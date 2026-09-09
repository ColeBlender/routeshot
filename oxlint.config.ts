import { defineConfig } from 'oxlint';
import node from 'oxlint-config-universe/node';
import typescriptAnalysis from 'oxlint-config-universe/typescript-analysis';

export default defineConfig({
  extends: [node, typescriptAnalysis],
  ignorePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/vendor/**',
    '**/.expo/**',
    '**/ios/**',
    '**/android/**',
    'example/**',
  ],
  jsPlugins: [{ name: 'async-protect', specifier: 'eslint-plugin-async-protect' }],
  rules: {
    'no-console': 'warn',
    curly: 'warn',
    'no-restricted-imports': [
      'error',
      { paths: [{ name: 'lodash', message: "Don't use lodash, it's heavy!" }] },
    ],
    'async-protect/async-suffix': 'error',
  },
  overrides: [
    {
      files: ['**/__tests__/**/*.ts', '**/*.config.ts'],
      rules: { 'async-protect/async-suffix': 'off' },
    },
  ],
});
