/**
 * Syncular React module scaffold.
 *
 * Dialect: <%= it.CLIENT_DIALECT_LABEL %>
 */

<%= it.CLIENT_DIALECT_IMPORT %>
import type { SyncClientDb } from '@syncular/client';
import { createSyncularReact } from '@syncular/client-react';
import { createHttpTransport } from '@syncular/transport-http';

export const clientDialect = '<%= it.CLIENT_DIALECT %>';

export function createClientDb<DB>() {
  <%= it.CLIENT_DB_FACTORY_LINE %>
}

export function createSyncTransport(args: { baseUrl: string; token: string }) {
  return createHttpTransport({
    baseUrl: args.baseUrl,
    getHeaders: () => ({ Authorization: `Bearer ${args.token}` }),
  });
}

export function createReactBindings<DB extends SyncClientDb>() {
  return createSyncularReact<DB>();
}
