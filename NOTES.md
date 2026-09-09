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
