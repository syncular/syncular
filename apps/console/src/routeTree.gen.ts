// This file is manually created to support TanStack Router code-based routing

import { Route as rootRoute } from './routes/__root';
import { Route as ConfigRoute } from './routes/config';
import { Route as FleetRoute } from './routes/fleet';
import { Route as IndexRoute } from './routes/index';
import { Route as OpsRoute } from './routes/ops';
import { Route as StreamRoute } from './routes/stream';

export const routeTree = rootRoute.addChildren([
  IndexRoute,
  StreamRoute,
  FleetRoute,
  OpsRoute,
  ConfigRoute,
]);
