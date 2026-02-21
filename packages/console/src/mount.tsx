import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App, type SyncularConsoleProps } from './App';
import { applyConsoleThemeScope } from './theme-scope';

interface MountSyncularConsoleOptions {
  strictMode?: boolean;
  basePath?: SyncularConsoleProps['basePath'];
  defaultConfig?: SyncularConsoleProps['defaultConfig'];
  autoConnect?: SyncularConsoleProps['autoConnect'];
}

function resolveContainer(containerOrSelector: Element | string): Element {
  if (typeof containerOrSelector !== 'string') {
    return containerOrSelector;
  }

  const container = document.querySelector(containerOrSelector);
  if (!container) {
    throw new Error(
      `Unable to mount console: ${containerOrSelector} not found`
    );
  }

  return container;
}

export function mountSyncularConsoleApp(
  containerOrSelector: Element | string,
  options: MountSyncularConsoleOptions = {}
): Root {
  const container = resolveContainer(containerOrSelector);
  applyConsoleThemeScope(container);

  const root = createRoot(container);
  const app = (
    <App
      basePath={options.basePath}
      defaultConfig={options.defaultConfig}
      autoConnect={options.autoConnect}
    />
  );

  if (options.strictMode === false) {
    root.render(app);
    return root;
  }

  root.render(<StrictMode>{app}</StrictMode>);
  return root;
}
