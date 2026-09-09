import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**'],
      exclude: [
        '**/__tests__/**',
        '**/testing/**',
        // Expo's route parser, vendored; its coverage is Expo's concern, not a signal here.
        'packages/routeshot/src/vendor/**',
        // Process entry points: the CLI is tested as a spawned binary, the server by binding a port.
        'packages/routeshot/src/cli.ts',
        'packages/server/src/main.ts',
      ],
      thresholds: { lines: 85, statements: 85, functions: 80, branches: 75 },
    },
  },
});
