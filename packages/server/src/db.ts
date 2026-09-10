import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

import { ServerError } from './errors.js';
import type { RunSummary, Store, StoredCompare, StoredFile, StoredRun } from './store.js';
import type { CaptureRun, CompareReport, Verdict } from './types.js';

export type Sql = postgres.Sql;

export function createSql(databaseUrl: string): Sql {
  // Railway Postgres terminates TLS with its own certificate chain, and the pooled connection
  // count is kept low because the service is a single small container.
  return postgres(databaseUrl, { max: 5, ssl: 'prefer', onnotice: () => {} });
}

/**
 * Applied on every boot. The file is copied next to the bundle by tsdown so `dist/main.mjs` can
 * read it; keeping the DDL in .sql (not a template literal) means it stays greppable and can be
 * piped into psql by hand.
 */
export async function applySchemaAsync(sql: Sql): Promise<void> {
  const ddl = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await sql.unsafe(ddl);
}

/** postgres' JSONValue requires an index signature; the wire contracts are closed interfaces. */
function asJson(value: unknown): postgres.JSONValue {
  return value as postgres.JSONValue;
}

interface RunRow {
  id: string;
  label: string;
  created_at: Date;
  repo: string | null;
  branch: string | null;
  sha: string | null;
  index: CaptureRun;
  verdicts: Verdict[] | null;
}

function toStoredRun(row: RunRow): StoredRun {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at.toISOString(),
    repo: row.repo ?? undefined,
    branch: row.branch ?? undefined,
    sha: row.sha ?? undefined,
    index: row.index,
    verdicts: row.verdicts ?? undefined,
  };
}

/**
 * PNG bytes are stored as `bytea` rows rather than in a bucket. That is a deliberate v1 call:
 * one Railway service plus one Railway Postgres is the whole deployment, no bucket credentials,
 * no lifecycle rules, and a run is a few megabytes of small screenshots. It stops being the right
 * call once runs are retained for long or screenshots get large, which is why every read and
 * write goes through the `FileStore` interface: swapping in an S3 adapter touches this file only.
 */
export class PostgresStore implements Store {
  constructor(private readonly sql: Sql) {}

