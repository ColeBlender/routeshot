import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import {
  affectedRoutes,
  buildCodeContextAsync,
  changedFilesSinceAsync,
  collectRouteSourcesAsync,
  type RouteSources,
} from './affected.js';
import type { RouteshotConfig } from './config.js';
import { RouteshotError } from './errors.js';
import { Log } from './log.js';
import { discoverRoutesAsync, resolveAppDirAsync } from './routes.js';
import { waitForSettledFrameAsync } from './settle.js';
import { pickDeviceAsync } from './simulator.js';
import type { CaptureEntry, CaptureRun, Route, Simulator } from './types.js';

/** Named without the `Async` suffix because it is not an `async function`, only promise-returning. */
const execFilePromise = promisify(execFile);

/** A dev client pulling a bundle over the network can take a while on a cold Metro cache. */
const DEV_CLIENT_BOOT_TIMEOUT_MS = 60_000;

export interface CaptureOptions {
  projectRoot: string;
  config: RouteshotConfig;
  sim: Simulator;
  label?: string;
  /** EAS update group manifest URL to point the runner build at before capturing. */
  updateUrl?: string;
  /** Overrides `config.appearance` for this run. */
  appearance?: 'light' | 'dark';
  /**
   * A git ref. Only routes whose source (route file, layouts, imports) changed against the merge
   * base with it are captured; everything else is left out of the run entirely.
   */
  changedSince?: string;
}

/** Seams for tests. Production passes nothing and gets the real route/device/git lookups. */
export interface CaptureDeps {
  discoverRoutesAsync?: typeof discoverRoutesAsync;
  pickDeviceAsync?: typeof pickDeviceAsync;
  collectRouteSourcesAsync?: (projectRoot: string, routes: Route[]) => Promise<RouteSources[]>;
  changedFilesSinceAsync?: typeof changedFilesSinceAsync;
  now?: () => Date;
}

/**
 * Source files behind each route. Not fatal when they cannot be found: the screenshot still
 * gets taken, the judge just reads it without code.
 */
