# Contributing

Requirements: macOS with Xcode and an iOS simulator runtime, Node 22+, pnpm (`corepack enable`).

```
pnpm install
pnpm check
```

Before opening a PR: run `pnpm check`, keep the `Async` suffix on promise-returning functions,
and put human output on stderr. Read `AGENTS.md` for the layout and conventions.
