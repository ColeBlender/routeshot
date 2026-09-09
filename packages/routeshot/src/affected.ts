import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { RouteshotError } from './errors.js';
import type { Route } from './types.js';

/** Named without the `Async` suffix because it is not an `async function`, only promise-returning. */
const execFilePromise = promisify(execFile);

/**
 * Which screens does a code change touch? A route is affected when the change lands in its route
 * file, any `_layout` above it, or anything those import, transitively, inside the project. Metro
 * would answer this exactly; this is the cheap static version: import specifiers read with a
 * regex, resolved the way Metro resolves them on iOS (relative paths, tsconfig `paths`, platform
 * extensions), never evaluated.
 */

/** Platform order Metro uses on iOS, so `Button.ios.tsx` shadows `Button.tsx`. All that exist count. */
const EXTENSIONS = ['.ios', '.native', ''].flatMap((platform) =>
  ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json'].map((ext) => `${platform}${ext}`)
);
const SOURCE_EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs']);

/** Per route, so one screen that imports the world cannot make every capture take a minute. */
const MAX_FILES_PER_ROUTE = 400;

/**
 * Changes to these touch every screen without being imported by any of them. Matched against the
 * path relative to the project root.
 */
const GLOBAL_FILES = [
  /^package\.json$/,
  /^(pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lock(b)?)$/,
  /^app\.(json|config\.(ts|js|mjs|cjs))$/,
  /^(babel|metro|tailwind)\.config\.(ts|js|mjs|cjs)$/,
  /^tsconfig(\..+)?\.json$/,
  /^global\.css$/,
];

// `import x from 'y'`, `import 'y'`, `export * from 'y'`, `export { a } from 'y'`, with `type` and
// line breaks in between. The character class stops at the first quote, so a specifier is never
// read out of a later statement.
const STATIC_IMPORT_RE = /\b(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const CALL_IMPORT_RE = /\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;

interface PathAlias {
  /** `@/` for a `@/*` pattern; `@env` for an exact one. */
  prefix: string;
  wildcard: boolean;
  /** Absolute directories (or files, when not a wildcard) the alias maps to, in order. */
  targets: string[];
}

export interface RouteSources {
  /** The route template, same key `CaptureEntry.route` uses. */
  route: string;
  /**
   * Absolute paths, most relevant first: the route file, its layouts root to leaf, then every
   * import breadth-first. Assets (images, fonts) are included; `node_modules` never is.
   */
  files: string[];
  /** True when the walk stopped at `MAX_FILES_PER_ROUTE`. */
  truncated: boolean;
}

export interface SourceGraphOptions {
  projectRoot: string;
  /** The expo-router app directory the routes' `sourceFile` values are relative to. */
  appDir: string;
}

/** Collects the source files behind each route. Parsed files are cached across routes. */
export async function collectRouteSourcesAsync(
  routes: Route[],
  options: SourceGraphOptions
): Promise<RouteSources[]> {
  const aliases = await readPathAliasesAsync(options.projectRoot);
  const importCache = new Map<string, Promise<string[]>>();
  const importsOf = (file: string): Promise<string[]> => {
    let cached = importCache.get(file);
    if (!cached) {
      cached = resolveImportsAsync(file, options.projectRoot, aliases);
      importCache.set(file, cached);
    }
    return cached;
  };

  const results: RouteSources[] = [];
  for (const route of routes) {
    const routeFile = resolve(options.appDir, route.sourceFile);
    const seeds = [routeFile, ...(await layoutsForAsync(routeFile, options.appDir))];
    const files: string[] = [];
    const seen = new Set<string>();
    const queue = [...seeds];
    let truncated = false;
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      if (files.length >= MAX_FILES_PER_ROUTE) {
        truncated = true;
        break;
      }
      files.push(file);
      if (SOURCE_EXTENSIONS.has(extname(file))) {
        queue.push(...(await importsOf(file)));
      }
    }
    results.push({ route: route.template ?? route.pathname, files, truncated });
  }
  return results;
}

/** `_layout.*` in every directory from the app root down to the route file's own directory. */
async function layoutsForAsync(routeFile: string, appDir: string): Promise<string[]> {
  const layouts: string[] = [];
  const segments = relative(appDir, dirname(routeFile)).split(sep).filter(Boolean);
  for (let depth = 0; depth <= segments.length; depth += 1) {
    const dir = join(appDir, ...segments.slice(0, depth));
    layouts.push(...(await existingFilesAsync(join(dir, '_layout'))));
  }
  return layouts;
}

async function resolveImportsAsync(
  file: string,
  projectRoot: string,
  aliases: PathAlias[]
): Promise<string[]> {
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch {
    // A file that vanished between discovery and the walk has no imports worth failing over.
    return [];
  }
  const specifiers = new Set<string>();
  for (const re of [STATIC_IMPORT_RE, CALL_IMPORT_RE]) {
    for (const match of source.matchAll(re)) {
      specifiers.add(match[1] as string);
    }
  }

  const resolved: string[] = [];
  for (const specifier of specifiers) {
    for (const base of candidateBases(specifier, dirname(file), aliases)) {
      if (!isInside(projectRoot, base) || base.split(sep).includes('node_modules')) {
        continue;
      }
      resolved.push(...(await existingFilesAsync(base)));
    }
  }
  return resolved;
}

