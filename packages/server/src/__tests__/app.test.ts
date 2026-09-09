import { beforeEach, describe, expect, it } from 'vitest';

import { createApp, type AppDeps } from '../app.js';
import { DEFAULT_JUDGE_MODEL, type JudgeDeps, type JudgeModel } from '../judge.js';
import { silentLogger } from '../log.js';
import { MemoryStore } from '../store.js';
import type { CaptureEntry, CaptureRun, CompareReport } from '../types.js';
import { fakeJudge, makePng, makeRun } from './fixtures.js';

const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function entry(route: string, file: string, overrides: Partial<CaptureEntry> = {}): CaptureEntry {
  return {
    route,
    file,
    status: 'captured',
    reason: undefined,
    settledMs: 300,
    settled: true,
    ...overrides,
  };
}

function judgeDeps(anthropic: JudgeModel, overrides: Partial<JudgeDeps> = {}): JudgeDeps {
  return {
    anthropic,
    model: DEFAULT_JUDGE_MODEL,
    thresholds: { yellow: 40, red: 75 },
    timeoutMs: 1_000,
    concurrency: 4,
    quota: undefined,
    now: () => new Date('2026-09-09T12:00:00.000Z'),
    ...overrides,
  };
}

let store: MemoryStore;

function build(overrides: Partial<AppDeps> = {}) {
  return createApp({
    store,
    version: '0.1.0',
    token: TOKEN,
    judge: undefined,
    logger: silentLogger,
    now: () => new Date('2026-09-09T12:00:00.000Z'),
    compareRateLimit: 60,
    ...overrides,
  });
}

async function uploadAsync(
  app: ReturnType<typeof build>,
  run: CaptureRun,
  files: Record<string, Uint8Array>,
  options: { repo?: string; token?: string } = {}
): Promise<Response> {
  const form = new FormData();
  form.set(
    'index.json',
    new Blob([JSON.stringify(run)], { type: 'application/json' }),
    'index.json'
  );
  for (const [name, bytes] of Object.entries(files)) {
    form.set(name, new Blob([bytes], { type: 'image/png' }), name);
  }
  if (options.repo !== undefined) {
    form.set('repo', options.repo);
  }
  return await app.request('/runs', {
    method: 'POST',
    body: form,
    headers: { authorization: `Bearer ${options.token ?? TOKEN}` },
  });
}

async function uploadIdAsync(
  app: ReturnType<typeof build>,
  run: CaptureRun,
  files: Record<string, Uint8Array>,
  options: { repo?: string } = {}
): Promise<string> {
  const response = await uploadAsync(app, run, files, options);
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

beforeEach(() => {
  store = new MemoryStore();
});

describe('GET /health', () => {
  it('reports ok and the version without a token', async () => {
    const response = await build().request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: '0.1.0' });
  });
});

describe('auth', () => {
  it('rejects an upload with no token', async () => {
    const app = build();
    const form = new FormData();
    form.set('index.json', JSON.stringify(makeRun()));
    const response = await app.request('/runs', { method: 'POST', body: form });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects an upload with the wrong token', async () => {
    const app = build();
    const response = await uploadAsync(
      app,
      makeRun(),
      { 'index.png': makePng(4, 4, [0, 0, 0]) },
      {
        token: 'nope',
      }
    );
    expect(response.status).toBe(401);
  });

  it('rejects listing runs without a token', async () => {
    expect((await build().request('/runs')).status).toBe(401);
  });

  it('rejects a compare without a token', async () => {
    expect((await build().request('/compare?baseline=a&candidate=b')).status).toBe(401);
  });
});

