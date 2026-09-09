import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { timingSafeEqual } from 'node:crypto';

import { compareRunsAsync } from './compare.js';
import { ServerError, isServerError } from './errors.js';
import { newId } from './ids.js';
import type { JudgeDeps } from './judge.js';
import type { Logger } from './log.js';
import { renderReportHtml } from './report-html.js';
import { parseCaptureRun } from './schemas.js';
import type { Store, StoredFile } from './store.js';

export interface AppDeps {
  store: Store;
  version: string;
  /** Single shared token per repo for v1, checked on writes and on the compare endpoint. */
  token: string;
  /** Undefined turns the AI verdict off; reports are still produced, with `verdicts: undefined`. */
  judge: JudgeDeps | undefined;
  logger: Logger;
  now: () => Date;
  /** Compare requests allowed per token per minute. */
  compareRateLimit: number;
}

const PNG_HEADERS = {
  'content-type': 'image/png',
  // Run and compare files are immutable once written, and the id is the only thing guarding them.
  'cache-control': 'private, max-age=31536000, immutable',
};

/** Copies out of the view so a `bytea` row backed by a pooled buffer is not sent wholesale. */
function toBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const compareWindows = new Map<string, { resetAt: number; count: number }>();

  const requireToken = (header: string | undefined): string => {
    const provided = header?.startsWith('Bearer ') === true ? header.slice(7) : undefined;
    if (provided === undefined || !tokensMatch(provided, deps.token)) {
      throw new ServerError('UNAUTHORIZED', 'missing or invalid bearer token');
    }
    return provided;
  };

  app.use('*', async (c, next) => {
    const startedAt = performance.now();
    await next();
    deps.logger.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - startedAt),
    });
  });

  app.onError((error, c) => {
    if (isServerError(error)) {
      return c.json(
        { error: error.message, code: error.code },
        error.status as ContentfulStatusCode
      );
    }
    deps.logger.error('unhandled error', {
      path: c.req.path,
      error: error instanceof Error ? error.stack : String(error),
    });
    return c.json({ error: 'internal error', code: 'INTERNAL' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true, version: deps.version }));

  app.post('/runs', async (c) => {
    requireToken(c.req.header('authorization'));

    const form = await c.req.raw.formData().catch(() => {
      throw new ServerError('BAD_REQUEST', 'expected a multipart/form-data body');
    });

    let indexJson: string | undefined;
    const files: StoredFile[] = [];
    let repo: string | undefined;

    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') {
        if (key === 'index.json' || key === 'index') {
          indexJson = value;
        } else if (key === 'repo') {
          repo = value;
        }
        continue;
      }
      if (key === 'index.json' || key === 'index' || value.name === 'index.json') {
        indexJson = await value.text();
        continue;
      }
      // The part name is the slug the index refers to. Clients that key every file under one
      // repeated field instead (`files`) fall back to the uploaded file name.
      const name = key.endsWith('.png') ? key : value.name;
      files.push({ name, bytes: new Uint8Array(await value.arrayBuffer()) });
    }

    if (indexJson === undefined) {
      throw new ServerError('BAD_REQUEST', 'multipart body is missing the index.json part');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(indexJson);
    } catch (error) {
      throw new ServerError('BAD_REQUEST', 'index.json is not valid JSON', { cause: error });
    }
    const index = parseCaptureRun(parsed);

    const uploaded = new Set(files.map((file) => file.name));
    const missing = index.routes
      .filter(
        (entry) =>
          entry.status === 'captured' && (entry.file === undefined || !uploaded.has(entry.file))
      )
      .map((entry) => entry.route);
    if (missing.length > 0) {
      throw new ServerError(
        'BAD_REQUEST',
        `index.json references screenshots that were not uploaded: ${missing.join(', ')}`
      );
    }

    // The client's run id is only unique on the machine that produced it, so the server assigns
    // its own unguessable id and rewrites the index: every link and baseline lookup uses one id.
    const id = newId();
    await deps.store.saveRunAsync(
      {
        id,
        label: index.label,
        createdAt: index.createdAt,
        repo,
        branch: index.git.branch,
        sha: index.git.sha,
        index: { ...index, id },
      },
      files
    );

    return c.json({ id, url: `/runs/${id}` }, 201);
  });

  app.get('/runs', async (c) => {
    requireToken(c.req.header('authorization'));
    const rawLimit = Number(c.req.query('limit') ?? 20);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 20;
    const runs = await deps.store.listRunsAsync({
      repo: c.req.query('repo'),
      branch: c.req.query('branch'),
      limit,
    });
    return c.json({ runs });
  });

  // No token: the id is unguessable and the report page loads these from a plain browser.
  app.get('/runs/:id', async (c) => {
    const run = await deps.store.getRunAsync(c.req.param('id'));
    if (!run) {
      throw new ServerError('NOT_FOUND', 'run not found');
    }
    return c.json(run.index);
  });

  app.get('/runs/:id/files/:name', async (c) => {
    const bytes = await deps.store.getFileAsync(c.req.param('id'), c.req.param('name'));
    if (!bytes) {
      throw new ServerError('NOT_FOUND', 'file not found');
    }
    return c.body(toBody(bytes), 200, PNG_HEADERS);
  });

  app.get('/compare', async (c) => {
    const token = requireToken(c.req.header('authorization'));
    const now = deps.now().getTime();
    const window = compareWindows.get(token);
    if (!window || window.resetAt <= now) {
      compareWindows.set(token, { resetAt: now + 60_000, count: 1 });
    } else if (window.count >= deps.compareRateLimit) {
      throw new ServerError(
        'RATE_LIMITED',
        `more than ${deps.compareRateLimit} compares in a minute`
      );
    } else {
      window.count += 1;
    }

    const baselineId = c.req.query('baseline');
    const candidateId = c.req.query('candidate');
    if (baselineId === undefined || candidateId === undefined) {
      throw new ServerError('BAD_REQUEST', 'baseline and candidate query parameters are required');
    }
    const rawThreshold = Number(c.req.query('threshold') ?? 0);
    if (!Number.isFinite(rawThreshold) || rawThreshold < 0 || rawThreshold > 1) {
      throw new ServerError('BAD_REQUEST', 'threshold must be a ratio between 0 and 1');
    }

    const cached = await deps.store.findCompareAsync(baselineId, candidateId, rawThreshold);
    if (cached) {
      return c.json({ ...cached.report, id: cached.id, url: `/r/${cached.id}` });
    }

    const [baseline, candidate] = await Promise.all([
      deps.store.getRunAsync(baselineId),
      deps.store.getRunAsync(candidateId),
    ]);
    if (!baseline) {
      throw new ServerError('NOT_FOUND', `baseline run ${baselineId} not found`);
    }
    if (!candidate) {
      throw new ServerError('NOT_FOUND', `candidate run ${candidateId} not found`);
    }

    const id = newId();
    const { report, diffFiles } = await compareRunsAsync({
      compareId: id,
      baseline,
      candidate,
      threshold: rawThreshold,
      files: deps.store,
      judge: deps.judge,
    });

    // Masks first: the report row is what makes the URL live, and it must never point at
    // images that are not there yet.
    await deps.store.putFilesAsync(id, diffFiles);
    const saved = await deps.store.saveCompareAsync({
      id,
      baselineId,
      candidateId,
      threshold: rawThreshold,
      report,
      createdAt: deps.now().toISOString(),
    });

    if (saved.id !== id) {
      // A concurrent compare of the same triple won: only its row exists, so serve its id and drop
      // the masks written under the id nothing points at.
      await deps.store.deleteFilesAsync(id);
    }

    return c.json({ ...saved.report, id: saved.id, url: `/r/${saved.id}` });
  });

  app.get('/r/:compareId', async (c) => {
    const compare = await deps.store.getCompareAsync(c.req.param('compareId'));
    if (!compare) {
      throw new ServerError('NOT_FOUND', 'report not found');
    }
    return c.html(renderReportHtml(compare.report, compare.id));
  });

  app.get('/r/:compareId/files/:name', async (c) => {
    const bytes = await deps.store.getFileAsync(c.req.param('compareId'), c.req.param('name'));
    if (!bytes) {
      throw new ServerError('NOT_FOUND', 'file not found');
    }
    return c.body(toBody(bytes), 200, PNG_HEADERS);
  });

  return app;
}
