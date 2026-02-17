export interface ObservableClient {
  id: string;
  type: string;
  status: 'online' | 'syncing' | 'offline';
  lastSync: number;
  commits: number;
  syncingCommits?: number;
  via: 'direct' | 'relay';
}

export interface ObservableStreamEntry {
  id: string;
  timestamp: string;
  operation: 'PUSH' | 'PULL' | 'ACK';
  clientId: string;
  table: string;
  mutation: 'INSERT' | 'UPDATE' | 'DELETE';
  commits: number;
}

export interface ObservableMetrics {
  commitsPerSec: number;
  avgLatency: number;
  activeClients: number;
  uptime: string;
}
