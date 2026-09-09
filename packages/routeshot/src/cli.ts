#!/usr/bin/env node
import { Command, Option } from 'commander';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { captureAsync } from './capture.js';
import {
  DEFAULT_DEV_SERVER_URL,
  DEFAULT_THRESHOLD,
  loadRouteshotConfigAsync,
  type RouteshotConfig,
} from './config.js';
import { diffRunsAsync } from './diff.js';
import { isRouteshotError, RouteshotError } from './errors.js';
import { judgeDepsFromEnv, judgeRunAsync, type JudgeRunResult } from './judge-run.js';
import { enableJsonOutput, Log } from './log.js';
import { writeReportAsync } from './report.js';
import { SimctlSimulator } from './simulator.js';
import type { CaptureRun } from './types.js';
import { requestVerdictsAsync, resolveRemoteRunIdAsync, uploadRunAsync } from './upload.js';

/** Named without the `Async` suffix because it is not an `async function`, only promise-returning. */
const execFilePromise = promisify(execFile);
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const program = new Command()
  .name('routeshot')
  .description(
    'Screenshot every expo-router screen a change touched and ask whether it looks broken.'
  )
  .version(version);

program
  .command('capture')
  .description('Deep link every route on a simulator and write a run to .routeshot/runs')
  .option('--label <name>', 'name for this run (default: the current git branch)')
  .option('--device <name>', 'simulator name, e.g. "iPhone 17 Pro"')
  .option(
    '--update-url <url>',
    'EAS update manifest URL to load before capturing: https://u.expo.dev/update/<updateId> or https://u.expo.dev/<projectId>/group/<groupId>'
  )
  .addOption(
    new Option('--appearance <mode>', 'color scheme to capture in').choices(['light', 'dark'])
  )
  .option(
    '--dev-client [url]',
    `treat the installed app as a development build that loads from this dev server (default when expo-dev-client is a dependency; url defaults to ${DEFAULT_DEV_SERVER_URL})`
  )
  .option('--no-dev-client', 'treat the installed app as a release build')
  .option(
    '--changed-since <ref>',
    'capture only the screens whose code changed against this git ref (route file, layouts, imports)'
  )
  .option(
    '--judge',
    'after capturing, ask the model whether each screen looks broken (ANTHROPIC_API_KEY, or a report server)'
  )
  .option('--no-fail', 'with --judge, exit 0 even when a screen is red')
  .option('--open', 'with --judge, open the report in the default browser')
  .option(
    '--upload',
    'POST the run to the report server (server.url in routeshot.config, or ROUTESHOT_SERVER_URL)'
  )
  .option('--json', 'print only the run JSON on stdout')
  .action(captureCommandAsync);

program
  .command('judge')
  .description('Ask the model whether each captured screen looks broken, given its code')
  .argument('[run]', 'run id, label, directory, or "latest" / "previous"', 'latest')
  .option('--no-fail', 'exit 0 even when a screen is red')
  .option('--open', 'open the report in the default browser')
  .option('--json', 'print only the verdicts JSON on stdout')
  .action(judgeCommandAsync);

program
  .command('upload')
  .description('Send a run that is already on disk to the report server')
  .argument('<run>', 'run id, label, directory, or "latest" / "previous"')
  .option('--json', 'print only the upload JSON on stdout')
  .action(uploadCommandAsync);

program
  .command('compare')
  .description('Diff two runs and write report.html + report.json')
  .argument('<baseline>', 'run id, label, directory, or "latest" / "previous"')
  .argument('<candidate>', 'run id, label, directory, or "latest" / "previous"')
  .option('--threshold <ratio>', 'fraction of differing pixels that counts as changed')
  .option(
    '--remote',
    'compare runs already uploaded to the report server; refs are server run ids or branch names'
  )
  .option('--no-fail', 'exit 0 even when routes changed')
  .option('--open', 'open the report in the default browser')
  .option('--json', 'print only the report JSON on stdout')
  .action(compareCommandAsync);

interface CaptureCommandOptions {
  label?: string;
  device?: string;
  updateUrl?: string;
  appearance?: 'light' | 'dark';
  /** commander: `--dev-client` gives true, `--dev-client <url>` the url, `--no-dev-client` false. */
  devClient?: boolean | string;
  changedSince?: string;
  judge?: boolean;
  /** commander's `--no-fail` inverse: true unless the flag was passed. */
  fail: boolean;
  open?: boolean;
  upload?: boolean;
  json?: boolean;
}

