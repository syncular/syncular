import {
  mountSyncularConsoleApp,
  resolveConsoleBrowserSentryOptions,
} from '@syncular/console';
import { initAndConfigureBrowserSentry } from '@syncular/observability-sentry/browser';
import '@syncular/console/styles.source.css';

const sentryOptions = resolveConsoleBrowserSentryOptions();
if (sentryOptions) {
  initAndConfigureBrowserSentry(sentryOptions);
}

mountSyncularConsoleApp('#root');
