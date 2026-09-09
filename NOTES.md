# Build notes (working log, not shipped)

Decisions made while building, and blockers that need Cole. Newest at the bottom.

## Blockers needing Cole

- [ ] `eas login` on this machine (EAS update-group mode spike cannot run without it). Everything else built around it; the flag + hook + local update-server fallback are testable offline.
- [ ] Railway project + Postgres for the report server (I can create via MCP once you say go).
- [ ] `ANTHROPIC_API_KEY` for the judge (server env var). Local dev reads `.env`.

## Decisions

- pnpm pinned to 10.25.0 (what is installed). Expo is on pnpm 12; bump later if install is clean under corepack.
- TS 6.0.3, not 7: Expo repos are on 6.x, and tsdown/oxlint-tsgolint compat with 7 is unverified.
- oxlint `node` + `typescript-analysis` presets from oxlint-config-universe, plus eas-cli's hand-picked rules (no-console, curly, no lodash, async-suffix via eslint-plugin-async-protect, which is what eas-cli uses).
- Vitest `projects` at the root, one config per package. Tests in `__tests__/` next to src (Expo convention), `*.test.ts` naming (Vitest default).
- action.yml assumes `routeshot compare <baseline> <run> --remote` (server-side compare by id/branch alias `main`). The CLI agent was told compare takes run ids/dirs/latest/previous. Reconcile: add `--remote` (calls GET /compare on the server) or have the action call the server with curl. Decide after the CLI report.
- README drafted with placeholders: hero image, measured settle/noise numbers, the "decision against Claude's output" line.

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
