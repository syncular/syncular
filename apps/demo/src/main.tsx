/**
 * @syncular/demo-app - React frontend entry point
 */

import {
  initAndConfigureBrowserSentry,
  logBrowserSentryMessage,
} from '@syncular/observability-sentry/browser';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { resolveDemoBrowserSentryOptions } from './client/sentry';
import { configureDemoServiceWorkerServer } from './client/service-worker-server';
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
const reactRoot = createRoot(root);

function renderStartupError(message: string): void {
  reactRoot.render(
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#0c0c0c',
        color: '#e5e5e5',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        padding: '24px',
      }}
    >
      <div
        style={{
          maxWidth: '720px',
          border: '1px solid #2a2a2a',
          borderRadius: '8px',
          padding: '16px',
          background: '#111111',
        }}
      >
        <div style={{ fontSize: '12px', opacity: 0.8, marginBottom: '8px' }}>
          Service Worker Server Startup Failed
        </div>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            margin: 0,
            fontSize: '12px',
            lineHeight: 1.5,
          }}
        >
          {message}
        </pre>
      </div>
    </div>
  );
}

async function start(): Promise<void> {
  reactRoot.render(
    <StrictMode>
      <App />
    </StrictMode>
  );

  const swReady = await configureDemoServiceWorkerServer();
  if (!swReady) {
    renderStartupError(
      'This demo now requires Service Worker mode. Ensure service workers are allowed and reload the page.'
    );
  }
}

void start();