/** Where a specifier could live before extensions are tried. Bare package names yield nothing. */
function candidateBases(specifier: string, fromDir: string, aliases: PathAlias[]): string[] {
  const clean = specifier.split('?')[0] as string;
  if (clean.startsWith('.')) {
    return [resolve(fromDir, clean)];
  }
  if (isAbsolute(clean)) {
    return [clean];
  }
  for (const alias of aliases) {
    if (alias.wildcard && clean.startsWith(alias.prefix)) {
      const rest = clean.slice(alias.prefix.length);
      return alias.targets.map((target) => join(target, rest));
    }
    if (!alias.wildcard && clean === alias.prefix) {
      return alias.targets;
    }
  }
  return [];
}

/**
 * The files a base path stands for: itself when it names an existing file, otherwise every
 * platform/extension variant and every `index` variant that exists. Directories are not files.
 */
async function existingFilesAsync(base: string): Promise<string[]> {
  const found: string[] = [];
  if (extname(base) !== '' && (await isFileAsync(base))) {
    found.push(base);
  }
  for (const ext of EXTENSIONS) {
    if (await isFileAsync(`${base}${ext}`)) {
      found.push(`${base}${ext}`);
    }
  }
  if (found.length === 0) {
    for (const ext of EXTENSIONS) {
      if (await isFileAsync(join(base, `index${ext}`))) {
        found.push(join(base, `index${ext}`));
      }
    }
  }
  return found;
}

async function isFileAsync(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * `compilerOptions.paths` from tsconfig.json, following `extends` (Expo apps extend
 * `expo/tsconfig.base`). Metro honours these through `@expo/metro-config`, so a change behind
 * `@/components/Button` has to be traced the same way.
 */
async function readPathAliasesAsync(projectRoot: string): Promise<PathAlias[]> {
  const chain = await tsconfigChainAsync(join(projectRoot, 'tsconfig.json'), projectRoot);
  // The nearest config wins, so walk from the base upward and let later entries override.
  let baseUrl: string | undefined;
  let paths: { dir: string; value: Record<string, string[]> } | undefined;
  for (const { dir, config } of chain.reverse()) {
    const options = config.compilerOptions ?? {};
    if (typeof options.baseUrl === 'string') {
      baseUrl = resolve(dir, options.baseUrl);
    }
    if (options.paths && typeof options.paths === 'object') {
      paths = { dir, value: options.paths as Record<string, string[]> };
    }
  }
  if (!paths) {
    return [];
  }
  const root = baseUrl ?? paths.dir;
  return (
    Object.entries(paths.value)
      .map(([pattern, targets]) => {
        const wildcard = pattern.endsWith('*');
        return {
          prefix: wildcard ? pattern.slice(0, -1) : pattern,
          wildcard,
          targets: (Array.isArray(targets) ? targets : []).map((target) =>
            resolve(root, wildcard ? target.replace(/\*$/, '') : target)
          ),
        };
      })
      // Longest prefix first so `@/components/*` beats `@/*`.
      .sort((a, b) => b.prefix.length - a.prefix.length)
  );
}

interface TsconfigLike {
  extends?: string | string[];
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
}

async function tsconfigChainAsync(
  file: string,
  projectRoot: string,
  depth = 0
): Promise<{ dir: string; config: TsconfigLike }[]> {
  if (depth > 10) {
    return [];
  }
  let config: TsconfigLike;
  try {
    config = parseJsonc(await readFile(file, 'utf8')) as TsconfigLike;
  } catch {
    // No tsconfig, or one TypeScript itself would reject: no aliases, not an error.
    return [];
  }
  const chain = [{ dir: dirname(file), config }];
  const parents = Array.isArray(config.extends)
    ? config.extends
    : config.extends
      ? [config.extends]
      : [];
  for (const parent of parents) {
    const resolved = resolveTsconfigExtends(parent, dirname(file), projectRoot);
    if (resolved) {
      chain.push(...(await tsconfigChainAsync(resolved, projectRoot, depth + 1)));
    }
  }
  return chain;
}

function resolveTsconfigExtends(
  specifier: string,
  fromDir: string,
  projectRoot: string
): string | undefined {
  if (specifier.startsWith('.') || isAbsolute(specifier)) {
    const base = resolve(fromDir, specifier);
    return base.endsWith('.json') ? base : `${base}.json`;
  }
  const require = createRequire(join(projectRoot, 'package.json'));
  for (const candidate of [specifier, `${specifier}.json`, `${specifier}/tsconfig.json`]) {
    try {
      return require.resolve(candidate);
    } catch {
      // Try the next spelling.
    }
  }
  return undefined;
}

/** tsconfig allows comments and trailing commas; JSON.parse does not. */
function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

export interface ChangedFiles {
  /** What `since` resolved to: the merge base with HEAD, so commits that landed on `since` later do not count. */
  base: string;
  /** Absolute paths inside the project root: committed, staged, unstaged, and untracked changes. */
  files: string[];
}

/** Everything that differs between the working tree and the merge base with `since`. */
export async function changedFilesSinceAsync(
  projectRoot: string,
  since: string
): Promise<ChangedFiles> {
  let toplevel: string;
  try {
    toplevel = (await gitAsync(projectRoot, ['rev-parse', '--show-toplevel'])).trim();
  } catch (error) {
    throw new RouteshotError('CONFIG', `--changed-since needs a git repository at ${projectRoot}`, {
      cause: error,
    });
  }
  let base: string;
  try {
    base = (await gitAsync(projectRoot, ['merge-base', since, 'HEAD'])).trim();
  } catch (error) {
    throw new RouteshotError('CONFIG', `--changed-since: git does not know the ref "${since}"`, {
      cause: error,
    });
  }
  const [diff, untracked] = await Promise.all([
    gitAsync(projectRoot, ['diff', '--name-only', base]),
    gitAsync(projectRoot, ['ls-files', '--others', '--exclude-standard']),
  ]);
  // `diff --name-only` is relative to the repository root, `ls-files` to the cwd. git reports the
  // root resolved through symlinks (/private/var on macOS), so compare on real paths and hand back
  // paths under the caller's own spelling of the project root.
  const realRoot = await realpath(projectRoot);
  const fromDiff = diff
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => join(projectRoot, relative(realRoot, join(toplevel, line))));
  const fromUntracked = untracked
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => resolve(projectRoot, line));
  const files = [...new Set([...fromDiff, ...fromUntracked])]
    .filter((file) => isInside(projectRoot, file))
    .sort();
  return { base, files };
}

