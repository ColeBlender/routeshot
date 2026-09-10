import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pc from 'picocolors';

import { RouteshotError } from './errors.js';
import { createRemoteJudgeModel } from './judge-remote.js';
import { renderJudgeReport } from './judge-report.js';
import {
  createAnthropicJudgeModel,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_THRESHOLDS,
  JUDGE_CONCURRENCY,
  JUDGE_TIMEOUT_MS,
  judgeRoutesAsync,
  type JudgeDeps,
  type JudgeInput,
} from './judge.js';
import { Log } from './log.js';
import type { CaptureRun, Verdict, VerdictLevel } from './types.js';

export interface JudgeRunOptions {
  /** The run directory holding `index.json`, the PNGs and the `.code.txt` files. */
  dir: string;
  run: CaptureRun;
  /** Everything the judge needs to talk to the model. `judgeDepsFromEnv` builds it from the environment. */
  deps: JudgeDeps;
}

export interface JudgeRunResult {
  verdicts: Verdict[];
  summary: Record<VerdictLevel, number> & { total: number };
  report: { html: string; json: string };
}

/**
 * Judges every captured screen in a run and writes `verdicts.json` + `report.html` next to it.
 * Screens that were skipped or failed get an `unverified` verdict with the capture's reason, so
 * the report never quietly shrinks.
 */
export async function judgeRunAsync(options: JudgeRunOptions): Promise<JudgeRunResult> {
  const { dir, run, deps } = options;

  const inputs: JudgeInput[] = [];
  const verdicts = new Map<string, Verdict>();
  for (const entry of run.routes) {
    if (entry.status !== 'captured' || entry.file === undefined) {
      verdicts.set(entry.route, {
        route: entry.route,
        level: 'unverified',
        score: undefined,
        defect: 'none',
        region: undefined,
        caption: entry.reason ?? `screen was ${entry.status}`,
      });
      continue;
    }
    inputs.push({
      route: entry.route,
      screenshot: await readFile(join(dir, entry.file)),
      code: entry.code === undefined ? undefined : await readFile(join(dir, entry.code), 'utf8'),
    });
  }

  Log.log(`judging ${inputs.length} screen(s) with ${deps.model}`);
  // Each answer prints the moment it lands: four are in flight at a time and a screen can take
  // ten seconds, so a silent wait for the whole batch reads as a hang.
  const paint = { red: pc.red, yellow: pc.yellow, green: pc.green, unverified: pc.gray };
  const judged = await judgeRoutesAsync(inputs, deps, (verdict, done, total) => {
    Log.log(
      `[${done}/${total}] ${paint[verdict.level](verdict.level.padEnd(10))} ${verdict.route}  ${verdict.caption}`
    );
  });
  for (const verdict of judged) {
    verdicts.set(verdict.route, verdict);
  }

  const ordered = run.routes.map((entry) => verdicts.get(entry.route) as Verdict);
  const summary = {
    red: ordered.filter((item) => item.level === 'red').length,
    yellow: ordered.filter((item) => item.level === 'yellow').length,
    green: ordered.filter((item) => item.level === 'green').length,
    unverified: ordered.filter((item) => item.level === 'unverified').length,
    total: ordered.length,
  };

  const json = join(dir, 'verdicts.json');
  const html = join(dir, 'report.html');
  await writeFile(
    json,
    `${JSON.stringify({ run: run.id, summary, verdicts: ordered }, null, 2)}\n`
  );
  await writeFile(html, renderJudgeReport(run, ordered));

  return { verdicts: ordered, summary, report: { html, json } };
}

/**
 * Model access from the environment: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `JUDGE_YELLOW`,
 * `JUDGE_RED`. The same four knobs the report server reads, so a verdict from a laptop and one
 * from the server are the same verdict. Without a key, a configured report server answers
 * instead (its key, its model); without either there is no judge.
 */
export function judgeDepsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  server: { url: string; token: string } | undefined = undefined
): JudgeDeps {
  const apiKey = env['ANTHROPIC_API_KEY'];
  if ((apiKey === undefined || apiKey === '') && server === undefined) {
    throw new RouteshotError(
      'CONFIG',
      'The judge needs ANTHROPIC_API_KEY (in the shell or in .env.local next to the app), or a report server in routeshot.config to ask instead.'
    );
  }
  const threshold = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') {
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new RouteshotError('CONFIG', `${name} must be a score between 0 and 100, got ${raw}`);
    }
    return value;
  };
  return {
    anthropic:
      apiKey === undefined || apiKey === ''
        ? createRemoteJudgeModel(server as { url: string; token: string })
        : createAnthropicJudgeModel(new Anthropic({ apiKey })),
    model:
      env['ANTHROPIC_MODEL'] === undefined || env['ANTHROPIC_MODEL'] === ''
        ? DEFAULT_JUDGE_MODEL
        : env['ANTHROPIC_MODEL'],
    thresholds: {
      yellow: threshold('JUDGE_YELLOW', DEFAULT_JUDGE_THRESHOLDS.yellow),
      red: threshold('JUDGE_RED', DEFAULT_JUDGE_THRESHOLDS.red),
    },
    timeoutMs: JUDGE_TIMEOUT_MS,
    concurrency: JUDGE_CONCURRENCY,
    quota: undefined,
    now: () => new Date(),
  };
}
