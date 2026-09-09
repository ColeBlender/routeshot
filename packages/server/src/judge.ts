import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import type { DefectClass, Verdict, VerdictLevel } from './types.js';

/**
 * The judge: one screenshot, the code that rendered it, one question. "Does this screen look
 * broken?" It is deliberately not "what changed": nobody signed off on the previous screenshot
 * either, so a baseline proves nothing. The code says what should be on screen; the screenshot
 * shows what is. The model reads both.
 */
export const JUDGE_SYSTEM_PROMPT = `You are checking one screen of a mobile app for visual defects.

You get the screenshot of the screen as it rendered on an iOS simulator, and the source code that renders it: the route file, the layout files above it, and the components they import. Read the code to work out what should be on screen, then check the screenshot against it.

Report a defect only when the screenshot cannot be explained by a state the code allows. Loading, empty, signed-out, or permission-denied states the code renders on purpose are not defects. Copy, colors, spacing, and layout choices are not defects. You are not told what the screen used to look like, and it does not matter: judge what is in front of you.

A defect is one of:
- clipped: text or a control is cut off, truncated, or overflows its container
- overlap: elements are drawn on top of each other so something is unreadable
- offscreen: a control or content is pushed outside the visible screen
- wrapped: text in a button, tab, or label breaks onto a second line where the code clearly meant one
- missing: something the code renders unconditionally is not visible
- blank: the screen is empty or mostly empty where the code renders content
- error: an error screen, a red error box, a stack trace, or a crash screen
- other: something else that is clearly broken; say what in the caption
- none: the screen looks correct

score is your confidence that the screen is broken: 0 is certainly fine, 100 is certainly broken.
region is the bounding box of the defect in the screenshot, normalized to 0..1 of width and height, or null when there is no defect.
caption is at most 20 words, written for a pull request comment: what is wrong, or when nothing is, what the screen shows.

Respond ONLY with JSON in this shape, no prose:
{"score": 0-100, "defect": "clipped|overlap|offscreen|wrapped|missing|blank|error|other|none", "region": {"x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1} | null, "caption": "<= 20 words"}`;

export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5';
export const JUDGE_MAX_TOKENS = 300;
export const JUDGE_TIMEOUT_MS = 60_000;
export const JUDGE_CONCURRENCY = 4;
/** score >= yellow is yellow, score >= red is red; measured on the example app's labeled screens. */
export const DEFAULT_JUDGE_THRESHOLDS: JudgeThresholds = { yellow: 40, red: 75 };

export const DEFECT_CLASSES = [
  'clipped',
  'overlap',
  'offscreen',
  'wrapped',
  'missing',
  'blank',
  'error',
  'other',
  'none',
] as const;

export const judgeOutputSchema = z.object({
  score: z.number().min(0).max(100),
  defect: z.enum(DEFECT_CLASSES),
  region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullish(),
  caption: z.string(),
});

export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

export interface JudgeThresholds {
  yellow: number;
  red: number;
}

export type JudgeContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } };

export interface JudgeRequest {
  model: string;
  maxTokens: number;
  system: string;
  content: JudgeContent[];
}

export interface JudgeResponse {
  /** Set when the model honored the structured output format. */
  parsedOutput: unknown;
  /** Text blocks joined, for the fallback parse when `parsedOutput` is absent. */
  text: string;
}

/**
 * The slice of the Anthropic SDK the judge needs. `createAnthropicJudgeModel` adapts the real
 * client; tests pass a fake that returns canned JSON and records the request.
 */
export interface JudgeModel {
  parseAsync(request: JudgeRequest, signal: AbortSignal): Promise<JudgeResponse>;
}

export interface JudgeQuota {
  /** Max judge calls per UTC day. */
  cap: number;
  countAsync(day: string): Promise<number>;
  recordAsync(day: string, count: number): Promise<void>;
}

export interface JudgeDeps {
  anthropic: JudgeModel;
  model: string;
  thresholds: JudgeThresholds;
  timeoutMs: number;
  concurrency: number;
  quota: JudgeQuota | undefined;
  now: () => Date;
}

export interface JudgeInput {
  route: string;
  screenshot: Uint8Array;
  /** The source behind the screen (see `buildCodeContextAsync`). Undefined when none was captured. */
  code: string | undefined;
}

function unverified(route: string, caption: string): Verdict {
  return {
    route,
    level: 'unverified',
    score: undefined,
    defect: 'none',
    caption,
    region: undefined,
  };
}

/** `defect: none` caps the level at yellow: the model saw nothing broken, so red is not earned. */
export function levelForScore(
  score: number,
  defect: DefectClass,
  thresholds: JudgeThresholds
): VerdictLevel {
  const level: VerdictLevel =
    score >= thresholds.red ? 'red' : score >= thresholds.yellow ? 'yellow' : 'green';
  return defect === 'none' && level === 'red' ? 'yellow' : level;
}

export function buildJudgeRequest(input: JudgeInput, model: string): JudgeRequest {
  const source =
    input.code === undefined
      ? 'No source code was captured for this screen. Judge the screenshot on its own.'
      : `SOURCE, the code that rendered this screen:\n\n${input.code}`;
  return {
    model,
    maxTokens: JUDGE_MAX_TOKENS,
    system: JUDGE_SYSTEM_PROMPT,
    content: [
      { type: 'text', text: `Route: ${input.route}\n\n${source}\n\nSCREENSHOT:` },
      { type: 'image', source: toImageSource(input.screenshot) },
    ],
  };
}

function toImageSource(png: Uint8Array): {
  type: 'base64';
  media_type: 'image/png';
  data: string;
} {
  return { type: 'base64', media_type: 'image/png', data: Buffer.from(png).toString('base64') };
}

