import {
  mountSyncularConsoleApp,
  resolveConsoleBrowserSentryOptions,
} from '@syncular/console';
import { initAndConfigureBrowserSentry } from '@syncular/observability-sentry';
import '@syncular/console/styles.css';

const sentryOptions = resolveConsoleBrowserSentryOptions();
if (sentryOptions) {
  initAndConfigureBrowserSentry(sentryOptions);
}

mountSyncularConsoleApp('#root');
