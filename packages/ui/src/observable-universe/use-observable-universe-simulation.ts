'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { INITIAL_CLIENTS, MUTATIONS, OPERATIONS, TABLES } from './constants';
import type {
  ObservableClient,
  ObservableMetrics,
  ObservableStreamEntry,
} from './types';

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function randomPick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function timestamp() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}

export function useObservableUniverseSimulation() {
  const [clients, setClients] = useState<ObservableClient[]>(INITIAL_CLIENTS);
  const [entries, setEntries] = useState<ObservableStreamEntry[]>([]);
  const [metrics, setMetrics] = useState<ObservableMetrics>({
    commitsPerSec: 12.4,
    avgLatency: 34,
    activeClients: INITIAL_CLIENTS.filter((c) => c.status !== 'offline').length,
    uptime: '99.97%',
  });

  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const generateEntry = useCallback((): ObservableStreamEntry => {
    const onlineClients = clients.filter((c) => c.status !== 'offline');
    const client =
      onlineClients.length > 0
        ? randomPick(onlineClients)
        : randomPick(clients);
    return {
      id: randomId(),
      timestamp: timestamp(),
      operation: randomPick(OPERATIONS) as 'PUSH' | 'PULL' | 'ACK',
      clientId: client.id,
      table: randomPick(TABLES),
      mutation: randomPick(MUTATIONS),
      commits: Math.ceil(Math.random() * 5),
    };
  }, [clients]);

  useEffect(() => {
    const tick = () => {
      const entry = generateEntry();
      setEntries((prev) => [entry, ...prev].slice(0, 40));
      setMetrics((prev) => ({
        ...prev,
        commitsPerSec: Number.parseFloat((10 + Math.random() * 8).toFixed(1)),
        avgLatency: Math.floor(25 + Math.random() * 30),
      }));
    };

    intervalRef.current = setInterval(tick, 800 + Math.random() * 400);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [generateEntry]);

  // Periodically shuffle client statuses
  useEffect(() => {
    const shuffle = setInterval(() => {
      setClients((prev) =>
        prev.map((c) => {
          if (Math.random() > 0.15) return c;
          const statuses: ObservableClient['status'][] = [
            'online',
            'syncing',
            'offline',
          ];
          const newStatus = randomPick(statuses);
          return {
            ...c,
            status: newStatus,
            lastSync:
              newStatus === 'offline'
                ? c.lastSync + 10
                : Math.floor(Math.random() * 5),
            syncingCommits:
              newStatus === 'syncing'
                ? Math.floor(Math.random() * 5) + 1
                : undefined,
          };
        })
      );
      setMetrics((prev) => ({
        ...prev,
        activeClients: clients.filter((c) => c.status !== 'offline').length,
      }));
    }, 3000);

    return () => clearInterval(shuffle);
  }, [clients]);

  return {
    clients,
    entries,
    metrics,
    streamRate: `${metrics.commitsPerSec}/s`,
  };
}
