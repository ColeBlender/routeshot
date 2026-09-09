// Adapted from expo/expo packages/expo-router/src/testing-library/require-context-ponyfill.ts
// @ d461c0835dfdc9fad1688cf5c7c234a3c36b240e (MIT).
// Changes: the returned `Module(file)` no longer calls CommonJS `require` (routeshot is ESM and
// never executes app code); it returns a stub `{ default: () => null }` instead. See the caveat
// below for what that costs us.

import fs from 'node:fs';
import path from 'node:path';

import type { RequireContext } from './route-node.js';

export interface RequireContextPonyFill extends RequireContext {
  __add(file: string): void;
  __delete(file: string): void;
}

/**
 * CAVEAT: routeshot never evaluates route modules. Anything expo-router reads out of a module's
 * exports is therefore invisible to us:
 *   - `unstable_settings` (a layout's anchor / initialRouteName) — only affects navigation order,
 *     not which routes exist, so route discovery is unaffected.
 *   - `generateStaticParams()` — routes that only exist because of it are NOT discovered; supply
 *     those pathnames through `routes.params` in the config instead.
 * Evaluating them would mean running React Native code (and a Metro transform) in Node, which is
 * exactly the dependency this tool exists to avoid.
 */
export default function requireContext(
  base = '.',
  scanSubDirectories = true,
  regularExpression = /\.[tj]sx?$/,
  files: Record<string, unknown> = {}
) {
  const baseTarget = path.resolve(base);

  function readDirectory(directory: string = '') {
    const target = path.resolve(baseTarget, directory);
    const entries = fs.readdirSync(target, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = directory ? path.join(directory, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          continue;
        } else if (scanSubDirectories) {
          readDirectory(relativePath);
        }
      } else if (entry.isFile()) {
        const posixPath = `./${relativePath.split(path.sep).join('/')}`;
        if (regularExpression.test(posixPath)) {
          files[posixPath] = true;
        }
      }
    }
  }

  if (fs.existsSync(baseTarget)) {
    readDirectory();
  }

  const context: RequireContextPonyFill = Object.assign(
    function Module(_file: string) {
      return { default: () => null };
    },
    {
      keys: () => Object.keys(files),
      resolve: (key: string) => key,
      id: '0',
      __add(file: string) {
        files[file] = true;
      },
      __delete(file: string) {
        delete files[file];
      },
    }
  );

  return context;
}
