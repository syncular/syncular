import { initAndConfigureBrowserSentry } from '@syncular/client/sentry';
import { mountSyncularConsoleApp } from './mount';
import { resolveConsoleBrowserSentryOptions } from './sentry';

const sentryOptions = resolveConsoleBrowserSentryOptions();
if (sentryOptions) {
  initAndConfigureBrowserSentry(sentryOptions);
}

mountSyncularConsoleApp('#root');
