import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RouteshotError } from '../errors.js';
import { judgeDepsFromEnv, judgeRunAsync } from '../judge-run.js';
import { DEFAULT_JUDGE_MODEL, type JudgeDeps } from '../judge.js';
import type { CaptureRun } from '../types.js';
import { fakeJudge, makePng } from './judge-fixtures.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRunAsync(): Promise<{ dir: string; run: CaptureRun }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routeshot-judge-run-'));
  dirs.push(dir);
  const run: CaptureRun = {
    id: 'run-1',
    label: 'feature',
    createdAt: '2026-09-09T20:15:03.000Z',
    device: { udid: 'U', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', state: 'Booted' },
    app: { bundleId: 'com.example.demo', scheme: 'demo' },
    updateUrl: undefined,
    git: { sha: 'abc', branch: 'feature' },
    affected: {
      since: 'main',
      changedFiles: ['components/Button.tsx'],
      all: undefined,
      because: { '/settings/billing': ['components/Button.tsx'] },
      ignored: [],
    },
    routes: [
      {
        route: '/settings/billing',
        file: 'settings__billing.png',
        code: 'settings__billing.code.txt',
        status: 'captured',
        reason: undefined,
        settledMs: 300,
        settled: true,
      },
      {
        route: '/',
        file: 'index.png',
        code: undefined,
        status: 'captured',
        reason: undefined,
        settledMs: 300,
        settled: true,
      },
      {
        route: '/items/[id]',
        file: undefined,
        code: undefined,
        status: 'skipped',
        reason: 'dynamic route has no params fixture',
        settledMs: undefined,
        settled: false,
      },
    ],
  };
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(run));
  await fs.writeFile(path.join(dir, 'settings__billing.png'), makePng(4, 4, [255, 255, 255]));
  await fs.writeFile(path.join(dir, 'index.png'), makePng(4, 4, [0, 0, 0]));
  await fs.writeFile(
    path.join(dir, 'settings__billing.code.txt'),
    '// app/settings/billing.tsx\n<Button label="Update payment method" />\n'
  );
  return { dir, run };
}

function deps(anthropic: JudgeDeps['anthropic']): JudgeDeps {
  return {
    anthropic,
    model: DEFAULT_JUDGE_MODEL,
    thresholds: { yellow: 40, red: 75 },
    timeoutMs: 1_000,
    concurrency: 4,
    quota: undefined,
    now: () => new Date('2026-09-09T12:00:00.000Z'),
  };
}

describe('judgeRunAsync', () => {
  it('judges captured screens with their code, marks skipped ones unverified, and writes the report', async () => {
    const { dir, run } = await makeRunAsync();
    const judge = fakeJudge((request) => {
      const text = request.content[0]?.type === 'text' ? request.content[0].text : '';
      return text.includes('/settings/billing')
        ? {
            parsedOutput: {
              score: 92,
              defect: 'missing',
              region: { x: 0.1, y: 0.8, w: 0.8, h: 0.1 },
              caption: 'Update payment method button is not on screen',
            },
          }
        : { parsedOutput: { score: 3, defect: 'none', region: null, caption: 'home renders' } };
    });

    const result = await judgeRunAsync({ dir, run, deps: deps(judge) });

    expect(judge.requests).toHaveLength(2);
    const billingRequest = judge.requests.find(
      (request) =>
        request.content[0]?.type === 'text' && request.content[0].text.includes('billing')
    );
    expect(
      billingRequest?.content[0]?.type === 'text' ? billingRequest.content[0].text : ''
    ).toContain('Update payment method');
    expect(result.summary).toEqual({ red: 1, yellow: 0, green: 1, unverified: 1, total: 3 });
    expect(result.verdicts.map((item) => [item.route, item.level])).toEqual([
      ['/settings/billing', 'red'],
      ['/', 'green'],
      ['/items/[id]', 'unverified'],
    ]);
    expect(result.verdicts[2]?.caption).toBe('dynamic route has no params fixture');

    const html = await fs.readFile(result.report.html, 'utf8');
    expect(html).toContain('Update payment method button is not on screen');
    expect(html).toContain('class="region"');
    expect(html).toContain('changed: components/Button.tsx');
    const json = JSON.parse(await fs.readFile(result.report.json, 'utf8')) as { summary: unknown };
    expect(json.summary).toEqual(result.summary);
  });
});

describe('judgeDepsFromEnv', () => {
  it('needs an API key and reads the model and thresholds', () => {
    expect(() => judgeDepsFromEnv({})).toThrow(RouteshotError);
    const built = judgeDepsFromEnv({
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_MODEL: 'claude-opus-5',
      JUDGE_YELLOW: '30',
      JUDGE_RED: '60',
    });
    expect(built.model).toBe('claude-opus-5');
    expect(built.thresholds).toEqual({ yellow: 30, red: 60 });
    expect(judgeDepsFromEnv({ ANTHROPIC_API_KEY: 'k' }).thresholds).toEqual({
      yellow: 40,
      red: 75,
    });
    expect(() => judgeDepsFromEnv({ ANTHROPIC_API_KEY: 'k', JUDGE_RED: 'lots' })).toThrow(
      /JUDGE_RED/
    );
  });

  it('falls back to the report server when there is no key, and to nothing without either', () => {
    const server = { url: 'https://routeshot.example.com', token: 'demo' };
    expect(judgeDepsFromEnv({}, server).model).toBe(DEFAULT_JUDGE_MODEL);
    expect(() => judgeDepsFromEnv({ ANTHROPIC_API_KEY: '' }, undefined)).toThrow(
      /ANTHROPIC_API_KEY.*report server/
    );
  });
});
