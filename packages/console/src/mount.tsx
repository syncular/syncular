import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App, type SyncularConsoleProps } from './App';

interface MountSyncularConsoleOptions {
  strictMode?: boolean;
  basePath?: SyncularConsoleProps['basePath'];
  defaultConfig?: SyncularConsoleProps['defaultConfig'];
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
  const root = createRoot(resolveContainer(containerOrSelector));
  const app = (
    <App basePath={options.basePath} defaultConfig={options.defaultConfig} />
  );

  if (options.strictMode === false) {
    root.render(app);
    return root;
  }

  root.render(<StrictMode>{app}</StrictMode>);
  return root;
}
