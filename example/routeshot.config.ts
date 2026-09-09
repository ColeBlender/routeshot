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
  threshold: 0.01,
});
