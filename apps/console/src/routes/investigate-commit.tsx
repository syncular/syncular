import { createRoute } from '@tanstack/react-router';
import { Stream } from '../pages';
import { Route as rootRoute } from './__root';

function InvestigateCommit() {
  const { seq } = Route.useParams();
  return <Stream initialSelectedEntryId={`#${seq}`} />;
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/investigate/commit/$seq',
  component: InvestigateCommit,
});
