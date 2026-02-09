import { createRoute } from '@tanstack/react-router';
import { KeyshareTab } from '../../tabs/keyshare';
import { Route as demoRootRoute } from '../index';

export const Route = createRoute({
  getParentRoute: () => demoRootRoute,
  path: '/keyshare',
  component: KeyshareTab,
});
