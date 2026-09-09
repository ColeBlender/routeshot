import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { PostgresStore, applySchemaAsync, createSql, type Sql } from './db.js';
import { ServerError } from './errors.js';
import {
  DEFAULT_JUDGE_MODEL,
  JUDGE_CONCURRENCY,
  JUDGE_TIMEOUT_MS,
  createAnthropicJudgeModel,
  type JudgeDeps,
} from './judge.js';
import { Log } from './log.js';
import { MemoryStore, type Store } from './store.js';

const VERSION = '0.1.0';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new ServerError('CONFIG', `${name} is required`);
  }
  return value;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ServerError('CONFIG', `${name} must be a number, got ${raw}`);
  }
  return value;
}

function buildJudgeDeps(store: Store): JudgeDeps | undefined {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    // No key is a supported configuration: reports still ship, every changed route just goes out
    // without a verdict rather than pretending to be green.
    Log.warn('ANTHROPIC_API_KEY is not set, the judge is disabled');
    return undefined;
  }
  const cap = numberFromEnv('JUDGE_DAILY_CAP', 500);
  return {
    anthropic: createAnthropicJudgeModel(new Anthropic({ apiKey })),
    model: process.env['ANTHROPIC_MODEL'] ?? DEFAULT_JUDGE_MODEL,
    thresholds: {
      yellow: numberFromEnv('JUDGE_YELLOW', 40),
      red: numberFromEnv('JUDGE_RED', 75),
    },
    timeoutMs: JUDGE_TIMEOUT_MS,
    concurrency: JUDGE_CONCURRENCY,
    quota: {
      cap,
      countAsync: async (day) => await store.countJudgeCallsAsync(day),
      recordAsync: async (day, count) => {
        await store.recordJudgeCallsAsync(day, count);
      },
    },
    now: () => new Date(),
  };
}

/**
 * Production always needs a database. Locally, an unset DATABASE_URL falls back to process memory
 * so `pnpm dev` runs with nothing installed; every run and report dies with the process.
 */
async function openStoreAsync(): Promise<{ store: Store; sql: Sql | undefined }> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    if (process.env['NODE_ENV'] === 'production') {
      throw new ServerError('CONFIG', 'DATABASE_URL is required');
    }
    Log.warn('DATABASE_URL is not set, storing runs and reports in memory: nothing persists');
    return { store: new MemoryStore(), sql: undefined };
  }
  const sql = createSql(databaseUrl);
  await applySchemaAsync(sql);
  return { store: new PostgresStore(sql), sql };
}

async function mainAsync(): Promise<void> {
  const port = numberFromEnv('PORT', 3000);
  const { store, sql } = await openStoreAsync();

  const app = createApp({
    store,
    version: VERSION,
    token: required('ROUTESHOT_TOKEN'),
    judge: buildJudgeDeps(store),
    logger: Log,
    now: () => new Date(),
    compareRateLimit: numberFromEnv('COMPARE_RATE_LIMIT', 60),
  });

  const server = serve({ fetch: app.fetch, port }, (info) => {
    Log.info('listening', { port: info.port, version: VERSION });
  });

  // Railway sends SIGTERM on redeploy and waits before SIGKILL; finish in-flight requests and
  // drain the pool so a deploy never truncates an upload.
  let shuttingDown = false;
  const shutdownAsync = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    Log.info('shutting down', { signal });
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await sql?.end({ timeout: 5 });
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      shutdownAsync(signal).catch((error: unknown) => {
        Log.error('shutdown failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      });
    });
  }
}

// The entry is the one place that turns a throw into an exit status, the same contract the CLI
// uses. Everything below it throws.
try {
  await mainAsync();
} catch (error) {
  Log.error('failed to start', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
