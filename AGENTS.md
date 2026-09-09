# routeshot

Screenshot every expo-router route, before and after an EAS update, and show what changed.
This file is the map for humans and coding agents alike. Keep it accurate; keep it short.

## Layout

- `packages/routeshot/` the npm package. Three entry points built by tsdown:
  - `src/cli.ts` the `routeshot` binary (`capture`, `upload`, `compare`)
  - `src/index.ts` the programmatic API
  - `src/expo.ts` the in-app hook for the EAS update-group mode (imports only `expo-updates`)
- `packages/server/` the report server deployed to Railway (Hono + Postgres). Stores runs, diffs them, serves the HTML report, asks Claude for a verdict per changed screen.
- `example/` a small expo-router app used by the README quickstart, the dogfood CI job, and the judge eval. `EXPO_PUBLIC_ROUTESHOT_SCENARIO=baseline|benign|broken` switches deliberately broken screens on.
- `action.yml` composite GitHub Action that runs the CLI on a macOS runner and comments on the PR.

## How the pieces talk

CLI discovers routes with expo-router's own parser (vendored under `src/vendor/`), drives the iOS
Simulator through `xcrun simctl` (ported from `@expo/cli` and Expo Orbit), deep-links into each
route, waits for the screen to stop changing, screenshots it. `compare` diffs two runs with
pixelmatch. `--upload` sends a run to the server; the server diffs, judges, and hosts the report.

## Conventions (Expo house style)

- Every promise-returning function ends in `Async`. Lint-enforced.
- Throw, never log-and-return. `RouteshotError` carries a code; the CLI maps it to an exit status.
- Human output on stderr through `Log`. `--json` owns stdout. No `console.log`.
- Inline over single-use helpers. Comments say why, not what. No lodash.
- `import type`, `node:` builtins, `.js` extensions on relative imports (NodeNext ESM).
- Tests live in `__tests__/` beside the code and exercise real behavior; only simulator and network I/O are faked.
- Formatting: oxfmt, printWidth 100, single quotes, trailing commas es5. Lint: oxlint with `oxlint-config-universe`.
- Commits: `[routeshot] Title`, `[server] Title`, `[example] Title`. One idea per commit.

## Commands

```
pnpm check                 # lint, format check, typecheck, test, build
pnpm --filter routeshot test
pnpm --filter @routeshot/server dev
cd example && npx expo run:ios
```

## Things that are deliberately not here

MCP server, Android adapter (the `Simulator` interface is the seam), auth-gated routes, `init` command.
