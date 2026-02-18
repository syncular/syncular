import { createRoute } from '@tanstack/react-router';
import { Ops } from '../pages';
import { Route as rootRoute } from './__root';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ops',
  component: Ops,
});
