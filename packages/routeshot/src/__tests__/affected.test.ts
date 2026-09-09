import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  affectedRoutes,
  buildCodeContextAsync,
  changedFilesSinceAsync,
  collectRouteSourcesAsync,
} from '../affected.js';
import { RouteshotError } from '../errors.js';
import type { Route } from '../types.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** An expo-router shaped project: tabs, a nested stack, `@/` aliases, a platform split, an asset. */
async function makeProjectAsync(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routeshot-affected-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': '{ "name": "demo", "version": "1.0.0" }\n',
    'tsconfig.json': `{
  // comments and trailing commas are legal here
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "paths": { "@/*": ["./*"], }, },
}
`,
    'tsconfig.base.json': '{ "compilerOptions": { "strict": true } }\n',
    'app/_layout.tsx':
      "import { Stack } from 'expo-router';\nimport '../lib/polyfills';\nexport default function L() { return <Stack />; }\n",
    'app/(tabs)/_layout.tsx':
      "import { Tabs } from 'expo-router';\nimport { colors } from '@/lib/theme';\nexport default function T() { return <Tabs />; }\n",
    'app/(tabs)/index.tsx':
      "import { Hero } from '@/components/Hero';\nexport default function Home() { return <Hero />; }\n",
    'app/(tabs)/settings/_layout.tsx':
      "import { Stack } from 'expo-router';\nexport default function S() { return <Stack />; }\n",
    'app/(tabs)/settings/billing.tsx':
      "import { Button } from '../../../components/Button';\nexport default function B() { return <Button />; }\n",
    'app/about.tsx': 'export default function About() { return null; }\n',
    'components/Hero.tsx':
      "import { Button } from './Button';\nimport logo from '../assets/logo.png';\nexport const Hero = () => <Button />;\n",
    'components/Button.tsx':
      "import { colors } from '@/lib/theme';\nexport const Button = () => null;\n",
    'components/Button.ios.tsx': 'export const Button = () => null; // ios override\n',
    'lib/theme.ts': "export const colors = { accent: 'blue' };\n",
    'lib/polyfills.ts': '// nothing\n',
    'assets/logo.png': 'not really a png',
    'README.md': '# demo\n',
  };
  for (const [name, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), contents);
  }
  return root;
}

const route = (template: string, sourceFile: string): Route => ({
  pathname: template,
  template,
  dynamic: false,
  params: undefined,
  sourceFile,
});

const ROUTES = [
  route('/', '(tabs)/index.tsx'),
  route('/settings/billing', '(tabs)/settings/billing.tsx'),
  route('/about', 'about.tsx'),
];

async function gitAsync(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
  return stdout;
}

describe('collectRouteSourcesAsync', () => {
  it('walks the route file, its layouts root to leaf, and transitive imports through aliases', async () => {
    const root = await makeProjectAsync();
    const appDir = path.join(root, 'app');

    const [home, billing, about] = await collectRouteSourcesAsync(ROUTES, {
      projectRoot: root,
      appDir,
    });
    const rel = (files: string[]) => files.map((file) => path.relative(root, file));

    expect(rel(home?.files ?? [])).toEqual([
      'app/(tabs)/index.tsx',
      'app/_layout.tsx',
      'app/(tabs)/_layout.tsx',
      'components/Hero.tsx',
      'lib/polyfills.ts',
      'lib/theme.ts',
      'components/Button.ios.tsx',
      'components/Button.tsx',
      'assets/logo.png',
    ]);
    expect(rel(billing?.files ?? [])).toContain('app/(tabs)/settings/_layout.tsx');
    expect(rel(billing?.files ?? [])).toContain('components/Button.tsx');
    expect(rel(billing?.files ?? [])).not.toContain('components/Hero.tsx');
    expect(rel(about?.files ?? [])).toEqual([
      'app/about.tsx',
      'app/_layout.tsx',
      'lib/polyfills.ts',
    ]);
    expect(home?.truncated).toBe(false);
  });

  it('ignores bare package imports and files outside the project', async () => {
    const root = await makeProjectAsync();
    await fs.writeFile(
      path.join(root, 'app/about.tsx'),
      "import x from 'react-native';\nimport y from '../../outside';\nexport default () => null;\n"
    );

    const [, , about] = await collectRouteSourcesAsync(ROUTES, {
      projectRoot: root,
      appDir: path.join(root, 'app'),
    });

    expect(about?.files.map((file) => path.relative(root, file))).toEqual([
      'app/about.tsx',
      'app/_layout.tsx',
      'lib/polyfills.ts',
    ]);
  });
});

