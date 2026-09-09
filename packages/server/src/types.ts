/**
 * Wire contracts shared with the CLI. These are COPIES of `packages/routeshot/src/types.ts`,
 * deliberately duplicated rather than imported: the server is deployed on its own and must not
 * take a build dependency on the published CLI package. The shapes must stay identical; the
 * upload endpoint validates incoming payloads against `runSchema` in `schemas.ts`.
 */

export interface SimulatorDevice {
  udid: string;
  name: string;
  /** e.g. `iOS 26.5` */
  runtime: string;
  state: 'Booted' | 'Shutdown' | 'Shutting Down' | 'Booting';
}

export type CaptureStatus = 'captured' | 'skipped' | 'failed';

export interface CaptureEntry {
  route: string;
  /** File name inside the run directory, e.g. `settings__billing.png`. Absent when not captured. */
  file: string | undefined;
  /** File name of the source bundle the judge reads next to the screenshot (`<slug>.code.txt`). */
  code: string | undefined;
  status: CaptureStatus;
  /** Why it was skipped or failed. */
  reason: string | undefined;
  /** How long the screen took to stop changing. Undefined when it never settled before the cap. */
  settledMs: number | undefined;
  settled: boolean;
}

export interface CaptureRun {
  /** Run identifier, unique per machine, e.g. `2026-09-09T20-15-03Z-main-3f2a9c1`. */
  id: string;
  label: string;
  createdAt: string;
  device: SimulatorDevice;
  app: { bundleId: string; scheme: string };
  /** Present when the run was pointed at a specific EAS update group. */
  updateUrl: string | undefined;
  git: { sha: string | undefined; branch: string | undefined };
  /** Present when `--changed-since` narrowed the run to the screens a code change touched. */
  affected:
    | {
        since: string;
        changedFiles: string[];
        all: string | undefined;
        because: Record<string, string[]>;
        ignored: string[];
      }
    | undefined;
  routes: CaptureEntry[];
}

export type DiffStatus = 'unchanged' | 'changed' | 'added' | 'removed' | 'unverified';

export interface RouteDiff {
  route: string;
  status: DiffStatus;
  /** Fraction of pixels that differ, 0..1. Undefined when one side is missing. */
  diffRatio: number | undefined;
  diffPixels: number | undefined;
  files: { before: string | undefined; after: string | undefined; diff: string | undefined };
  /** Why the route could not be verified (capture failed, sizes differ, never settled). */
  reason: string | undefined;
}

export type VerdictLevel = 'green' | 'yellow' | 'red' | 'unverified';

export type DefectClass =
  | 'clipped'
  | 'overlap'
  | 'offscreen'
  | 'wrapped'
  | 'missing'
  | 'blank'
  | 'error'
  | 'other'
  | 'none';

export interface Verdict {
  route: string;
  level: VerdictLevel;
  /** 0..100, the judge's estimate that something is broken. Undefined when unverified. */
  score: number | undefined;
  defect: DefectClass;
  /** Normalized bounding box of the suspected defect, 0..1 of width/height. */
  region: { x: number; y: number; w: number; h: number } | undefined;
  caption: string;
}

export interface CompareReport {
  baseline: { id: string; label: string };
  candidate: { id: string; label: string };
  threshold: number;
  routes: RouteDiff[];
  summary: {
    total: number;
    unchanged: number;
    changed: number;
    added: number;
    removed: number;
    unverified: number;
  };
  verdicts: Verdict[] | undefined;
}
