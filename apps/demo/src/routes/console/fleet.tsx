import { createRoute } from '@tanstack/react-router';
import { Fleet } from '../../console/pages/Fleet';
import { Route as consoleRoute } from '../console';

export const Route = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'fleet',
  component: Fleet,
});