/**
 * The one place in this package that swallows errors instead of throwing. A judge that cannot
 * answer must not fail the run that asked: an 'unverified' verdict is the honest result and is
 * never rendered as green.
 */
export async function judgeRouteAsync(input: JudgeInput, deps: JudgeDeps): Promise<Verdict> {
  return (await judgeRouteResultAsync(input, deps)).verdict;
}

/** `spent` is false when the call never produced an answer, so its quota reservation is refundable. */
interface JudgeRouteResult {
  verdict: Verdict;
  spent: boolean;
}

async function judgeRouteResultAsync(
  input: JudgeInput,
  deps: JudgeDeps
): Promise<JudgeRouteResult> {
  const signal = AbortSignal.timeout(deps.timeoutMs);
  let response: JudgeResponse;
  try {
    response = await deps.anthropic.parseAsync(buildJudgeRequest(input, deps.model), signal);
  } catch (error) {
    if (signal.aborted) {
      return { verdict: unverified(input.route, 'judge timed out'), spent: false };
    }
    return {
      verdict: unverified(
        input.route,
        `judge unavailable: ${error instanceof Error ? error.message : String(error)}`
      ),
      spent: false,
    };
  }

  const output = parseJudgeOutput(response);
  if (output === undefined) {
    // The model answered, so the tokens are gone even though the answer is useless.
    return { verdict: unverified(input.route, 'judge returned unparseable output'), spent: true };
  }

  return {
    verdict: {
      route: input.route,
      level: levelForScore(output.score, output.defect, deps.thresholds),
      score: output.score,
      defect: output.defect,
      region: output.region ?? undefined,
      // Models sometimes wrap the whole caption in quotes. Only a matching pair goes; a caption
      // that merely starts with a quoted word ('Saved' button ...) keeps it.
      caption: output.caption.trim().replace(/^(['"])(.*)\1$/s, '$2'),
    },
    spent: true,
  };
}

function parseJudgeOutput(response: JudgeResponse): JudgeOutput | undefined {
  const fromStructured = judgeOutputSchema.safeParse(response.parsedOutput);
  if (fromStructured.success) {
    return fromStructured.data;
  }
  // Structured output is best-effort; a model that answered in prose with a JSON object still
  // counts, so pull the outermost braces out of the text before giving up.
  const start = response.text.indexOf('{');
  const end = response.text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    const parsed = judgeOutputSchema.safeParse(JSON.parse(response.text.slice(start, end + 1)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Judges many routes with a fixed concurrency and one daily spend check for the whole batch. */
export async function judgeRoutesAsync(inputs: JudgeInput[], deps: JudgeDeps): Promise<Verdict[]> {
  if (inputs.length === 0) {
    return [];
  }

  const day = deps.now().toISOString().slice(0, 10);
  let allowed = inputs.length;
  if (deps.quota) {
    const used = await deps.quota.countAsync(day);
    allowed = Math.max(0, Math.min(inputs.length, deps.quota.cap - used));
    if (allowed > 0) {
      // Reserved before the calls go out so two concurrent batches cannot both spend the tail
      // of the daily budget.
      await deps.quota.recordAsync(day, allowed);
    }
  }

  const verdicts: Verdict[] = [];
  let refundable = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(deps.concurrency, inputs.length) }, async () => {
    for (;;) {
      const index = next++;
      const input = inputs[index];
      if (input === undefined) {
        return;
      }
      if (index >= allowed) {
        verdicts[index] = unverified(input.route, 'daily judge cap reached');
        continue;
      }
      const result = await judgeRouteResultAsync(input, deps);
      verdicts[index] = result.verdict;
      if (!result.spent) {
        refundable += 1;
      }
    }
  });
  await Promise.all(workers);

  // A timeout or a transport failure bought nothing, so hand the reservation back rather than
  // letting one bad minute eat the rest of the day's budget.
  if (deps.quota && refundable > 0) {
    await deps.quota.recordAsync(day, -refundable);
  }
  return verdicts;
}

/**
 * Adapts the Anthropic SDK to `JudgeModel`. SDK 0.124 exposes structured output on the stable
 * Messages API as `output_config.format` plus a `parsed_output` property; if the account or API
 * version rejects the parameter itself, the flag flips and every later call uses plain `create`
 * with the same prompt, which already demands JSON-only output.
 */
export function createAnthropicJudgeModel(client: Anthropic): JudgeModel {
  let structuredOutputSupported = true;

  return {
    async parseAsync(request, signal) {
      const params = {
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: 'user' as const, content: request.content }],
      };

      if (structuredOutputSupported) {
        try {
          const message = await client.messages.parse(
            { ...params, output_config: { format: zodOutputFormat(judgeOutputSchema) } },
            { signal }
          );
          return { parsedOutput: message.parsed_output, text: textOf(message.content) };
        } catch (error) {
          if (signal.aborted || !isStructuredOutputUnsupported(error)) {
            throw error;
          }
          structuredOutputSupported = false;
        }
      }

      const message = await client.messages.create(params, { signal });
      return { parsedOutput: undefined, text: textOf(message.content) };
    },
  };
}

/**
 * Only a 400 that names the structured-output parameter proves the endpoint cannot do structured
 * output. Every other 400 is about the one request that made it (an oversized image, an unknown
 * model), so it is rethrown into an unverified verdict for that route and the latch stays closed.
 */
function isStructuredOutputUnsupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error) || error.status !== 400) {
    return false;
  }
  const haystack = [
    error instanceof Error ? error.message : '',
    'error' in error ? safeStringify(error.error) : '',
  ]
    .join(' ')
    .toLowerCase();
  return (
    haystack.includes('output_config') ||
    haystack.includes('output_format') ||
    haystack.includes('structured output')
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}
