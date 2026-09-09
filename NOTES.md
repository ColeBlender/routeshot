# Build notes (working log, not shipped)

Decisions made while building, and blockers that need Cole. Newest at the bottom.

## Blockers needing Cole (status 2026-09-09 13:30 PT)

- [x] DONE 2026-09-09: EAS update-group mode proven end to end (see the spike section below). The dev-client launcher loads a manifest URL directly, so no anti-bricking flag is needed on that path; the `routeshot/expo` hook + runner profile stay for release runner builds and are unit-tested only.
- [x] DONE 2026-09-09 14:15: Railway project live (see Deployed below). Was: `railway link` a new project, then `railway config apply` (needs CLI >= 5.42.1; installed 5.26.1) reads `.railway/railway.ts`. Set ROUTESHOT_TOKEN and ANTHROPIC_API_KEY with `railway variables --set` before the first deploy.
- [x] DONE 2026-09-09: judge eval 14/14 levels, 13/14 labels, numbers in the README. Was: `ANTHROPIC_API_KEY` in `packages/server/.env` locally, then `pnpm judge:eval` scores the thresholds against the labeled example screens and the numbers go in the README. Nothing has been judged by the model yet; every verdict so far is `unverified` by design.
- [ ] Decide when the repo goes public and gets the `v1` tag (README references `@main` until then).
- [ ] IN FLIGHT 2026-09-09 15:00 PT (run 34409757505): the manual `dogfood` workflow (Actions > CI > Run workflow) to see whether hosted macOS runners are pixel-identical to this Mac.

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

## Deployed (2026-09-09 14:15 PT)

- Railway project `routeshot`: `routeshot-server` + `routeshot-postgres`, https://routeshot-server-production.up.railway.app (/health ok). IaC applied from `.railway/railway.ts`; domain (port 8080) and the three secrets set by hand.
- GitHub secrets ROUTESHOT_SERVER_URL / ROUTESHOT_SERVER_TOKEN set on the repo; same values in example/.env.local (gitignored).
- Live smoke: upload x2 + compare --remote -> hosted report with real verdicts (About: red 97 error).
- Judge eval with the live key: 14/14 levels, 13/14 labels (Billing off-screen button read as `blank`).
- EAS update mode proven: `--update-url https://u.expo.dev/update/<updateId>` (or the group URL) on the dev client, no override, same ratios as Metro.
- Avoid the Railway MCP's list_variables on this project: it returns secret values in plaintext into the transcript.

## Clean-room pass (2026-09-09 15:00 PT)

- Fresh `git clone` into a scratch dir, README quickstart followed literally, three times as fixes landed.
- Found and fixed: pnpm never linked the `routeshot` bin because `dist/cli.js` did not exist at install
  time (`prepare: tsdown` now builds it during install, and `pnpm build` left the quickstart); `compare
before after` failed because refs did not resolve by label; the c12 MODULE_TYPELESS warning on every
  run (config now loads through jiti); the `pnpm approve-builds` notice for esbuild; the judge stripping
  the opening quote of a caption that starts with a quoted word.
- Final run on the pushed main: install only, 7/7 captured in 17s, compare by label reports the same
  five ratios as the README (10.65 / 2.06 / 2.33 / 1.17 / 4.27). Hosted path from the same clone:
  upload x2 + `compare --remote` gave five red verdicts, all correct.
- Still Cole's: decide NOTES.md's fate and the v1 tag before going public.

## Pivot: judge reads the code, no before image (2026-09-09 16:00 PT)

- Cole's call: the judge must not depend on a human-approved baseline. It now gets one
  screenshot plus the source behind it (route file, `_layout` chain, imports, 60 KB cap) and
  answers "does this look broken?". Classes gained `wrapped`, `missing`, `other`.
- `capture --changed-since <ref>`: static import graph (`affected.ts`) intersected with
  `git diff` against the merge base; global files (app.json, package.json, babel/metro config)
  select every screen. `capture --judge` / `routeshot judge` run the model locally from
  `ANTHROPIC_API_KEY` (`.env.local` is read) and exit 1 on red. Every captured screen stores
  `<slug>.code.txt`; `upload` sends it and the server judges with it.
- Measured (`pnpm judge:eval`, twice over baseline/benign/broken): 42/42 levels, 42/42 labels,
  0 unverified. Fine screens 0-5, broken 92-97. Caveat in the README: the example's defects are
  behind a visible `isBroken` flag, so the model can read the intent.
- Judge fixes found by running it: full-size 1206x2622 screenshots produced hallucinated
  "duplicated content" reds on two clean screens (halved now, `downscaleForJudge`); Sonnet 5
  rejects `temperature`; the SDK's `messages.parse` threw on a truncated answer and skipped the
  retry, so JSON is requested via `output_config` on `create` and parsed locally, one retry.
- Without the code bundle the hosted judge missed the off-screen Billing button (pixels only);
  with it, 5/5 red. That is the before-image argument settled by measurement.
- Dogfood on hosted macOS: the example builds (33 min, expensive: macOS minutes are 10x) but
  `expo run:ios` timed out on its post-build launcher open. ci.yml now checks the install instead.
  Pixel parity on hosted runners is still unmeasured; re-run only when the minutes are worth it.
- `pnpm check` now builds before testing: the CLI tests run dist/cli.js.