async function gitAsync(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export interface AffectedRoute {
  route: string;
  /** Changed files, relative to the project root, that put this route on the list. */
  because: string[];
}

export interface AffectedRoutes {
  /** Routes to capture, in the original order. Every route when `all` is set. */
  routes: AffectedRoute[];
  /** Set when a change outside any import graph (app.json, package.json, ...) touches every screen. */
  all: string | undefined;
  /** Changed files, relative to the project root, that no route imports and no global rule matches. */
  ignored: string[];
}

/** Intersects the changed files with each route's import graph. */
export function affectedRoutes(
  sources: RouteSources[],
  changed: string[],
  projectRoot: string
): AffectedRoutes {
  const changedSet = new Set(changed);
  const relativeOf = (file: string): string => relative(projectRoot, file);
  const global = changed.find((file) => GLOBAL_FILES.some((re) => re.test(relativeOf(file))));
  if (global) {
    return {
      routes: sources.map((source) => ({ route: source.route, because: [relativeOf(global)] })),
      all: relativeOf(global),
      ignored: [],
    };
  }

  const claimed = new Set<string>();
  const routes: AffectedRoute[] = [];
  for (const source of sources) {
    const because = source.files.filter((file) => changedSet.has(file));
    if (because.length > 0) {
      because.forEach((file) => claimed.add(file));
      routes.push({ route: source.route, because: because.map(relativeOf) });
    }
  }
  return {
    routes,
    all: undefined,
    ignored: changed.filter((file) => !claimed.has(file)).map(relativeOf),
  };
}

export interface CodeContext {
  /** The source, one file after another, each under a `// <relative path>` header. */
  text: string;
  /** Files included, relative to the project root, in the order they appear. */
  files: string[];
  /** Files that did not fit under the byte budget, relative to the project root. */
  omitted: string[];
}

/** Default budget for one screen's code. Roughly 15k tokens; the screenshot is the other half. */
export const CODE_CONTEXT_MAX_BYTES = 60_000;

/**
 * The code the judge reads next to a screenshot. Source files in `RouteSources` order until the
 * budget runs out; assets are listed by name so the model knows an image was meant to be there.
 */
export async function buildCodeContextAsync(
  sources: RouteSources,
  projectRoot: string,
  maxBytes = CODE_CONTEXT_MAX_BYTES
): Promise<CodeContext> {
  const relativeOf = (file: string): string => relative(projectRoot, file);
  const chunks: string[] = [];
  const files: string[] = [];
  const omitted: string[] = [];
  const assets: string[] = [];
  let used = 0;
  for (const file of sources.files) {
    if (!SOURCE_EXTENSIONS.has(extname(file)) && extname(file) !== '.json') {
      assets.push(relativeOf(file));
      continue;
    }
    const contents = await readFile(file, 'utf8').catch(() => undefined);
    if (contents === undefined) {
      continue;
    }
    const chunk = `// ${relativeOf(file)}\n${contents.trimEnd()}\n`;
    if (used + chunk.length > maxBytes) {
      omitted.push(relativeOf(file));
      continue;
    }
    used += chunk.length;
    chunks.push(chunk);
    files.push(relativeOf(file));
  }
  if (assets.length > 0) {
    chunks.push(`// Assets imported by these files: ${assets.join(', ')}\n`);
  }
  if (omitted.length > 0) {
    chunks.push(`// Omitted for length: ${omitted.join(', ')}\n`);
  }
  return { text: chunks.join('\n'), files, omitted };
}
