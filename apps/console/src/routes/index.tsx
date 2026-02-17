import { createRoute } from '@tanstack/react-router';
import { Command } from '../pages';
import { Route as rootRoute } from './__root';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Command,
});
