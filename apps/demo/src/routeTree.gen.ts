import { Route as rootRoute } from './routes/__root';
import { Route as ConsoleRoute } from './routes/console';
import { Route as ConsoleConfigRoute } from './routes/console/config';
import { Route as ConsoleFleetRoute } from './routes/console/fleet';
import { Route as ConsoleIndexRoute } from './routes/console/index';
import { Route as ConsoleOpsRoute } from './routes/console/ops';
import { Route as ConsoleStreamRoute } from './routes/console/stream';
import { Route as DemoCatalogRoute } from './routes/demo/catalog';
import { Route as DemoIndexRoute } from './routes/demo/index';
import { Route as DemoKeyshareRoute } from './routes/demo/keyshare';
import { Route as DemoMediaRoute } from './routes/demo/media';
import { Route as DemoSymmetricRoute } from './routes/demo/symmetric';
import { Route as IndexRoute } from './routes/index';

export const routeTree = rootRoute.addChildren([
  IndexRoute.addChildren([
    DemoIndexRoute,
    DemoMediaRoute,
    DemoCatalogRoute,
    DemoKeyshareRoute,
    DemoSymmetricRoute,
  ]),
  ConsoleRoute.addChildren([
    ConsoleIndexRoute,
    ConsoleStreamRoute,
    ConsoleFleetRoute,
    ConsoleOpsRoute,
    ConsoleConfigRoute,
  ]),
]);
