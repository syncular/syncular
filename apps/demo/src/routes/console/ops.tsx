import { Ops } from '@syncular/console';
import { createRoute } from '@tanstack/react-router';
import { Route as consoleRoute } from '../console';

export const Route = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'ops',
  component: Ops,
});
