import { createRoute } from '@tanstack/react-router';
import { Stream } from '../pages';
import { Route as rootRoute } from './__root';

function InvestigateCommit() {
  const { seq } = Route.useParams();
  const parsedSeq = Number.parseInt(seq, 10);
  if (!Number.isFinite(parsedSeq)) {
    return <Stream />;
  }
  return <Stream initialSelectedEntryId={`#${parsedSeq}`} />;
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/investigate/commit/$seq',
  component: InvestigateCommit,
});
