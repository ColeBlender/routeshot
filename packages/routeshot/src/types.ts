/**
 * Shared contracts. Everything that touches the outside world (simulator, filesystem, server)
 * goes through one of these interfaces so the core can be exercised with fakes in tests.
 */

export interface Route {
  /** URL path as expo-router would match it, e.g. `/settings/billing` or `/users/[id]`. */
  pathname: string;
  /** True when the pathname contains a dynamic segment (`[id]`, `[...rest]`). */
  dynamic: boolean;
  /** Params that fill the dynamic segments, from config. Undefined when none were provided. */
  params: Record<string, string> | undefined;
  /** Path of the route file relative to the app directory, for messages. */
  sourceFile: string;
  /**
   * The route as expo-router names it on disk, before params were substituted: `/users/[id]`.
   * Same as `pathname` for static routes. Config (`routes.params`, `routes.ignore`) keys off this.
   */
  template?: string;
}

export interface SimulatorDevice {
  udid: string;
  name: string;
  /** e.g. `iOS 26.5` */
  runtime: string;
  state: 'Booted' | 'Shutdown' | 'Shutting Down' | 'Booting';
}

export interface LaunchOptions {
  /**
   * Launch arguments passed to the process. `--routeshot-update-url` is passed for a future
   * native shim; JS reads the update URL from the deep link instead (see `capture.ts`).
   */
  args?: string[];
  env?: Record<string, string>;
}

export interface Simulator {
  listDevicesAsync(): Promise<SimulatorDevice[]>;
  bootAsync(udid: string): Promise<void>;
  installAsync(udid: string, appPath: string): Promise<void>;
  isInstalledAsync(udid: string, bundleId: string): Promise<boolean>;
  launchAsync(udid: string, bundleId: string, options?: LaunchOptions): Promise<void>;
  terminateAsync(udid: string, bundleId: string): Promise<void>;
  openUrlAsync(udid: string, url: string): Promise<void>;
  /** PNG bytes of the whole screen. */
  screenshotAsync(udid: string): Promise<Uint8Array>;
  setAppearanceAsync(udid: string, appearance: 'light' | 'dark'): Promise<void>;
  /** Freezes clock/battery/signal so they never show up as diffs. */
  overrideStatusBarAsync(udid: string): Promise<void>;
  /**
   * Pre-approves `scheme://` links for `bundleId` so iOS never shows the "Open in App?" sheet
   * that would otherwise be the content of every screenshot.
   */
  approveUrlSchemeAsync(udid: string, scheme: string, bundleId: string): Promise<void>;
  /**
   * Quiets expo-dev-menu for `bundleId`: marks its first-launch onboarding as seen and hides the
   * floating gear button, so neither ends up in a screenshot.
   */
  configureDevMenuAsync(udid: string, bundleId: string): Promise<void>;
}

export type CaptureStatus = 'captured' | 'skipped' | 'failed';

export interface CaptureEntry {
  route: string;
  /** File name inside the run directory, e.g. `settings__billing.png`. Absent when not captured. */
  file: string | undefined;
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

export type DefectClass = 'clipped' | 'overlap' | 'offscreen' | 'blank' | 'error' | 'none';

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
  /** Directory the diff images and the report were written to. */
  outDir: string | undefined;
  verdicts: Verdict[] | undefined;
}
