import { diffPngs } from './diff.js';
import { judgeRoutesAsync, type JudgeDeps, type JudgeInput } from './judge.js';
import type { FileStore, StoredFile, StoredRun } from './store.js';
import type { CaptureEntry, CompareReport, RouteDiff, Verdict } from './types.js';

export interface CompareInput {
  compareId: string;
  baseline: StoredRun;
  candidate: StoredRun;
  /** Diff ratio above which a route counts as changed. */
  threshold: number;
  files: FileStore;
  /** Undefined disables the AI verdict entirely (no API key configured). */
  judge: JudgeDeps | undefined;
}

export interface CompareResult {
  report: CompareReport;
  /** Diff masks to persist under the compare id before the report is served. */
  diffFiles: StoredFile[];
}

async function loadAsync(
  files: FileStore,
  runId: string,
  entry: CaptureEntry | undefined
): Promise<Uint8Array | undefined> {
  if (entry?.status !== 'captured' || entry.file === undefined) {
    return undefined;
  }
  return await files.getFileAsync(runId, entry.file);
}

export async function compareRunsAsync(input: CompareInput): Promise<CompareResult> {
  const baselineEntries = new Map(input.baseline.index.routes.map((entry) => [entry.route, entry]));
  const candidateEntries = new Map(
    input.candidate.index.routes.map((entry) => [entry.route, entry])
  );
  const routes = [...new Set([...baselineEntries.keys(), ...candidateEntries.keys()])].sort();

  const diffs: RouteDiff[] = [];
  const diffFiles: StoredFile[] = [];
  const judgeInputs: JudgeInput[] = [];
  const preVerdicts = new Map<string, Verdict>();

  for (const route of routes) {
    const baselineEntry = baselineEntries.get(route);
    const candidateEntry = candidateEntries.get(route);
    const before = await loadAsync(input.files, input.baseline.id, baselineEntry);
    const after = await loadAsync(input.files, input.candidate.id, candidateEntry);
    const files = {
      before: before ? baselineEntry?.file : undefined,
      after: after ? candidateEntry?.file : undefined,
      diff: undefined as string | undefined,
    };

    if (!before && !after) {
      diffs.push({
        route,
        status: 'unverified',
        diffRatio: undefined,
        diffPixels: undefined,
        files,
        reason: candidateEntry?.reason ?? baselineEntry?.reason ?? 'no screenshot in either run',
      });
      preVerdicts.set(route, verdict(route, 'unverified', 'no screenshot to compare'));
      continue;
    }

    if (!before) {
      diffs.push({
        route,
        status: 'added',
        diffRatio: undefined,
        diffPixels: undefined,
        files,
        reason: baselineEntry ? baselineEntry.reason : 'route is not in the baseline run',
      });
      preVerdicts.set(route, verdict(route, 'unverified', 'new route, no baseline to compare'));
      continue;
    }

    if (!after) {
      diffs.push({
        route,
        status: 'removed',
        diffRatio: undefined,
        diffPixels: undefined,
        files,
        reason: candidateEntry ? candidateEntry.reason : 'route is not in the candidate run',
      });
      preVerdicts.set(route, verdict(route, 'unverified', 'route missing from the candidate run'));
      continue;
    }

    const result = diffPngs(before, after);
    if (result.status === 'unverified') {
      diffs.push({
        route,
        status: 'unverified',
        diffRatio: undefined,
        diffPixels: undefined,
        files,
        reason: result.reason,
      });
      preVerdicts.set(route, verdict(route, 'unverified', result.reason));
      continue;
    }

    const changed = result.diffRatio > input.threshold;
    if (changed) {
      // Diff masks are only worth storing for routes the report will actually show side by side.
      const name = candidateEntry?.file ?? `${route.replaceAll('/', '_')}.png`;
      diffFiles.push({ name, bytes: result.png });
      files.diff = name;
    }
    diffs.push({
      route,
      status: changed ? 'changed' : 'unchanged',
      diffRatio: result.diffRatio,
      diffPixels: result.diffPixels,
      files,
      reason: undefined,
    });

    if (changed) {
      const codeBytes =
        candidateEntry?.code === undefined
          ? undefined
          : await input.files.getFileAsync(input.candidate.id, candidateEntry.code);
      judgeInputs.push({
        route,
        screenshot: after,
        code: codeBytes === undefined ? undefined : new TextDecoder().decode(codeBytes),
      });
    } else {
      // Identical pixels cannot hide a defect the baseline did not already have, so this is a
      // green verdict with no AI call: the judge only ever sees screens that moved.
      preVerdicts.set(route, {
        route,
        level: 'green',
        score: 0,
        defect: 'none',
        region: undefined,
        caption: 'no visible change',
      });
    }
  }

  const judged = input.judge ? await judgeRoutesAsync(judgeInputs, input.judge) : [];
  for (const item of judged) {
    preVerdicts.set(item.route, item);
  }

  const report: CompareReport = {
    baseline: { id: input.baseline.id, label: input.baseline.label },
    candidate: { id: input.candidate.id, label: input.candidate.label },
    threshold: input.threshold,
    routes: diffs,
    summary: {
      total: diffs.length,
      unchanged: diffs.filter((item) => item.status === 'unchanged').length,
      changed: diffs.filter((item) => item.status === 'changed').length,
      added: diffs.filter((item) => item.status === 'added').length,
      removed: diffs.filter((item) => item.status === 'removed').length,
      unverified: diffs.filter((item) => item.status === 'unverified').length,
    },
    verdicts: input.judge
      ? diffs.map(
          (item) => preVerdicts.get(item.route) ?? verdict(item.route, 'unverified', 'not judged')
        )
      : undefined,
  };

  return { report, diffFiles };
}

function verdict(route: string, level: 'unverified', caption: string): Verdict {
  return { route, level, score: undefined, defect: 'none', region: undefined, caption };
}
