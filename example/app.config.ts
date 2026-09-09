import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Static config lives in app.json. This file only layers on the one thing that must NOT be
 * baked into every build: the EAS Update anti-bricking override.
 *
 * ============================================================================================
 *  A BUILD PRODUCED BY THE `routeshot` PROFILE IS NEVER DISTRIBUTED.
 *  `updates.disableAntiBrickingMeasures` turns off the rollback protection that stops a bad
 *  update from bricking the app, which is exactly what lets routeshot point a single installed
 *  runner build at an arbitrary EAS update group. Expo's own docs say do not enable this in
 *  production builds. It exists here for one purpose: a simulator-only runner on CI and on a
 *  developer machine. It is never uploaded to TestFlight, never sent to a device farm, and
 *  never shared with anyone outside the repo.
 * ============================================================================================
 *
 * The gate is the eas.json `routeshot` profile, which sets `ROUTESHOT_UPDATE_OVERRIDE=1` in its
 * own `env` block. `EAS_BUILD_PROFILE` is also checked, but Expo documents that the built-in
 * EAS_* variables are not available when app.config.ts is evaluated locally, so the explicit
 * per-profile variable is the reliable signal and the profile name is the belt-and-braces one.
 */
const isRouteshotRunner =
  process.env.ROUTESHOT_UPDATE_OVERRIDE === '1' || process.env.EAS_BUILD_PROFILE === 'routeshot';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  updates: {
    ...config.updates,
    ...(isRouteshotRunner ? { disableAntiBrickingMeasures: true } : {}),
  },
});
