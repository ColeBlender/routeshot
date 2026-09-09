# Build notes (working log, not shipped)

Decisions made while building, and blockers that need Cole. Newest at the bottom.

## Blockers needing Cole (status 2026-09-09 13:30 PT)

- [x] DONE 2026-09-09: EAS update-group mode proven end to end (see the spike section below). The dev-client launcher loads a manifest URL directly, so no anti-bricking flag is needed on that path; the `routeshot/expo` hook + runner profile stay for release runner builds and are unit-tested only.
- [ ] Railway: `railway link` a new project, then `railway config apply` (needs CLI >= 5.42.1; installed 5.26.1) reads `.railway/railway.ts`. Set ROUTESHOT_TOKEN and ANTHROPIC_API_KEY with `railway variables --set` before the first deploy.
- [ ] `ANTHROPIC_API_KEY`: in `packages/server/.env` locally, then `pnpm judge:eval` scores the thresholds against the labeled example screens and the numbers go in the README. Nothing has been judged by the model yet; every verdict so far is `unverified` by design.
- [ ] Decide when the repo goes public and gets the `v1` tag (README references `@main` until then).
- [ ] Run the manual `dogfood` workflow once (Actions > CI > Run workflow) to see whether hosted macOS runners are pixel-identical to this Mac.

## Decisions

- pnpm pinned to 10.25.0 (what is installed). Expo is on pnpm 12; bump later if install is clean under corepack.
- TS 6.0.3, not 7: Expo repos are on 6.x, and tsdown/oxlint-tsgolint compat with 7 is unverified.
- oxlint `node` + `typescript-analysis` presets from oxlint-config-universe, plus eas-cli's hand-picked rules (no-console, curly, no lodash, async-suffix via eslint-plugin-async-protect, which is what eas-cli uses).
- Vitest `projects` at the root, one config per package. Tests in `__tests__/` next to src (Expo convention), `*.test.ts` naming (Vitest default).
- RESOLVED: `compare --remote` exists (server-side compare, refs are server run ids or branch names) and action.yml uses it.
- RESOLVED: README has the real hero run, the measured numbers, and the threshold decision.

## Spike measurements (2026-09-09, iPhone 17 Pro, iOS 26.5, dev client + Metro, example app)

- Pixel noise: two identical captures, 7 routes, 0 differing pixels on every route (0.0000%). Threshold can be tight.
- Benign scenario vs baseline: Home 0.30%, Explore 0.47%, Settings 0.44%; the other four routes exactly 0.
- Broken scenario vs baseline: Home 10.65% (clipped title), Billing 4.27% (button off-screen), Explore 2.33% (overlap), About 2.06% (error box), Item 1.17% (blank); Modal and Settings exactly 0.
- Decision: DEFAULT_THRESHOLD 0.01 -> 0.001. The 1% default the builder chose ("simulator noise") would have reported every benign change as unchanged.
- Cold deep link into the nested route (tabs > settings stack > billing) works; the sequence / -> about -> explore -> items/42 -> modal -> settings -> settings/billing all landed on the right screen with the tab bar intact. Settle times 0.9s-3.3s per route; a full 7-route capture is ~19s.
- iOS 26 "Open in Routeshot Example?" sheet: solved by pre-approving the scheme in com.apple.launchservices.schemeapproval + a SpringBoard restart (approveUrlSchemeAsync).
- expo-dev-client: the launcher swallows the first deep link, so capture opens `exp+<slug>://expo-development-client/?url=<metro>` first (bootDevClientAsync). expo-dev-menu's gear FAB and onboarding sheet are turned off through its own defaults keys (configureDevMenuAsync). Same launcher link loads an EAS update manifest URL, so `--update-url` on a dev client needs no anti-bricking override at all.
- `pod install` needs LANG=en_US.UTF-8 on this Mac (Ruby 4 encoding crash); `expo prebuild` still exits 0 when it fails. CI must export it.
- c12 prints a Node MODULE_TYPELESS_PACKAGE_JSON warning when loading routeshot.config.ts from an app without "type": "module". Cosmetic; look at c12 jiti options or document.

