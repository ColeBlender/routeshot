import { getConfig } from '@expo/config';
import fs from 'node:fs';
import path from 'node:path';

import { RouteshotError } from './errors.js';
import type { Route } from './types.js';
import { getRoutes } from './vendor/get-routes-core.js';
import { matchDynamicName, stripInvisibleSegmentsFromPath } from './vendor/matchers.js';
import requireContext from './vendor/require-context-ponyfill.js';
import type { RouteNode } from './vendor/route-node.js';

export interface DiscoverRoutesOptions {
  /**
   * Fixtures for dynamic segments, keyed by the route template: `{ '/users/[id]': { id: '42' } }`.
   * A leading slash is optional. A `[...rest]` value may contain slashes.
   */
  params?: Record<string, Record<string, string>> | undefined;
  /**
   * Glob patterns matched against the route template AND the concrete pathname; a hit on either
   * drops the route. Supported syntax is deliberately small: `**` spans segments, `*` and `?` stay
   * inside one segment, everything else is literal, and the pattern must match the whole pathname.
   */
  ignore?: string[] | undefined;
}

/**
 * Route files whose last segment starts with `+` are expo-router internals, never navigable
 * screens. `_sitemap` is the generated debug screen. API routes are dropped by the parser itself
 * (`preserveApiRoutes: false`), but a `+api` contextKey is re-checked here as a belt-and-braces.
 */
const INTERNAL_LAST_SEGMENTS = new Set(['_sitemap']);

/**
 * Discover every navigable screen in an expo-router app, using expo-router's own parser over a
 * filesystem-backed `require.context`.
 */
