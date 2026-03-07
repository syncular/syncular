import {
  createIncrementingVersionPlugin,
  INCREMENTING_VERSION_PLUGIN_KIND,
} from './incrementing-version';
import type { SyncClientPlugin } from './types';

function hasIncrementingVersionPlugin(
  plugins: readonly SyncClientPlugin[]
): boolean {
  return plugins.some(
    (plugin) =>
      plugin.kind === INCREMENTING_VERSION_PLUGIN_KIND ||
      plugin.name === INCREMENTING_VERSION_PLUGIN_KIND
  );
}

export function withDefaultClientPlugins(
  plugins?: readonly SyncClientPlugin[]
): SyncClientPlugin[] {
  const resolved = plugins ? [...plugins] : [];
  if (!hasIncrementingVersionPlugin(resolved)) {
    resolved.push(createIncrementingVersionPlugin());
  }
  return resolved;
}
