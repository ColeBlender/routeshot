import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RouteshotError } from '../errors.js';
import { discoverRoutesAsync } from '../routes.js';

const projectRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    projectRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** Writes a real app tree on disk: the ponyfill reads the actual filesystem, so memfs is no help. */
async function makeProjectAsync(files: string[], appDir = 'app'): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'routeshot-routes-'));
  projectRoots.push(projectRoot);
  for (const file of files) {
    const target = path.join(projectRoot, appDir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'export default function Screen() {}\n');
  }
  return projectRoot;
}

describe('discoverRoutesAsync', () => {
  it('flattens a tabs group into top-level pathnames', async () => {
    const projectRoot = await makeProjectAsync([
      '_layout.tsx',
      '(tabs)/_layout.tsx',
      '(tabs)/index.tsx',
      '(tabs)/settings.tsx',
    ]);

    const routes = await discoverRoutesAsync(projectRoot);

    expect(routes.map((route) => route.pathname)).toEqual(['/', '/settings']);
    expect(routes[0]).toMatchObject({
      pathname: '/',
      template: '/',
      dynamic: false,
      sourceFile: '(tabs)/index.tsx',
    });
  });

  it('keeps nested stack segments and drops the index suffix', async () => {
    const projectRoot = await makeProjectAsync([
      '_layout.tsx',
      'index.tsx',
      'posts/_layout.tsx',
      'posts/index.tsx',
      'posts/new.tsx',
      'posts/archive/index.tsx',
    ]);

    const routes = await discoverRoutesAsync(projectRoot);

    expect(routes.map((route) => route.pathname)).toEqual([
      '/',
      '/posts',
      '/posts/archive',
      '/posts/new',
    ]);
  });

  it('reports dynamic routes without params as their template', async () => {
    const projectRoot = await makeProjectAsync(['_layout.tsx', 'users/[id].tsx']);

    const [route] = await discoverRoutesAsync(projectRoot);

    expect(route).toMatchObject({
      pathname: '/users/[id]',
      template: '/users/[id]',
      dynamic: true,
      params: undefined,
    });
  });

  it('substitutes params into dynamic routes', async () => {
    const projectRoot = await makeProjectAsync([
      '_layout.tsx',
      'users/[id].tsx',
      'files/[...slug].tsx',
    ]);

    const routes = await discoverRoutesAsync(projectRoot, {
      params: { '/users/[id]': { id: '42' }, 'files/[...slug]': { slug: 'a/b' } },
    });

    expect(routes).toEqual([
      {
        pathname: '/files/a/b',
        template: '/files/[...slug]',
        dynamic: true,
        params: { slug: 'a/b' },
        sourceFile: 'files/[...slug].tsx',
      },
      {
        pathname: '/users/42',
        template: '/users/[id]',
        dynamic: true,
        params: { id: '42' },
        sourceFile: 'users/[id].tsx',
      },
    ]);
  });

  it('skips layouts, expo-router internals and API routes', async () => {
    const projectRoot = await makeProjectAsync([
      '_layout.tsx',
      'index.tsx',
      '+not-found.tsx',
      '+html.tsx',
      'hello+api.ts',
      'nested/_layout.tsx',
      'nested/+not-found.tsx',
      'nested/ok.tsx',
    ]);

    const routes = await discoverRoutesAsync(projectRoot);

    expect(routes.map((route) => route.pathname)).toEqual(['/', '/nested/ok']);
  });

  it('applies ignore globs to the template and the concrete pathname', async () => {
    const projectRoot = await makeProjectAsync([
      '_layout.tsx',
      'index.tsx',
      'settings.tsx',
      'admin/index.tsx',
      'admin/billing.tsx',
      'users/[id].tsx',
    ]);

    const routes = await discoverRoutesAsync(projectRoot, {
      params: { '/users/[id]': { id: '42' } },
      ignore: ['/admin/**', '/settings', '/users/42'],
    });

    expect(routes.map((route) => route.pathname)).toEqual(['/', '/admin']);
  });

  it('matches a single-segment star without crossing a slash', async () => {
    const projectRoot = await makeProjectAsync([
      '_layout.tsx',
      'a/one.tsx',
      'a/deep/two.tsx',
      'b/three.tsx',
    ]);

    const routes = await discoverRoutesAsync(projectRoot, { ignore: ['/a/*'] });

    expect(routes.map((route) => route.pathname)).toEqual(['/a/deep/two', '/b/three']);
  });

  it('resolves src/app', async () => {
    const projectRoot = await makeProjectAsync(
      ['_layout.tsx', 'index.tsx'],
      path.join('src', 'app')
    );

    const routes = await discoverRoutesAsync(projectRoot);

    expect(routes.map((route) => route.pathname)).toEqual(['/']);
  });

  it('honors an expo-router root configured in app.json', async () => {
    const projectRoot = await makeProjectAsync(['_layout.tsx', 'index.tsx'], 'screens');
    await fs.writeFile(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' })
    );
    await fs.writeFile(
      path.join(projectRoot, 'app.json'),
      JSON.stringify({
        expo: {
          name: 'x',
          slug: 'x',
          extra: { router: { root: 'screens' } },
          plugins: [['expo-router', { root: 'screens' }]],
        },
      })
    );

    const routes = await discoverRoutesAsync(projectRoot);

    expect(routes.map((route) => route.pathname)).toEqual(['/']);
  });

  it('works without a root _layout', async () => {
    const projectRoot = await makeProjectAsync(['index.tsx', 'about.tsx']);

    const routes = await discoverRoutesAsync(projectRoot);

    expect(routes.map((route) => route.pathname)).toEqual(['/', '/about']);
  });

  it('throws ROUTES when there is no app directory', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'routeshot-routes-'));
    projectRoots.push(projectRoot);

    await expect(discoverRoutesAsync(projectRoot)).rejects.toMatchObject({
      name: 'RouteshotError',
      code: 'ROUTES',
    });
  });

  it('throws ROUTES when the app directory has no routes', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'routeshot-routes-'));
    projectRoots.push(projectRoot);
    await fs.mkdir(path.join(projectRoot, 'app'));

    const error = await discoverRoutesAsync(projectRoot).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RouteshotError);
    expect((error as RouteshotError).code).toBe('ROUTES');
  });
});
