import { Config } from '@syncular/console-app';
import { createRoute } from '@tanstack/react-router';
import { Route as consoleRoute } from '../console';

export const Route = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'config',
  component: Config,
});
