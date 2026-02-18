import { initAndConfigureBrowserSentry } from '@syncular/observability-sentry';
import { mountSyncularConsoleApp } from './mount';
import { resolveConsoleBrowserSentryOptions } from './sentry';

const sentryOptions = resolveConsoleBrowserSentryOptions();
if (sentryOptions) {
  initAndConfigureBrowserSentry(sentryOptions);
}

mountSyncularConsoleApp('#root');
