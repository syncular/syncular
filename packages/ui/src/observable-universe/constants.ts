import type { ObservableClient } from './types';

export const INITIAL_CLIENTS: ObservableClient[] = [
  {
    id: 'client-a',
    type: 'mobile',
    status: 'online',
    lastSync: 2,
    commits: 847,
    via: 'direct',
  },
  {
    id: 'client-b',
    type: 'desktop',
    status: 'online',
    lastSync: 0,
    commits: 1203,
    via: 'direct',
  },
  {
    id: 'client-c',
    type: 'tablet',
    status: 'syncing',
    lastSync: 0,
    commits: 445,
    syncingCommits: 3,
    via: 'direct',
  },
  {
    id: 'client-d',
    type: 'edge',
    status: 'offline',
    lastSync: 240,
    commits: 201,
    via: 'direct',
  },
  {
    id: 'client-e',
    type: 'mobile',
    status: 'online',
    lastSync: 1,
    commits: 312,
    via: 'relay',
  },
  {
    id: 'client-f',
    type: 'laptop',
    status: 'online',
    lastSync: 3,
    commits: 589,
    via: 'relay',
  },
  {
    id: 'client-g',
    type: 'iot',
    status: 'offline',
    lastSync: 180,
    commits: 67,
    via: 'relay',
  },
];

export const TABLES = ['todos', 'projects', 'notes', 'users'];
export const MUTATIONS = ['INSERT', 'UPDATE', 'DELETE'] as const;
export const OPERATIONS = [
  'PUSH',
  'PULL',
  'ACK',
  'PUSH',
  'PULL',
  'PUSH',
] as const;

export const NODE_POSITIONS: Record<string, { x: number; y: number }> = {
  server: { x: 195, y: 210 },
  relay: { x: 465, y: 210 },
  'client-a': { x: 52, y: 100 },
  'client-b': { x: 38, y: 220 },
  'client-c': { x: 52, y: 340 },
  'client-d': { x: 195, y: 390 },
  'client-e': { x: 608, y: 100 },
  'client-f': { x: 622, y: 220 },
  'client-g': { x: 608, y: 340 },
};
