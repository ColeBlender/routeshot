import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureAsync, routeSlug, type CaptureDeps } from '../capture.js';
import type { RouteshotConfig } from '../config.js';
import { FakeSimulator, makeFakePng } from '../testing/fake-simulator.js';
import type { CaptureRun, Route, SimulatorDevice } from '../types.js';

const projectRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    projectRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

const DEVICE: SimulatorDevice = {
  udid: 'FAKE-UDID-0001',
  name: 'iPhone 17 Pro',
  runtime: 'iOS 26.5',
  state: 'Shutdown',
};

const ROUTES: Route[] = [
  { pathname: '/', template: '/', dynamic: false, params: undefined, sourceFile: 'index.tsx' },
  {
    pathname: '/settings/billing',
    template: '/settings/billing',
    dynamic: false,
    params: undefined,
    sourceFile: 'settings/billing.tsx',
  },
  {
    pathname: '/users/42',
    template: '/users/[id]',
    dynamic: true,
    params: { id: '42' },
    sourceFile: 'users/[id].tsx',
  },
  {
    pathname: '/posts/[slug]',
    template: '/posts/[slug]',
    dynamic: true,
    params: undefined,
    sourceFile: 'posts/[slug].tsx',
  },
];

const CONFIG: RouteshotConfig = {
  scheme: 'demo',
  bundleId: 'com.example.demo',
  slug: 'demo',
  device: 'iPhone 17 Pro',
  appearance: 'dark',
  routes: { params: {}, ignore: [], waitFor: {} },
  // One screenshot per route keeps the assertions on `screenshotAsync` readable.
  settle: { intervalMs: 1, stableFrames: 1, timeoutMs: 500 },
  threshold: 0.01,
  devClient: undefined,
  server: undefined,
};

function makeDeps(routes: Route[] = ROUTES): CaptureDeps {
  return {
    discoverRoutesAsync: () => Promise.resolve(routes),
    pickDeviceAsync: () => Promise.resolve(DEVICE),
    now: () => new Date('2026-09-09T20:15:03.123Z'),
  };
}

async function makeProjectRootAsync(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'routeshot-capture-'));
  projectRoots.push(projectRoot);
  return projectRoot;
}

describe('routeSlug', () => {
  it('flattens a pathname into one filename and strips dynamic syntax', () => {
    expect(routeSlug('/')).toBe('index');
    expect(routeSlug('/settings/billing')).toBe('settings__billing');
    expect(routeSlug('/users/[id]')).toBe('users__id');
    expect(routeSlug('/docs/[...rest]')).toBe('docs__rest');
  });
});

