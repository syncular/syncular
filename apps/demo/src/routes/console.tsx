import { createRoute } from '@tanstack/react-router';
import { ConnectionProvider } from '../console/hooks/ConnectionContext';
import { ConsoleLayout } from '../console/layout';
import { Route as rootRoute } from './__root';

function ConsoleWrapper() {
  return (
    <ConnectionProvider>
      <ConsoleLayout />
    </ConnectionProvider>
  );
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console',
  component: ConsoleWrapper,
});
