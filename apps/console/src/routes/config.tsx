import { createRoute } from '@tanstack/react-router';
import { Config } from '@/pages/Config';
import { Route as rootRoute } from './__root';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/config',
  component: Config,
});
