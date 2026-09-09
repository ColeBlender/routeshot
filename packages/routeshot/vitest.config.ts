import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'routeshot', include: ['src/**/__tests__/**/*.test.ts'] },
});
