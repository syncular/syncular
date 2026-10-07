# React: realtime & lifecycle

Show connection and sync state, surface conflicts, and follow a write to its
final server result. You finish with a status pill, a conflict list, and a
commit-outcome lookup built from hooks.

::meta{for="React developers building status and conflict UI" time="8 minutes" first="platform-react-reads-writes" spec="8.4"}

:::terms
- **Outbox count**: `useSyncStatus().outbox`, the number of local commits not yet sent.
- **Outcome journal**: The durable, newest-first record of each commit's final server result.
- **Presence**: Ephemeral realtime peers on a scope key.
:::

:::figure{title="From a write to its outcome" note="Local first, server later" ticks}
<div class="d-row">
<div class="node hot"><span class="t">mutate</span><code>onEnqueued(commitId)</code> fires after local persistence</div>
<span class="d-arrow"></span>
<div class="node"><span class="t">Outbox</span><code>useSyncStatus().outbox</code> counts it</div>
<span class="d-arrow"></span>
<div class="node ok"><span class="t">Outcome journal</span><code>useCommitOutcomes()</code> shows the final result</div>
</div>

::caption[Both `onEnqueued` and the resolved mutation promise can complete while offline. Server acceptance arrives later in the journal.]
:::

:::::steps
::::step{title="Read sync status" time="2 min"}
`useSyncStatus()` observes the outbox, the schema state, and the pull state:

```tsx title="src/StatusPill.tsx"
import { useSyncStatus } from '@syncular/react';

const { outbox, syncNeeded, upgrading, leaseState, schemaFloor, availability } =
  useSyncStatus();
```

`syncNeeded` means an inbound pull or catch-up is due; `outbox` is pending local
push work. The hook also returns `currentSchemaVersion`, `isLoading`, `error`,
and `refresh`. It exposes no `online` flag: the host owns connectivity
([SPEC §8.4](https://github.com/syncular/syncular/blob/main/docs/SPEC.md)), and
the browser already reports it.

::checkpoint[`outbox` rises when you write offline and returns to `0` after a round drains it.]
::::

::::step{title="Combine status with connectivity" time="3 min"}
A status pill needs three states: offline (queueing), online with a draining
outbox, and in sync. Read connectivity from the host and pair it with `outbox`:

```tsx title="src/StatusPill.tsx"
const [online, setOnline] = useState(navigator.onLine);
useEffect(() => {
  const on = () => setOnline(true);
  const off = () => setOnline(false);
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  return () => {
    window.removeEventListener('online', on);
    window.removeEventListener('offline', off);
  };
}, []);
// "synced" = online && outbox === 0
```

On React Native, read connectivity from your platform's signal instead; the
pairing with `outbox` is the same.

::checkpoint[The pill reads offline with the network off, draining while `outbox > 0`, and synced otherwise.]
::::

::::step{title="Follow a write to its outcome" time="3 min"}
`useMutation` calls `onEnqueued` with the commit id after local persistence.
`useCommitOutcomes()` observes the journal:

```tsx title="src/AddTodo.tsx"
const mutation = useMutation({
  onEnqueued(commitId) {
    setLastCommitId(commitId);
  },
});
const { outcomes } = useCommitOutcomes();
const outcome = outcomes.find((item) => item.clientCommitId === lastCommitId);
```

`isPending` counts local mutation calls. Use `client.commitOutcome(commitId)` to
look up the same result after a restart. An absent terminal outcome means the
commit has not reached a recorded final server result. For a rejection or
conflict, inspect the outcome and apply the resolution actions in
[Conflicts & optimistic writes](/concepts-conflicts/). Resolve an entry with
`useSyncClient().resolveCommitOutcome(...)`.

::checkpoint[`outcome` is `undefined` while the commit is pending and holds the server result after a round accepts or rejects it.]
::::
:::::

## Conflicts

`useConflicts()` observes conflict and rejection changes. Conflict-only changes
do not rerun SQL, so a conflict banner never costs a query.

## Presence

`usePresence(scopeKey)` returns the ephemeral realtime peers on a scope key.
The server rejects a publish to a scope key the client does not hold with
`presence.forbidden`.

## Sync progress

`useSyncProgress(client)` subscribes to the client's progress events and
releases its listener on unmount. It returns the latest snapshot: `phase`,
`state`, byte and row counters, and a retry delay after a failed attempt. The
fields are described in
[Browser: realtime & lifecycle](/platform-web-realtime/#sync-progress); the
Tauri and React Native clients expose the same listener.

## Realtime supervisor

The supervisor attaches to the concrete client. Install it with
`installRealtimeSupervisor` before `SyncProvider` mounts. Components then read
it through `useSyncClient()` with `realtimeSupervisorSnapshot()` and
`subscribeRealtimeSupervisor()`; that read path does not acquire socket
ownership. Setup is in
[Browser: realtime & lifecycle](/platform-web-realtime/#install-the-supervisor).