async function defaultCollectRouteSourcesAsync(
  projectRoot: string,
  routes: Route[]
): Promise<RouteSources[]> {
  try {
    const appDir = await resolveAppDirAsync(projectRoot);
    return await collectRouteSourcesAsync(routes, { projectRoot, appDir });
  } catch (error) {
    Log.warn(
      `could not read route sources, the judge will see screenshots only: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

/**
 * File name for a route. Built from the route *template*, not from the filled-in URL, so a run
 * stays comparable with an older one after somebody edits a param fixture.
 */
export function routeSlug(pathname: string): string {
  const slug = pathname
    .replace(/^\//, '')
    .replace(/\//g, '__')
    .replace(/\[\.\.\.?/g, '')
    .replace(/[[\]]/g, '');
  return slug === '' ? 'index' : slug;
}

export async function captureAsync(
  options: CaptureOptions,
  deps: CaptureDeps = {}
): Promise<{ run: CaptureRun; dir: string }> {
  const { projectRoot, config, sim } = options;
  const discover = deps.discoverRoutesAsync ?? discoverRoutesAsync;
  const pickDevice = deps.pickDeviceAsync ?? pickDeviceAsync;
  const createdAt = (deps.now ?? (() => new Date()))();
  const appearance = options.appearance ?? config.appearance;

  const allRoutes = await discover(projectRoot, {
    params: config.routes.params,
    ignore: config.routes.ignore,
  });
  const sources = await (deps.collectRouteSourcesAsync ?? defaultCollectRouteSourcesAsync)(
    projectRoot,
    allRoutes
  );
  const sourcesByRoute = new Map(sources.map((source) => [source.route, source]));

  let routes = allRoutes;
  let affected: CaptureRun['affected'];
  if (options.changedSince !== undefined) {
    const changed = await (deps.changedFilesSinceAsync ?? changedFilesSinceAsync)(
      projectRoot,
      options.changedSince
    );
    const selection = affectedRoutes(sources, changed.files, projectRoot);
    const selected = new Set(selection.routes.map((item) => item.route));
    routes = allRoutes.filter((route) => selected.has(route.template ?? route.pathname));
    affected = {
      since: options.changedSince,
      changedFiles: changed.files.map((file) => relative(projectRoot, file)),
      all: selection.all,
      because: Object.fromEntries(selection.routes.map((item) => [item.route, item.because])),
      ignored: selection.ignored,
    };
    const count = `${affected.changedFiles.length} files changed since ${options.changedSince}`;
    if (selection.all !== undefined) {
      Log.log(`${count}; ${selection.all} affects every screen`);
    } else {
      Log.log(`${count}; ${routes.length} of ${allRoutes.length} screens affected`);
      for (const item of selection.routes) {
        Log.gray(`  ${item.route}  ${item.because.join(', ')}`);
      }
      if (selection.ignored.length > 0) {
        Log.gray(`  not imported by any screen: ${selection.ignored.join(', ')}`);
      }
    }
  }

  const device = await pickDevice(sim, config.device);
  if (routes.length > 0) {
    await sim.bootAsync(device.udid);
    // Clock, carrier and battery are the three things that differ on every single screenshot.
    await sim.overrideStatusBarAsync(device.udid);
    await sim.setAppearanceAsync(device.udid, appearance);
    await sim.approveUrlSchemeAsync(device.udid, config.scheme, config.bundleId);

    if (config.devClient) {
      await bootDevClientAsync(sim, device.udid, config, options.updateUrl ?? config.devClient.url);
    } else if (options.updateUrl) {
      await applyUpdateOverrideAsync(sim, device.udid, config, options.updateUrl);
    }
  }

  const [sha, branch] = await Promise.all([
    gitAsync(projectRoot, ['rev-parse', '--short', 'HEAD']),
    gitAsync(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);

  const label = options.label ?? branch ?? 'local';
  const id = [
    // Colons are legal in HFS+ paths but break every shell one-liner that touches a run dir.
    createdAt
      .toISOString()
      .replace(/\.\d+Z$/, 'Z')
      .replace(/:/g, '-'),
    label,
    sha,
  ]
    .filter(Boolean)
    .join('-');

  const dir = join(projectRoot, '.routeshot', 'runs', id);
  await mkdir(dir, { recursive: true });

  const entries: CaptureEntry[] = [];
  for (const [index, route] of routes.entries()) {
    const counter = `[${index + 1}/${routes.length}]`;
    const entry = await captureRouteAsync({ counter, route, dir, config, sim, udid: device.udid });
    const source = sourcesByRoute.get(entry.route);
    if (entry.status === 'captured' && source !== undefined) {
      entry.code = `${routeSlug(entry.route)}.code.txt`;
      const context = await buildCodeContextAsync(source, projectRoot);
      await writeFile(join(dir, entry.code), context.text);
    }
    entries.push(entry);
  }

  const run: CaptureRun = {
    id,
    label,
    createdAt: createdAt.toISOString(),
    device,
    app: { bundleId: config.bundleId, scheme: config.scheme },
    updateUrl: options.updateUrl,
    git: { sha, branch },
    affected,
    routes: entries,
  };

  await writeFile(join(dir, 'index.json'), `${JSON.stringify(run, null, 2)}\n`);

  if (routes.length === 0 && affected !== undefined) {
    Log.succeed(`no screens affected, nothing to capture (empty run recorded in ${dir})`);
  } else {
    const captured = entries.filter((entry) => entry.status === 'captured').length;
    Log.succeed(`${captured}/${entries.length} routes captured into ${dir}`);
  }

  return { run, dir };
}

async function captureRouteAsync(context: {
  counter: string;
  route: Route;
  dir: string;
  config: RouteshotConfig;
  sim: Simulator;
  udid: string;
}): Promise<CaptureEntry> {
  const { counter, route, dir, config, sim, udid } = context;
  // `pathname` already has the fixtures substituted; `template` is the stable identity that
  // config keys off and that pairs a route with its counterpart in another run.
  const key = route.template ?? route.pathname;

  if (route.dynamic && !route.params) {
    const reason = 'dynamic route has no params fixture';
    Log.warn(`${counter} ${key}  skipped (${reason})`);
    Log.gray(`      routes.params['${key}'] = ${paramsSnippet(key)}`);
    return {
      route: key,
      file: undefined,
      code: undefined,
      status: 'skipped',
      reason,
      settledMs: undefined,
      settled: false,
    };
  }

  const file = `${routeSlug(key)}.png`;
  try {
    await sim.openUrlAsync(udid, `${config.scheme}://${deepLinkPath(route.pathname)}`);

    const waitFor = config.routes.waitFor[key];
    const frame = await waitForSettledFrameAsync(sim, udid, {
      ...config.settle,
      ...(waitFor === undefined ? {} : { timeoutMs: waitFor }),
    });

    await writeFile(join(dir, file), frame.png);
    Log.log(`${counter} ${key}  ${frame.settled ? 'settled' : 'NOT settled'} ${frame.elapsedMs}ms`);
    return {
      route: key,
      file,
      code: undefined,
      status: 'captured',
      reason: frame.settled ? undefined : 'screen never stopped changing',
      settledMs: frame.settled ? frame.elapsedMs : undefined,
      settled: frame.settled,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    Log.warn(`${counter} ${key}  failed (${reason})`);
    return {
      route: key,
      file: undefined,
      code: undefined,
      status: 'failed',
      reason,
      settledMs: undefined,
      settled: false,
    };
  }
}

/**
 * Hand a development build the URL it should load: Metro for the working tree, or an EAS update
 * manifest for a published update. This is the same launcher link the EAS dashboard's QR code
 * encodes, which is why a dev client can load a specific update with no anti-bricking override at
 * all. The launcher discards any other deep link it is opened with, so this has to happen before
 * the first route.
 */
async function bootDevClientAsync(
  sim: Simulator,
  udid: string,
  config: RouteshotConfig,
  bundleUrl: string
): Promise<void> {
  if (!config.slug) {
    throw new RouteshotError(
      'CONFIG',
      'A development build needs `expo.slug` in app.json: the dev client registers exp+<slug>://'
    );
  }
  Log.gray(`loading ${bundleUrl} in the development build`);
  await sim.configureDevMenuAsync(udid, config.bundleId);
  await sim.terminateAsync(udid, config.bundleId);
  await sim.openUrlAsync(
    udid,
    `exp+${config.slug}://expo-development-client/?url=${encodeURIComponent(bundleUrl)}`
  );
  const frame = await waitForSettledFrameAsync(sim, udid, {
    ...config.settle,
    timeoutMs: DEV_CLIENT_BOOT_TIMEOUT_MS,
  });
  if (!frame.settled) {
    throw new RouteshotError(
      'CAPTURE',
      `The development build did not finish loading ${bundleUrl} within ${DEV_CLIENT_BOOT_TIMEOUT_MS}ms. Is the dev server running?`
    );
  }
}

/**
 * Point a release runner build at one EAS update group.
 *
 * `Updates.setUpdateURLAndRequestHeadersOverride` only takes effect on the *next* launch, hence
 * the launch / hand off the URL / terminate / relaunch dance. The URL reaches JS as a deep link
 * (`<scheme>://routeshot/update?url=...`), not as a launch argument: `simctl launch --args` and
 * `SIMCTL_CHILD_*` both land in the native process where React Native exposes neither to JS
 * without a native module, while `Linking.getInitialURL()` is already there. The argument is still
 * passed so a future native shim can read it, but the deep link is the channel that works today.
 */
async function applyUpdateOverrideAsync(
  sim: Simulator,
  udid: string,
  config: RouteshotConfig,
  updateUrl: string
): Promise<void> {
  Log.gray(`pointing ${config.bundleId} at ${updateUrl}`);
  await sim.terminateAsync(udid, config.bundleId);
  await sim.launchAsync(udid, config.bundleId, { args: ['--routeshot-update-url', updateUrl] });
  await sim.openUrlAsync(
    udid,
    `${config.scheme}://routeshot/update?url=${encodeURIComponent(updateUrl)}`
  );
  // Long enough for the JS bundle to boot and the hook to run on a cold start.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 2000);
  });
  await sim.terminateAsync(udid, config.bundleId);
  await sim.launchAsync(udid, config.bundleId);
}

/** Param fixtures are plain strings; a space or `?` in one must not change the URL's shape. */
function deepLinkPath(pathname: string): string {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** The exact object to paste into `routeshot.config`, with every dynamic segment spelled out. */
function paramsSnippet(pathname: string): string {
  const keys = [...pathname.matchAll(/\[\.{0,3}([^\]]+)\]/g)].map((match) => match[1]);
  return `{ ${keys.map((key) => `${key}: '...'`).join(', ')} }`;
}

async function gitAsync(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFilePromise('git', args, { cwd });
    return stdout.trim() || undefined;
  } catch {
    // Not a repo, detached, or no git on PATH. The run id just loses its suffix.
    return undefined;
  }
}
