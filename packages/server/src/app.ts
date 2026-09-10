import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { timingSafeEqual } from 'node:crypto';

import { compareRunsAsync } from './compare.js';
import { ServerError, isServerError } from './errors.js';
import { newId } from './ids.js';
import { renderJudgeReport } from './judge-report.js';
import { JUDGE_MAX_TOKENS, JUDGE_SYSTEM_PROMPT, type JudgeDeps } from './judge.js';
import type { Logger } from './log.js';
import { renderReportHtml } from './report-html.js';
import {
  parseCaptureRun,
  parseExampleBody,
  parseExampleName,
  parseJudgeBody,
  parseVerdicts,
} from './schemas.js';
import type { Store, StoredFile } from './store.js';
import type { Verdict } from './types.js';

export interface AppDeps {
  store: Store;
  version: string;
  /** Single shared token per repo for v1, checked on writes and on the compare endpoint. */
  token: string;
  /**
   * Optional second token that only `POST /judge` accepts. It is what lets a fresh clone of the
   * example app run the judge with no Anthropic key of its own, so it is committed to the repo and
   * spends against the same daily cap as everything else.
   */
  demoToken: string | undefined;
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
  const rateWindows = new Map<string, { resetAt: number; count: number }>();

  const requireToken = (header: string | undefined, allowDemo = false): string => {
    const provided = header?.startsWith('Bearer ') === true ? header.slice(7) : undefined;
    if (provided === undefined) {
      throw new ServerError('UNAUTHORIZED', 'missing or invalid bearer token');
    }
    if (tokensMatch(provided, deps.token)) {
      return provided;
    }
    if (allowDemo && deps.demoToken !== undefined && tokensMatch(provided, deps.demoToken)) {
      return provided;
    }
    throw new ServerError('UNAUTHORIZED', 'missing or invalid bearer token');
  };

