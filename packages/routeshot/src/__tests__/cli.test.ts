import { execa } from 'execa';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { CaptureEntry, CaptureRun, CompareReport } from '../types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(packageRoot, 'dist', 'cli.js');
const roots: string[] = [];

beforeAll(async () => {
  // These are contract tests against the published entry point, so they need the real bundle.
  if (!existsSync(cli)) {
    await execa('pnpm', ['--filter', 'routeshot', 'build'], {
      cwd: path.resolve(packageRoot, '..', '..'),
    });
  }
}, 180_000);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function png(width: number, height: number, differentPixels = 0): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < width * height; index++) {
    const value = index < differentPixels ? 255 : 0;
    image.data.set([value, value, value, 255], index * 4);
  }
  return PNG.sync.write(image);
}

async function makeRunAsync(root: string, id: string, differentPixels: number): Promise<void> {
  const dir = path.join(root, '.routeshot', 'runs', id);
  await fs.mkdir(dir, { recursive: true });
  const entry: CaptureEntry = {
    route: '/settings',
    file: 'settings.png',
    status: 'captured',
    reason: undefined,
    settledMs: 120,
    settled: true,
  };
  const run: CaptureRun = {
    id,
    label: id,
    createdAt: '2026-09-09T20:15:03Z',
    device: { udid: 'U', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', state: 'Booted' },
    app: { bundleId: 'com.example.demo', scheme: 'demo' },
    updateUrl: undefined,
    git: { sha: undefined, branch: undefined },
    routes: [entry],
  };
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(run, null, 2));
  await fs.writeFile(path.join(dir, 'settings.png'), png(10, 10, differentPixels));
}

/** A project with two runs whose only route differs by 40% of its pixels. */
async function makeRootAsync(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routeshot-cli-'));
  roots.push(root);
  await makeRunAsync(root, 'base', 0);
  await makeRunAsync(root, 'cand', 40);
  return root;
}

function runCliAsync(cwd: string, args: string[]) {
  return execa(process.execPath, [cli, ...args], { cwd, reject: false });
}

describe('routeshot --help', () => {
  it('lists every command', async () => {
    const result = await runCliAsync(process.cwd(), ['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Screenshot every expo-router route');
    expect(result.stdout).toMatch(/capture \[options\]\s+Deep link every route/);
    expect(result.stdout).toMatch(/upload \[options\] <run>\s+Send a run that is already on disk/);
    expect(result.stdout).toMatch(/compare \[options\] <baseline> <candidate>\s+Diff two runs/);
  });

  it('documents every capture flag', async () => {
    const result = await runCliAsync(process.cwd(), ['capture', '--help']);

    expect(result.exitCode).toBe(0);
    for (const flag of [
      '--label',
      '--device',
      '--update-url',
      '--appearance',
      '--upload',
      '--json',
    ]) {
      expect(result.stdout).toContain(flag);
    }
    expect(result.stdout).toContain('"light", "dark"');
  });

  it('documents the compare arguments and flags', async () => {
    const result = await runCliAsync(process.cwd(), ['compare', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('run id, run directory, or "latest" / "previous"');
    for (const flag of ['--threshold', '--no-fail', '--open', '--json']) {
      expect(result.stdout).toContain(flag);
    }
  });
});

describe('routeshot upload', () => {
  it('documents the run argument and flags', async () => {
    const result = await runCliAsync(process.cwd(), ['upload', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('run id, run directory, or "latest" / "previous"');
    expect(result.stdout).toContain('--json');
  });

  it('exits 1 with a CONFIG error when no report server is configured', async () => {
    const root = await makeRootAsync();

    const result = await execa(process.execPath, [cli, 'upload', 'latest'], {
      cwd: root,
      reject: false,
      // The ambient environment may point at a real server; this asserts the unconfigured path.
      env: { ROUTESHOT_SERVER_URL: undefined, ROUTESHOT_SERVER_TOKEN: undefined },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ROUTESHOT_SERVER_URL');
  });

  it('exits 1 for a run reference that is not on disk, before any request', async () => {
    const root = await makeRootAsync();

    const result = await execa(process.execPath, [cli, 'upload', 'nope'], {
      cwd: root,
      reject: false,
      // A server it could never reach: resolving the ref has to fail first.
      env: { ROUTESHOT_SERVER_URL: 'http://127.0.0.1:9', ROUTESHOT_SERVER_TOKEN: 'token' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No run "nope"');
  });
});

describe('routeshot compare', () => {
  it('exits 1 on a diff above the threshold and puts only JSON on stdout', async () => {
    const root = await makeRootAsync();

    const result = await runCliAsync(root, ['compare', 'base', 'cand', '--json']);

    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as CompareReport & {
      report: { html: string; json: string };
    };
    expect(report.summary).toMatchObject({ total: 1, changed: 1, unchanged: 0 });
    expect(report.routes[0]?.diffRatio).toBeCloseTo(0.4);
    expect(result.stderr).toContain('1 route(s) changed');
    await expect(fs.stat(report.report.html)).resolves.toBeTruthy();
  });

  it('exits 0 with --no-fail', async () => {
    const root = await makeRootAsync();

    const result = await runCliAsync(root, ['compare', 'base', 'cand', '--no-fail', '--json']);

    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as CompareReport).summary.changed).toBe(1);
  });

  it('treats a diff below --threshold as unchanged', async () => {
    const root = await makeRootAsync();

    const result = await runCliAsync(root, [
      'compare',
      'base',
      'cand',
      '--threshold',
      '0.9',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as CompareReport).summary).toMatchObject({
      changed: 0,
      unchanged: 1,
    });
  });

  it('resolves latest and previous by recency', async () => {
    const root = await makeRootAsync();
    const older = new Date('2026-09-01T00:00:00Z');
    await fs.utimes(path.join(root, '.routeshot', 'runs', 'base'), older, older);

    const result = await runCliAsync(root, [
      'compare',
      'previous',
      'latest',
      '--no-fail',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as CompareReport;
    expect(report.baseline.id).toBe('base');
    expect(report.candidate.id).toBe('cand');
  });

  it('accepts run directories as well as ids', async () => {
    const root = await makeRootAsync();
    const runs = path.join(root, '.routeshot', 'runs');

    const result = await runCliAsync(root, [
      'compare',
      path.join(runs, 'base'),
      path.join(runs, 'cand'),
      '--no-fail',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as CompareReport).candidate.id).toBe('cand');
  });

  it('exits 1 with a message on stderr and nothing on stdout for an unknown run', async () => {
    const root = await makeRootAsync();

    const result = await runCliAsync(root, ['compare', 'base', 'nope', '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('No run "nope"');
  });

  it('rejects a threshold outside 0..1', async () => {
    const root = await makeRootAsync();

    const result = await runCliAsync(root, ['compare', 'base', 'cand', '--threshold', '7']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--threshold must be a ratio between 0 and 1');
  });
});

describe('routeshot capture', () => {
  it('fails with a CONFIG error when there is no scheme to deep link with', async () => {
    const root = await makeRootAsync();

    const result = await runCliAsync(root, ['capture', '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('No URL scheme');
  });
});
