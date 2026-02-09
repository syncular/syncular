import { createRoute } from '@tanstack/react-router';
import { Config } from '../../console/pages/Config';
import { Route as consoleRoute } from '../console';

export const Route = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'config',
  component: Config,
});