  /** One fixed window per token and endpoint; the demo token shares the compare limit. */
  const rateLimit = (bucket: string, token: string, what: string): void => {
    const now = deps.now().getTime();
    const key = `${bucket}:${token}`;
    const window = rateWindows.get(key);
    if (!window || window.resetAt <= now) {
      rateWindows.set(key, { resetAt: now + 60_000, count: 1 });
    } else if (window.count >= deps.compareRateLimit) {
      throw new ServerError(
        'RATE_LIMITED',
        `more than ${deps.compareRateLimit} ${what} in a minute`
      );
    } else {
      window.count += 1;
    }
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
    let verdictsJson: string | undefined;
    const files: StoredFile[] = [];
    let repo: string | undefined;

    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') {
        if (key === 'index.json' || key === 'index') {
          indexJson = value;
        } else if (key === 'verdicts.json') {
          verdictsJson = value;
        } else if (key === 'repo') {
          repo = value;
        }
        continue;
      }
      if (key === 'index.json' || key === 'index' || value.name === 'index.json') {
        indexJson = await value.text();
        continue;
      }
      if (key === 'verdicts.json' || value.name === 'verdicts.json') {
        verdictsJson = await value.text();
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

    let verdicts: Verdict[] | undefined;
    if (verdictsJson !== undefined) {
      let parsedVerdicts: unknown;
      try {
        parsedVerdicts = JSON.parse(verdictsJson);
      } catch (error) {
        throw new ServerError('BAD_REQUEST', 'verdicts.json is not valid JSON', { cause: error });
      }
      verdicts = parseVerdicts(parsedVerdicts);
      const routes = new Set(index.routes.map((entry) => entry.route));
      const stray = verdicts.filter((verdict) => !routes.has(verdict.route));
      if (stray.length > 0) {
        throw new ServerError(
          'BAD_REQUEST',
          `verdicts.json names routes the run did not capture: ${stray.map((verdict) => verdict.route).join(', ')}`
        );
      }
    }

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
        verdicts,
      },
      files
    );

    // A judged run has a page worth opening; an unjudged one only has its index.
    return c.json({ id, url: verdicts === undefined ? `/runs/${id}` : `/runs/${id}/report` }, 201);
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

  /** The judge report for one run, the page `capture --judge --open` shows locally. */
  const judgeReportAsync = async (id: string): Promise<string> => {
    const run = await deps.store.getRunAsync(id);
    if (!run) {
      throw new ServerError('NOT_FOUND', 'run not found');
    }
    if (run.verdicts === undefined) {
      throw new ServerError('NOT_FOUND', 'this run was uploaded without verdicts');
    }
    return renderJudgeReport(run.index, run.verdicts, {
      fileUrl: (name) => `/runs/${run.id}/files/${name}`,
    });
  };

  app.get('/runs/:id/report', async (c) => c.html(await judgeReportAsync(c.req.param('id'))));

  app.get('/runs/:id/files/:name', async (c) => {
    const bytes = await deps.store.getFileAsync(c.req.param('id'), c.req.param('name'));
    if (!bytes) {
      throw new ServerError('NOT_FOUND', 'file not found');
    }
    return c.body(toBody(bytes), 200, PNG_HEADERS);
  });

  /**
   * One judge question, answered with the server's key, prompt and model. The CLI calls this when
   * it has no `ANTHROPIC_API_KEY` of its own; the body is the content blocks it would have sent
   * to Anthropic directly, and the reply is the model's text, parsed and scored on the CLI side
   * exactly as a local answer would be.
   */
  app.post('/judge', async (c) => {
    const token = requireToken(c.req.header('authorization'), true);
    rateLimit('judge', token, 'judge calls');
    if (!deps.judge) {
      throw new ServerError('JUDGE_DISABLED', 'this server runs without an Anthropic key');
    }

    const body = parseJudgeBody(
      await c.req.json().catch(() => {
        throw new ServerError('BAD_REQUEST', 'expected a JSON body');
      })
    );

    const day = deps.now().toISOString().slice(0, 10);
    if (deps.judge.quota) {
      const used = await deps.judge.quota.countAsync(day);
      if (used >= deps.judge.quota.cap) {
        throw new ServerError('RATE_LIMITED', 'daily judge cap reached, try again tomorrow');
      }
      await deps.judge.quota.recordAsync(day, 1);
    }

    let text: string;
    try {
      const response = await deps.judge.anthropic.parseAsync(
        {
          model: deps.judge.model,
          maxTokens: JUDGE_MAX_TOKENS,
          system: JUDGE_SYSTEM_PROMPT,
          content: body.content,
        },
        AbortSignal.timeout(deps.judge.timeoutMs)
      );
      text = response.text;
    } catch (error) {
      // Nothing was bought, so the reservation goes back; the CLI reports the screen unverified.
      await deps.judge.quota?.recordAsync(day, -1);
      throw new ServerError('JUDGE_UNAVAILABLE', 'the model did not answer', { cause: error });
    }
    return c.json({ text });
  });

  app.get('/compare', async (c) => {
    const token = requireToken(c.req.header('authorization'));
    rateLimit('compare', token, 'compares');

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

  /**
   * A judged run under a fixed name, for links that must not rot: the README's "see that report"
   * points at /examples/green and /examples/broken. Pinning needs the real token; reading does not.
   */
  app.put('/examples/:name', async (c) => {
    requireToken(c.req.header('authorization'));
    const name = parseExampleName(c.req.param('name'));
    const { runId } = parseExampleBody(
      await c.req.json().catch(() => {
        throw new ServerError('BAD_REQUEST', 'expected a JSON body');
      })
    );
    const run = await deps.store.getRunAsync(runId);
    if (!run) {
      throw new ServerError('NOT_FOUND', `run ${runId} not found`);
    }
    if (run.verdicts === undefined) {
      throw new ServerError('BAD_REQUEST', `run ${runId} was uploaded without verdicts`);
    }
    await deps.store.setExampleAsync(name, runId);
    return c.json({ name, runId, url: `/examples/${name}` });
  });

  app.get('/examples/:name', async (c) => {
    const runId = await deps.store.getExampleRunIdAsync(parseExampleName(c.req.param('name')));
    if (runId === undefined) {
      throw new ServerError('NOT_FOUND', 'no such example');
    }
    return c.html(await judgeReportAsync(runId));
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
