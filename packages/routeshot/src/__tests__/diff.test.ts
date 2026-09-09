import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';

import { diffRunsAsync } from '../diff.js';
import { RouteshotError } from '../errors.js';
import type { CaptureEntry, CaptureRun } from '../types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A real PNG whose first `differentPixels` pixels are white and the rest black. */
function png(width: number, height: number, differentPixels = 0): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < width * height; index++) {
    const value = index < differentPixels ? 255 : 0;
    image.data.set([value, value, value, 255], index * 4);
  }
  return PNG.sync.write(image);
}

function entry(route: string, overrides: Partial<CaptureEntry> = {}): CaptureEntry {
  return {
    route,
    file: `${route.replace(/^\//, '').replace(/\//g, '__') || 'index'}.png`,
    code: undefined,
    status: 'captured',
    reason: undefined,
    settledMs: 120,
    settled: true,
    ...overrides,
  };
}

async function makeRunAsync(
  root: string,
  id: string,
  entries: CaptureEntry[],
  images: Record<string, Buffer>
): Promise<string> {
  const dir = path.join(root, '.routeshot', 'runs', id);
  await fs.mkdir(dir, { recursive: true });
  const run: CaptureRun = {
    id,
    label: id,
    createdAt: '2026-09-09T20:15:03Z',
    device: { udid: 'U', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', state: 'Booted' },
    app: { bundleId: 'com.example.demo', scheme: 'demo' },
    updateUrl: undefined,
    git: { sha: undefined, branch: undefined },
    affected: undefined,
    routes: entries,
  };
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(run, null, 2));
  for (const [name, bytes] of Object.entries(images)) {
    await fs.writeFile(path.join(dir, name), bytes);
  }
  return dir;
}

async function makeRootAsync(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routeshot-diff-'));
  roots.push(root);
  return root;
}

describe('diffRunsAsync', () => {
  it('classifies every pairing and writes diff art only where pixels moved', async () => {
    const root = await makeRootAsync();
    const solid = png(10, 10);

    const baselineDir = await makeRunAsync(
      root,
      'base',
      [
        entry('/'),
        entry('/settings'),
        entry('/tiny'),
        entry('/gone'),
        entry('/broken', { status: 'failed', file: undefined, reason: 'simctl blew up' }),
      ],
      {
        'index.png': solid,
        'settings.png': solid,
        'tiny.png': solid,
        'gone.png': solid,
      }
    );
    const candidateDir = await makeRunAsync(
      root,
      'cand',
      [
        entry('/'),
        // 40 of 100 pixels differ: far above the 1% threshold.
        entry('/settings'),
        // 1 of 100 pixels differs: exactly at the threshold, so not "changed".
        entry('/tiny'),
        entry('/new'),
        entry('/broken'),
      ],
      {
        'index.png': solid,
        'settings.png': png(10, 10, 40),
        'tiny.png': png(10, 10, 1),
        'new.png': solid,
        'broken.png': solid,
      }
    );

    const report = await diffRunsAsync(baselineDir, candidateDir, { threshold: 0.01 });

    expect(report.baseline).toEqual({ id: 'base', label: 'base' });
    expect(report.candidate).toEqual({ id: 'cand', label: 'cand' });
    expect(Object.fromEntries(report.routes.map((route) => [route.route, route.status]))).toEqual({
      '/': 'unchanged',
      '/settings': 'changed',
      '/tiny': 'unchanged',
      '/new': 'added',
      '/gone': 'removed',
      '/broken': 'unverified',
    });
    expect(report.summary).toEqual({
      total: 6,
      unchanged: 2,
      changed: 1,
      added: 1,
      removed: 1,
      unverified: 1,
    });

    const settings = report.routes.find((route) => route.route === '/settings');
    expect(settings?.diffPixels).toBe(40);
    expect(settings?.diffRatio).toBeCloseTo(0.4);
    expect(settings?.files.diff).toBe('settings.diff.png');

    const identical = report.routes.find((route) => route.route === '/');
    expect(identical?.diffPixels).toBe(0);
    // Nothing moved, so there is nothing to draw.
    expect(identical?.files.diff).toBeUndefined();

    const broken = report.routes.find((route) => route.route === '/broken');
    expect(broken?.reason).toBe('baseline failed: simctl blew up');

    const outDir = report.outDir as string;
    expect(outDir).toBe(path.join(root, '.routeshot', 'compare', 'base__cand'));
    const written = (await fs.readdir(outDir)).sort();
    expect(written).toEqual([
      'settings.diff.png',
      'settings.triptych.png',
      'tiny.diff.png',
      'tiny.triptych.png',
    ]);

    // The triptych is before | diff | after with a 24px gap between panes.
    const triptych = PNG.sync.read(await fs.readFile(path.join(outDir, 'settings.triptych.png')));
    expect([triptych.width, triptych.height]).toEqual([10 * 3 + 24 * 2, 10]);
  });

  it('reports a size mismatch as unverified rather than scaling one side', async () => {
    const root = await makeRootAsync();
    const baselineDir = await makeRunAsync(root, 'base', [entry('/')], {
      'index.png': png(10, 20),
    });
    const candidateDir = await makeRunAsync(root, 'cand', [entry('/')], {
      'index.png': png(10, 21),
    });

    const report = await diffRunsAsync(baselineDir, candidateDir, { threshold: 0.01 });

    expect(report.routes[0]).toMatchObject({
      status: 'unverified',
      diffRatio: undefined,
      reason: 'size mismatch: 10x20 vs 10x21',
    });
  });

  it('points the report at the screenshots with paths relative to the output dir', async () => {
    const root = await makeRootAsync();
    const baselineDir = await makeRunAsync(root, 'base', [entry('/')], { 'index.png': png(4, 4) });
    const candidateDir = await makeRunAsync(root, 'cand', [entry('/')], {
      'index.png': png(4, 4, 8),
    });

    const report = await diffRunsAsync(baselineDir, candidateDir, { threshold: 0.01 });

    expect(report.routes[0]?.files).toEqual({
      before: path.join('..', '..', 'runs', 'base', 'index.png'),
      after: path.join('..', '..', 'runs', 'cand', 'index.png'),
      diff: 'index.diff.png',
    });
  });

  it('honours an explicit output directory', async () => {
    const root = await makeRootAsync();
    const outDir = path.join(root, 'elsewhere');
    const baselineDir = await makeRunAsync(root, 'base', [entry('/')], { 'index.png': png(4, 4) });
    const candidateDir = await makeRunAsync(root, 'cand', [entry('/')], { 'index.png': png(4, 4) });

    const report = await diffRunsAsync(baselineDir, candidateDir, { threshold: 0.01, outDir });

    expect(report.outDir).toBe(outDir);
    await expect(fs.stat(outDir)).resolves.toBeTruthy();
  });

  it('throws COMPARE when a run directory has no index.json', async () => {
    const root = await makeRootAsync();
    const candidateDir = await makeRunAsync(root, 'cand', [entry('/')], { 'index.png': png(4, 4) });

    const error = await diffRunsAsync(path.join(root, 'nope'), candidateDir, {
      threshold: 0.01,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RouteshotError);
    expect((error as RouteshotError).code).toBe('COMPARE');
  });
});
