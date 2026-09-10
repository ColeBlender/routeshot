import type { CaptureRun, CompareReport, Verdict } from './types.js';

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
  /** The judge's answers uploaded with the run, one per route. Undefined when it was not judged. */
  verdicts: Verdict[] | undefined;
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
  /** Drops every file under one owner: the diff masks of a compare that lost the save race. */
  deleteFilesAsync(ownerId: string): Promise<void>;
}

export interface Store extends FileStore {
  saveRunAsync(run: StoredRun, files: StoredFile[]): Promise<void>;
  getRunAsync(id: string): Promise<StoredRun | undefined>;
  listRunsAsync(query: {
    repo: string | undefined;
    branch: string | undefined;
    limit: number;
  }): Promise<RunSummary[]>;
  /**
   * First writer wins. Returns the row that is actually stored, which is the earlier one when a
   * concurrent compare of the same (baseline, candidate, threshold) already saved: the caller has
   * to serve that id, because its own id was never persisted and would 404.
   */
  saveCompareAsync(compare: StoredCompare): Promise<StoredCompare>;
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
  /** Pins a run under a fixed public name; pinning again replaces the run. */
  setExampleAsync(name: string, runId: string): Promise<void>;
  getExampleRunIdAsync(name: string): Promise<string | undefined>;
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
  private readonly examples = new Map<string, string>();

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

  async deleteFilesAsync(ownerId: string): Promise<void> {
    for (const key of this.files.keys()) {
      if (key.startsWith(`${ownerId}/`)) {
        this.files.delete(key);
      }
    }
  }

  async saveCompareAsync(compare: StoredCompare): Promise<StoredCompare> {
    const existing = await this.findCompareAsync(
      compare.baselineId,
      compare.candidateId,
      compare.threshold
    );
    if (existing) {
      return existing;
    }
    this.compares.set(compare.id, compare);
    return compare;
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

  async setExampleAsync(name: string, runId: string): Promise<void> {
    this.examples.set(name, runId);
  }

  async getExampleRunIdAsync(name: string): Promise<string | undefined> {
    return this.examples.get(name);
  }
}
