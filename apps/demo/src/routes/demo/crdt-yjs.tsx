import { createRoute } from '@tanstack/react-router';
import { CrdtYjsTab } from '../../tabs/crdt-yjs';
import { Route as demoRootRoute } from '../index';

export const Route = createRoute({
  getParentRoute: () => demoRootRoute,
  path: '/crdt-yjs',
  component: CrdtYjsTab,
});
