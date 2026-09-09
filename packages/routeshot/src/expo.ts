import * as Updates from 'expo-updates';

/**
 * The React Native half of routeshot: `routeshot/expo`.
 *
 * Why a deep link and not a launch argument. `xcrun simctl launch --args` and
 * `SIMCTL_CHILD_<VAR>` both land in the native process, and React Native exposes neither
 * `NSProcessInfo.arguments` nor `getenv` to JS without a native module, which would mean shipping
 * an autolinked pod to read one string. `Linking` already exists in every RN app and
 * `xcrun simctl openurl` is already how routeshot navigates, so the update URL rides the channel
 * that is guaranteed to be there. The CLI still passes `--routeshot-update-url` on launch so a
 * native shim can take over later without a CLI change.
 *
 * Why this file imports nothing but `expo-updates`. It is bundled into the app under test, and
 * `react-native`'s type declarations replace the global `fetch`, `FormData` and `Blob` for every
 * file in the package, which silently breaks the Node-side uploader. So the two things the hook
 * needs are passed in by the caller and typed structurally here.
 */
const UPDATE_LINK = /^[^:]+:\/\/routeshot\/update\?url=(.+)$/;

/** The `Linking` module from `react-native`, structurally. */
export interface RouteshotLinking {
  getInitialURL(): Promise<string | null>;
  addEventListener(type: 'url', handler: (event: { url: string }) => void): { remove: () => void };
}

/** React's `useEffect`, structurally. */
export type RouteshotUseEffect = (
  effect: () => undefined | (() => void),
  deps: readonly unknown[]
) => void;

/** `myapp://routeshot/update?url=<encoded>` to the manifest URL. Undefined for any other link. */
export function parseRouteshotUpdateUrl(deepLink: string | null | undefined): string | undefined {
  if (deepLink === null || deepLink === undefined) {
    return undefined;
  }
  // RN's URL polyfill has no usable `searchParams`, so the query comes apart by hand.
  const encoded = UPDATE_LINK.exec(deepLink)?.[1];
  return encoded === undefined ? undefined : decodeURIComponent(encoded);
}

/**
 * Sets the update override if the link carries one, and reports whether it did. The override only
 * takes effect on the *next* launch, which is why the CLI terminates and relaunches the app right
 * after handing the link over.
 */
export async function applyRouteshotUpdateOverrideAsync(
  deepLink: string | null | undefined
): Promise<boolean> {
  const updateUrl = parseRouteshotUpdateUrl(deepLink);
  if (updateUrl === undefined) {
    return false;
  }

  // Requires `updates.disableAntiBrickingMeasures`, which is why the runner build is its own EAS
  // profile and is never distributed.
  Updates.setUpdateURLAndRequestHeadersOverride({ updateUrl, requestHeaders: {} });
  return true;
}

/**
 * Drop into the root layout of a routeshot runner build:
 *
 * ```tsx
 * import { useEffect } from 'react';
 * import { Linking } from 'react-native';
 * import { useRouteshotUpdateOverride } from 'routeshot/expo';
 *
 * useRouteshotUpdateOverride({ useEffect, Linking });
 * ```
 *
 * Safe to leave in a build routeshot never drives: without the deep link it does nothing.
 */
export function useRouteshotUpdateOverride(runtime: {
  useEffect: RouteshotUseEffect;
  Linking: RouteshotLinking;
}): void {
  const { useEffect, Linking } = runtime;
  useEffect(() => {
    // A runner build that cannot apply the override still captures the bundle it already has;
    // throwing out of a link handler would crash the app under test, which is strictly worse.
    const apply = (link: string | null) => {
      applyRouteshotUpdateOverrideAsync(link).catch(() => undefined);
    };

    // Cold start: the link the app launched with. Warm: the listener below.
    Linking.getInitialURL().then(apply, () => undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => {
      apply(url);
    });
    return () => {
      subscription.remove();
    };
  }, []);
}
