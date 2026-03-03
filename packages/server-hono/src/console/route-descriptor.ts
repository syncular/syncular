import { describeRoute } from 'hono-openapi';

type OpenApiRouteConfig = Parameters<typeof describeRoute>[0];

const CONSOLE_ROUTE_TAGS = ['console'];
const CONSOLE_GATEWAY_ROUTE_TAGS = ['console-gateway'];

export function describeConsoleRoute(
  config: Omit<OpenApiRouteConfig, 'tags'>
) {
  return describeRoute({
    tags: CONSOLE_ROUTE_TAGS,
    ...config,
  });
}

export function describeConsoleGatewayRoute(
  config: Omit<OpenApiRouteConfig, 'tags'>
) {
  return describeRoute({
    tags: CONSOLE_GATEWAY_ROUTE_TAGS,
    ...config,
  });
}