## Review gate (2026-09-09 13:00 PT, Opus with eas-cli's .expo-code-review prompts + slop checklist)

- Verdict: hire signal. Blocking: Actions template injection in action.yml (inputs interpolated into run: and the github-script body), /compare returning a dead link on a race (ON CONFLICT DO NOTHING). Both fixed.
- Should-fix done: fail-on-change input, judge structured-output latch scoped, Postgres service container in CI so the real store is tested, upload id-probe sends the token, action SHAs pinned, MemoryStore dev path, stale docs.
- Left as nits on purpose: two HTML renderers (CLI and server) share no code by design (the package must not depend on the server); routeSlug collision between `/a/b` and a literal `/a__b` route is theoretical.

## EAS update-group mode, proven end to end (2026-09-09, iPhone 17 Pro, iOS 26.5)

- `eas update:configure` replaced the `updates.url` placeholder in `example/app.json` with
  `https://u.expo.dev/268c423a-95a4-41de-86d2-aa2ea02ebdfe`. Runtime versions already matched:
  the installed dev build's `Expo.plist` has `EXUpdatesRuntimeVersion 1.0.0` and the `appVersion`
  policy publishes `1.0.0`. No rebuild was needed.
- eas-cli 24 refuses `update --non-interactive` without `--environment`. Both publishes used
  `--environment production`. Anything scripted (CI, the Action) has to pass it.
- Two updates on branch `routeshot`, distinct bundles (`entry-59264ba1...hbc` vs `entry-e0fd3d94...hbc`):
  baseline update `01a087f2-1091-7836-b999-e4a3257946cc` in group `b9ab34f5-5d8b-4a8a-89d5-588cac93ff20`,
  broken update `01a087f2-71f7-7e27-856d-72df1eb59050` in group `5faff6dd-871c-4204-8fbc-49935c47f4d0`.
- Both manifest URL forms load in the dev client through
  `exp+routeshot-example://expo-development-client/?url=<encoded>`: the per-platform
  `https://u.expo.dev/update/<updateId>` (what `eas update --json` calls `manifestPermalink`) and
  the group `https://u.expo.dev/<projectId>/group/<groupId>`. Switching between them is not sticky;
  each launcher open loads the URL it was given.
- Anti-bricking was left ON and the installed build's baked-in `EXUpdatesURL` is still the
  placeholder. Neither matters on the launcher path, which is the point.
- `capture --update-url` on each, then `compare`: 5 changed, 2 unchanged. Home 10.65%,
  Billing 4.27%, Explore 2.33%, About 2.06%, Item 1.17%, Modal and Settings exactly 0. Identical to
  the Metro-driven spike numbers above, so the EAS path is pixel-equivalent to the Metro path.
- The `routeshot/expo` hook did not run: `config.devClient` is auto-detected, so `captureAsync`
  takes `bootDevClientAsync` and never sends the `routeshotexample://routeshot/update?url=` deep
  link that `applyRouteshotUpdateOverrideAsync` parses. Still release-path-only and unit-tested only.
- Determinism on the update path is as clean as on Metro: two separate captures of the same
  published baseline, loaded fresh each time, came back 0 changed / 7 unchanged.
- Bug found and fixed while proving this: `simctl io <udid> screenshot --type=png -` is not honoured
  as stdout on this Xcode, so simctl wrote a 184 KB PNG literally named `-` into the project root on
  every capture (the temp-file fallback in `screenshotAsync` is what actually returned the bytes, so
  it was silent). `screenshotToStdoutAsync` now spawns with `cwd: os.tmpdir()`
  (packages/routeshot/src/simulator.ts:344). Verified: a fresh capture leaves no `example/-`.
