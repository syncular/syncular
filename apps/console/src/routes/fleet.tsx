import { createRoute } from '@tanstack/react-router';
import { Fleet } from '../pages';
import { Route as rootRoute } from './__root';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/fleet',
  component: Fleet,
});
