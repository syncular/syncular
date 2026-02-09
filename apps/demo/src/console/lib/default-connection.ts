import type { ConnectionConfig } from './api';

export const DEFAULT_DEMO_CONSOLE_TOKEN = 'demo-token';

export function getDefaultDemoConnectionConfig(): ConnectionConfig | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return {
    serverUrl: new URL('/api', window.location.origin).toString(),
    token: DEFAULT_DEMO_CONSOLE_TOKEN,
  };
}