async function captureCommandAsync(options: CaptureCommandOptions): Promise<void> {
  if (options.json) {
    enableJsonOutput();
  }

  const projectRoot = process.cwd();
  loadDotenv(projectRoot);
  const loaded = await loadRouteshotConfigAsync(projectRoot);
  // Fail before the simulator boots when the judge was asked for but cannot run.
  const judgeDeps = options.judge ? judgeDepsFromEnv(process.env, loaded.server) : undefined;
  const config: RouteshotConfig = {
    ...loaded,
    ...(options.device === undefined ? {} : { device: options.device }),
    ...(options.devClient === undefined
      ? {}
      : { devClient: devClientFromFlag(options.devClient, loaded) }),
  };
  const { run, dir } = await captureAsync({
    projectRoot,
    config,
    sim: new SimctlSimulator(),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.updateUrl === undefined ? {} : { updateUrl: options.updateUrl }),
    ...(options.appearance === undefined ? {} : { appearance: options.appearance }),
    ...(options.changedSince === undefined ? {} : { changedSince: options.changedSince }),
  });

  let judged: JudgeRunResult | undefined;
  if (judgeDeps) {
    judged = await judgeRunAsync({ dir, run, deps: judgeDeps });
    printVerdicts(judged);
    if (options.open) {
      await execFilePromise('open', [judged.report.html]);
    }
  }

  let upload;
  if (options.upload) {
    if (!config.server) {
      throw new RouteshotError(
        'CONFIG',
        '--upload needs server.url and server.token in routeshot.config'
      );
    }
    upload = await uploadRunAsync({
      dir,
      run,
      serverUrl: config.server.url,
      token: config.server.token,
    });
    Log.succeed(`uploaded to ${upload.url}`);
  }

  if (options.json) {
    Log.json({
      id: run.id,
      dir,
      ...(run.affected === undefined ? {} : { affected: run.affected }),
      routes: run.routes,
      ...(judged === undefined ? {} : { verdicts: judged.verdicts, summary: judged.summary }),
      ...(upload === undefined ? {} : { upload }),
    });
  }
  if (judged && judged.summary.red > 0 && options.fail) {
    throw new RouteshotError(
      'DEFECT_FOUND',
      `${judged.summary.red} screen(s) look broken. Pass --no-fail to exit 0.`
    );
  }
}

interface JudgeCommandOptions {
  fail: boolean;
  open?: boolean;
  json?: boolean;
}

async function judgeCommandAsync(runRef: string, options: JudgeCommandOptions): Promise<void> {
  if (options.json) {
    enableJsonOutput();
  }
  const projectRoot = process.cwd();
  loadDotenv(projectRoot);
  // The run may be judged from a checkout with no Expo app (CI), so a config that will not load
  // only costs the report-server fallback, not the command.
  const server = (await loadRouteshotConfigAsync(projectRoot).catch(() => undefined))?.server;
  const deps = judgeDepsFromEnv(process.env, server);
  const dir = await resolveRunDirAsync(projectRoot, runRef);
  let run: CaptureRun;
  try {
    run = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as CaptureRun;
  } catch (error) {
    throw new RouteshotError('JUDGE', `Cannot read the run at ${dir}`, { cause: error });
  }

  const judged = await judgeRunAsync({ dir, run, deps });
  printVerdicts(judged);
  if (options.open) {
    await execFilePromise('open', [judged.report.html]);
  }
  if (options.json) {
    Log.json({
      run: run.id,
      dir,
      summary: judged.summary,
      verdicts: judged.verdicts,
      report: judged.report,
    });
  }
  if (judged.summary.red > 0 && options.fail) {
    throw new RouteshotError(
      'DEFECT_FOUND',
      `${judged.summary.red} screen(s) look broken. Pass --no-fail to exit 0.`
    );
  }
}

function printVerdicts(judged: JudgeRunResult): void {
  const { summary } = judged;
  Log.log(
    `${summary.red} red, ${summary.yellow} yellow, ${summary.green} green, ${summary.unverified} unverified`
  );
  for (const verdict of judged.verdicts) {
    if (verdict.level !== 'green') {
      Log.log(`  ${verdict.level.padEnd(10)} ${verdict.route}  ${verdict.caption}`);
    }
  }
  Log.succeed(`report at ${judged.report.html}`);
}

/**
 * `.env.local` then `.env` in the app directory, without overriding what the shell already set.
 * That is where Expo apps keep secrets, and where `ANTHROPIC_API_KEY` for the judge belongs.
 */
function loadDotenv(projectRoot: string): void {
  for (const name of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(join(projectRoot, name));
    } catch {
      // No such file: fine.
    }
  }
}

