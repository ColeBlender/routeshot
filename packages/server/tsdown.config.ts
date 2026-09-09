import { defineConfig } from 'tsdown';

export default defineConfig({ entry: { main: 'src/main.ts' }, format: 'esm', platform: 'node', clean: true });
