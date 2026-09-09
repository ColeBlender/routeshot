import { z } from 'zod';

import { ServerError } from './errors.js';
import type { CaptureRun } from './types.js';

/**
 * Runtime validation for everything crossing the wire. Kept next to `types.ts` on purpose: the
 * types are the compile-time contract with the CLI, these are the runtime one, and they describe
 * the same shape. `parseCaptureRunAsync`'s caller gets a fully-populated object, because the
 * types use required `| undefined` keys while JSON omits them.
 */
const deviceSchema = z.object({
  udid: z.string(),
  name: z.string(),
  runtime: z.string(),
  state: z.enum(['Booted', 'Shutdown', 'Shutting Down', 'Booting']),
});

const entrySchema = z.object({
  route: z.string().min(1),
  file: z.string().optional(),
  status: z.enum(['captured', 'skipped', 'failed']),
  reason: z.string().optional(),
  settledMs: z.number().optional(),
  settled: z.boolean(),
});

const runSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  createdAt: z.string().min(1),
  device: deviceSchema,
  app: z.object({ bundleId: z.string(), scheme: z.string() }),
  updateUrl: z.string().optional(),
  git: z.object({ sha: z.string().optional(), branch: z.string().optional() }),
  routes: z.array(entrySchema),
});

export function parseCaptureRun(value: unknown): CaptureRun {
  const result = runSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue ? issue.path.join('.') || '(root)' : '(root)';
    throw new ServerError(
      'BAD_REQUEST',
      `index.json is not a valid capture run: ${where}: ${issue?.message ?? 'unknown error'}`
    );
  }
  const run = result.data;
  return {
    id: run.id,
    label: run.label,
    createdAt: run.createdAt,
    device: run.device,
    app: run.app,
    updateUrl: run.updateUrl,
    git: { sha: run.git.sha, branch: run.git.branch },
    routes: run.routes.map((entry) => ({
      route: entry.route,
      file: entry.file,
      status: entry.status,
      reason: entry.reason,
      settledMs: entry.settledMs,
      settled: entry.settled,
    })),
  };
}

export const judgeOutputSchema = z.object({
  score: z.number().min(0).max(100),
  defect: z.enum(['clipped', 'overlap', 'offscreen', 'blank', 'error', 'none']),
  region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullish(),
  caption: z.string(),
});

export type JudgeOutput = z.infer<typeof judgeOutputSchema>;
