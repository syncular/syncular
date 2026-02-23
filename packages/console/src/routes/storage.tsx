import { createRoute } from '@tanstack/react-router';
import { Storage } from '../pages';
import { Route as rootRoute } from './__root';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/storage',
  component: Storage,
});
