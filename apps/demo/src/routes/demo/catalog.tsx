import { createRoute } from '@tanstack/react-router';
import { LargeCatalogTab } from '../../tabs/large-catalog';
import { Route as demoRootRoute } from '../index';

export const Route = createRoute({
  getParentRoute: () => demoRootRoute,
  path: '/catalog',
  component: LargeCatalogTab,
});
