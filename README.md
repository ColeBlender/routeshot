# routeshot

Catches broken screens in your Expo app before you ship them.

Add one line to your test script. Every time it runs, routeshot uses Claude (bring your own
Anthropic API key) to:

1. Figure out which screens your change touched. ([how](docs/details.md#how-it-works))
2. Open each of those screens on the iOS Simulator and screenshot it.
3. Read the screenshot next to the code that drew it, and check that everything the code says
   should be on screen is there, not cut off, not pushed off the edge, not drawn on top of
   something else. ([what it catches](docs/details.md#what-the-numbers-look-like))

A broken screen fails the test, the same way a failing unit test does. No screenshots to approve,
nothing to maintain.

## See it work

This repo includes a small example app with a switch that breaks five of its screens on purpose.
You need a Mac with Xcode, Node 22+, pnpm (`corepack enable`), and an Anthropic API key.

```sh
git clone https://github.com/ColeBlender/routeshot && cd routeshot
pnpm install
cd example && echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local
npx expo run:ios
```

That builds the example app and leaves Metro running. In a second terminal, in `example/`:

```sh
pnpm exec routeshot capture --judge            # 7 screens, all green
```

Now flip the switch. Stop Metro in the first terminal and restart it with the broken screens,
then capture again:

```sh
EXPO_PUBLIC_ROUTESHOT_SCENARIO=broken npx expo start     # first terminal
pnpm exec routeshot capture --judge --open               # second terminal: 5 red, report opens
```

Here is that report, hosted: https://routeshot-server-production.up.railway.app/r/8kQ2CZ-BFS8-E3fCv0By4w

## Use it in your app

```json
"test": "vitest run && routeshot capture --changed-since origin/main --judge"
```

Not on npm yet: clone this repo and `pnpm link` the package until the public release. Details,
options, the GitHub Action, and the honest list of limitations: [docs/details.md](docs/details.md).

## License

MIT
