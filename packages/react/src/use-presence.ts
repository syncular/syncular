/**
 * `usePresence(scopeKey)` — the ephemeral peers present on a §8.6 scope key
 * (join/update/leave). Reads the current peer list on mount and re-reads
 * whenever presence on THIS key changes, via the client's `onPresence`
 * subscription (the subscribable twin of the config callback). Presence is
 * lost on disconnect (the server emits leave), so the list reflects only
 * what the live socket has delivered.
 */

import type { PresencePeer } from '@syncular/client';
import { useEffect, useState } from 'react';
import type { SyncClientLike } from './client';
import { useSyncClient } from './use-client';

const EMPTY_PEERS: readonly PresencePeer[] = [];

export function usePresence(scopeKey: string): readonly PresencePeer[] {
  const client = useSyncClient();
  const [snapshot, setSnapshot] = useState<{
    client: SyncClientLike;
    scopeKey: string;
    peers: readonly PresencePeer[];
  }>(() => ({ client, scopeKey, peers: EMPTY_PEERS }));
  if (snapshot.client !== client || snapshot.scopeKey !== scopeKey) {
    setSnapshot({ client, scopeKey, peers: EMPTY_PEERS });
  }

  useEffect(() => {
    let generation = 0;
    const read = () => {
      const request = ++generation;
      void Promise.resolve()
        .then(() => client.presence(scopeKey))
        .then((peers) => {
          if (request === generation) {
            setSnapshot((previous) =>
              previous.client === client && previous.scopeKey === scopeKey
                ? { client, scopeKey, peers }
                : previous,
            );
          }
        })
        .catch(() => {
          // Keep the current scope's last snapshot until the next event.
        });
    };
    const unsubscribe = client.onPresence((changedKey) => {
      if (changedKey === scopeKey) read();
    });
    read();
    return () => {
      generation += 1;
      unsubscribe();
    };
  }, [client, scopeKey]);

  return snapshot.client === client && snapshot.scopeKey === scopeKey
    ? snapshot.peers
    : EMPTY_PEERS;
}
