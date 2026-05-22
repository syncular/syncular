import { createRoute } from '@tanstack/react-router';
import { ClientDetails } from '../pages';
import { Route as rootRoute } from './__root';

function FleetClient() {
  const { clientId } = Route.useParams();
  return <ClientDetails clientId={clientId} />;
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/fleet/$clientId',
  component: FleetClient,
});
