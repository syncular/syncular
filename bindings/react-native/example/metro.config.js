const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// The example is intentionally OUTSIDE the bun workspace (RN apps pin exact
// react / react-native versions; a hoisted workspace would fight autolinking
// and Metro's single-react-copy rule). But it consumes two source packages —
// `@syncular/react` and `@syncular/react-native` — that live in the v2
// tree. So we tell Metro to (a) watch the v2 root, so their .ts sources are in
// the haste map, and (b) resolve `react` / `react-native` to THIS app's copy
// only, so those source packages never pull a second React in.
const exampleDir = __dirname;
const v2Root = path.resolve(exampleDir, '..', '..', '..');

const config = {
  // Watch the whole v2 tree so the workspace packages' sources are bundled.
  watchFolders: [v2Root],
  resolver: {
    // Metro must transform the .ts of the workspace packages, so add `ts`/`tsx`
    // to the source extensions (RN's preset handles TS syntax).
    sourceExts: ['tsx', 'ts', 'jsx', 'js', 'json'],
    // Force a single copy of react / react-native (the app's), so the
    // workspace packages resolve the same instances the app renders with.
    extraNodeModules: {
      react: path.resolve(exampleDir, 'node_modules', 'react'),
      'react-native': path.resolve(exampleDir, 'node_modules', 'react-native'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(exampleDir), config);
