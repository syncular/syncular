import { createRoute } from '@tanstack/react-router';
import { MediaSyncTab } from '../../tabs/media-sync';
import { Route as demoRootRoute } from '../index';

export const Route = createRoute({
  getParentRoute: () => demoRootRoute,
  path: '/media',
  component: MediaSyncTab,
});
