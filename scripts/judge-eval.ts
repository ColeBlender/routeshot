#!/usr/bin/env node
/**
 * Scores the judge against the example runs. Every screen of every labeled run is judged on its
 * own (screenshot + code, no baseline), and the expected verdict per screen comes from
 * example/README.md: `broken` holds one defect per screen, `baseline` and `benign` hold none.
 *
 *   pnpm judge:eval                    # newest baseline, benign and broken runs under example/
 *   pnpm judge:eval <runDir>...        # any runs; expectations show as "?" for unknown labels
 *   JUDGE_EVAL_REPEAT=3 pnpm judge:eval   # judge each run N times to see the variance
 */
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createAnthropicJudgeModel,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_THRESHOLDS,
  JUDGE_CONCURRENCY,
  JUDGE_TIMEOUT_MS,
  judgeRoutesAsync,
  type CaptureRun,
  type JudgeDeps,
  type JudgeInput,
  type Verdict,
} from '../packages/routeshot/dist/index.js';

/** Labels the judge may use for each deliberate defect. The level (red) is what matters most. */
const DEFECTS: Record<string, Record<string, string[]>> = {
  broken: {
    '/': ['clipped'],
    '/about': ['error'],
    '/explore': ['overlap'],
    '/items/[id]': ['blank', 'missing'],
    '/settings/billing': ['offscreen', 'missing'],
  },
  benign: {},
  baseline: {},
};

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const runsDir = join(repoRoot, 'example', '.routeshot', 'runs');
const WIDTHS = [19, 20, 12, 7, 11];
const row = (cells: string[]): string =>
  cells.map((cell, index) => cell.padEnd(WIDTHS[index] ?? 0)).join('');

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got ${String(raw)}`);
  }
  return value;
}

/** Newest run carrying that label. Run directory names sort chronologically. */
async function runDirForLabelAsync(label: string): Promise<string> {
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const name of names.sort().reverse()) {
    const index = JSON.parse(await readFile(join(runsDir, name, 'index.json'), 'utf8')) as {
      label?: string;
    };
    if (index.label === label) {
      return join(runsDir, name);
    }
  }
  throw new Error(
    `No run labelled "${label}" under ${runsDir}. ` +
      `Capture one with: cd example && EXPO_PUBLIC_ROUTESHOT_SCENARIO=${label} npx expo start, then pnpm exec routeshot capture --label ${label}`
  );
}

async function inputsForAsync(dir: string): Promise<{ run: CaptureRun; inputs: JudgeInput[] }> {
  const run = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as CaptureRun;
  const inputs: JudgeInput[] = [];
  for (const entry of run.routes) {
    if (entry.status !== 'captured' || entry.file === undefined) {
      continue;
    }
    inputs.push({
      route: entry.route,
      screenshot: await readFile(join(dir, entry.file)),
      code: entry.code === undefined ? undefined : await readFile(join(dir, entry.code), 'utf8'),
    });
  }
  return { run, inputs };
}

/** Resolved out of the CLI package so the eval runs the exact SDK version it ships. */
async function judgeDepsAsync(
  apiKey: string,
  rest: Omit<JudgeDeps, 'anthropic'>
): Promise<JudgeDeps> {
  const entry = createRequire(join(repoRoot, 'packages/routeshot/package.json'));
  const { default: Anthropic } = (await import(
    pathToFileURL(entry.resolve('@anthropic-ai/sdk')).href
  )) as { default: new (options: { apiKey: string }) => never };
  return { ...rest, anthropic: createAnthropicJudgeModel(new Anthropic({ apiKey })) };
}

async function mainAsync(): Promise<void> {
  const dirs =
    process.argv.length > 2
      ? process.argv.slice(2)
      : await Promise.all(['baseline', 'benign', 'broken'].map(runDirForLabelAsync));
  const repeat = numberFromEnv('JUDGE_EVAL_REPEAT', 1);
  const thresholds = {
    yellow: numberFromEnv('JUDGE_YELLOW', DEFAULT_JUDGE_THRESHOLDS.yellow),
    red: numberFromEnv('JUDGE_RED', DEFAULT_JUDGE_THRESHOLDS.red),
  };
  const model = process.env['ANTHROPIC_MODEL'] ?? DEFAULT_JUDGE_MODEL;
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    out('no ANTHROPIC_API_KEY, nothing to evaluate');
    return;
  }
  const deps = await judgeDepsAsync(apiKey, {
    model,
    thresholds,
    timeoutMs: JUDGE_TIMEOUT_MS,
    concurrency: JUDGE_CONCURRENCY,
    quota: undefined,
    now: () => new Date(),
  });

  out(`yellow >= ${thresholds.yellow} · red >= ${thresholds.red} · ${model} · ${repeat}x`);

  let levelHits = 0;
  let labelHits = 0;
  let seen = 0;
  let unverified = 0;
  for (const dir of dirs) {
    const { run, inputs } = await inputsForAsync(dir);
    const expectations = DEFECTS[run.label];
    for (let pass = 0; pass < repeat; pass += 1) {
      const verdicts = new Map<string, Verdict>(
        (await judgeRoutesAsync(inputs, deps)).map((item) => [item.route, item])
      );
      out(`\n${dir}${repeat > 1 ? ` (pass ${pass + 1})` : ''}`);
      out(`   ${row(['route', 'want', 'got', 'score', 'defect'])}caption`);
      for (const input of inputs) {
        const verdict = verdicts.get(input.route);
        const wantLabels = expectations?.[input.route] ?? (expectations ? ['none'] : undefined);
        const wantLevel =
          wantLabels === undefined ? '?' : wantLabels[0] === 'none' ? 'green' : 'red';
        const got = verdict?.level ?? 'unverified';
        const defect = verdict?.defect ?? '-';
        const levelOk = wantLevel !== '?' && got === wantLevel;
        const labelOk = levelOk && (wantLabels?.includes(defect) ?? false);
        if (wantLevel !== '?') {
          seen += 1;
          levelHits += levelOk ? 1 : 0;
          labelHits += labelOk ? 1 : 0;
          unverified += got === 'unverified' ? 1 : 0;
        }
        out(
          `  ${labelOk || wantLevel === '?' ? ' ' : levelOk ? '~' : '✗'}` +
            row([
              input.route,
              wantLabels === undefined ? '?' : `${wantLevel}:${wantLabels.join('|')}`,
              got,
              String(verdict?.score ?? '-'),
              defect,
            ]) +
            (verdict?.caption ?? '')
        );
      }
    }
  }

  out(
    `\n${levelHits}/${seen} verdict levels · ${labelHits}/${seen} defect labels · ${unverified} unverified`
  );
}

await mainAsync();
