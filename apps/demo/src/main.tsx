/**
 * @syncular/demo-app - React frontend entry point
 */

import {
  initAndConfigureBrowserSentry,
  logBrowserSentryMessage,
} from '@syncular/observability-sentry';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { resolveDemoBrowserSentryOptions } from './client/sentry';
import './styles/globals.css';

const sentryOptions = resolveDemoBrowserSentryOptions();
if (sentryOptions) {
  initAndConfigureBrowserSentry(sentryOptions);
  logBrowserSentryMessage('syncular.demo.browser.startup', {
    level: 'info',
    attributes: {
      app: 'demo',
      runtime: 'browser',
    },
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
