import { getConfig } from '@expo/config';
import { loadConfig } from 'c12';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { RouteshotError } from './errors.js';

/**
 * `routeshot.config.{ts,js,mjs,json}`, loaded with c12 (so a TS config file needs no build step)
 * and validated with zod. Every knob has a default; the only two values that must exist are
 * `scheme` and `bundleId`, and both are read out of the Expo app config when omitted.
 */

/**
 * 0.1% of pixels. Measured on the example app (iPhone 17 Pro, iOS 26.5): identical reruns differ
 * by exactly 0 pixels, the smallest intentional change (a subtitle copy edit) moves 0.30%, and
 * the smallest deliberate defect moves 1.17%. The default sits well under the real changes and
 * leaves room for a runner that is not pixel-identical to the baseline machine.
 */
export const DEFAULT_THRESHOLD = 0.001;

/** Where `npx expo start` listens unless told otherwise. */
export const DEFAULT_DEV_SERVER_URL = 'http://localhost:8081';

const SettleSchema = z
  .object({
    /**
     * One screenshot per 300ms. Shorter than a simctl screenshot round trip (~150-250ms) would
     * just compare the same rendered frame twice and report "settled" while an animation runs.
     */
    intervalMs: z.number().int().positive().default(300),
    /** Two identical frames is the shortest streak that survives one spinner tick. */
    stableFrames: z.number().int().positive().default(2),
    /** Cold deep-link into a nested route lands well inside 5s; past that something is wrong. */
    timeoutMs: z.number().int().positive().default(5000),
  })
  .prefault({});

const RoutesSchema = z
  .object({
    /** Fixtures for dynamic segments, keyed by route template: `{ '/users/[id]': { id: '1' } }`. */
    params: z.record(z.string(), z.record(z.string(), z.string())).default({}),
    /** Route templates to leave out of the run entirely. */
    ignore: z.array(z.string()).default([]),
    /** Per-route settle timeout override in milliseconds, keyed by route template. */
    waitFor: z.record(z.string(), z.number().int().positive()).default({}),
  })
  .prefault({});

const ConfigSchema = z.object({
  /** URL scheme the app registers, without `://`. Defaults to `expo.scheme` from the app config. */
  scheme: z.string().min(1).optional(),
  /** Defaults to `expo.ios.bundleIdentifier` from the app config. */
  bundleId: z.string().min(1).optional(),
  /** Simulator name, e.g. `iPhone 17 Pro`. Unset means "whatever is booted, else the newest". */
  device: z.string().min(1).optional(),
  appearance: z.enum(['light', 'dark']).default('light'),
  routes: RoutesSchema,
  settle: SettleSchema,
  /** Fraction of differing pixels above which a route counts as changed. */
  threshold: z.number().min(0).max(1).default(DEFAULT_THRESHOLD),
  /**
   * `true` / `{ url }` when the installed app is an expo-dev-client build that loads its bundle
   * from Metro (or from an EAS update URL). Unset means "detect from package.json".
   */
  devClient: z.union([z.boolean(), z.object({ url: z.url() })]).optional(),
  server: z.object({ url: z.url(), token: z.string().min(1) }).optional(),
});

/** What a user writes in `routeshot.config.ts`. Everything is optional. */
export type RouteshotUserConfig = z.input<typeof ConfigSchema>;

/** What the rest of the CLI consumes: defaults applied, `scheme`/`bundleId` resolved. */
export interface RouteshotConfig {
  scheme: string;
  bundleId: string;
  /** Expo `slug`; the dev client registers `exp+<slug>://` for its launcher links. */
  slug: string | undefined;
  device: string | undefined;
  appearance: 'light' | 'dark';
  routes: {
    params: Record<string, Record<string, string>>;
    ignore: string[];
    waitFor: Record<string, number>;
  };
  settle: { intervalMs: number; stableFrames: number; timeoutMs: number };
  threshold: number;
  /** Set when the app under test is a development build; `url` is the dev server it boots from. */
  devClient: { url: string } | undefined;
  server: { url: string; token: string } | undefined;
}

