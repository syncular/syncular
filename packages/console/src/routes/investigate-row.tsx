import { createRoute } from '@tanstack/react-router';
import { RowInvestigation } from '../pages';
import { Route as rootRoute } from './__root';

function InvestigateRow() {
  const { table, rowId } = Route.useParams();
  return <RowInvestigation table={table} rowId={rowId} />;
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/investigate/row/$table/$rowId',
  component: InvestigateRow,
});
