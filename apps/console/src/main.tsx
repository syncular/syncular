import { initAndConfigureBrowserSentry } from '@syncular/client/sentry';
import {
  mountSyncularConsoleApp,
  resolveConsoleBrowserSentryOptions,
} from '@syncular/console';
import '@syncular/console/styles.source.css';

const sentryOptions = resolveConsoleBrowserSentryOptions();
if (sentryOptions) {
  initAndConfigureBrowserSentry(sentryOptions);
}

mountSyncularConsoleApp('#root');
