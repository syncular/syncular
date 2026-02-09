import { createRoute } from '@tanstack/react-router';
import { Command } from '../../console/pages/Command';
import { Route as consoleRoute } from '../console';

export const Route = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/',
  component: Command,
});
