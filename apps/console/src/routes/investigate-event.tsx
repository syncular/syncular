import { createRoute } from '@tanstack/react-router';
import { Stream } from '../pages';
import { Route as rootRoute } from './__root';

function InvestigateEvent() {
  const { id } = Route.useParams();
  const parsedId = Number.parseInt(id, 10);
  if (!Number.isFinite(parsedId)) {
    return <Stream />;
  }
  return <Stream initialSelectedEntryId={`E${parsedId}`} />;
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/investigate/event/$id',
  component: InvestigateEvent,
});
