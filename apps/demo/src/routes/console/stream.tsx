import { createRoute } from '@tanstack/react-router';
import { Stream } from '../../console/pages/Stream';
import { Route as consoleRoute } from '../console';

export const Route = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'stream',
  component: Stream,
});
