/**
 * Programmatic API. The CLI is a thin wrapper over exactly these functions, so anything
 * `routeshot capture` can do is available from a script or a custom CI step.
 */
export {
  affectedRoutes,
  buildCodeContextAsync,
  changedFilesSinceAsync,
  collectRouteSourcesAsync,
  type AffectedRoutes,
  type CodeContext,
  type RouteSources,
} from './affected.js';
export { captureAsync, routeSlug, type CaptureDeps, type CaptureOptions } from './capture.js';
export {
  defineConfig,
  loadRouteshotConfigAsync,
  DEFAULT_THRESHOLD,
  type RouteshotConfig,
  type RouteshotUserConfig,
} from './config.js';
export { diffRunsAsync, type DiffOptions } from './diff.js';
export { isRouteshotError, RouteshotError, type ErrorCode } from './errors.js';
export {
  buildJudgeRequest,
  createAnthropicJudgeModel,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_THRESHOLDS,
  DEFECT_CLASSES,
  JUDGE_CONCURRENCY,
  JUDGE_SYSTEM_PROMPT,
  JUDGE_TIMEOUT_MS,
  judgeRouteAsync,
  judgeRoutesAsync,
  levelForScore,
  type JudgeDeps,
  type JudgeInput,
  type JudgeModel,
  type JudgeRequest,
  type JudgeThresholds,
} from './judge.js';
export { renderJudgeReport } from './judge-report.js';
export { judgeDepsFromEnv, judgeRunAsync, type JudgeRunResult } from './judge-run.js';
export { enableJsonOutput, Log } from './log.js';
export { renderReport, writeReportAsync } from './report.js';
export { discoverRoutesAsync } from './routes.js';
export {
  CompareResponseSchema,
  UploadRunResponseSchema,
  VerdictSchema,
  type CompareResponse,
  type UploadRunResponse,
} from './server-contract.js';
export { waitForSettledFrameAsync, type SettledFrame, type SettleOptions } from './settle.js';
export { pickDeviceAsync, SimctlSimulator } from './simulator.js';
export {
  requestVerdictsAsync,
  uploadRunAsync,
  type UploadRunOptions,
  type VerdictRequestOptions,
} from './upload.js';
export type {
  CaptureEntry,
  CaptureRun,
  CaptureStatus,
  CompareReport,
  DefectClass,
  DiffStatus,
  LaunchOptions,
  Route,
  RouteDiff,
  Simulator,
  SimulatorDevice,
  Verdict,
  VerdictLevel,
} from './types.js';