function devClientFromFlag(
  flag: boolean | string,
  loaded: RouteshotConfig
): RouteshotConfig['devClient'] {
  if (flag === false) {
    return undefined;
  }
  if (typeof flag === 'string') {
    return { url: flag };
  }
  return loaded.devClient ?? { url: DEFAULT_DEV_SERVER_URL };
}

interface UploadCommandOptions {
  json?: boolean;
}

/**
 * `capture --upload` covers the machine that took the screenshots. CI splits the two: the macOS
 * runner captures and stores the run as an artifact, and a later job uploads it once the build it
 * belongs to is known, so the run has to be postable from disk without a simulator.
 */
async function uploadCommandAsync(runRef: string, options: UploadCommandOptions): Promise<void> {
  if (options.json) {
    enableJsonOutput();
  }

  const projectRoot = process.cwd();
  const server = await resolveServerAsync(projectRoot);
  const dir = await resolveRunDirAsync(projectRoot, runRef);
  let run: CaptureRun;
  try {
    run = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as CaptureRun;
  } catch (error) {
    throw new RouteshotError('UPLOAD', `Cannot read the run at ${dir}`, { cause: error });
  }

  const upload = await uploadRunAsync({ dir, run, serverUrl: server.url, token: server.token });
  Log.succeed(`uploaded ${run.label} to ${upload.url}`);

  if (options.json) {
    Log.json({ ...upload, dir, label: run.label });
  }
}

/**
 * `upload` and `compare --remote` run against downloaded run artifacts in CI, where there is no
 * Expo app and `loadRouteshotConfigAsync` throws for the missing scheme. The server can still come
 * from the environment, so a config that will not load falls back to it rather than reporting a
 * server that was in fact configured.
 */
async function resolveServerAsync(projectRoot: string): Promise<{ url: string; token: string }> {
  const configured = (await loadRouteshotConfigAsync(projectRoot).catch(() => undefined))?.server;
  const url = configured?.url ?? process.env['ROUTESHOT_SERVER_URL'];
  const token = configured?.token ?? process.env['ROUTESHOT_SERVER_TOKEN'];
  if (!url || !token) {
    throw new RouteshotError(
      'CONFIG',
      'No report server. Set server.url and server.token in routeshot.config, or ROUTESHOT_SERVER_URL and ROUTESHOT_SERVER_TOKEN.'
    );
  }
  return { url, token };
}

interface CompareCommandOptions {
  threshold?: string;
  remote?: boolean;
  /** commander's `--no-fail` inverse: true unless the flag was passed. */
  fail: boolean;
  open?: boolean;
  json?: boolean;
}

async function compareCommandAsync(
  baselineRef: string,
  candidateRef: string,
  options: CompareCommandOptions
): Promise<void> {
  if (options.json) {
    enableJsonOutput();
  }

  const projectRoot = process.cwd();
  const threshold =
    options.threshold === undefined
      ? await defaultThresholdAsync(projectRoot)
      : parseThreshold(options.threshold);

  if (options.remote) {
    await compareRemoteAsync(projectRoot, baselineRef, candidateRef, threshold, options);
    return;
  }

  const baselineDir = await resolveRunDirAsync(projectRoot, baselineRef);
  const candidateDir = await resolveRunDirAsync(projectRoot, candidateRef);
  const report = await diffRunsAsync(baselineDir, candidateDir, { threshold });
  const outDir = report.outDir ?? candidateDir;
  const written = await writeReportAsync(report, outDir);

  Log.log(
    `${report.summary.changed} changed, ${report.summary.unchanged} unchanged, ` +
      `${report.summary.added} added, ${report.summary.removed} removed, ` +
      `${report.summary.unverified} unverified`
  );
  for (const route of report.routes) {
    if (route.status === 'changed' || route.status === 'unverified') {
      const detail =
        route.diffRatio === undefined
          ? (route.reason ?? '')
          : `${(route.diffRatio * 100).toFixed(2)}%`;
      Log.log(`  ${route.status.padEnd(10)} ${route.route}  ${detail}`);
    }
  }
  Log.succeed(`report at ${written.html}`);

  if (options.open) {
    await execFilePromise('open', [written.html]);
  }
  if (options.json) {
    Log.json({ ...report, report: written });
  }
  if (report.summary.changed > 0 && options.fail) {
    throw new RouteshotError(
      'DIFF_FOUND',
      `${report.summary.changed} route(s) changed above ${threshold}. Pass --no-fail to exit 0.`
    );
  }
}

