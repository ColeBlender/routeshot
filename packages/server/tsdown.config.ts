import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: 'esm',
  platform: 'node',
  clean: true,
  // db.ts reads the DDL at boot with `new URL('./schema.sql', import.meta.url)`, so the file has
  // to sit next to the bundle.
  copy: [{ from: 'src/schema.sql', to: 'dist' }],
});
