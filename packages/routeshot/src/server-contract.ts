import { z } from 'zod';

/**
 * The wire contract between the CLI and the report server. Both sides parse with these schemas.
 * Kept deliberately small and dependency-free (zod only) so the server can copy this file
 * verbatim instead of depending on the CLI package. URLs may be relative to the server origin.
 */

export const VerdictLevelSchema = z.enum(['green', 'yellow', 'red', 'unverified']);

export const DefectClassSchema = z.enum([
  'clipped',
  'overlap',
  'offscreen',
  'blank',
  'error',
  'none',
]);

export const VerdictSchema = z.object({
  route: z.string(),
  level: VerdictLevelSchema,
  /** 0..100 likelihood the screen is broken. Absent when the judge could not look at it. */
  score: z.number().min(0).max(100).optional(),
  defect: DefectClassSchema,
  region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
  caption: z.string(),
});

/** `POST /runs` — multipart body of `index.json` plus one part per screenshot. */
export const UploadRunResponseSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
});

/** `GET /runs?branch=&limit=` — newest first. */
export const RunSummarySchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  createdAt: z.string(),
  branch: z.string().optional(),
  sha: z.string().optional(),
});

export const ListRunsResponseSchema = z.object({ runs: z.array(RunSummarySchema) });

/** `GET /compare?baseline=&candidate=` — the hosted report plus the per-route AI verdicts. */
export const CompareResponseSchema = z.looseObject({
  id: z.string().min(1),
  url: z.string().min(1),
  summary: z.object({
    total: z.number(),
    unchanged: z.number(),
    changed: z.number(),
    added: z.number(),
    removed: z.number(),
    unverified: z.number(),
  }),
  /** Omitted by the server when it runs without an Anthropic key. */
  verdicts: z.array(VerdictSchema).optional(),
});

export type UploadRunResponse = z.infer<typeof UploadRunResponseSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type CompareResponse = z.infer<typeof CompareResponseSchema>;
