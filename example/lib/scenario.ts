/**
 * Scenario switch for the routeshot judge eval.
 *
 * `EXPO_PUBLIC_ROUTESHOT_SCENARIO` is inlined by Metro at bundle time, so switching
 * scenarios needs a Metro restart but never a native rebuild. Metro keys its transform cache on
 * `EXPO_PUBLIC_*` values, so no `--clear` is needed (verified: baseline then broken, 5 red).
 *
 *   baseline  the app as it should look (every route GREEN against itself)
 *   benign    real but harmless changes (routes should read as CHANGED, not broken)
 *   broken    deliberate visual defects the judge is supposed to catch (RED)
 */
export type Scenario = 'baseline' | 'benign' | 'broken';

const raw = process.env.EXPO_PUBLIC_ROUTESHOT_SCENARIO;

export const scenario: Scenario = raw === 'benign' || raw === 'broken' ? raw : 'baseline';

export const isBaseline = scenario === 'baseline';
export const isBenign = scenario === 'benign';
export const isBroken = scenario === 'broken';

/** Pick a value per scenario, falling back to the baseline value. */
export function pick<T>(values: { baseline: T; benign?: T; broken?: T }): T {
  return values[scenario] ?? values.baseline;
}