  async saveRunAsync(run: StoredRun, files: StoredFile[]): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO runs (id, label, created_at, repo, branch, sha, device, app, update_url, "index", verdicts)
        VALUES (${run.id}, ${run.label}, ${run.createdAt}, ${run.repo ?? null},
                ${run.branch ?? null}, ${run.sha ?? null}, ${tx.json(asJson(run.index.device))},
                ${tx.json(asJson(run.index.app))}, ${run.index.updateUrl ?? null},
                ${tx.json(asJson(run.index))},
                ${run.verdicts === undefined ? null : tx.json(asJson(run.verdicts))})
      `;
      for (const file of files) {
        await tx`
          INSERT INTO files (owner_id, name, bytes)
          VALUES (${run.id}, ${file.name}, ${Buffer.from(file.bytes)})
          ON CONFLICT (owner_id, name) DO UPDATE SET bytes = EXCLUDED.bytes
        `;
      }
    });
  }

  async getRunAsync(id: string): Promise<StoredRun | undefined> {
    const rows = await this.sql<RunRow[]>`
      SELECT id, label, created_at, repo, branch, sha, "index", verdicts FROM runs WHERE id = ${id}
    `;
    const row = rows[0];
    return row ? toStoredRun(row) : undefined;
  }

  async listRunsAsync(query: {
    repo: string | undefined;
    branch: string | undefined;
    limit: number;
  }): Promise<RunSummary[]> {
    const rows = await this.sql<RunRow[]>`
      SELECT id, label, created_at, repo, branch, sha, "index", verdicts FROM runs
      WHERE (${query.repo ?? null}::text IS NULL OR repo = ${query.repo ?? null})
        AND (${query.branch ?? null}::text IS NULL OR branch = ${query.branch ?? null})
      ORDER BY created_at DESC
      LIMIT ${query.limit}
    `;
    return rows.map((row) => {
      const run = toStoredRun(row);
      return {
        id: run.id,
        label: run.label,
        createdAt: run.createdAt,
        repo: run.repo,
        branch: run.branch,
        sha: run.sha,
        routeCount: run.index.routes.length,
      };
    });
  }

  async putFilesAsync(ownerId: string, files: StoredFile[]): Promise<void> {
    for (const file of files) {
      await this.sql`
        INSERT INTO files (owner_id, name, bytes)
        VALUES (${ownerId}, ${file.name}, ${Buffer.from(file.bytes)})
        ON CONFLICT (owner_id, name) DO UPDATE SET bytes = EXCLUDED.bytes
      `;
    }
  }

  async getFileAsync(ownerId: string, name: string): Promise<Uint8Array | undefined> {
    const rows = await this.sql<{ bytes: Buffer }[]>`
      SELECT bytes FROM files WHERE owner_id = ${ownerId} AND name = ${name}
    `;
    return rows[0]?.bytes;
  }

  async deleteFilesAsync(ownerId: string): Promise<void> {
    await this.sql`DELETE FROM files WHERE owner_id = ${ownerId}`;
  }

  async saveCompareAsync(compare: StoredCompare): Promise<StoredCompare> {
    // The no-op `SET id = compares.id` is what makes RETURNING hand back the row that won when a
    // concurrent compare of the same triple got there first; DO NOTHING would return nothing and
    // leave the caller serving an id that was never stored.
    const rows = await this.sql<CompareRow[]>`
      INSERT INTO compares (id, baseline_id, candidate_id, threshold, report, created_at)
      VALUES (${compare.id}, ${compare.baselineId}, ${compare.candidateId}, ${compare.threshold},
              ${this.sql.json(asJson(compare.report))},
              ${compare.createdAt})
      ON CONFLICT (baseline_id, candidate_id, threshold) DO UPDATE SET id = compares.id
      RETURNING id, baseline_id, candidate_id, threshold, report, created_at
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new ServerError('STORAGE', 'saving the compare returned no row');
    }
    return toStoredCompare(row);
  }

  async getCompareAsync(id: string): Promise<StoredCompare | undefined> {
    const rows = await this.sql<CompareRow[]>`
      SELECT id, baseline_id, candidate_id, threshold, report, created_at
      FROM compares WHERE id = ${id}
    `;
    const row = rows[0];
    return row ? toStoredCompare(row) : undefined;
  }

  async findCompareAsync(
    baselineId: string,
    candidateId: string,
    threshold: number
  ): Promise<StoredCompare | undefined> {
    const rows = await this.sql<CompareRow[]>`
      SELECT id, baseline_id, candidate_id, threshold, report, created_at
      FROM compares
      WHERE baseline_id = ${baselineId} AND candidate_id = ${candidateId}
        AND threshold = ${threshold}
    `;
    const row = rows[0];
    return row ? toStoredCompare(row) : undefined;
  }

  async countJudgeCallsAsync(day: string): Promise<number> {
    const rows = await this.sql<{ calls: string }[]>`
      SELECT calls FROM judge_calls WHERE day = ${day}
    `;
    return rows[0] ? Number(rows[0].calls) : 0;
  }

  async recordJudgeCallsAsync(day: string, count: number): Promise<void> {
    await this.sql`
      INSERT INTO judge_calls (day, calls) VALUES (${day}, ${count})
      ON CONFLICT (day) DO UPDATE SET calls = judge_calls.calls + EXCLUDED.calls
    `;
  }

  async setExampleAsync(name: string, runId: string): Promise<void> {
    await this.sql`
      INSERT INTO examples (name, run_id) VALUES (${name}, ${runId})
      ON CONFLICT (name) DO UPDATE SET run_id = EXCLUDED.run_id, created_at = now()
    `;
  }

  async getExampleRunIdAsync(name: string): Promise<string | undefined> {
    const rows = await this.sql<{ run_id: string }[]>`
      SELECT run_id FROM examples WHERE name = ${name}
    `;
    return rows[0]?.run_id;
  }
}

interface CompareRow {
  id: string;
  baseline_id: string;
  candidate_id: string;
  threshold: number;
  report: CompareReport;
  created_at: Date;
}

function toStoredCompare(row: CompareRow): StoredCompare {
  return {
    id: row.id,
    baselineId: row.baseline_id,
    candidateId: row.candidate_id,
    threshold: Number(row.threshold),
    report: row.report,
    createdAt: row.created_at.toISOString(),
  };
}
