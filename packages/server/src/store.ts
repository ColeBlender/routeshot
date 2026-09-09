import type { CaptureRun, CompareReport } from './types.js';

/** A run as the server holds it: the client's index plus the columns we query on. */
export interface StoredRun {
  /** Server-assigned, unguessable. Replaces the client's machine-local run id. */
  id: string;
  label: string;
  createdAt: string;
  repo: string | undefined;
  branch: string | undefined;
  sha: string | undefined;
  index: CaptureRun;
}

/** What `GET /runs` returns. The full index is only served by `GET /runs/:id`. */
export interface RunSummary {
  id: string;
  label: string;
  createdAt: string;
  repo: string | undefined;
  branch: string | undefined;
  sha: string | undefined;
  routeCount: number;
}

export interface StoredCompare {
  id: string;
  baselineId: string;
  candidateId: string;
  threshold: number;
  report: CompareReport;
  createdAt: string;
}

export interface StoredFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * PNG bytes live behind this interface so a bucket adapter can replace the Postgres one without
 * touching the routes. `ownerId` is a run id for captures and a compare id for diff masks.
 */
export interface FileStore {
  putFilesAsync(ownerId: string, files: StoredFile[]): Promise<void>;
  getFileAsync(ownerId: string, name: string): Promise<Uint8Array | undefined>;
}

export interface Store extends FileStore {
  saveRunAsync(run: StoredRun, files: StoredFile[]): Promise<void>;
  getRunAsync(id: string): Promise<StoredRun | undefined>;
  listRunsAsync(query: {
    repo: string | undefined;
    branch: string | undefined;
    limit: number;
  }): Promise<RunSummary[]>;
  saveCompareAsync(compare: StoredCompare): Promise<void>;
  getCompareAsync(id: string): Promise<StoredCompare | undefined>;
  /** The cache lookup for `GET /compare`: the same three inputs always give the same report. */
  findCompareAsync(
    baselineId: string,
    candidateId: string,
    threshold: number
  ): Promise<StoredCompare | undefined>;
  /** Spend ceiling bookkeeping, one row per UTC day. */
  countJudgeCallsAsync(day: string): Promise<number>;
  recordJudgeCallsAsync(day: string, count: number): Promise<void>;
}

function summarize(run: StoredRun): RunSummary {
  return {
    id: run.id,
    label: run.label,
    createdAt: run.createdAt,
    repo: run.repo,
    branch: run.branch,
    sha: run.sha,
    routeCount: run.index.routes.length,
  };
}

/** The whole store in process memory. Used by the tests, and by `pnpm dev` without a database. */
export class MemoryStore implements Store {
  private readonly runs = new Map<string, StoredRun>();
  private readonly files = new Map<string, Uint8Array>();
  private readonly compares = new Map<string, StoredCompare>();
  private readonly judgeCalls = new Map<string, number>();

  async saveRunAsync(run: StoredRun, files: StoredFile[]): Promise<void> {
    this.runs.set(run.id, run);
    await this.putFilesAsync(run.id, files);
  }

  async getRunAsync(id: string): Promise<StoredRun | undefined> {
    return this.runs.get(id);
  }

  async listRunsAsync(query: {
    repo: string | undefined;
    branch: string | undefined;
    limit: number;
  }): Promise<RunSummary[]> {
    return [...this.runs.values()]
      .filter(
        (run) =>
          (query.repo === undefined || run.repo === query.repo) &&
          (query.branch === undefined || run.branch === query.branch)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, query.limit)
      .map(summarize);
  }

  async putFilesAsync(ownerId: string, files: StoredFile[]): Promise<void> {
    for (const file of files) {
      this.files.set(`${ownerId}/${file.name}`, file.bytes);
    }
  }

  async getFileAsync(ownerId: string, name: string): Promise<Uint8Array | undefined> {
    return this.files.get(`${ownerId}/${name}`);
  }

  async saveCompareAsync(compare: StoredCompare): Promise<void> {
    this.compares.set(compare.id, compare);
  }

  async getCompareAsync(id: string): Promise<StoredCompare | undefined> {
    return this.compares.get(id);
  }

  async findCompareAsync(
    baselineId: string,
    candidateId: string,
    threshold: number
  ): Promise<StoredCompare | undefined> {
    return [...this.compares.values()].find(
      (compare) =>
        compare.baselineId === baselineId &&
        compare.candidateId === candidateId &&
        compare.threshold === threshold
    );
  }

  async countJudgeCallsAsync(day: string): Promise<number> {
    return this.judgeCalls.get(day) ?? 0;
  }

  async recordJudgeCallsAsync(day: string, count: number): Promise<void> {
    this.judgeCalls.set(day, (this.judgeCalls.get(day) ?? 0) + count);
  }
}
