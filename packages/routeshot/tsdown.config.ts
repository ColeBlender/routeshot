import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts', expo: 'src/expo.ts' },
  format: 'esm',
  platform: 'node',
  dts: true,
  clean: true,
  // `expo` is imported by the app under test (React Native), so it must not pull Node deps in.
  external: ['expo-updates', 'react-native', 'sharp'],
});
