import { createExpoSqliteDialect } from '@syncular/dialect-expo-sqlite';
import { openDatabaseSync } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { Kysely, type ColumnType } from 'kysely';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

interface ItemRow {
  id: string;
  payload: { foo: string; n: number; nested: { ok: boolean } };
  created_at: ColumnType<Date, Date, Date>;
  done: ColumnType<boolean, boolean, boolean>;
}

interface Db {
  items: ItemRow;
}

export default function App() {
  const [phase, setPhase] = useState<'idle' | 'running' | 'ok' | 'error'>(
    'idle'
  );
  const [details, setDetails] = useState<string>('');

  const runDbSmoke = useCallback(async () => {
    setPhase('running');
    setDetails('');
    const db = new Kysely<Db>({
      dialect: createExpoSqliteDialect({
        name: 'syncular-tests.db',
        openDatabaseSync,
      }),
    });

    try {
      await db.schema.dropTable('items').ifExists().execute();
      await db.schema
        .createTable('items')
        .addColumn('id', 'text', (c) => c.primaryKey().notNull())
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('done', 'text', (c) => c.notNull())
        .execute();

      const createdAt = new Date('2026-02-05T12:34:56.789Z');
      const payload = { foo: 'bar', n: 42, nested: { ok: true } };

      await db
        .insertInto('items')
        .values({ id: '1', payload, created_at: createdAt, done: true })
        .execute();

      const row = await db
        .selectFrom('items')
        .selectAll()
        .where('id', '=', '1')
        .executeTakeFirstOrThrow();

      if (row.payload.foo !== payload.foo || row.payload.n !== payload.n) {
        throw new Error('payload mismatch');
      }
      if (row.payload.nested.ok !== payload.nested.ok) {
        throw new Error('payload nested mismatch');
      }
      if (row.done !== true) {
        throw new Error('boolean mismatch');
      }
      if (!(row.created_at instanceof Date)) {
        throw new Error('date mismatch (not a Date)');
      }
      if (row.created_at.toISOString() !== createdAt.toISOString()) {
        throw new Error('date mismatch (value)');
      }

      setPhase('ok');
      setDetails('DB_SMOKE_OK');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      setPhase('error');
      setDetails(`DB_SMOKE_ERROR: ${message}`);
    } finally {
      await db.destroy();
    }
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Syncular Expo Tests</Text>
      <Text style={styles.subtitle}>Dialect: expo-sqlite</Text>

      <Pressable
        accessibilityLabel="run-db-smoke"
        testID="run-db-smoke"
        style={[styles.button, phase === 'running' && styles.buttonDisabled]}
        disabled={phase === 'running'}
        onPress={runDbSmoke}
      >
        <Text style={styles.buttonText}>Run DB smoke</Text>
      </Pressable>

      {phase === 'running' && (
        <View style={styles.row}>
          <ActivityIndicator />
          <Text style={styles.rowText}>Running…</Text>
        </View>
      )}

      <Text
        accessibilityLabel="result"
        testID="result"
        style={[
          styles.result,
          phase === 'ok' && styles.ok,
          phase === 'error' && styles.error,
        ]}
      >
        {details || '—'}
      </Text>

      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b1220',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    color: '#94a3b8',
    fontSize: 14,
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    marginBottom: 16,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  result: {
    width: '100%',
    backgroundColor: '#111827',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#e5e7eb',
    textAlign: 'center',
  },
  ok: {
    borderColor: '#22c55e',
    borderWidth: 1,
  },
  error: {
    borderColor: '#ef4444',
    borderWidth: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  rowText: {
    color: '#e5e7eb',
    fontSize: 14,
  },
});