describe('captureAsync', () => {
  it('deep links every route, writes a PNG each, and records the run', async () => {
    const projectRoot = await makeProjectRootAsync();
    const sim = new FakeSimulator({ devices: [DEVICE] });

    const { run, dir } = await captureAsync(
      { projectRoot, config: CONFIG, sim, label: 'my-label' },
      makeDeps()
    );

    expect(dir).toBe(path.join(projectRoot, '.routeshot', 'runs', run.id));
    expect(run.id).toMatch(/^2026-09-09T20-15-03Z-my-label/);
    expect(run.label).toBe('my-label');
    expect(run.device).toEqual(DEVICE);
    expect(run.app).toEqual({ bundleId: 'com.example.demo', scheme: 'demo' });
    expect(run.updateUrl).toBeUndefined();

    expect(run.routes.map((entry) => [entry.route, entry.status, entry.file])).toEqual([
      ['/', 'captured', 'index.png'],
      ['/settings/billing', 'captured', 'settings__billing.png'],
      // Keyed by the template, not by the URL that was opened.
      ['/users/[id]', 'captured', 'users__id.png'],
      ['/posts/[slug]', 'skipped', undefined],
    ]);

    expect(sim.callsTo('openUrlAsync').map((call) => call.args[1])).toEqual([
      'demo://',
      'demo://settings/billing',
      'demo://users/42',
    ]);

    expect((await fs.readdir(dir)).sort()).toEqual([
      'index.json',
      'index.png',
      'settings__billing.png',
      'users__id.png',
    ]);
    const onDisk = JSON.parse(
      await fs.readFile(path.join(dir, 'index.json'), 'utf8')
    ) as CaptureRun;
    expect(onDisk.routes).toEqual(run.routes.map((entry) => JSON.parse(JSON.stringify(entry))));
  });

  it('percent-encodes param values in the deep link', async () => {
    const sim = new FakeSimulator({ devices: [DEVICE] });
    const projectRoot = await makeProjectRootAsync();
    const routes: Route[] = [
      {
        pathname: '/users/first last?',
        template: '/users/[id]',
        dynamic: true,
        params: { id: 'first last?' },
        sourceFile: 'users/[id].tsx',
      },
    ];

    await captureAsync({ projectRoot, config: CONFIG, sim }, makeDeps(routes));

    expect(sim.callsTo('openUrlAsync').map((call) => call.args[1])).toEqual([
      'demo://users/first%20last%3F',
    ]);
  });

  it('boots the device and pins appearance and the status bar before the first route', async () => {
    const projectRoot = await makeProjectRootAsync();
    const sim = new FakeSimulator({ devices: [DEVICE] });

    await captureAsync({ projectRoot, config: CONFIG, sim, appearance: 'light' }, makeDeps());

    const order = sim.calls.map((call) => call.method);
    expect(order.slice(0, 3)).toEqual([
      'bootAsync',
      'overrideStatusBarAsync',
      'setAppearanceAsync',
    ]);
    // The explicit option beats config.appearance.
    expect(sim.callsTo('setAppearanceAsync')[0]?.args[1]).toBe('light');
  });

  it('prints the exact config snippet for a dynamic route with no params', async () => {
    const projectRoot = await makeProjectRootAsync();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const { run } = await captureAsync(
      { projectRoot, config: CONFIG, sim: new FakeSimulator({ devices: [DEVICE] }) },
      makeDeps()
    );

    const printed = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(printed).toContain("routes.params['/posts/[slug]'] = { slug: '...' }");
    expect(run.routes.at(-1)).toMatchObject({
      status: 'skipped',
      reason: 'dynamic route has no params fixture',
    });
  });

  it('uses the per-route waitFor as the settle timeout', async () => {
    const projectRoot = await makeProjectRootAsync();
    // Frames that never repeat, so the route can only end on the timeout. A counter, not
    // Math.random: two random bytes collide about one pair in 255 and the route "settles".
    const sim = new FakeSimulator({ devices: [DEVICE] });
    let frame = 0;
    sim.screenshotAsync = () => Promise.resolve(makeFakePng({ color: [frame++ % 255, 0, 0, 255] }));

    const config: RouteshotConfig = {
      ...CONFIG,
      settle: { intervalMs: 1, stableFrames: 2, timeoutMs: 5000 },
      routes: { params: {}, ignore: [], waitFor: { '/settings/billing': 20 } },
    };
    const routes = ROUTES.filter((route) => route.pathname === '/settings/billing');

    const started = Date.now();
    const { run } = await captureAsync({ projectRoot, config, sim }, makeDeps(routes));

    expect(Date.now() - started).toBeLessThan(2000);
    expect(run.routes[0]).toMatchObject({
      status: 'captured',
      settled: false,
      settledMs: undefined,
      reason: 'screen never stopped changing',
    });
  });

  it('records a failed route without aborting the rest of the run', async () => {
    const projectRoot = await makeProjectRootAsync();
    const sim = new FakeSimulator({ devices: [DEVICE] });
    sim.failNext('openUrlAsync', new Error('simctl: Unable to lookup in current state'));

    const { run } = await captureAsync({ projectRoot, config: CONFIG, sim }, makeDeps());

    expect(run.routes[0]).toMatchObject({
      route: '/',
      status: 'failed',
      reason: 'simctl: Unable to lookup in current state',
    });
    expect(run.routes[1]).toMatchObject({ route: '/settings/billing', status: 'captured' });
  });

  it('hands the update URL over as a deep link and relaunches so it takes effect', async () => {
    const projectRoot = await makeProjectRootAsync();
    const sim = new FakeSimulator({ devices: [DEVICE] });
    const updateUrl = 'https://u.expo.dev/proj-1/group/group-9';

    const { run } = await captureAsync(
      { projectRoot, config: CONFIG, sim, updateUrl },
      makeDeps([ROUTES[0] as Route])
    );

    expect(run.updateUrl).toBe(updateUrl);
    const lifecycle = sim.calls
      .filter((call) => ['terminateAsync', 'launchAsync', 'openUrlAsync'].includes(call.method))
      .map((call) => call.method);
    expect(lifecycle).toEqual([
      'terminateAsync',
      'launchAsync',
      'openUrlAsync',
      'terminateAsync',
      'launchAsync',
      'openUrlAsync',
    ]);

    expect(sim.callsTo('launchAsync')[0]?.args[2]).toEqual({
      args: ['--routeshot-update-url', updateUrl],
    });
    expect(sim.callsTo('openUrlAsync')[0]?.args[1]).toBe(
      `demo://routeshot/update?url=${encodeURIComponent(updateUrl)}`
    );
  }, 15000);
});
