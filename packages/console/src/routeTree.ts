import { Route as rootRoute } from './routes/__root';
import { Route as configRoute } from './routes/config';
import { Route as fleetRoute } from './routes/fleet';
import { Route as indexRoute } from './routes/index';
import { Route as investigateCommitRoute } from './routes/investigate-commit';
import { Route as investigateEventRoute } from './routes/investigate-event';
import { Route as opsRoute } from './routes/ops';
import { Route as storageRoute } from './routes/storage';
import { Route as streamRoute } from './routes/stream';

export const routeTree = rootRoute.addChildren([
  indexRoute,
  streamRoute,
  investigateCommitRoute,
  investigateEventRoute,
  fleetRoute,
  opsRoute,
  storageRoute,
  configRoute,
]);
