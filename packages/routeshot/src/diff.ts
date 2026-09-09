import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import sharp from 'sharp';

import { routeSlug } from './capture.js';
import { RouteshotError } from './errors.js';
import type { CaptureEntry, CaptureRun, CompareReport, RouteDiff } from './types.js';

export interface DiffOptions {
  /** Fraction of differing pixels above which a route counts as changed. */
  threshold: number;
  /** Defaults to `<project>/.routeshot/compare/<baselineId>__<candidateId>`. */
  outDir?: string;
}

export async function diffRunsAsync(
  baselineDir: string,
  candidateDir: string,
  options: DiffOptions
): Promise<CompareReport> {
  const [baseline, candidate] = await Promise.all([
    readRunAsync(baselineDir),
    readRunAsync(candidateDir),
  ]);

  const outDir =
    options.outDir ??
    // `<project>/.routeshot/runs/<id>` -> `<project>/.routeshot/compare/<a>__<b>`
    join(resolve(candidateDir, '..', '..'), 'compare', `${baseline.id}__${candidate.id}`);
  await mkdir(outDir, { recursive: true });

  const baselineByRoute = new Map(baseline.routes.map((entry) => [entry.route, entry]));
  const candidateByRoute = new Map(candidate.routes.map((entry) => [entry.route, entry]));

  const routes: RouteDiff[] = [];
  for (const entry of candidate.routes) {
    routes.push(
      await diffRouteAsync({
        route: entry.route,
        before: baselineByRoute.get(entry.route),
        after: entry,
        baselineDir,
        candidateDir,
        outDir,
        threshold: options.threshold,
      })
    );
  }
  for (const entry of baseline.routes) {
    if (!candidateByRoute.has(entry.route)) {
      routes.push({
        route: entry.route,
        status: 'removed',
        diffRatio: undefined,
        diffPixels: undefined,
        files: {
          before: relativeFile(outDir, baselineDir, entry),
          after: undefined,
          diff: undefined,
        },
        reason: 'route is gone from the candidate run',
      });
    }
  }

  return {
    baseline: { id: baseline.id, label: baseline.label },
    candidate: { id: candidate.id, label: candidate.label },
    threshold: options.threshold,
    routes,
    summary: {
      total: routes.length,
      unchanged: routes.filter((route) => route.status === 'unchanged').length,
      changed: routes.filter((route) => route.status === 'changed').length,
      added: routes.filter((route) => route.status === 'added').length,
      removed: routes.filter((route) => route.status === 'removed').length,
      unverified: routes.filter((route) => route.status === 'unverified').length,
    },
    outDir,
    verdicts: undefined,
  };
}

async function diffRouteAsync(context: {
  route: string;
  before: CaptureEntry | undefined;
  after: CaptureEntry;
  baselineDir: string;
  candidateDir: string;
  outDir: string;
  threshold: number;
}): Promise<RouteDiff> {
  const { route, before, after, baselineDir, candidateDir, outDir, threshold } = context;
  const beforeFile = before ? relativeFile(outDir, baselineDir, before) : undefined;
  const afterFile = relativeFile(outDir, candidateDir, after);
  const files = { before: beforeFile, after: afterFile, diff: undefined };

  if (!before) {
    return {
      route,
      status: 'added',
      diffRatio: undefined,
      diffPixels: undefined,
      files,
      reason: 'route is new in the candidate run',
    };
  }
  if (before.status !== 'captured' || after.status !== 'captured') {
    const failed = before.status !== 'captured' ? before : after;
    const side = before.status !== 'captured' ? 'baseline' : 'candidate';
    return {
      route,
      status: 'unverified',
      diffRatio: undefined,
      diffPixels: undefined,
      files,
      reason: `${side} ${failed.status}: ${failed.reason ?? 'no screenshot'}`,
    };
  }

  const [beforePng, afterPng] = await Promise.all([
    readPngAsync(join(baselineDir, before.file ?? '')),
    readPngAsync(join(candidateDir, after.file ?? '')),
  ]);

  if (beforePng.width !== afterPng.width || beforePng.height !== afterPng.height) {
    return {
      route,
      status: 'unverified',
      diffRatio: undefined,
      diffPixels: undefined,
      files,
      // Two device sizes in one comparison is a setup bug, not a UI change; scaling one to fit
      // would turn every screen into a resample artifact and drown the real diff.
      reason: `size mismatch: ${beforePng.width}x${beforePng.height} vs ${afterPng.width}x${afterPng.height}`,
    };
  }

  const { width, height } = beforePng;
  const output = new PNG({ width, height });
  const diffPixels = pixelmatch(beforePng.data, afterPng.data, output.data, width, height, {
    // 0.1 is pixelmatch's own default: below it, simulator text rendering jitter reads as a diff.
    threshold: 0.1,
    includeAA: false,
  });
  const diffRatio = diffPixels / (width * height);

  if (diffPixels === 0) {
    return { route, status: 'unchanged', diffRatio, diffPixels, files, reason: undefined };
  }

  const slug = routeSlug(route);
  const diffBuffer = PNG.sync.write(output);
  await writeFile(join(outDir, `${slug}.diff.png`), diffBuffer);
  await writeTriptychAsync({
    outFile: join(outDir, `${slug}.triptych.png`),
    before: PNG.sync.write(beforePng),
    diff: diffBuffer,
    after: PNG.sync.write(afterPng),
    width,
    height,
  });

  return {
    route,
    status: diffRatio > threshold ? 'changed' : 'unchanged',
    diffRatio,
    diffPixels,
    files: { before: beforeFile, after: afterFile, diff: `${slug}.diff.png` },
    reason: undefined,
  };
}

/** before | diff | after on one canvas, so a reviewer can read a screen without three clicks. */
async function writeTriptychAsync(context: {
  outFile: string;
  before: Buffer;
  diff: Buffer;
  after: Buffer;
  width: number;
  height: number;
}): Promise<void> {
  const gap = 24;
  await sharp({
    create: {
      width: context.width * 3 + gap * 2,
      height: context.height,
      channels: 4,
      background: { r: 10, g: 11, b: 14, alpha: 1 },
    },
  })
    .composite([
      { input: context.before, left: 0, top: 0 },
      { input: context.diff, left: context.width + gap, top: 0 },
      { input: context.after, left: (context.width + gap) * 2, top: 0 },
    ])
    .png()
    .toFile(context.outFile);
}

async function readRunAsync(dir: string): Promise<CaptureRun> {
  let run: CaptureRun;
  try {
    run = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as CaptureRun;
  } catch (error) {
    throw new RouteshotError('COMPARE', `Cannot read run at ${dir}`, { cause: error });
  }
  if (!Array.isArray(run.routes)) {
    throw new RouteshotError('COMPARE', `${join(dir, 'index.json')} has no routes array`);
  }
  return run;
}

async function readPngAsync(file: string): Promise<PNG> {
  try {
    return PNG.sync.read(await readFile(file));
  } catch (error) {
    throw new RouteshotError('COMPARE', `Cannot decode ${basename(file)}`, { cause: error });
  }
}

/** Report HTML lives in `outDir` and points back at the run dirs, so links stay relative. */
function relativeFile(outDir: string, runDir: string, entry: CaptureEntry): string | undefined {
  return entry.file === undefined ? undefined : relative(outDir, join(runDir, entry.file));
}
