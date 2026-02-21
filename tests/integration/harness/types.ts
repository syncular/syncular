/**
 * Integration test harness types
 */

import type { Server as NodeServer } from 'node:http';
import type { ClientHandlerCollection, SyncClientDb } from '@syncular/client';
import type { SyncTransport } from '@syncular/core';
import type { ServerSyncDialect, SyncCoreDb } from '@syncular/server';
import type { Hono } from 'hono';
import type { Kysely } from 'kysely';

export type ServerDialect = 'sqlite' | 'pglite';
export type ClientDialect = 'bun-sqlite' | 'pglite';

export interface MatrixCombination {
  serverDialect: ServerDialect;
  clientDialect: ClientDialect;
  name: string;
}

export interface IntegrationServerDb extends SyncCoreDb {
  projects: {
    id: string;
    name: string;
    owner_id: string;
    server_version: number;
  };
  tasks: {
    id: string;
    title: string;
    completed: number;
    user_id: string;
    project_id: string;
    server_version: number;
  };
}

export interface IntegrationClientDb extends SyncClientDb {
  projects: {
    id: string;
    name: string;
    owner_id: string;
    server_version: number;
  };
  tasks: {
    id: string;
    title: string;
    completed: number;
    user_id: string;
    project_id: string;
    server_version: number;
  };
}

export interface IntegrationServer {
  db: Kysely<IntegrationServerDb>;
  dialect: ServerSyncDialect;
  app: Hono;
  httpServer: NodeServer;
  baseUrl: string;
  destroy: () => Promise<void>;
}

export interface IntegrationClient {
  db: Kysely<IntegrationClientDb>;
  transport: SyncTransport;
  handlers: ClientHandlerCollection<IntegrationClientDb>;
  actorId: string;
  clientId: string;
  destroy: () => Promise<void>;
}

export interface ScenarioContext {
  server: IntegrationServer;
  createClient: (opts?: {
    actorId?: string;
    clientId?: string;
  }) => Promise<IntegrationClient>;
  clients: IntegrationClient[];
  userId: string;
  clientId: string;
}
