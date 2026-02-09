import { createRoute } from '@tanstack/react-router';
import { SymmetricTab } from '../../tabs/symmetric';
import { Route as demoRootRoute } from '../index';

export const Route = createRoute({
  getParentRoute: () => demoRootRoute,
  path: '/symmetric',
  component: SymmetricTab,
});
