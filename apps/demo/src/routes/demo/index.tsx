import { createRoute } from '@tanstack/react-router';
import { SplitScreenTab } from '../../tabs/split-screen';
import { Route as demoRootRoute } from '../index';

export const Route = createRoute({
  getParentRoute: () => demoRootRoute,
  path: '/',
  component: SplitScreenTab,
});
