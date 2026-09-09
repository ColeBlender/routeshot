import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresStore, applySchemaAsync, createSql, type Sql } from '../db.js';
import { makePng, makeRun } from './fixtures.js';

/**
 * Exercises the real SQL. Skipped unless TEST_DATABASE_URL points at a throwaway database, so CI
 * stays green without a service container:
 *   docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=routeshot -p 55433:5432 postgres:16
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/routeshot pnpm test
 */
const databaseUrl = process.env['TEST_DATABASE_URL'];

describe.skipIf(databaseUrl === undefined)('PostgresStore', () => {
  let sql: Sql;
  let store: PostgresStore;

  beforeAll(async () => {
    sql = createSql(databaseUrl ?? '');
    await applySchemaAsync(sql);
    // Applying twice proves the DDL is idempotent, which is what boot does on every deploy.
    await applySchemaAsync(sql);
    await sql`TRUNCATE runs, files, compares, judge_calls CASCADE`;
    store = new PostgresStore(sql);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('round-trips a run, its screenshots, a compare and the judge counter', async () => {
    const png = makePng(6, 6, [1, 2, 3]);
    const index = makeRun({ label: 'smoke' });
    await store.saveRunAsync(
      {
        id: 'run-a',
        label: index.label,
        createdAt: index.createdAt,
        repo: 'ColeBlender/routeshot',
        branch: 'main',
        sha: 'abc1234',
        index: { ...index, id: 'run-a' },
      },
      [{ name: 'index.png', bytes: png }]
    );

    const stored = await store.getRunAsync('run-a');
    expect(stored?.index.routes).toHaveLength(1);
    expect(stored?.repo).toBe('ColeBlender/routeshot');
    expect(await store.getFileAsync('run-a', 'index.png')).toEqual(Buffer.from(png));
    expect(await store.getFileAsync('run-a', 'nope.png')).toBeUndefined();

    expect(
      await store.listRunsAsync({ repo: 'ColeBlender/routeshot', branch: 'main', limit: 10 })
    ).toHaveLength(1);
    expect(
      await store.listRunsAsync({ repo: 'other/repo', branch: undefined, limit: 10 })
    ).toHaveLength(0);
    expect(
      await store.listRunsAsync({ repo: undefined, branch: undefined, limit: 10 })
    ).toHaveLength(1);

    const report = {
      baseline: { id: 'run-a', label: 'smoke' },
      candidate: { id: 'run-a', label: 'smoke' },
      threshold: 0,
      routes: [],
      summary: { total: 0, unchanged: 0, changed: 0, added: 0, removed: 0, unverified: 0 },
      verdicts: undefined,
    };
    await store.saveCompareAsync({
      id: 'cmp-a',
      baselineId: 'run-a',
      candidateId: 'run-a',
      threshold: 0,
      report,
      createdAt: new Date().toISOString(),
    });
    expect((await store.getCompareAsync('cmp-a'))?.report.threshold).toBe(0);
    expect((await store.findCompareAsync('run-a', 'run-a', 0))?.id).toBe('cmp-a');
    expect(await store.findCompareAsync('run-a', 'run-a', 0.5)).toBeUndefined();

    await store.recordJudgeCallsAsync('2026-09-09', 3);
    await store.recordJudgeCallsAsync('2026-09-09', 2);
    expect(await store.countJudgeCallsAsync('2026-09-09')).toBe(5);
    expect(await store.countJudgeCallsAsync('2026-09-10')).toBe(0);
  });
});