export async function discoverRoutesAsync(
  projectRoot: string,
  options: DiscoverRoutesOptions = {}
): Promise<Route[]> {
  const appDir = await resolveAppDirAsync(projectRoot);
  const contextModule = requireContext(appDir);

  let tree: RouteNode | null;
  try {
    tree = getRoutes(contextModule, {
      // We never evaluate route modules, so entry points and the sitemap/not-found screens that the
      // parser generates for the runtime are noise here.
      ignoreEntryPoints: true,
      ignoreRequireErrors: true,
      internal_stripLoadRoute: true,
      skipGenerated: true,
      platform: 'ios',
      getSystemRoute: ({ route, type }) => ({
        type: type ?? 'route',
        loadRoute: () => ({}),
        route,
        contextKey: `./${route}.js`,
        children: [],
        dynamic: null,
        generated: true,
        internal: true,
      }),
    });
  } catch (error) {
    throw new RouteshotError(
      'ROUTES',
      `Could not parse the route tree in ${appDir}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  if (!tree) {
    throw new RouteshotError(
      'ROUTES',
      `No expo-router routes found in ${appDir}. Add at least one screen file, e.g. ${path.join(appDir, 'index.tsx')}.`
    );
  }

  const params = normalizeParamKeys(options.params);
  const ignore = options.ignore ?? [];
  const routes: Route[] = [];
  const seen = new Set<string>();

  for (const node of collectLeafNodes(tree, '')) {
    const template = `/${stripInvisibleSegmentsFromPath(node.fullRoute)}`.replace(/\/$/, '') || '/';

    // Array syntax (`(a,b)/home.tsx`) extrapolates to several nodes that collapse onto one
    // pathname once groups are stripped. The screen is the same one, so capture it once.
    if (seen.has(template)) {
      continue;
    }
    seen.add(template);

    const routeParams = params.get(template);
    const dynamic = template.split('/').some((segment) => matchDynamicName(segment) != null);
    const pathname = routeParams ? fillTemplate(template, routeParams) : template;

    if (
      ignore.some((pattern) => matchesGlob(template, pattern) || matchesGlob(pathname, pattern))
    ) {
      continue;
    }

    routes.push({
      pathname,
      template,
      dynamic,
      params: dynamic ? routeParams : undefined,
      sourceFile: node.node.contextKey.replace(/^\.\//, ''),
    });
  }

  routes.sort((a, b) => a.pathname.localeCompare(b.pathname));
  return routes;
}

/**
 * expo-router looks for `src/app` before `app`, and an explicit root can come either from the
 * config plugin's `root` option or from `extra.router.root` once the plugin has run.
 */
async function resolveAppDirAsync(projectRoot: string): Promise<string> {
  const configured = readConfiguredRouterRoot(projectRoot);
  if (configured) {
    const absolute = path.isAbsolute(configured)
      ? configured
      : path.resolve(projectRoot, configured);
    if (!isDirectory(absolute)) {
      throw new RouteshotError(
        'ROUTES',
        `The expo-router root is configured as "${configured}" but ${absolute} is not a directory.`
      );
    }
    return absolute;
  }

  for (const candidate of [path.join(projectRoot, 'src', 'app'), path.join(projectRoot, 'app')]) {
    if (isDirectory(candidate)) {
      return candidate;
    }
  }

  throw new RouteshotError(
    'ROUTES',
    `No expo-router app directory found under ${projectRoot}. Expected src/app or app, or an expo-router \`root\` in app.json.`
  );
}

function readConfiguredRouterRoot(projectRoot: string): string | undefined {
  // Running the config plugins is what materializes `extra.router.root` (this is the value
  // @expo/cli itself reads), but it needs node_modules; `skipPlugins` still surfaces an
  // `extra.router.root` written by hand, at the cost of dropping the raw `plugins` array.
  const exp =
    readExpoConfig(projectRoot, false)?.exp ?? readExpoConfig(projectRoot, true)?.exp ?? undefined;
  if (!exp) {
    // A project without an app config is still a valid target: fall through to directory sniffing.
    return undefined;
  }

  const fromExtra = (exp.extra as { router?: { root?: unknown } } | undefined)?.router?.root;
  if (typeof fromExtra === 'string') {
    return fromExtra;
  }

  for (const plugin of exp.plugins ?? []) {
    if (Array.isArray(plugin) && plugin[0] === 'expo-router') {
      const root = (plugin[1] as { root?: unknown } | undefined)?.root;
      if (typeof root === 'string') {
        return root;
      }
    }
  }
  return undefined;
}

function readExpoConfig(
  projectRoot: string,
  skipPlugins: boolean
): ReturnType<typeof getConfig> | undefined {
  try {
    return getConfig(projectRoot, { skipSDKVersionRequirement: true, skipPlugins });
  } catch {
    return undefined;
  }
}

function isDirectory(target: string): boolean {
  return fs.existsSync(target) && fs.statSync(target).isDirectory();
}

/** Depth-first walk that rebuilds each leaf's absolute route from the layout-relative segments. */
function* collectLeafNodes(
  node: RouteNode,
  prefix: string
): Generator<{ node: RouteNode; fullRoute: string }> {
  const fullRoute = [prefix, node.route].filter(Boolean).join('/');

  if (node.type === 'layout') {
    for (const child of node.children) {
      yield* collectLeafNodes(child, fullRoute);
    }
    return;
  }

  // Redirects and rewrites have no screen of their own, and API routes are not navigable.
  if (node.type !== 'route' || node.internal || /\+api\b/.test(node.contextKey)) {
    return;
  }

  const lastSegment = fullRoute.split('/').pop() ?? '';
  if (lastSegment.startsWith('+') || INTERNAL_LAST_SEGMENTS.has(lastSegment)) {
    return;
  }

  yield { node, fullRoute };
}

function normalizeParamKeys(
  params: Record<string, Record<string, string>> | undefined
): Map<string, Record<string, string>> {
  const normalized = new Map<string, Record<string, string>>();
  for (const [key, value] of Object.entries(params ?? {})) {
    normalized.set(key.startsWith('/') ? key : `/${key}`, value);
  }
  return normalized;
}

function fillTemplate(template: string, params: Record<string, string>): string {
  const filled = template
    .split('/')
    .map((segment) => {
      const match = matchDynamicName(segment);
      if (!match) {
        return segment;
      }
      const value = params[match.name];
      if (value == null) {
        throw new RouteshotError(
          'ROUTES',
          `Route "${template}" needs a value for the "${match.name}" segment. Add it to routes.params: { '${template}': { ${match.name}: '…' } }.`
        );
      }
      return value;
    })
    .join('/');
  return filled.replace(/\/$/, '') || '/';
}

function matchesGlob(pathname: string, pattern: string): boolean {
  const normalized = pattern.startsWith('/') ? pattern : `/${pattern}`;
  const source = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*|\*|\?/g, (token) => {
    if (token === '**') {
      return '.*';
    }
    return token === '*' ? '[^/]*' : '[^/]';
  });
  return new RegExp(`^${source}$`).test(pathname);
}
