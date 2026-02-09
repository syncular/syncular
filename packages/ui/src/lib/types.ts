export type ClientStatus = 'online' | 'syncing' | 'offline';

/** @deprecated Use SyncClientNode */
export type SyncClient = SyncClientNode;

export type SyncClientNode = {
  id: string;
  type: string;
  status: ClientStatus;
  cursor: number;
  actor: string;
  mode: 'realtime' | 'polling';
  dialect: string;
  scopes: string[];
  lastSeen: string;
};

export type CommitStreamEntry = {
  seq: number;
  actor: string;
  changes: number;
  tables: string;
  time: string;
};

export type StreamOperation = {
  type: 'commit' | 'push' | 'pull';
  id: string;
  outcome: string;
  duration: string;
  actor: string;
  client: string;
  detail: string;
  time: string;
};

export type MetricItem = {
  label: string;
  value: string | number;
  color?: string;
  trend?: string;
  unit?: string;
};

export type NavItem = {
  id: string;
  label: string;
  href?: string;
};

export type FilterGroup = {
  label?: string;
  options: { id: string; label: string }[];
  activeId: string;
  onActiveChange: (id: string) => void;
};

export type ApiKeyEntry = {
  name: string;
  type: string;
  prefix: string;
  created: string;
};

export type HandlerEntry = {
  table: string;
  dependsOn: string | null;
  chunkTtl: string;
};
