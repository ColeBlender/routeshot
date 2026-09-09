# @routeshot/server

The routeshot report server. Stores capture runs, diffs any two of them, asks Claude whether a
changed screen looks broken, and serves a side-by-side HTML report at an unguessable URL.

Private to the monorepo (not published). See `../../README.md` for what routeshot is.

## Endpoints

| Method | Path                                       | Auth   | Returns                       |
| ------ | ------------------------------------------ | ------ | ----------------------------- |
| GET    | `/health`                                  | none   | `{ ok: true, version }`       |
| POST   | `/runs`                                    | bearer | `201 { id, url }`             |
| GET    | `/runs?repo=&branch=&limit=`               | bearer | `{ runs: RunSummary[] }`      |
| GET    | `/runs/:id`                                | none   | the `CaptureRun` index        |
| GET    | `/runs/:id/files/:name`                    | none   | `image/png`                   |
| GET    | `/compare?baseline=&candidate=&threshold=` | bearer | `CompareReport & { id, url }` |
| GET    | `/r/:compareId`                            | none   | the HTML report               |
| GET    | `/r/:compareId/files/:name`                | none   | `image/png` (diff masks)      |

Reads are unauthenticated on purpose: a browser rendering `/r/:id` cannot send a bearer token, so
run and compare ids are 22 characters of base64url from `randomBytes(16)` and the id is the
capability. Writes and `/compare` (which spends money on the judge) require the shared token.

## Local development

```bash
cp .env.example .env            # fill in DATABASE_URL and ROUTESHOT_TOKEN
docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=routeshot -p 5432:5432 postgres:16
pnpm --filter @routeshot/server build
pnpm --filter @routeshot/server dev
```

`src/schema.sql` is applied at every boot with `CREATE TABLE IF NOT EXISTS`, so there is no
migration step for v1.

## Deploying to Railway

The repo is a pnpm shared monorepo, so the service's **root directory stays `/`** (the repo root)
and the workspace filter picks the package. In service settings:

- Root Directory: `/`
- Config File: `/packages/server/railway.json` (the Railway config file path is absolute and does
  not follow the root directory setting)
- Attach a Railway Postgres service so `DATABASE_URL` is injected
- Set `ROUTESHOT_TOKEN` and `ANTHROPIC_API_KEY`

`railway.json` pins the Railpack builder, the workspace-filtered build and start commands, the
watch patterns that keep CLI-only commits from redeploying the server, and `healthcheckPath`.

> Railway deprecated Config as Code (`railway.json` / `railway.toml`) in favour of Infrastructure
> as Code (`.railway/railway.ts`). Existing files keep working until **2026-12-01**, and new
> services cannot opt into Config as Code, so a service created from scratch needs the IaC file at
> the repo root instead. The equivalent is:
>
> ```ts
> import { defineRailway, project, service } from 'railway/iac';
>
> export default defineRailway(() => {
>   const server = service('routeshot-server', {
>     build: 'pnpm install --frozen-lockfile && pnpm --filter @routeshot/server build',
>     start: 'pnpm --filter @routeshot/server start',
>   });
>   return project('routeshot', { resources: [server] });
> });
> ```
>
> That file is project-level, so it belongs at the repo root, not in this package.
