import { Route as rootRoute } from './routes/__root';
import { Route as consoleRoute } from './routes/console';
import { Route as consoleConfigRoute } from './routes/console/config';
import { Route as consoleFleetRoute } from './routes/console/fleet';
import { Route as consoleIndexRoute } from './routes/console/index';
import { Route as consoleOpsRoute } from './routes/console/ops';
import { Route as consoleStreamRoute } from './routes/console/stream';
import { Route as demoCatalogRoute } from './routes/demo/catalog';
import { Route as demoIndexRoute } from './routes/demo/index';
import { Route as demoKeyshareRoute } from './routes/demo/keyshare';
import { Route as demoMediaRoute } from './routes/demo/media';
import { Route as demoSymmetricRoute } from './routes/demo/symmetric';
import { Route as demoShellRoute } from './routes/index';

export const routeTree = rootRoute.addChildren([
  demoShellRoute.addChildren([
    demoIndexRoute,
    demoMediaRoute,
    demoCatalogRoute,
    demoKeyshareRoute,
    demoSymmetricRoute,
  ]),
  consoleRoute.addChildren([
    consoleIndexRoute,
    consoleStreamRoute,
    consoleFleetRoute,
    consoleOpsRoute,
    consoleConfigRoute,
  ]),
]);
