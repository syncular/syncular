import { Fleet } from '@syncular/console';
import { createRoute } from '@tanstack/react-router';
import { Route as consoleRoute } from '../console';

export const Route = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'fleet',
  component: Fleet,
});
