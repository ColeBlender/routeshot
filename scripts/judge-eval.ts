#!/usr/bin/env node
/**
 * Scores the server's judge against the example runs, whose expected verdict per screen is fixed
 * by example/README.md. Diffs with the CLI's own diff, then feeds every changed route to
 * `judgeRoutesAsync` with the deployed thresholds, so a prompt change is measurable.
 *   pnpm judge:eval                                 # baseline vs broken and benign
 *   pnpm judge:eval <baselineDir> <candidateDir>... # any runs; expectations show as "?"
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_THRESHOLD, diffRunsAsync } from '../packages/routeshot/dist/index.js';
import {
  createAnthropicJudgeModel,
  judgeRouteAsync,
  judgeRoutesAsync,
  JUDGE_CONCURRENCY,
  JUDGE_TIMEOUT_MS,
  type JudgeDeps,
  type JudgeInput,
} from '../packages/server/dist/judge.mjs';

type Verdict = Awaited<ReturnType<typeof judgeRouteAsync>>;

/** example/README.md: one defect class per screen in `broken`, none in `benign`. Unlisted = green. */
const DEFECTS: Record<string, Record<string, string>> = {
  broken: {
    '/': 'clipped',
    '/about': 'error',
    '/explore': 'overlap',
    '/items/[id]': 'blank',
    '/settings/billing': 'offscreen',
  },
  benign: {},
};

// `baseline`, not `before`: before/again are the repeatability pair, captured against a different
// dev-client state, so diffing them against `broken` even moves the two unchanged controls.
const DEFAULT_BASELINE = 'baseline';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const runsDir = join(repoRoot, 'example', '.routeshot', 'runs');
const WIDTHS = [19, 15, 12, 7, 11];
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
      `Capture one with: cd example && npx routeshot capture --label ${label}`
  );
}

/** The judge only sees screens that moved, so `inputs` is also what a real compare would spend. */
async function scenarioAsync(baselineDir: string, dir: string, threshold: number) {
  const outDir = await mkdtemp(join(tmpdir(), 'routeshot-judge-eval-'));
  const report = await diffRunsAsync(baselineDir, dir, { threshold, outDir });
  const changed = report.routes.filter((route) => route.status === 'changed' && route.files.diff);
  const inputs: JudgeInput[] = await Promise.all(
    changed.map(async (route) => ({
      route: route.route,
      before: await readFile(join(outDir, route.files.before ?? '')),
      after: await readFile(join(outDir, route.files.after ?? '')),
      diff: await readFile(join(outDir, route.files.diff ?? '')),
      diffRatio: route.diffRatio ?? 0,
    }))
  );
  const label = Object.keys(DEFECTS).find((name) => dir.includes(`-${name}-`)) ?? '';
  return { label, routes: report.routes, inputs };
}

/** Resolved out of the server package so the eval runs the exact SDK version the server ships. */
async function judgeDepsAsync(
  apiKey: string,
  rest: Omit<JudgeDeps, 'anthropic'>
): Promise<JudgeDeps> {
  const entry = createRequire(join(repoRoot, 'packages/server/package.json'));
  const { default: Anthropic } = (await import(
    pathToFileURL(entry.resolve('@anthropic-ai/sdk')).href
  )) as { default: new (options: { apiKey: string }) => never };
  return { ...rest, anthropic: createAnthropicJudgeModel(new Anthropic({ apiKey })) };
}

async function mainAsync(): Promise<void> {
  const [baselineArg, ...candidateArgs] = process.argv.slice(2);
  const baselineDir = baselineArg ?? (await runDirForLabelAsync(DEFAULT_BASELINE));
  const candidateDirs =
    candidateArgs.length > 0
      ? candidateArgs
      : await Promise.all(Object.keys(DEFECTS).map(runDirForLabelAsync));

  const yellow = numberFromEnv('JUDGE_YELLOW', 40);
  const thresholds = { yellow, red: numberFromEnv('JUDGE_RED', 75) };
  const threshold = numberFromEnv('ROUTESHOT_THRESHOLD', DEFAULT_THRESHOLD);
  const model = process.env['ANTHROPIC_MODEL'] ?? 'claude-sonnet-5';
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const config = {
    model,
    thresholds,
    timeoutMs: JUDGE_TIMEOUT_MS,
    concurrency: JUDGE_CONCURRENCY,
    quota: undefined,
    now: () => new Date(),
  };
  const deps = apiKey ? await judgeDepsAsync(apiKey, config) : undefined;

  out(`diff > ${threshold} · yellow >= ${thresholds.yellow} · red >= ${thresholds.red} · ${model}`);
  out(`baseline ${baselineDir}`);

  const tally = new Map<string, { hit: number; seen: number }>();
  for (const dir of candidateDirs) {
    const { label, routes, inputs } = await scenarioAsync(baselineDir, dir, threshold);
    const verdicts = new Map<string, Verdict>(
      deps ? (await judgeRoutesAsync(inputs, deps)).map((item) => [item.route, item]) : []
    );

    out(`\n${dir}`);
    out(`   ${row(['route', 'want', 'got', 'score', 'defect'])}caption`);
    for (const route of routes) {
      const wantDefect = DEFECTS[label]?.[route.route] ?? 'none';
      const want = label === '' ? '?' : wantDefect === 'none' ? 'green' : 'red';
      const verdict = verdicts.get(route.route);
      const changed = inputs.some((input) => input.route === route.route);
      // Zero moved pixels never reaches the judge, and the server scores that green/none too.
      const got = deps ? (verdict?.level ?? 'green') : changed ? 'would judge' : 'skipped';
      const defect = verdict?.defect ?? (changed ? '-' : 'none');
      const ok = deps !== undefined && want !== '?' && got === want && defect === wantDefect;
      if (deps) {
        const seen = tally.get(want) ?? { hit: 0, seen: 0 };
        tally.set(want, { hit: seen.hit + (ok ? 1 : 0), seen: seen.seen + 1 });
      }
      out(
        `  ${ok || !deps ? ' ' : '✗'}` +
          row([route.route, `${want}:${wantDefect}`, got, String(verdict?.score ?? '-'), defect]) +
          `${verdict?.caption ?? (changed ? '' : 'no pixels moved')}`
      );
    }
  }

  if (!deps) {
    out('\nno ANTHROPIC_API_KEY, judge skipped');
    return;
  }
  const totals = [...tally].map(([want, t]) => `${want} ${t.hit}/${t.seen}`).join(' · ');
  const hit = [...tally.values()].reduce((sum, t) => sum + t.hit, 0);
  const seen = [...tally.values()].reduce((sum, t) => sum + t.seen, 0);
  out(`\n${hit}/${seen} routes matched · ${totals}`);
}

await mainAsync();
