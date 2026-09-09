import { defineRailway, github, postgres, preserve, project, service } from 'railway/iac';

/**
 * Railway Infrastructure as Code for the whole project: the report server and its Postgres.
 * Config as Code (`railway.json` / `railway.toml`) is deprecated, stops being read on 2026-12-01,
 * and new services cannot opt into it, so this file is the only deploy config in the repo.
 *
 *   railway link && railway config plan     # preview, never applies
 *   railway config apply                    # applies after showing the same plan
 *
 * Needs Railway CLI >= 5.42.1 plus the `railway` npm package (root devDependency): the CLI runs
 * this file and resolves `railway/iac` from node_modules.
 */
export default defineRailway(() => {
  const db = postgres('routeshot-postgres');

  const server = service('routeshot-server', {
    // A pnpm shared monorepo: the root directory stays the repo root so the workspace and the
    // lockfile are present, and the `--filter` picks the one package that gets built.
    source: github('ColeBlender/routeshot', { branch: 'main', rootDirectory: '/' }),
    build: {
      builder: 'RAILPACK',
      buildCommand: 'pnpm install --frozen-lockfile && pnpm --filter @routeshot/server build',
      // Without these, a commit that only touches the CLI package redeploys the server.
      watchPatterns: ['packages/server/**', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    },
    deploy: {
      // The built entry directly, not `pnpm --filter ... start`: one less process in the tree, so
      // Railway's SIGTERM reaches the server itself and `main.ts` can drain the pool.
      startCommand: 'node packages/server/dist/main.mjs',
      healthcheckPath: '/health',
      healthcheckTimeout: 60,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
    },
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      // Secrets stay on Railway. `preserve()` keeps whatever is already set, so the values are
      // never written into git; set them once with `railway variables --set` or in the dashboard.
      ROUTESHOT_TOKEN: preserve(),
      ROUTESHOT_DEMO_TOKEN: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      // Everything below is the same default `.env.example` documents, pinned here so the
      // deployed judge cannot silently drift from the one the eval script scores.
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      JUDGE_YELLOW: '40',
      JUDGE_RED: '75',
      JUDGE_DAILY_CAP: '500',
      COMPARE_RATE_LIMIT: '60',
    },
  });

  return project('routeshot', { resources: [server, db] });
});
