# Routeshot Example

A small, deliberately boring Expo Router app. It exists so `routeshot` has something real to
walk: a tab bar, a stack nested inside a tab, a dynamic route, a modal, and a plain stack screen.

Every screen is deterministic by construction. No clocks, no random data, no network calls, no
animations that never settle, and only static bundled images. A pixel that changes between two
runs changed because the code changed.

```
npm install             # from the repo root
cd example
npx expo run:ios        # builds the dev client and launches the simulator
```

`npx expo run:ios` produces a development build, so **Metro has to be running** for the app to
load JavaScript. `expo run:ios` starts it for you on the first run. After that, keep
`npx expo start` running in another shell, or the app will launch to a red "could not connect to
the development server" screen.

## Routes

| Route       | File                              | Deep link                             |
| ----------- | --------------------------------- | ------------------------------------- |
| Home        | `app/(tabs)/index.tsx`            | `routeshotexample://`                 |
| Explore     | `app/(tabs)/explore.tsx`          | `routeshotexample://explore`          |
| Settings    | `app/(tabs)/settings/index.tsx`   | `routeshotexample://settings`         |
| Billing     | `app/(tabs)/settings/billing.tsx` | `routeshotexample://settings/billing` |
| Item detail | `app/items/[id].tsx`              | `routeshotexample://items/42`         |
| Modal       | `app/modal.tsx`                   | `routeshotexample://modal`            |
| About       | `app/about.tsx`                   | `routeshotexample://about`            |

Billing is the interesting one. Reaching it from a cold start means restoring the tab navigator,
then the Settings tab's own stack, then pushing Billing on top, with the tab bar still visible.
That is the hardest case routeshot has to get right.

`items/[id]` cannot be deep-linked without a value, which is why `routeshot.config.ts` pins
`id` to `42`.

## Scenarios

The app reads `EXPO_PUBLIC_ROUTESHOT_SCENARIO` at Metro bundle time, so switching scenarios is a
reload, never a native rebuild. This is what the judge is calibrated against: `broken` holds one
instance of each defect class the judge is supposed to name, and `benign` holds changes that move
pixels without anything being wrong.

```
npx expo start                                        # baseline
EXPO_PUBLIC_ROUTESHOT_SCENARIO=benign npx expo start  # or: npm run start:benign
EXPO_PUBLIC_ROUTESHOT_SCENARIO=broken npx expo start  # or: npm run start:broken
```

| Route       | `benign`                            | expected       | `broken`                                      | expected         |
| ----------- | ----------------------------------- | -------------- | --------------------------------------------- | ---------------- |
| Home        | Subtitle copy rewritten             | GREEN, changed | Title in a fixed-height box, clipped mid-word | RED, `clipped`   |
| Explore     | Accent colour green instead of blue | GREEN, changed | Badge absolutely positioned over the caption  | RED, `overlap`   |
| Settings    | List rows in reverse order          | GREEN, changed | unchanged                                     | GREEN            |
| Billing     | unchanged                           | GREEN          | Primary button pushed below the viewport      | RED, `offscreen` |
| Item detail | unchanged                           | GREEN          | Renders an empty white screen                 | RED, `blank`     |
| Modal       | unchanged                           | GREEN          | unchanged                                     | GREEN            |
| About       | unchanged                           | GREEN          | Renders a red "Something went wrong" box      | RED, `error`     |

"GREEN, changed" means the diff is non-zero and the judge should still say the screen looks fine.
An unchanged row is a control: it should stay identical across all three scenarios, so any diff on
it is a false positive in routeshot itself.

Scenario logic lives in `lib/scenario.ts` and is applied inline in each screen next to a comment
saying what it breaks. Nothing is hidden behind indirection.

## EAS build profiles

`eas.json` defines two profiles. `preview` is an ordinary internal simulator build.

**`routeshot` is a runner build and is never distributed.** It sets
`updates.disableAntiBrickingMeasures: true` through `app.config.ts`, which turns off the rollback
protection that stops a bad update from bricking the app. That is precisely what lets one
installed build be pointed at an arbitrary EAS update group, and precisely why Expo's own docs say
not to enable it in production. It is a simulator-only artefact for CI and for a developer
machine. It never goes to TestFlight, never to a device farm, and never to anyone outside this
repo.

The gate is the `ROUTESHOT_UPDATE_OVERRIDE=1` variable set in that profile's `env` block.
`app.config.ts` also checks `EAS_BUILD_PROFILE`, but Expo documents that the built-in `EAS_*`
variables are not available when the config is evaluated locally, so the explicit variable is the
one that actually decides.

## Capturing on the simulator

Two things bite before a single screenshot is taken. Both were measured on macOS with Xcode 26.6
and the iOS 26.5 simulator runtime, on 2026-09-09.

**iOS asks before opening a custom scheme.** `xcrun simctl openurl booted routeshotexample://...`
puts up a system alert, "Open in Routeshot Example?", and waits. It happens whether the app is
running or not, so the capture just hangs on a picture of a dialog. Pre-approving the scheme in
LaunchServices clears it, and the write only takes effect after SpringBoard restarts:

```
xcrun simctl spawn booted defaults write com.apple.launchservices.schemeapproval \
  "com.apple.CoreSimulator.CoreSimulatorBridge-->routeshotexample" -string "dev.routeshot.example"
xcrun simctl spawn booted launchctl stop com.apple.SpringBoard
```

**A development build cold-starts into the dev launcher, not the app.** Terminate the app, send
it `routeshotexample://settings/billing`, and you land on the "Development Servers" list with the
link discarded. Opening the dev-client URL first loads the bundle, and the route link then works:

```
xcrun simctl terminate booted dev.routeshot.example
xcrun simctl openurl booted 'exp+routeshot-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'
# wait for the bundle to load, then
xcrun simctl openurl booted routeshotexample://settings/billing
```

That is a fresh process every time, so navigation state really is restored from the link rather
than left over from the previous route. A release build has neither problem and needs no Metro,
which is the better capture target where an update override is not needed.

The dev client also draws a floating gear button over the top right of every screen, and shows a
blue "Refreshing" banner while it reconnects to Metro. The gear sits in the same place every run
so it diffs clean, but the banner does not, which is another reason to prefer a release build.