describe('affectedRoutes', () => {
  it('maps a changed shared component to every route that imports it, with the reason', async () => {
    const root = await makeProjectAsync();
    const sources = await collectRouteSourcesAsync(ROUTES, {
      projectRoot: root,
      appDir: path.join(root, 'app'),
    });

    const result = affectedRoutes(sources, [path.join(root, 'components/Button.tsx')], root);

    expect(result.all).toBeUndefined();
    expect(result.routes).toEqual([
      { route: '/', because: ['components/Button.tsx'] },
      { route: '/settings/billing', because: ['components/Button.tsx'] },
    ]);
    expect(result.ignored).toEqual([]);
  });

  it('treats a layout change as affecting everything under it, and unrelated files as ignored', async () => {
    const root = await makeProjectAsync();
    const sources = await collectRouteSourcesAsync(ROUTES, {
      projectRoot: root,
      appDir: path.join(root, 'app'),
    });

    const result = affectedRoutes(
      sources,
      [path.join(root, 'app/(tabs)/_layout.tsx'), path.join(root, 'README.md')],
      root
    );

    expect(result.routes.map((item) => item.route)).toEqual(['/', '/settings/billing']);
    expect(result.ignored).toEqual(['README.md']);
  });

  it('selects every route when a global file such as app.json changed', async () => {
    const root = await makeProjectAsync();
    const sources = await collectRouteSourcesAsync(ROUTES, {
      projectRoot: root,
      appDir: path.join(root, 'app'),
    });

    const result = affectedRoutes(sources, [path.join(root, 'app.json')], root);

    expect(result.all).toBe('app.json');
    expect(result.routes.map((item) => item.route)).toEqual(['/', '/settings/billing', '/about']);
  });
});

describe('changedFilesSinceAsync', () => {
  it('returns committed, unstaged and untracked changes against the merge base', async () => {
    const root = await makeProjectAsync();
    await gitAsync(root, 'init', '-q', '-b', 'main');
    await gitAsync(root, 'add', '.');
    await gitAsync(root, 'commit', '-q', '-m', 'base');
    await gitAsync(root, 'checkout', '-q', '-b', 'feature');
    await fs.appendFile(path.join(root, 'components/Button.tsx'), '// committed change\n');
    await gitAsync(root, 'commit', '-q', '-am', 'change button');
    await fs.appendFile(path.join(root, 'lib/theme.ts'), '// unstaged\n');
    await fs.writeFile(path.join(root, 'components/New.tsx'), 'export const New = 1;\n');
    // main moves on after the branch point; that commit must not count as "changed" on feature.
    await gitAsync(root, 'checkout', '-q', 'main');
    await fs.appendFile(path.join(root, 'app/about.tsx'), '// only on main\n');
    await gitAsync(root, 'add', 'app/about.tsx');
    await gitAsync(root, 'commit', '-q', '-m', 'main moves');
    await gitAsync(root, 'checkout', '-q', 'feature');

    const result = await changedFilesSinceAsync(root, 'main');

    expect(result.files.map((file) => path.relative(root, file))).toEqual([
      'components/Button.tsx',
      'components/New.tsx',
      'lib/theme.ts',
    ]);
  });

  it('throws a CONFIG error for a ref git does not know', async () => {
    const root = await makeProjectAsync();
    await gitAsync(root, 'init', '-q', '-b', 'main');
    await gitAsync(root, 'add', '.');
    await gitAsync(root, 'commit', '-q', '-m', 'base');

    await expect(changedFilesSinceAsync(root, 'nope')).rejects.toMatchObject({
      name: 'RouteshotError',
      code: 'CONFIG',
    } satisfies Partial<RouteshotError>);
  });
});

describe('buildCodeContextAsync', () => {
  it('concatenates source files under path headers, lists assets, and respects the budget', async () => {
    const root = await makeProjectAsync();
    const [home] = await collectRouteSourcesAsync(ROUTES, {
      projectRoot: root,
      appDir: path.join(root, 'app'),
    });

    const full = await buildCodeContextAsync(home as NonNullable<typeof home>, root);
    expect(full.text).toMatch(/^\/\/ app\/\(tabs\)\/index\.tsx\n/);
    expect(full.text).toContain('// components/Button.ios.tsx');
    expect(full.text).toContain('// Assets imported by these files: assets/logo.png');
    expect(full.files[0]).toBe('app/(tabs)/index.tsx');
    expect(full.omitted).toEqual([]);

    // Small files later in the order still fit; big ones that do not are listed, not dropped.
    const tight = await buildCodeContextAsync(home as NonNullable<typeof home>, root, 200);
    expect(tight.files[0]).toBe('app/(tabs)/index.tsx');
    expect(tight.files).not.toContain('components/Hero.tsx');
    expect(tight.omitted).toContain('components/Hero.tsx');
    expect(tight.text).toContain('// Omitted for length:');
  });
});
