import { createRoute } from '@tanstack/react-router';
import { Ops } from '../../console/pages/Ops';
import { Route as consoleRoute } from '../console';

export const Route = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'ops',
  component: Ops,
});