/**
 * The server already holds both runs (CI uploaded them), so it diffs and judges; the CLI only
 * resolves refs, prints the summary, and turns changed routes into the exit code.
 */
async function compareRemoteAsync(
  projectRoot: string,
  baselineRef: string,
  candidateRef: string,
  threshold: number,
  options: CompareCommandOptions
): Promise<void> {
  const server = await resolveServerAsync(projectRoot);
  const serverOptions = { serverUrl: server.url, token: server.token };
  const [baselineId, candidateId] = await Promise.all([
    resolveRemoteRunIdAsync(serverOptions, baselineRef),
    resolveRemoteRunIdAsync(serverOptions, candidateRef),
  ]);
  const result = await requestVerdictsAsync({
    ...serverOptions,
    baselineId,
    candidateId,
    threshold,
  });

  const { summary } = result;
  Log.log(
    `${summary.changed} changed, ${summary.unchanged} unchanged, ${summary.added} added, ` +
      `${summary.removed} removed, ${summary.unverified} unverified`
  );
  for (const verdict of result.verdicts ?? []) {
    if (verdict.level !== 'green') {
      Log.log(`  ${verdict.level.padEnd(10)} ${verdict.route}  ${verdict.caption}`);
    }
  }
  Log.succeed(`report at ${result.url}`);

  if (options.open) {
    await execFilePromise('open', [result.url]);
  }
  if (options.json) {
    Log.json(result);
  }
  if (summary.changed > 0 && options.fail) {
    throw new RouteshotError(
      'DIFF_FOUND',
      `${summary.changed} route(s) changed above ${threshold}. Pass --no-fail to exit 0.`
    );
  }
}

function parseThreshold(raw: string): number {
  const threshold = Number(raw);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RouteshotError('COMPARE', `--threshold must be a ratio between 0 and 1, got ${raw}`);
  }
  return threshold;
}

/**
 * `compare` needs nothing from the Expo app config, and it routinely runs in CI against
 * downloaded run artifacts where there is no app to read. A missing config is a default, not
 * a failure; every other config error still throws.
 */
async function defaultThresholdAsync(projectRoot: string): Promise<number> {
  try {
    return (await loadRouteshotConfigAsync(projectRoot)).threshold;
  } catch (error) {
    if (isRouteshotError(error) && error.code === 'CONFIG') {
      return DEFAULT_THRESHOLD;
    }
    throw error;
  }
}

async function resolveRunDirAsync(projectRoot: string, ref: string): Promise<string> {
  const runsDir = join(projectRoot, '.routeshot', 'runs');

  if (ref === 'latest' || ref === 'previous') {
    const dirs = await runDirsByRecencyAsync(runsDir);
    const dir = dirs[ref === 'latest' ? 0 : 1];
    if (dir === undefined) {
      throw new RouteshotError('COMPARE', `No "${ref}" run in ${runsDir}`);
    }
    return dir;
  }

  const asPath = isAbsolute(ref) ? ref : resolve(projectRoot, ref);
  if (await isRunDirAsync(asPath)) {
    return asPath;
  }
  const asId = join(runsDir, ref);
  if (await isRunDirAsync(asId)) {
    return asId;
  }
  // `--label before` is how a run gets named by hand, so the label has to work as a ref. Labels
  // repeat (CI labels every run with the branch), and the newest one is the run people mean.
  for (const dir of await runDirsByRecencyAsync(runsDir)) {
    if ((await readRunLabelAsync(dir)) === ref) {
      return dir;
    }
  }
  throw new RouteshotError(
    'COMPARE',
    `No run "${ref}": not a run directory, and not an id or label in ${runsDir}`
  );
}

async function readRunLabelAsync(dir: string): Promise<string | undefined> {
  try {
    return (JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as CaptureRun).label;
  } catch {
    return undefined;
  }
}

async function runDirsByRecencyAsync(runsDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(runsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No runs directory yet: the caller's "no latest run" message is the useful one.
    return [];
  }

  const dirs = await Promise.all(
    names.map(async (name) => {
      const dir = join(runsDir, name);
      // Run ids sort chronologically, but a re-downloaded CI artifact does not, so use mtime.
      return { dir, mtimeMs: (await stat(dir)).mtimeMs, ok: await isRunDirAsync(dir) };
    })
  );
  return dirs
    .filter((entry) => entry.ok)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.dir);
}

async function isRunDirAsync(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, 'index.json'))).isFile();
  } catch {
    return false;
  }
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (isRouteshotError(error)) {
    Log.error(error.message);
  } else {
    Log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  process.exitCode = 1;
}
