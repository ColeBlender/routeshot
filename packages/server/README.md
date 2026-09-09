# @routeshot/server

The routeshot report server. Stores capture runs, diffs any two of them, asks Claude whether a
changed screen looks broken, and serves a side-by-side HTML report at an unguessable URL.

Private to the monorepo (not published). See `../../README.md` for what routeshot is.

## Endpoints

| Method | Path                                       | Auth           | Returns                        |
| ------ | ------------------------------------------ | -------------- | ------------------------------ |
| GET    | `/health`                                  | none           | `{ ok: true, version }`        |
| POST   | `/runs`                                    | bearer         | `201 { id, url }`              |
| GET    | `/runs?repo=&branch=&limit=`               | bearer         | `{ runs: RunSummary[] }`       |
| GET    | `/runs/:id`                                | none           | the `CaptureRun` index         |
| GET    | `/runs/:id/files/:name`                    | none           | `image/png`                    |
| GET    | `/compare?baseline=&candidate=&threshold=` | bearer         | `CompareReport & { id, url }`  |
| POST   | `/judge`                                   | bearer or demo | `{ text }`, the model's answer |
| GET    | `/r/:compareId`                            | none           | the HTML report                |
| GET    | `/r/:compareId/files/:name`                | none           | `image/png` (diff masks)       |

Reads are unauthenticated on purpose: a browser rendering `/r/:id` cannot send a bearer token, so
run and compare ids are 22 characters of base64url from `randomBytes(16)` and the id is the
capability. Writes and `/compare` (which spends money on the judge) require the shared token. `POST /judge`
also accepts `ROUTESHOT_DEMO_TOKEN`, a second token that buys nothing but the judge's one
question with the server's own prompt and model, under the same daily cap; the example app
commits it so a fresh clone needs no key.

## Local development

```bash
cp .env.example .env            # fill in DATABASE_URL and ROUTESHOT_TOKEN
docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=routeshot -p 5432:5432 postgres:16
pnpm --filter @routeshot/server build
pnpm --filter @routeshot/server dev
```

Leaving `DATABASE_URL` empty is supported outside production: the server keeps runs, reports and
PNGs in process memory and says so at boot, so `pnpm dev` needs no Postgres. Everything is lost on
restart. `NODE_ENV=production` still refuses to start without a database.

`src/schema.sql` is applied at every boot with `CREATE TABLE IF NOT EXISTS`, so there is no
migration step for v1.

## Deploying to Railway

The whole project is declared in [`.railway/railway.ts`](../../.railway/railway.ts) at the repo
root: this service plus its Postgres, wired together. Railway deprecated Config as Code
(`railway.json` / `railway.toml`) in favour of Infrastructure as Code, new services cannot opt
into it, and existing files stop being read on **2026-12-01**, so `packages/server/railway.json`
is gone and that file is the only deploy config.

```bash
railway link                    # pick the project and environment once
railway config plan             # preview, applies nothing
railway config apply            # same plan, then applies after confirmation
```

Needs Railway CLI >= 5.42.1 and the `railway` npm package (already a root devDependency). The
public domain is not declared in the IaC; Railpack injects `PORT=8080`, so a generated domain must
target 8080.

The repo is a pnpm shared monorepo, so the service's root directory stays the repo root and the
workspace filter picks the package: build `pnpm install --frozen-lockfile && pnpm --filter
@routeshot/server build`, start `node packages/server/dist/main.mjs`, healthcheck `/health`, and
watch patterns that keep CLI-only commits from redeploying the server.

`DATABASE_URL` is a reference to the Postgres resource and the judge knobs are literals in the
file. `ROUTESHOT_TOKEN` and `ANTHROPIC_API_KEY` are `preserve()`, meaning the file never carries
their values, so set them once before the first deploy:

```bash
railway variables --set ROUTESHOT_TOKEN=... --set ANTHROPIC_API_KEY=...
```
