import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_THRESHOLD, defineConfig, loadRouteshotConfigAsync } from '../config.js';
import { RouteshotError } from '../errors.js';

const projectRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    projectRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function makeProjectAsync(files: Record<string, unknown>): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'routeshot-config-'));
  projectRoots.push(projectRoot);
  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(projectRoot, name), `${JSON.stringify(contents, null, 2)}\n`);
  }
  return projectRoot;
}

const APP_JSON = {
  expo: {
    name: 'demo',
    slug: 'demo',
    scheme: 'demo',
    ios: { bundleIdentifier: 'com.example.demo' },
  },
};

describe('loadRouteshotConfigAsync', () => {
  it('fills scheme and bundleId from the Expo app config and applies every default', async () => {
    const projectRoot = await makeProjectAsync({
      'package.json': { name: 'demo', version: '1.0.0' },
      'app.json': APP_JSON,
    });

    const config = await loadRouteshotConfigAsync(projectRoot);

    expect(config).toEqual({
      scheme: 'demo',
      bundleId: 'com.example.demo',
      slug: 'demo',
      device: undefined,
      appearance: 'light',
      routes: { params: {}, ignore: [], waitFor: {} },
      settle: { intervalMs: 300, stableFrames: 2, timeoutMs: 5000 },
      threshold: DEFAULT_THRESHOLD,
      devClient: undefined,
      server: undefined,
    });
  });

  it('detects a development build from expo-dev-client in package.json', async () => {
    const projectRoot = await makeProjectAsync({
      'package.json': {
        name: 'demo',
        version: '1.0.0',
        dependencies: { 'expo-dev-client': '~57.0.0' },
      },
      'app.json': APP_JSON,
    });

    const config = await loadRouteshotConfigAsync(projectRoot);

    expect(config.devClient).toEqual({ url: 'http://localhost:8081' });
  });

  it('lets `devClient: false` override the package.json detection', async () => {
    const projectRoot = await makeProjectAsync({
      'package.json': {
        name: 'demo',
        version: '1.0.0',
        dependencies: { 'expo-dev-client': '~57.0.0' },
      },
      'app.json': APP_JSON,
      'routeshot.config.json': { devClient: false },
    });

    expect((await loadRouteshotConfigAsync(projectRoot)).devClient).toBeUndefined();
  });

  it('reads the report server from the environment when the config omits it', async () => {
    const projectRoot = await makeProjectAsync({
      'package.json': { name: 'demo', version: '1.0.0' },
      'app.json': APP_JSON,
    });
    process.env['ROUTESHOT_SERVER_URL'] = 'https://routeshot.example';
    process.env['ROUTESHOT_SERVER_TOKEN'] = 'secret';
    try {
      expect((await loadRouteshotConfigAsync(projectRoot)).server).toEqual({
        url: 'https://routeshot.example',
        token: 'secret',
      });
    } finally {
      delete process.env['ROUTESHOT_SERVER_URL'];
      delete process.env['ROUTESHOT_SERVER_TOKEN'];
    }
  });

  it('takes the first entry when the app config declares several schemes', async () => {
    const projectRoot = await makeProjectAsync({
      'package.json': { name: 'demo', version: '1.0.0' },
      'app.json': { expo: { ...APP_JSON.expo, scheme: ['demo', 'demo-alt'] } },
    });

    expect((await loadRouteshotConfigAsync(projectRoot)).scheme).toBe('demo');
  });

  it('lets routeshot.config override the app config and keeps partial nested defaults', async () => {
    const projectRoot = await makeProjectAsync({
      'package.json': { name: 'demo', version: '1.0.0' },
      'app.json': APP_JSON,
      'routeshot.config.json': {
        scheme: 'override',
        device: 'iPhone 17 Pro',
        appearance: 'dark',
        threshold: 0.05,
        routes: { params: { '/users/[id]': { id: '42' } }, waitFor: { '/feed': 9000 } },
        settle: { timeoutMs: 8000 },
        server: { url: 'https://routeshot.example.com', token: 'tok_123' },
      },
    });

    const config = await loadRouteshotConfigAsync(projectRoot);

    expect(config.scheme).toBe('override');
    // Not overridden, so it still comes from app.json.
    expect(config.bundleId).toBe('com.example.demo');
    expect(config.appearance).toBe('dark');
    expect(config.threshold).toBe(0.05);
    expect(config.routes).toEqual({
      params: { '/users/[id]': { id: '42' } },
      ignore: [],
      waitFor: { '/feed': 9000 },
    });
    expect(config.settle).toEqual({ intervalMs: 300, stableFrames: 2, timeoutMs: 8000 });
    expect(config.server).toEqual({ url: 'https://routeshot.example.com', token: 'tok_123' });
  });

  it('throws CONFIG naming the missing value when neither source has a scheme', async () => {
    const projectRoot = await makeProjectAsync({
      'package.json': { name: 'demo', version: '1.0.0' },
      'routeshot.config.json': { bundleId: 'com.example.demo' },
    });

    await expect(loadRouteshotConfigAsync(projectRoot)).rejects.toThrow(
      /No URL scheme.*expo\.scheme/s
    );
    await expect(loadRouteshotConfigAsync(projectRoot)).rejects.toBeInstanceOf(RouteshotError);
  });

  it('throws CONFIG when the bundle identifier is nowhere to be found', async () => {
    const projectRoot = await makeProjectAsync({
      'package.json': { name: 'demo', version: '1.0.0' },
      'app.json': { expo: { name: 'demo', slug: 'demo', scheme: 'demo' } },
    });

    await expect(loadRouteshotConfigAsync(projectRoot)).rejects.toThrow(/No iOS bundle identifier/);
  });

  it('reports the offending field path when validation fails', async () => {
    const projectRoot = await makeProjectAsync({
      'package.json': { name: 'demo', version: '1.0.0' },
      'app.json': APP_JSON,
      'routeshot.config.json': { threshold: 12, settle: { stableFrames: 0 } },
    });

    const error = await loadRouteshotConfigAsync(projectRoot).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RouteshotError);
    expect((error as RouteshotError).code).toBe('CONFIG');
    expect((error as RouteshotError).message).toContain('threshold');
    expect((error as RouteshotError).message).toContain('settle.stableFrames');
  });
});

describe('defineConfig', () => {
  it('hands the config straight back', () => {
    const config = { scheme: 'demo', threshold: 0.02 };
    expect(defineConfig(config)).toBe(config);
  });
});

describe('routeshot.config.ts', () => {
  it('loads a TypeScript config from an app without "type": "module" and emits no Node warning', async () => {
    const projectRoot = await makeProjectAsync({
      'package.json': { name: 'demo', version: '1.0.0' },
      'app.json': APP_JSON,
    });
    await fs.writeFile(
      path.join(projectRoot, 'routeshot.config.ts'),
      `const threshold: number = 0.25;\nexport default { threshold, routes: { params: { '/items/[id]': { id: '7' } } } };\n`
    );
    const warnings: string[] = [];
    const onWarning = (warning: Error & { code?: string }): void => {
      warnings.push(warning.code ?? warning.name);
    };
    process.on('warning', onWarning);
    try {
      const config = await loadRouteshotConfigAsync(projectRoot);
      // Node emits warnings on a later tick; give them a chance to land before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      expect(config.threshold).toBe(0.25);
      expect(config.routes.params['/items/[id]']).toEqual({ id: '7' });
      expect(warnings).not.toContain('MODULE_TYPELESS_PACKAGE_JSON');
    } finally {
      process.off('warning', onWarning);
    }
  });
});