/** Identity helper so `routeshot.config.ts` gets completions and type errors. */
export function defineConfig(config: RouteshotUserConfig): RouteshotUserConfig {
  return config;
}

export async function loadRouteshotConfigAsync(cwd: string): Promise<RouteshotConfig> {
  const loaded = await loadConfig<RouteshotUserConfig>({ name: 'routeshot', cwd });

  const parsed = ConfigSchema.safeParse(loaded.config ?? {});
  if (!parsed.success) {
    const where = loaded.configFile ?? 'routeshot config';
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new RouteshotError('CONFIG', `Invalid ${where}:\n${issues}`);
  }

  const expo = readExpoConfig(cwd);
  const scheme = parsed.data.scheme ?? expo.scheme;
  const bundleId = parsed.data.bundleId ?? expo.bundleId;

  if (!scheme) {
    throw new RouteshotError(
      'CONFIG',
      'No URL scheme. Set `scheme` in routeshot.config, or `expo.scheme` in app.json ' +
        '(routeshot deep links every route as `<scheme>://<path>`).'
    );
  }
  if (!bundleId) {
    throw new RouteshotError(
      'CONFIG',
      'No iOS bundle identifier. Set `bundleId` in routeshot.config, or ' +
        '`expo.ios.bundleIdentifier` in app.json.'
    );
  }

  return {
    scheme,
    bundleId,
    slug: expo.slug,
    device: parsed.data.device,
    appearance: parsed.data.appearance,
    routes: parsed.data.routes,
    settle: parsed.data.settle,
    threshold: parsed.data.threshold,
    devClient: await resolveDevClientAsync(cwd, parsed.data.devClient),
    server: resolveServer(parsed.data.server),
  };
}

/**
 * CI passes the server through the environment so the token never sits in a committed config.
 * Explicit config still wins for the URL; the token comes from wherever it was set.
 */
function resolveServer(
  configured: { url: string; token: string } | undefined
): { url: string; token: string } | undefined {
  const url = configured?.url ?? process.env['ROUTESHOT_SERVER_URL'];
  const token = configured?.token ?? process.env['ROUTESHOT_SERVER_TOKEN'];
  return url && token ? { url, token } : undefined;
}

/**
 * A development build boots into expo-dev-launcher's server list and drops any deep link it was
 * opened with, so routeshot has to hand it a bundle URL first. Detecting `expo-dev-client` in the
 * app's dependencies is what makes a plain `routeshot capture` work on a freshly `expo run:ios`'d
 * app with no config at all.
 */
async function resolveDevClientAsync(
  cwd: string,
  configured: boolean | { url: string } | undefined
): Promise<{ url: string } | undefined> {
  if (configured === false) {
    return undefined;
  }
  if (typeof configured === 'object') {
    return configured;
  }
  if (configured === true) {
    return { url: DEFAULT_DEV_SERVER_URL };
  }

  let dependencies: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    // No package.json is fine: the app may be prebuilt elsewhere. Assume a release build.
  }
  return 'expo-dev-client' in dependencies ? { url: DEFAULT_DEV_SERVER_URL } : undefined;
}

function readExpoConfig(cwd: string): {
  scheme: string | undefined;
  bundleId: string | undefined;
  slug: string | undefined;
} {
  let exp;
  try {
    // Plugins can execute arbitrary project code and need the SDK installed; neither is worth it
    // when all we want are two strings.
    exp = getConfig(cwd, { skipSDKVersionRequirement: true, skipPlugins: true }).exp;
  } catch {
    // No app.json / app.config.js at all. The caller's error message is the useful one.
    return { scheme: undefined, bundleId: undefined, slug: undefined };
  }

  // `scheme` is `string | string[]`; the first entry is the one Expo registers as primary.
  const scheme = Array.isArray(exp.scheme) ? exp.scheme[0] : exp.scheme;
  return { scheme: scheme ?? undefined, bundleId: exp.ios?.bundleIdentifier, slug: exp.slug };
}