describe('POST /runs', () => {
  it('stores the run and its screenshots and serves them back', async () => {
    const app = build();
    const png = makePng(8, 8, [10, 20, 30]);
    const id = await uploadIdAsync(
      app,
      makeRun(),
      { 'index.png': png },
      { repo: 'ColeBlender/routeshot' }
    );

    const runResponse = await app.request(`/runs/${id}`);
    expect(runResponse.status).toBe(200);
    const stored = (await runResponse.json()) as CaptureRun;
    // The server rewrites the machine-local id so links resolve against one namespace.
    expect(stored.id).toBe(id);
    expect(stored.routes).toHaveLength(1);

    const fileResponse = await app.request(`/runs/${id}/files/index.png`);
    expect(fileResponse.status).toBe(200);
    expect(fileResponse.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await fileResponse.arrayBuffer())).toEqual(png);
  });

  it('rejects an index that references a screenshot that was not uploaded', async () => {
    const response = await uploadAsync(build(), makeRun(), {});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects an index that is not a capture run', async () => {
    const app = build();
    const form = new FormData();
    form.set('index.json', JSON.stringify({ id: 'x' }));
    const response = await app.request('/runs', { method: 'POST', body: form, headers: AUTH });
    expect(response.status).toBe(400);
  });

  it('404s an unknown run and an unknown file', async () => {
    const app = build();
    expect((await app.request('/runs/nope')).status).toBe(404);
    expect((await app.request('/runs/nope/files/index.png')).status).toBe(404);
  });
});

describe('GET /runs', () => {
  it('filters by repo and branch and honours the limit, newest first', async () => {
    const app = build();
    const png = makePng(4, 4, [0, 0, 0]);
    await uploadIdAsync(
      app,
      makeRun({ label: 'old', createdAt: '2026-09-01T00:00:00.000Z' }),
      { 'index.png': png },
      { repo: 'a/b' }
    );
    const newest = await uploadIdAsync(
      app,
      makeRun({ label: 'new', createdAt: '2026-09-08T00:00:00.000Z' }),
      { 'index.png': png },
      { repo: 'a/b' }
    );
    await uploadIdAsync(
      app,
      makeRun({ label: 'other', git: { sha: 'z', branch: 'feature' } }),
      { 'index.png': png },
      { repo: 'a/b' }
    );

    const response = await app.request('/runs?repo=a/b&branch=main&limit=1', { headers: AUTH });
    const body = (await response.json()) as { runs: { id: string; label: string }[] };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ id: newest, label: 'new', branch: 'main' });
  });
});

