# routeshot

Catches broken screens in your Expo app before you ship them.

Add one line to your test script. Every time it runs, routeshot uses an AI model to:

1. Figure out which screens your change touched. ([how](docs/details.md#how-it-works))
2. Open each of those screens on the iOS Simulator and screenshot it.
3. Read the screenshot next to the code that drew it, and check that everything the code says
   should be on screen is there, not cut off, not pushed off the edge, not drawn on top of
   something else. ([what it catches](docs/details.md#what-the-numbers-look-like))

A broken screen fails the test, the same way a failing unit test does. No screenshots to approve,
nothing to maintain.

## See it work

This repo includes a small example app with a switch that breaks five of its screens on purpose.
You need a Mac with Xcode and Node 22+. No API key: for this demo the example app asks a hosted
judge that holds a capped Anthropic key.

Terminal 1: clone, install, build the example app. Leave it running when it finishes; that is
Metro serving the app.

```sh
git clone https://github.com/ColeBlender/routeshot && cd routeshot && npm install && cd example && npx expo run:ios
```

Terminal 2: check every screen.

```sh
cd routeshot/example && npx routeshot capture --judge
```

7 screens, all green. Now flip the switch. In terminal 1, press Ctrl+C to stop Metro, then restart
it with the broken screens:

```sh
EXPO_PUBLIC_ROUTESHOT_SCENARIO=broken npx expo start
```

Terminal 2 again:

```sh
npx routeshot capture --judge --open
```

5 red, and the report opens with each broken screen marked up. Not on a Mac? Here are the two
reports, hosted:
[all 7 screens green](https://routeshot-server-production.up.railway.app/r/8kQ2CZ-BFS8-E3fCv0By4w)
and [5 broken](https://routeshot-server-production.up.railway.app/r/8kQ2CZ-BFS8-E3fCv0By4w).

Options, the GitHub Action, limitations, and how it works: [docs/details.md](docs/details.md).

## License

MIT
