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
import { useSyncClient } from './use-client';

export function usePresence(scopeKey: string): readonly PresencePeer[] {
  const client = useSyncClient();
  const [peers, setPeers] = useState<readonly PresencePeer[]>([]);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      Promise.resolve(client.presence(scopeKey))
        .then((list) => {
          if (!cancelled) setPeers(list);
        })
        .catch(() => {
          /* transient — the next presence event re-reads */
        });
    };
    read();
    const unsubscribe = client.onPresence((changedKey) => {
      if (changedKey === scopeKey) read();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, scopeKey]);

  return peers;
}
