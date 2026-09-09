import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RouteshotError } from '../errors.js';
import type { CaptureRun } from '../types.js';
import {
  listRunsAsync,
  requestVerdictsAsync,
  resolveRemoteRunIdAsync,
  uploadRunAsync,
} from '../upload.js';

const SERVER = { serverUrl: 'https://routeshot.example/', token: 'secret' };

const RUN: CaptureRun = {
  id: 'run-local',
  label: 'main',
  createdAt: '2026-09-09T20:15:03.000Z',
  device: { udid: 'U', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', state: 'Booted' },
  app: { bundleId: 'com.example.demo', scheme: 'demo' },
  updateUrl: undefined,
  git: { sha: 'abc1234', branch: 'main' },
  affected: undefined,
  routes: [
    {
      route: '/',
      file: 'index.png',
      code: 'index.code.txt',
      status: 'captured',
      reason: undefined,
      settledMs: 400,
      settled: true,
    },
    {
      route: '/x',
      file: undefined,
      code: undefined,
      status: 'skipped',
      reason: 'no params',
      settledMs: undefined,
      settled: false,
    },
  ],
};

/** A `fetch` that records requests and answers from a script keyed by method + path. */
function stubFetch(answers: Record<string, { status: number; body: unknown }>): {
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const answer = answers[key] ?? { status: 404, body: { error: 'not found' } };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadRunAsync', () => {
  it('posts index.json plus the screenshot and code bundle per captured route, keyed by file name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'routeshot-upload-'));
    await writeFile(join(dir, 'index.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(dir, 'index.code.txt'), '// app/index.tsx\nexport default 1;\n');
    const fetch = stubFetch({
      'POST /runs': { status: 201, body: { id: 'srv-1', url: '/runs/srv-1' } },
    });

    const result = await uploadRunAsync({ ...SERVER, dir, run: RUN });

    expect(result).toEqual({ id: 'srv-1', url: 'https://routeshot.example/runs/srv-1' });
    const [call] = fetch.calls;
    expect(call?.url).toBe('https://routeshot.example/runs');
    expect(new Headers(call?.init?.headers).get('authorization')).toBe('Bearer secret');
    const form = call?.init?.body;
    if (!(form instanceof FormData)) {
      throw new Error('expected a multipart body');
    }
    expect([...form.keys()]).toEqual(['index.json', 'index.png', 'index.code.txt']);
    const part = form.get('index.png');
    if (!(part instanceof Blob)) {
      throw new Error('expected the screenshot part to be a Blob');
    }
    expect(await part.bytes()).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const code = form.get('index.code.txt');
    if (!(code instanceof Blob)) {
      throw new Error('expected the code part to be a Blob');
    }
    expect(await code.text()).toBe('// app/index.tsx\nexport default 1;\n');
  });

  it('throws with the server status and body when the upload is rejected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'routeshot-upload-'));
    await writeFile(join(dir, 'index.png'), Buffer.from([0x89]));
    await writeFile(join(dir, 'index.code.txt'), '');
    stubFetch({ 'POST /runs': { status: 401, body: { error: 'bad token' } } });

    await expect(uploadRunAsync({ ...SERVER, dir, run: RUN })).rejects.toMatchObject({
      code: 'UPLOAD',
      message: expect.stringContaining('401'),
    });
  });
});

describe('resolveRemoteRunIdAsync', () => {
  it('returns an id the server knows as-is', async () => {
    const fetch = stubFetch({ 'GET /runs/srv-1': { status: 200, body: RUN } });

    expect(await resolveRemoteRunIdAsync(SERVER, 'srv-1')).toBe('srv-1');
    expect(new Headers(fetch.calls[0]?.init?.headers).get('authorization')).toBe('Bearer secret');
  });

  it('falls back to the newest run uploaded from a branch of that name', async () => {
    const fetch = stubFetch({
      'GET /runs': {
        status: 200,
        body: { runs: [{ id: 'srv-9', label: 'main', createdAt: 'x' }] },
      },
    });

    expect(await resolveRemoteRunIdAsync(SERVER, 'main')).toBe('srv-9');
    expect(fetch.calls[1]?.url).toBe('https://routeshot.example/runs?branch=main&limit=1');
  });

  it('names both lookups in the error when neither matches', async () => {
    stubFetch({ 'GET /runs': { status: 200, body: { runs: [] } } });

    await expect(resolveRemoteRunIdAsync(SERVER, 'nope')).rejects.toBeInstanceOf(RouteshotError);
  });
});

describe('requestVerdictsAsync', () => {
  it('passes both ids and the threshold and absolutizes the report url', async () => {
    const fetch = stubFetch({
      'GET /compare': {
        status: 200,
        body: {
          id: 'cmp-1',
          url: '/r/cmp-1',
          summary: { total: 1, unchanged: 0, changed: 1, added: 0, removed: 0, unverified: 0 },
          verdicts: [
            { route: '/', level: 'red', score: 90, defect: 'clipped', caption: 'Title clipped' },
          ],
        },
      },
    });

    const result = await requestVerdictsAsync({
      ...SERVER,
      baselineId: 'a',
      candidateId: 'b',
      threshold: 0.001,
    });

    expect(fetch.calls[0]?.url).toBe(
      'https://routeshot.example/compare?baseline=a&candidate=b&threshold=0.001'
    );
    expect(result.url).toBe('https://routeshot.example/r/cmp-1');
    expect(result.verdicts?.[0]?.level).toBe('red');
  });

  it('rejects a response that does not match the contract', async () => {
    stubFetch({ 'GET /compare': { status: 200, body: { nope: true } } });

    await expect(
      requestVerdictsAsync({ ...SERVER, baselineId: 'a', candidateId: 'b' })
    ).rejects.toMatchObject({ code: 'UPLOAD' });
  });
});

describe('listRunsAsync', () => {
  it('surfaces a failed listing with its status', async () => {
    stubFetch({ 'GET /runs': { status: 500, body: { error: 'boom' } } });

    await expect(listRunsAsync(SERVER)).rejects.toMatchObject({
      message: expect.stringContaining('500'),
    });
  });
});
