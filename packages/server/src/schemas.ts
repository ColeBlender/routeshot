import { z } from 'zod';

import { ServerError } from './errors.js';
import type { CaptureRun, Verdict } from './types.js';

/**
 * Runtime validation for everything crossing the wire. Kept next to `types.ts` on purpose: the
 * types are the compile-time contract with the CLI, these are the runtime one, and they describe
 * the same shape. `parseCaptureRunAsync`'s caller gets a fully-populated object, because the
 * types use required `| undefined` keys while JSON omits them.
 */
const deviceSchema = z.object({
  udid: z.string(),
  name: z.string(),
  runtime: z.string(),
  state: z.enum(['Booted', 'Shutdown', 'Shutting Down', 'Booting']),
});

const entrySchema = z.object({
  route: z.string().min(1),
  file: z.string().optional(),
  code: z.string().optional(),
  status: z.enum(['captured', 'skipped', 'failed']),
  reason: z.string().optional(),
  settledMs: z.number().optional(),
  settled: z.boolean(),
});

const runSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  createdAt: z.string().min(1),
  device: deviceSchema,
  app: z.object({ bundleId: z.string(), scheme: z.string() }),
  updateUrl: z.string().optional(),
  git: z.object({ sha: z.string().optional(), branch: z.string().optional() }),
  affected: z
    .object({
      since: z.string(),
      changedFiles: z.array(z.string()),
      all: z.string().optional(),
      because: z.record(z.string(), z.array(z.string())),
      ignored: z.array(z.string()),
    })
    .optional(),
  routes: z.array(entrySchema),
});

export function parseCaptureRun(value: unknown): CaptureRun {
  const result = runSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? issue.path.join('.') || '(root)' : '(root)';
    throw new ServerError(
      'BAD_REQUEST',
      `index.json is not a valid capture run: ${where}: ${issue?.message ?? 'unknown error'}`
    );
  }
  const run = result.data;
  return {
    id: run.id,
    label: run.label,
    createdAt: run.createdAt,
    device: run.device,
    app: run.app,
    updateUrl: run.updateUrl,
    git: { sha: run.git.sha, branch: run.git.branch },
    affected: run.affected
      ? {
          since: run.affected.since,
          changedFiles: run.affected.changedFiles,
          all: run.affected.all,
          because: run.affected.because,
          ignored: run.affected.ignored,
        }
      : undefined,
    routes: run.routes.map((entry) => ({
      route: entry.route,
      file: entry.file,
      code: entry.code,
      status: entry.status,
      reason: entry.reason,
      settledMs: entry.settledMs,
      settled: entry.settled,
    })),
  };
}

const verdictSchema = z.object({
  route: z.string().min(1),
  level: z.enum(['green', 'yellow', 'red', 'unverified']),
  score: z.number().min(0).max(100).optional(),
  defect: z.enum([
    'clipped',
    'overlap',
    'offscreen',
    'wrapped',
    'missing',
    'blank',
    'error',
    'other',
    'none',
  ]),
  region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
  caption: z.string(),
});

/**
 * The `verdicts.json` the CLI writes next to a judged run: `{ run, summary, verdicts }`. Only the
 * verdicts are kept; the summary is recomputed from them wherever it is shown.
 */
const verdictsFileSchema = z.object({ verdicts: z.array(verdictSchema) });

export function parseVerdicts(value: unknown): Verdict[] {
  const result = verdictsFileSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? issue.path.join('.') || '(root)' : '(root)';
    throw new ServerError(
      'BAD_REQUEST',
      `verdicts.json is not a list of verdicts: ${where}: ${issue?.message ?? 'unknown error'}`
    );
  }
  return result.data.verdicts.map((verdict) => ({
    route: verdict.route,
    level: verdict.level,
    score: verdict.score,
    defect: verdict.defect,
    region: verdict.region,
    caption: verdict.caption,
  }));
}

const EXAMPLE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `PUT /examples/:name`: a short lowercase slug, and the id of the run it should show. */
export function parseExampleName(name: string): string {
  if (!EXAMPLE_NAME.test(name)) {
    throw new ServerError(
      'BAD_REQUEST',
      'an example name is 1 to 40 lowercase letters, digits and dashes'
    );
  }
  return name;
}

const exampleBodySchema = z.object({ runId: z.string().min(1) });

export function parseExampleBody(value: unknown): { runId: string } {
  const result = exampleBodySchema.safeParse(value);
  if (!result.success) {
    throw new ServerError('BAD_REQUEST', 'expected a JSON body with a runId');
  }
  return result.data;
}

/**
 * `POST /judge` body: the content blocks of one judge request, screenshot plus code. The system
 * prompt and the model are the server's own, never the caller's, so a demo token only ever buys
 * the one question the judge asks.
 */
const judgeContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(200_000) }),
  z.object({
    type: z.literal('image'),
    source: z.object({
      type: z.literal('base64'),
      media_type: z.literal('image/png'),
      data: z.string().max(8_000_000),
    }),
  }),
]);

const judgeBodySchema = z.object({
  content: z
    .array(judgeContentSchema)
    .min(1)
    .max(8)
    .refine((blocks) => blocks.filter((block) => block.type === 'image').length === 1, {
      message: 'exactly one image block is required',
    }),
});

export type JudgeBody = z.infer<typeof judgeBodySchema>;

export function parseJudgeBody(value: unknown): JudgeBody {
  const result = judgeBodySchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? issue.path.join('.') || '(root)' : '(root)';
    throw new ServerError(
      'BAD_REQUEST',
      `not a valid judge request: ${where}: ${issue?.message ?? 'unknown error'}`
    );
  }
  return result.data;
}