describe('GET /compare', () => {
  const black = makePng(10, 10, [0, 0, 0]);
  const blackWithPatch = makePng(10, 10, [0, 0, 0], {
    x: 0,
    y: 0,
    w: 5,
    h: 10,
    color: [255, 255, 255],
  });

  async function seedAsync(app: ReturnType<typeof build>): Promise<[string, string]> {
    const baseline = await uploadIdAsync(
      app,
      makeRun({
        label: 'baseline',
        routes: [entry('/', 'index.png'), entry('/gone', 'gone.png'), entry('/same', 'same.png')],
      }),
      { 'index.png': black, 'gone.png': black, 'same.png': black }
    );
    const candidate = await uploadIdAsync(
      app,
      makeRun({
        label: 'candidate',
        routes: [entry('/', 'index.png'), entry('/new', 'new.png'), entry('/same', 'same.png')],
      }),
      { 'index.png': blackWithPatch, 'new.png': black, 'same.png': black }
    );
    return [baseline, candidate];
  }

  it('classifies unchanged, changed, added and removed routes', async () => {
    const app = build();
    const [baseline, candidate] = await seedAsync(app);

    const response = await app.request(`/compare?baseline=${baseline}&candidate=${candidate}`, {
      headers: AUTH,
    });
    expect(response.status).toBe(200);
    const report = (await response.json()) as CompareReport & { id: string; url: string };

    expect(report.summary).toEqual({
      total: 4,
      unchanged: 1,
      changed: 1,
      added: 1,
      removed: 1,
      unverified: 0,
    });
    const byRoute = new Map(report.routes.map((item) => [item.route, item]));
    expect(byRoute.get('/')?.status).toBe('changed');
    expect(byRoute.get('/')?.diffRatio).toBeCloseTo(0.5, 5);
    expect(byRoute.get('/same')?.status).toBe('unchanged');
    expect(byRoute.get('/new')?.status).toBe('added');
    expect(byRoute.get('/gone')?.status).toBe('removed');
    expect(report.verdicts).toBeUndefined();
    expect(report.url).toBe(`/r/${report.id}`);

    // The generated diff mask is served under the compare id.
    const mask = await app.request(`/r/${report.id}/files/index.png`);
    expect(mask.status).toBe(200);
    expect(mask.headers.get('content-type')).toBe('image/png');
  });

  it('marks a route unverified when the two screenshots are different sizes', async () => {
    const app = build();
    const baseline = await uploadIdAsync(app, makeRun({ label: 'a' }), { 'index.png': black });
    const candidate = await uploadIdAsync(app, makeRun({ label: 'b' }), {
      'index.png': makePng(12, 10, [0, 0, 0]),
    });

    const response = await app.request(`/compare?baseline=${baseline}&candidate=${candidate}`, {
      headers: AUTH,
    });
    const report = (await response.json()) as CompareReport;
    expect(report.routes[0]?.status).toBe('unverified');
    expect(report.routes[0]?.reason).toContain('sizes differ');
  });

  it('caches the report so the same inputs return the same id and re-judge nothing', async () => {
    const judge = fakeJudge(() => ({
      parsedOutput: { score: 10, defect: 'none', region: null, caption: 'fine' },
    }));
    const app = build({ judge: judgeDeps(judge) });
    const [baseline, candidate] = await seedAsync(app);
    const url = `/compare?baseline=${baseline}&candidate=${candidate}`;

    const first = (await (await app.request(url, { headers: AUTH })).json()) as { id: string };
    const second = (await (await app.request(url, { headers: AUTH })).json()) as { id: string };

    expect(second.id).toBe(first.id);
    expect(judge.requests).toHaveLength(1);
  });

  it('404s an unknown baseline and rejects a threshold outside 0..1', async () => {
    const app = build();
    const [baseline, candidate] = await seedAsync(app);
    expect(
      (await app.request(`/compare?baseline=missing&candidate=${candidate}`, { headers: AUTH }))
        .status
    ).toBe(404);
    expect(
      (
        await app.request(`/compare?baseline=${baseline}&candidate=${candidate}&threshold=4`, {
          headers: AUTH,
        })
      ).status
    ).toBe(400);
  });

  it('treats a change below the threshold as unchanged', async () => {
    const app = build();
    const [baseline, candidate] = await seedAsync(app);
    const response = await app.request(
      `/compare?baseline=${baseline}&candidate=${candidate}&threshold=0.9`,
      { headers: AUTH }
    );
    const report = (await response.json()) as CompareReport;
    expect(report.summary.changed).toBe(0);
    expect(report.summary.unchanged).toBe(2);
  });

  it('rate limits by token', async () => {
    const app = build({ compareRateLimit: 1 });
    const [baseline, candidate] = await seedAsync(app);
    await app.request(`/compare?baseline=${baseline}&candidate=${candidate}&threshold=0.1`, {
      headers: AUTH,
    });
    const response = await app.request(
      `/compare?baseline=${baseline}&candidate=${candidate}&threshold=0.2`,
      { headers: AUTH }
    );
    expect(response.status).toBe(429);
  });

  it('judges only the changed routes and maps the score onto a level', async () => {
    const judge = fakeJudge(() => ({
      parsedOutput: {
        score: 75,
        defect: 'clipped',
        region: { x: 0, y: 0.9, w: 1, h: 0.1 },
        caption: 'primary button clipped',
      },
    }));
    const app = build({ judge: judgeDeps(judge) });
    const [baseline, candidate] = await seedAsync(app);

    const response = await app.request(`/compare?baseline=${baseline}&candidate=${candidate}`, {
      headers: AUTH,
    });
    const report = (await response.json()) as CompareReport;
    const verdicts = new Map((report.verdicts ?? []).map((item) => [item.route, item]));

    expect(judge.requests).toHaveLength(1);
    expect(verdicts.get('/')).toMatchObject({ level: 'red', score: 75, defect: 'clipped' });
    // Identical pixels are green with no model call; a missing side is never hidden as green.
    expect(verdicts.get('/same')).toMatchObject({ level: 'green', score: 0 });
    expect(verdicts.get('/new')?.level).toBe('unverified');
    expect(verdicts.get('/gone')?.level).toBe('unverified');
  });

  it('caps a no-defect answer at yellow however high the score', async () => {
    const app = build({
      judge: judgeDeps(
        fakeJudge(() => ({
          parsedOutput: { score: 99, defect: 'none', region: null, caption: 'copy changed' },
        }))
      ),
    });
    const [baseline, candidate] = await seedAsync(app);
    const report = (await (
      await app.request(`/compare?baseline=${baseline}&candidate=${candidate}`, { headers: AUTH })
    ).json()) as CompareReport;

    expect(report.verdicts?.find((item) => item.route === '/')).toMatchObject({
      level: 'yellow',
      score: 99,
    });
  });

  it('returns an unverified verdict when the judge answer cannot be parsed', async () => {
    const app = build({ judge: judgeDeps(fakeJudge(() => ({ text: 'no idea' }))) });
    const [baseline, candidate] = await seedAsync(app);
    const report = (await (
      await app.request(`/compare?baseline=${baseline}&candidate=${candidate}`, { headers: AUTH })
    ).json()) as CompareReport;

    expect(report.verdicts?.find((item) => item.route === '/')).toMatchObject({
      level: 'unverified',
      caption: 'judge returned unparseable output',
    });
  });

  it('stops calling the judge once the daily cap is spent', async () => {
    const judge = fakeJudge(() => ({
      parsedOutput: { score: 90, defect: 'blank', region: null, caption: 'blank screen' },
    }));
    const app = build({
      judge: judgeDeps(judge, {
        quota: {
          cap: 2,
          countAsync: (day) => store.countJudgeCallsAsync(day),
          recordAsync: (day, count) => store.recordJudgeCallsAsync(day, count),
        },
      }),
    });
    await store.recordJudgeCallsAsync('2026-09-09', 2);
    const [baseline, candidate] = await seedAsync(app);

    const report = (await (
      await app.request(`/compare?baseline=${baseline}&candidate=${candidate}`, { headers: AUTH })
    ).json()) as CompareReport;

    expect(judge.requests).toHaveLength(0);
    expect(report.verdicts?.find((item) => item.route === '/')).toMatchObject({
      level: 'unverified',
      caption: 'daily judge cap reached',
    });
  });
});

