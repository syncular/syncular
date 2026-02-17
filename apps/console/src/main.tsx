import { initAndConfigureBrowserSentry } from '@syncular/observability-sentry';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolveConsoleBrowserSentryOptions } from './sentry';
import './styles/globals.css';

const sentryOptions = resolveConsoleBrowserSentryOptions();
if (sentryOptions) {
  initAndConfigureBrowserSentry(sentryOptions);
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
