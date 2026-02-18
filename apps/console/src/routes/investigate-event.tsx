import { createRoute } from '@tanstack/react-router';
import { Stream } from '../pages';
import { Route as rootRoute } from './__root';

function InvestigateEvent() {
  const { id } = Route.useParams();
  return <Stream initialSelectedEntryId={`E${id}`} />;
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/investigate/event/$id',
  component: InvestigateEvent,
});