describe('GET /r/:compareId', () => {
  it('renders a dark report with a badge and caption per route, worst first', async () => {
    const judge = fakeJudge(() => ({
      parsedOutput: {
        score: 90,
        defect: 'clipped',
        region: null,
        caption: 'primary button clipped',
      },
    }));
    const app = build({ judge: judgeDeps(judge) });
    const black = makePng(10, 10, [0, 0, 0]);
    const baseline = await uploadIdAsync(
      app,
      makeRun({ label: 'baseline', routes: [entry('/', 'index.png'), entry('/same', 'same.png')] }),
      { 'index.png': black, 'same.png': black }
    );
    const candidate = await uploadIdAsync(
      app,
      makeRun({
        label: 'candidate',
        routes: [entry('/', 'index.png'), entry('/same', 'same.png')],
      }),
      {
        'index.png': makePng(10, 10, [0, 0, 0], { x: 0, y: 0, w: 5, h: 10, color: [255, 0, 0] }),
        'same.png': black,
      }
    );
    const { id } = (await (
      await app.request(`/compare?baseline=${baseline}&candidate=${candidate}`, { headers: AUTH })
    ).json()) as { id: string };

    const response = await app.request(`/r/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();

    expect(html).toContain('<span class="badge red">red</span>');
    expect(html).toContain('<span class="badge green">green</span>');
    expect(html).toContain('primary button clipped');
    expect(html).toContain(`/runs/${baseline}/files/index.png`);
    expect(html).toContain(`/runs/${candidate}/files/index.png`);
    expect(html).toContain(`/r/${id}/files/index.png`);
    // Red sorts above green.
    expect(html.indexOf('badge red')).toBeLessThan(html.indexOf('badge green'));
  });

  it('404s an unknown report', async () => {
    expect((await build().request('/r/nope')).status).toBe(404);
  });
});
