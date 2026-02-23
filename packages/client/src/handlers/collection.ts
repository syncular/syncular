import type { ClientTableHandler } from './types';

export type ClientHandlerCollection<DB> = ClientTableHandler<DB>[];

export function createClientHandlerCollection<DB>(
  handlers: ClientTableHandler<DB>[]
): ClientHandlerCollection<DB> {
  const tables = new Set<string>();
  for (const handler of handlers) {
    if (tables.has(handler.table)) {
      throw new Error(
        `Client table handler already registered: ${handler.table}`
      );
    }
    tables.add(handler.table);
  }
  return handlers;
}

export function getClientHandler<DB>(
  handlers: ClientHandlerCollection<DB>,
  table: string
): ClientTableHandler<DB> | undefined {
  return handlers.find((handler) => handler.table === table);
}

export function getClientHandlerOrThrow<DB>(
  handlers: ClientHandlerCollection<DB>,
  table: string
): ClientTableHandler<DB> {
  const handler = getClientHandler(handlers, table);
  if (!handler) {
    throw new Error(`Missing client table handler for table: ${table}`);
  }
  return handler;
}
