import { defineConfig } from 'tsdown';

export default defineConfig({
  // `judge` is a second entry, not a second build: scripts/judge-eval.ts scores the real judge
  // against the example runs, and importing the built module is what keeps the eval honest.
  entry: { main: 'src/main.ts', judge: 'src/judge.ts' },
  format: 'esm',
  platform: 'node',
  clean: true,
  // db.ts reads the DDL at boot with `new URL('./schema.sql', import.meta.url)`, so the file has
  // to sit next to the bundle.
  copy: [{ from: 'src/schema.sql', to: 'dist' }],
});
