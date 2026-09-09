# routeshot

Screenshot every expo-router screen a change touched, and ask Claude, with the screen's code in
hand, whether it looks broken. Red fails the build.

![Home screen before, diff mask, and after: the title got clipped mid-word](docs/hero-home.png)

A real run on the app in `example/`. The judge read the screen's code next to the screenshot on
the right, scored it 97 and called it `clipped`: "Title 'Routeshot Example Application' is
clipped both vertically and mid-word due to fixed-height overflow box." Five defects like it,
caught in one hosted report: https://routeshot-server-production.up.railway.app/r/8kQ2CZ-BFS8-E3fCv0By4w

## What it does

- Reads your git diff and works out which screens that change can reach (route file, layouts, imports).
- Opens each one on the iOS Simulator, waits for it to settle, screenshots it.
- Hands the screenshot and the code that rendered it to Claude with one question: does this look broken?
- No golden images, no baseline anyone had to approve. `capture` exits 1 when a screen is red.

## Try it

You need macOS with Xcode and an iOS simulator runtime, CocoaPods, Node 22+, pnpm 10
(`corepack enable`), and an Anthropic API key.

```sh
git clone https://github.com/ColeBlender/routeshot && cd routeshot
pnpm install
cd example && echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local
npx expo run:ios                      # builds the example app and starts Metro
```

Leave that terminal on Metro and open a second one in `example/`:

```sh
pnpm exec routeshot capture --judge                     # 7 screens, all green, exit 0
```

Stop Metro, restart it with the broken screens, capture again:

```sh
EXPO_PUBLIC_ROUTESHOT_SCENARIO=broken npx expo start    # first terminal
pnpm exec routeshot capture --judge --open              # second terminal: 5 red, exit 1, report opens
```

Change one file and capture only what it touches:

```sh
echo "// touched" >> app/about.tsx
pnpm exec routeshot capture --changed-since HEAD --judge   # "1 of 7 screens affected: /about"
```

## In your own app

```json
"test": "vitest run && routeshot capture --changed-since origin/main --judge"
```

Scheme and bundle id come from `app.json`. `ANTHROPIC_API_KEY` is read from `.env.local`, `.env`,
or the shell. Dynamic routes need params in `routeshot.config.ts`; the snippet to paste is printed
when one is missing. Not on npm yet: clone and `pnpm link` until the public release.

## More

[docs/details.md](docs/details.md): how it works, the measured numbers, the EAS update mode, the
GitHub Action, the report server, limitations, and how this was built with Claude Code.

## License

MIT
