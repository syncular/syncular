import { createRoute } from '@tanstack/react-router';
import { Stream } from '@/pages/Stream';
import { Route as rootRoute } from './__root';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stream',
  component: Stream,
});
