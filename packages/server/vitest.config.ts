import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'server', include: ['src/**/__tests__/**/*.test.ts'] },
});
