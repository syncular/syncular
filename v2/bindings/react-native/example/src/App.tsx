/**
 * The syncular v2 React Native todo — the SAME clean interface as the web
 * demos (apps/demo-react), proving `@syncular-v2/react` hooks work UNCHANGED
 * over the native core:
 *
 *   createNativeSyncClient()  →  a SyncClientLike over the TurboModule (the
 *                                native Rust core: rusqlite on the device FS)
 *   <SyncProvider client={…}> →  the exact provider the web apps use
 *   useSyncQuery / useMutation / useSyncStatus → the exact hooks, unchanged
 *
 * No hacks, no RN-specific client shim in the tree: the whole point of the
 * binding is that RN is just the fifth host of the one interface. Everything
 * below `<SyncProvider>` is framework-agnostic hook code you could paste into
 * demo-react verbatim (only the render primitives are RN's <View>/<Text>).
 *
 * The `client` prop is injected (see index.js), so this component renders in a
 * bun test against the NativeModule double with NO device — the hooks↔module
 * integration proof.
 */

import type { SyncClientLike } from '@syncular-v2/react';
import {
  SyncProvider,
  useMutation,
  useSyncQuery,
  useSyncStatus,
} from '@syncular-v2/react';
import { useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { TodosInsert, TodosRow } from './syncular.generated';

const LIST_ID = 'groceries';

/** Outbox depth + upgrading/floor badges — `useSyncStatus` unchanged. */
function StatusBar(): React.ReactElement {
  const status = useSyncStatus();
  return (
    <View style={styles.statusBar}>
      <Text style={styles.status}>outbox {status.outbox}</Text>
      {status.upgrading ? <Text style={styles.status}>upgrading…</Text> : null}
      {status.syncNeeded ? (
        <Text style={styles.status}>sync needed</Text>
      ) : null}
    </View>
  );
}

/** The todo list itself — `useSyncQuery` (live SQL) + `useMutation` (outbox). */
function TodoList(): React.ReactElement {
  const [draft, setDraft] = useState('');
  const { mutate, isPending } = useMutation();

  // A live local read: runs on mount, re-runs on every `todos` invalidation
  // (optimistic writes land here without a manual refetch).
  const { rows, isLoading } = useSyncQuery<TodosRow>(
    'SELECT id, list_id, title, done, position, updated_at_ms FROM todos WHERE list_id = ? ORDER BY position, id',
    [LIST_ID],
  );

  const add = (): void => {
    const title = draft.trim();
    if (title.length === 0) return;
    setDraft('');
    const position = rows.reduce((max, r) => Math.max(max, r.position), 0) + 1;
    void mutate([
      {
        table: 'todos',
        op: 'upsert',
        values: {
          id: crypto.randomUUID(),
          list_id: LIST_ID,
          title,
          done: false,
          position,
          updated_at_ms: Date.now(),
          // `attachment` (a nullable blob_ref) is omitted — TodosInsert allows it.
        } satisfies TodosInsert,
      },
    ]);
  };

  const toggle = (row: TodosRow): void => {
    void mutate([
      {
        table: 'todos',
        op: 'upsert',
        values: { ...row, done: !row.done, updated_at_ms: Date.now() },
      },
    ]);
  };

  const remove = (id: string): void => {
    void mutate([{ table: 'todos', op: 'delete', rowId: id }]);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.h1}>syncular · react-native</Text>
      <StatusBar />

      <View style={styles.addRow}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={add}
          placeholder={`Add to "${LIST_ID}"…`}
          autoCorrect={false}
        />
        <Pressable
          style={styles.addBtn}
          onPress={add}
          disabled={isPending}
          accessibilityRole="button"
        >
          <Text style={styles.addBtnText}>Add</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <Text style={styles.empty}>loading…</Text>
      ) : rows.length === 0 ? (
        <Text style={styles.empty}>no todos yet</Text>
      ) : (
        <FlatList
          data={rows as TodosRow[]}
          keyExtractor={(row) => row.id}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Pressable
                style={styles.check}
                onPress={() => toggle(item)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: item.done }}
              >
                <Text>{item.done ? '☑' : '☐'}</Text>
              </Pressable>
              <Text style={[styles.title, item.done && styles.titleDone]}>
                {item.title}
              </Text>
              <Pressable
                onPress={() => remove(item.id)}
                accessibilityRole="button"
              >
                <Text style={styles.del}>×</Text>
              </Pressable>
            </View>
          )}
        />
      )}
    </View>
  );
}

/** The app root — supply the native client to the hook tree, then the todo. */
export function App({
  client,
}: {
  client: SyncClientLike;
}): React.ReactElement {
  return (
    <SyncProvider client={client}>
      <TodoList />
    </SyncProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, paddingTop: 48 },
  h1: { fontSize: 22, fontWeight: '600', marginBottom: 8 },
  statusBar: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  status: { fontSize: 12, color: '#666' },
  addRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  addBtn: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  addBtnText: { color: '#fff', fontWeight: '600' },
  empty: { color: '#999', marginTop: 24, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  check: { width: 24 },
  title: { flex: 1, fontSize: 16 },
  titleDone: { textDecorationLine: 'line-through', color: '#999' },
  del: { fontSize: 20, color: '#c00', paddingHorizontal: 8 },
});
