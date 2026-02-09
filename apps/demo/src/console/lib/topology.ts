import type { SyncClient } from '@syncular/ui';
import type { ConsoleClient, SyncStats } from './types';

interface TopologyAdapterOptions {
  maxNodes?: number;
}

const TYPE_HINTS: Array<{ hint: string; type: string }> = [
  { hint: 'ios', type: 'mobile' },
  { hint: 'android', type: 'mobile' },
  { hint: 'mobile', type: 'mobile' },
  { hint: 'tablet', type: 'tablet' },
  { hint: 'desktop', type: 'desktop' },
  { hint: 'mac', type: 'desktop' },
  { hint: 'windows', type: 'desktop' },
  { hint: 'linux', type: 'desktop' },
  { hint: 'browser', type: 'browser' },
  { hint: 'web', type: 'browser' },
  { hint: 'server', type: 'server' },
  { hint: 'api', type: 'server' },
  { hint: 'iot', type: 'iot' },
  { hint: 'sensor', type: 'iot' },
];

function inferType(clientId: string): string {
  const lowerId = clientId.toLowerCase();

  for (const hint of TYPE_HINTS) {
    if (lowerId.includes(hint.hint)) {
      return hint.type;
    }
  }

  return 'client';
}

function inferDialect(clientId: string): string {
  const lower = clientId.toLowerCase();
  if (lower.includes('pglite')) return 'PGlite';
  if (lower.includes('sqlite') || lower.includes('wa-sqlite')) return 'SQLite';
  if (lower.includes('postgres') || lower.includes('pg')) return 'PostgreSQL';
  return 'unknown';
}

function inferLagCommitCount(
  client: ConsoleClient,
  stats: SyncStats | undefined
): number {
  if (typeof client.lagCommitCount === 'number') {
    return Math.max(0, client.lagCommitCount);
  }
  return stats ? Math.max(0, stats.maxCommitSeq - client.cursor) : 0;
}

function inferStatus(
  client: ConsoleClient,
  lagCommitCount: number
): SyncClient['status'] {
  if (client.activityState === 'stale') {
    return 'offline';
  }

  if (lagCommitCount > 0) {
    return 'syncing';
  }

  return 'online';
}

function createDisplayId(clientId: string, index: number): string {
  if (clientId.length <= 16) {
    return clientId;
  }

  const prefix = clientId.slice(0, 12);
  return `${prefix}-${index + 1}`;
}

export function adaptConsoleClientsToTopology(
  clients: ConsoleClient[],
  stats?: SyncStats,
  options: TopologyAdapterOptions = {}
): SyncClient[] {
  const maxNodes = options.maxNodes ?? 10;

  return clients.slice(0, maxNodes).map((client, index) => {
    const lagCommitCount = inferLagCommitCount(client, stats);
    const status = inferStatus(client, lagCommitCount);

    return {
      id: createDisplayId(client.clientId, index),
      type: inferType(client.clientId),
      status,
      cursor: Math.max(0, client.cursor),
      actor: client.actorId,
      mode: client.connectionMode,
      dialect: inferDialect(client.clientId),
      scopes: Object.keys(client.effectiveScopes || {}),
      lastSeen: client.updatedAt,
    };
  });
}
