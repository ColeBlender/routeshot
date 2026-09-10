import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RouteshotError } from './errors.js';
import {
  CompareResponseSchema,
  ListRunsResponseSchema,
  UploadRunResponseSchema,
  type CompareResponse,
  type RunSummary,
  type UploadRunResponse,
} from './server-contract.js';
import type { CaptureRun } from './types.js';

export interface ServerOptions {
  serverUrl: string;
  token: string;
}

export interface UploadRunOptions extends ServerOptions {
  /** Run directory holding `index.json` and the PNGs. */
  dir: string;
  run: CaptureRun;
}

/**
 * `POST <server>/runs` as multipart/form-data: `index.json` plus one part per captured route.
 * The part's field name is the file name from `index.json`, which is how the server matches
 * parts to entries without trusting their order.
 */
export async function uploadRunAsync(options: UploadRunOptions): Promise<UploadRunResponse> {
  const form = new FormData();
  form.append(
    'index.json',
    new Blob([JSON.stringify(options.run)], { type: 'application/json' }),
    'index.json'
  );

  // A run that was judged locally carries its verdicts up, so the server can host the same
  // report `--open` showed, at /runs/:id/report.
  try {
    const verdicts = await readFile(join(options.dir, 'verdicts.json'));
    form.append(
      'verdicts.json',
      new Blob([verdicts], { type: 'application/json' }),
      'verdicts.json'
    );
  } catch {
    // Not judged: the server gets the screenshots and code alone.
  }

  for (const entry of options.run.routes) {
    if (entry.status !== 'captured' || entry.file === undefined) {
      continue;
    }
    const bytes = await readFile(join(options.dir, entry.file));
    form.append(entry.file, new Blob([bytes], { type: 'image/png' }), entry.file);
    // The code behind the screen travels with it: the server's judge reads it the same way the
    // CLI's does. Without it the server can only look at pixels.
    if (entry.code !== undefined) {
      const code = await readFile(join(options.dir, entry.code));
      form.append(entry.code, new Blob([code], { type: 'text/plain' }), entry.code);
    }
  }

  const response = await fetch(absolute(options.serverUrl, '/runs'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.token}` },
    body: form,
  });
  if (!response.ok) {
    throw new RouteshotError(
      'UPLOAD',
      `Upload of run ${options.run.id} failed: ${response.status} ${await safeTextAsync(response)}`
    );
  }

  const parsed = UploadRunResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new RouteshotError('UPLOAD', 'Server returned an unexpected /runs response');
  }
  return { ...parsed.data, url: absolute(options.serverUrl, parsed.data.url) };
}

export interface ListRunsOptions extends ServerOptions {
  branch?: string;
  limit?: number;
}

export async function listRunsAsync(options: ListRunsOptions): Promise<RunSummary[]> {
  const url = new URL(absolute(options.serverUrl, '/runs'));
  if (options.branch !== undefined) {
    url.searchParams.set('branch', options.branch);
  }
  if (options.limit !== undefined) {
    url.searchParams.set('limit', String(options.limit));
  }

  const response = await fetch(url, { headers: { Authorization: `Bearer ${options.token}` } });
  if (!response.ok) {
    throw new RouteshotError(
      'UPLOAD',
      `Listing runs failed: ${response.status} ${await safeTextAsync(response)}`
    );
  }
  const parsed = ListRunsResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new RouteshotError('UPLOAD', 'Server returned an unexpected /runs list');
  }
  return parsed.data.runs;
}

/**
 * A run reference on the server: an id as returned by upload, or a branch name, which resolves
 * to the newest run uploaded from that branch. That is what lets CI say "compare against main".
 */
export async function resolveRemoteRunIdAsync(
  options: ServerOptions,
  ref: string
): Promise<string> {
  const byId = await fetch(absolute(options.serverUrl, `/runs/${encodeURIComponent(ref)}`), {
    headers: { Authorization: `Bearer ${options.token}` },
  });
  if (byId.ok) {
    return ref;
  }
  const [newest] = await listRunsAsync({ ...options, branch: ref, limit: 1 });
  if (newest === undefined) {
    throw new RouteshotError(
      'COMPARE',
      `No run "${ref}" on ${options.serverUrl}: not an id, and no run uploaded from a branch by that name`
    );
  }
  return newest.id;
}

export interface VerdictRequestOptions extends ServerOptions {
  baselineId: string;
  candidateId: string;
  threshold?: number;
}

/** Asks the server to compare two already-uploaded runs and judge the changed screens. */
export async function requestVerdictsAsync(
  options: VerdictRequestOptions
): Promise<CompareResponse> {
  const url = new URL(absolute(options.serverUrl, '/compare'));
  url.searchParams.set('baseline', options.baselineId);
  url.searchParams.set('candidate', options.candidateId);
  if (options.threshold !== undefined) {
    url.searchParams.set('threshold', String(options.threshold));
  }

  const response = await fetch(url, { headers: { Authorization: `Bearer ${options.token}` } });
  if (!response.ok) {
    throw new RouteshotError(
      'UPLOAD',
      `Compare request failed: ${response.status} ${await safeTextAsync(response)}`
    );
  }

  const parsed = CompareResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new RouteshotError('UPLOAD', 'Server returned an unexpected /compare response');
  }
  return { ...parsed.data, url: absolute(options.serverUrl, parsed.data.url) };
}

/** The server answers with paths relative to its own origin; callers want something clickable. */
function absolute(serverUrl: string, pathOrUrl: string): string {
  return new URL(pathOrUrl, `${serverUrl.replace(/\/+$/, '')}/`).toString();
}

async function safeTextAsync(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    // A body that cannot be read is not worth failing the error path over.
    return '';
  }
}
