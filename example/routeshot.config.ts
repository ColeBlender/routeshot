import { defineConfig } from 'routeshot';

export default defineConfig({
  scheme: 'routeshotexample',
  bundleId: 'dev.routeshot.example',
  routes: {
    // Dynamic segments cannot be deep-linked without a concrete value.
    params: {
      '/items/[id]': { id: '42' },
    },
    // Every screen here is static, so nothing needs an extra settle wait yet.
    waitFor: {},
  },
  server: {
    url: 'https://routeshot-server-production.up.railway.app',
    // A judge-only token with a daily cap, so a fresh clone runs `capture --judge` with no
    // Anthropic key of its own. Uploads still need the real token from .env.local.
    token: process.env['ROUTESHOT_SERVER_TOKEN'] ?? 'demo_865c13e040213fea6d1c818952d5dd81',
  },
});
