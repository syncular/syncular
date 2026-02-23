import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import type {
  SyncClientDb,
  SyncClientPlugin,
  SyncClientPluginContext,
  SyncEngine,
} from '@syncular/client';
import type {
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '@syncular/core';
import { isRecord } from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64Url,
  hexToBytes,
  randomBytes,
} from './crypto-utils';

// Re-export key sharing utilities
export * from './key-sharing';

type EncryptOrDecrypt = 'encrypt' | 'decrypt';

type FieldDecryptionErrorMode = 'throw' | 'keepCiphertext';

interface FieldEncryptionRule {
  scope: string;
  /**
   * Optional table selector. Strongly recommended for correctness:
   * - Push/incremental changes have a table name.
   * - Snapshot rows often do not; if omitted, the plugin must be able to infer it.
   */
  table?: string;
  /** Column names to encrypt/decrypt */
  fields: string[];
  /**
   * Row id column in snapshot row objects (defaults to "id").
   * Push/incremental changes use the protocol `row_id` and ignore this.
   */
  rowIdField?: string;
}

export interface FieldEncryptionKeys {
  /**
   * Resolve a 32-byte symmetric key for a given key id.
   * Throws (or rejects) when the key is unavailable.
   */
  getKey: (kid: string) => Uint8Array | Promise<Uint8Array>;
  /**
   * Select which key id to use when encrypting new values.
   * Defaults to "default".
   */
  getEncryptionKid?: (
    ctx: SyncClientPluginContext,
    args: { scope: string; table: string; rowId: string; field: string }
  ) => string | Promise<string>;
}

interface FieldEncryptionPluginOptions {
  name?: string;
  rules: FieldEncryptionRule[];
  keys: FieldEncryptionKeys;
  /**
   * Controls what happens when ciphertext is present but decryption fails
   * (unknown key, bad AAD, corrupted data).
   */
  decryptionErrorMode?: FieldDecryptionErrorMode;
  /**
   * Envelope prefix written into the DB. Changing this breaks decryption
   * for existing rows.
   */
  envelopePrefix?: string;
}

interface RefreshEncryptedFieldsTarget {
  scope: string;
  table: string;
  fields?: string[];
}

export interface RefreshEncryptedFieldsResult {
  tablesProcessed: number;
  rowsScanned: number;
  rowsUpdated: number;
  fieldsUpdated: number;
}

interface RefreshEncryptedFieldsOptions<
  DB extends SyncClientDb = SyncClientDb,
> {
  db: Kysely<DB>;
  engine?: Pick<SyncEngine<DB>, 'recordLocalMutations'>;
  rules: FieldEncryptionRule[];
  keys: FieldEncryptionKeys;
  envelopePrefix?: string;
  decryptionErrorMode?: FieldDecryptionErrorMode;
  targets?: RefreshEncryptedFieldsTarget[];
  ctx?: Partial<SyncClientPluginContext>;
}

export interface FieldEncryptionPluginRefreshRequest<
  DB extends SyncClientDb = SyncClientDb,
> {
  db: Kysely<DB>;
  engine?: Pick<SyncEngine<DB>, 'recordLocalMutations'>;
  targets?: RefreshEncryptedFieldsTarget[];
  ctx?: Partial<SyncClientPluginContext>;
}

export interface FieldEncryptionPlugin extends SyncClientPlugin {
  refreshEncryptedFields: <DB extends SyncClientDb = SyncClientDb>(
    options: FieldEncryptionPluginRefreshRequest<DB>
  ) => Promise<RefreshEncryptedFieldsResult>;
}

type RuleConfig = {
  fields: ReadonlySet<string>;
  rowIdField: string;
};

const DEFAULT_PREFIX = 'dgsync:e2ee:1:';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodeKeyMaterial(key: Uint8Array | string): Uint8Array {
  if (key instanceof Uint8Array) return key;
  const trimmed = key.trim();
  if (trimmed.startsWith('hex:'))
    return hexToBytes(trimmed.slice('hex:'.length));
  if (trimmed.startsWith('base64:'))
    return base64ToBytes(trimmed.slice('base64:'.length));
  if (trimmed.startsWith('base64url:'))
    return base64UrlToBytes(trimmed.slice('base64url:'.length));

  // Heuristic: 64 hex chars → 32-byte key.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return hexToBytes(trimmed);
  return base64UrlToBytes(trimmed);
}

export function createStaticFieldEncryptionKeys(args: {
  keys: Record<string, Uint8Array | string>;
  encryptionKid?: string;
}): FieldEncryptionKeys {
  const cache = new Map<string, Uint8Array>();

  return {
    async getKey(kid: string): Promise<Uint8Array> {
      const cached = cache.get(kid);
      if (cached) return cached;
      const raw = args.keys[kid];
      if (!raw) throw new Error(`Missing encryption key for kid "${kid}"`);
      const decoded = decodeKeyMaterial(raw);
      if (decoded.length !== 32) {
        throw new Error(
          `Encryption key for kid "${kid}" must be 32 bytes (got ${decoded.length})`
        );
      }
      cache.set(kid, decoded);
      return decoded;
    },
    getEncryptionKid() {
      return args.encryptionKid ?? 'default';
    },
  };
}

function makeAadBytes(args: {
  scope: string;
  table: string;
  rowId: string;
  field: string;
}): Uint8Array {
  // Keep this stable; changing it breaks decryption.
  const s = `${args.scope}\u001f${args.table}\u001f${args.rowId}\u001f${args.field}`;
  return encoder.encode(s);
}

function encodeEnvelope(
  prefix: string,
  args: { kid: string; nonce: Uint8Array; ciphertext: Uint8Array }
): string {
  return `${prefix}${args.kid}:${bytesToBase64Url(args.nonce)}:${bytesToBase64Url(args.ciphertext)}`;
}

function decodeEnvelope(
  prefix: string,
  value: string
): { kid: string; nonce: Uint8Array; ciphertext: Uint8Array } | null {
  if (!value.startsWith(prefix)) return null;
  const rest = value.slice(prefix.length);
  const parts = rest.split(':');
  if (parts.length !== 3) return null;
  const [kid, nonceB64, ctB64] = parts;
  if (!kid || !nonceB64 || !ctB64) return null;
  try {
    return {
      kid,
      nonce: base64UrlToBytes(nonceB64),
      ciphertext: base64UrlToBytes(ctB64),
    };
  } catch {
    return null;
  }
}

async function getKeyOrThrow(
  keys: FieldEncryptionKeys,
  kid: string
): Promise<Uint8Array> {
  const key = await keys.getKey(kid);
  if (!(key instanceof Uint8Array)) {
    throw new Error(`Encryption key for kid "${kid}" must be a Uint8Array`);
  }
  if (key.length !== 32) {
    throw new Error(
      `Encryption key for kid "${kid}" must be 32 bytes (got ${key.length})`
    );
  }
  return key;
}

async function encryptValue(args: {
  ctx: SyncClientPluginContext;
  keys: FieldEncryptionKeys;
  prefix: string;
  scope: string;
  table: string;
  rowId: string;
  field: string;
  value: unknown;
}): Promise<unknown> {
  if (args.value === null || args.value === undefined) return args.value;
  if (typeof args.value === 'string') {
    const parsed = decodeEnvelope(args.prefix, args.value);
    if (parsed) return args.value;
  }

  const kid =
    (await args.keys.getEncryptionKid?.(args.ctx, {
      scope: args.scope,
      table: args.table,
      rowId: args.rowId,
      field: args.field,
    })) ?? 'default';

  if (typeof kid !== 'string' || kid.length === 0) {
    throw new Error('Encryption key id must be a non-empty string');
  }
  if (kid.includes(':')) {
    throw new Error('Encryption key id must not contain ":"');
  }

  const key = await getKeyOrThrow(args.keys, kid);
  const nonce = randomBytes(24); // XChaCha20-Poly1305 nonce size
  const aad = makeAadBytes({
    scope: args.scope,
    table: args.table,
    rowId: args.rowId,
    field: args.field,
  });

  const plaintext = encoder.encode(JSON.stringify(args.value));
  const aead = xchacha20poly1305(key, nonce, aad);
  const ciphertext = aead.encrypt(plaintext);

  return encodeEnvelope(args.prefix, { kid, nonce, ciphertext });
}

async function decryptValue(args: {
  keys: FieldEncryptionKeys;
  prefix: string;
  decryptionErrorMode: FieldDecryptionErrorMode;
  scope: string;
  table: string;
  rowId: string;
  field: string;
  value: unknown;
}): Promise<unknown> {
  if (typeof args.value !== 'string') return args.value;

  const parsed = decodeEnvelope(args.prefix, args.value);
  if (!parsed) return args.value;

  try {
    const key = await getKeyOrThrow(args.keys, parsed.kid);
    const aad = makeAadBytes({
      scope: args.scope,
      table: args.table,
      rowId: args.rowId,
      field: args.field,
    });
    const aead = xchacha20poly1305(key, parsed.nonce, aad);
    const plaintext = aead.decrypt(parsed.ciphertext);
    const json = decoder.decode(plaintext);
    return JSON.parse(json);
  } catch (err) {
    if (args.decryptionErrorMode === 'keepCiphertext') return args.value;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to decrypt ${args.scope}.${args.table}.${args.field} row=${args.rowId}: ${message}`
    );
  }
}

function buildRuleIndex(rules: FieldEncryptionRule[]): {
  byScopeTable: Map<string, RuleConfig>;
  tablesByScope: Map<string, Set<string>>;
  scopesByTable: Map<string, Set<string>>;
} {
  const byScopeTable = new Map<string, RuleConfig>();
  const tablesByScope = new Map<string, Set<string>>();
  const scopesByTable = new Map<string, Set<string>>();

  for (const rule of rules) {
    const scope = rule.scope;
    const table = rule.table ?? '*';
    const key = `${scope}\u001f${table}`;
    const rowIdField = rule.rowIdField ?? 'id';

    const existing = byScopeTable.get(key);
    if (existing) {
      if (existing.rowIdField !== rowIdField) {
        throw new Error(
          `Conflicting rowIdField for rule ${scope}/${table}: "${existing.rowIdField}" vs "${rowIdField}"`
        );
      }
      const merged = new Set(existing.fields);
      for (const f of rule.fields) merged.add(f);
      byScopeTable.set(key, { fields: merged, rowIdField });
    } else {
      byScopeTable.set(key, { fields: new Set(rule.fields), rowIdField });
    }

    if (table !== '*') {
      const tables = tablesByScope.get(scope) ?? new Set<string>();
      tables.add(table);
      tablesByScope.set(scope, tables);

      const scopes = scopesByTable.get(table) ?? new Set<string>();
      scopes.add(scope);
      scopesByTable.set(table, scopes);
    }
  }

  // Freeze sets to make accidental mutation harder.
  for (const [k, v] of byScopeTable) {
    byScopeTable.set(k, {
      fields: new Set(v.fields),
      rowIdField: v.rowIdField,
    });
  }

  return { byScopeTable, tablesByScope, scopesByTable };
}

function getRuleConfig(
  index: ReturnType<typeof buildRuleIndex>,
  args: { scope: string; table: string }
): RuleConfig | null {
  const exact = index.byScopeTable.get(`${args.scope}\u001f${args.table}`);
  if (exact) return exact;
  const wildcard = index.byScopeTable.get(`${args.scope}\u001f*`);
  return wildcard ?? null;
}

function resolveScopeAndTable(args: {
  index: ReturnType<typeof buildRuleIndex>;
  identifier: string;
}): { scope: string; table: string } {
  const direct = getRuleConfig(args.index, {
    scope: args.identifier,
    table: args.identifier,
  });
  if (direct) {
    return { scope: args.identifier, table: args.identifier };
  }

  const tablesForScope = args.index.tablesByScope.get(args.identifier);
  if (tablesForScope && tablesForScope.size === 1) {
    const table = Array.from(tablesForScope)[0]!;
    return { scope: args.identifier, table };
  }

  const scopesForTable = args.index.scopesByTable.get(args.identifier);
  if (scopesForTable && scopesForTable.size === 1) {
    const scope = Array.from(scopesForTable)[0]!;
    return { scope, table: args.identifier };
  }

  return { scope: args.identifier, table: args.identifier };
}

function inferSnapshotTable(args: {
  index: ReturnType<typeof buildRuleIndex>;
  scope: string;
  row: unknown;
}): string {
  if (isRecord(args.row)) {
    const tn = args.row.table_name;
    if (typeof tn === 'string' && tn.length > 0) return tn;
    const tt = args.row.__table;
    if (typeof tt === 'string' && tt.length > 0) return tt;
  }

  const tables = args.index.tablesByScope.get(args.scope);
  if (tables && tables.size === 1) return Array.from(tables)[0]!;

  throw new Error(
    `Cannot infer table for snapshot row (scope="${args.scope}"). Provide FieldEncryptionRule.table or include "table_name"/"__table" in snapshot rows.`
  );
}

function getSnapshotRowId(args: {
  row: unknown;
  rowIdField: string;
  scope: string;
  table: string;
}): string {
  if (!isRecord(args.row)) {
    throw new Error(
      `Snapshot row for ${args.scope}/${args.table} must be an object`
    );
  }
  const raw = args.row[args.rowIdField];
  const rowId = String(raw ?? '');
  if (!rowId) {
    throw new Error(
      `Snapshot row for ${args.scope}/${args.table} is missing row id field "${args.rowIdField}"`
    );
  }
  return rowId;
}

async function transformRecordFields(args: {
  ctx: SyncClientPluginContext;
  index: ReturnType<typeof buildRuleIndex>;
  keys: FieldEncryptionKeys;
  prefix: string;
  decryptionErrorMode: FieldDecryptionErrorMode;
  mode: EncryptOrDecrypt;
  scope: string;
  table: string;
  rowId: string;
  record: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const config = getRuleConfig(args.index, {
    scope: args.scope,
    table: args.table,
  });
  if (!config || config.fields.size === 0) return args.record;

  let changed = false;
  const next: Record<string, unknown> = { ...args.record };

  for (const field of config.fields) {
    if (!(field in next)) continue;
    const value = next[field];
    const transformed =
      args.mode === 'encrypt'
        ? await encryptValue({
            ctx: args.ctx,
            keys: args.keys,
            prefix: args.prefix,
            scope: args.scope,
            table: args.table,
            rowId: args.rowId,
            field,
            value,
          })
        : await decryptValue({
            keys: args.keys,
            prefix: args.prefix,
            decryptionErrorMode: args.decryptionErrorMode,
            scope: args.scope,
            table: args.table,
            rowId: args.rowId,
            field,
            value,
          });

    if (transformed !== value) {
      next[field] = transformed;
      changed = true;
    }
  }

  return changed ? next : args.record;
}

type ResolvedRefreshTarget = {
  scope: string;
  table: string;
  rowIdField: string;
  fields: string[];
};

function parseRuleKey(key: string): { scope: string; table: string } {
  const splitAt = key.indexOf('\u001f');
  if (splitAt < 0) return { scope: key, table: '*' };
  return {
    scope: key.slice(0, splitAt),
    table: key.slice(splitAt + 1),
  };
}

function coerceSqlValue(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function resolveRefreshTargets(args: {
  index: ReturnType<typeof buildRuleIndex>;
  targets?: RefreshEncryptedFieldsTarget[];
}): ResolvedRefreshTarget[] {
  const merged = new Map<
    string,
    { scope: string; table: string; rowIdField: string; fields: Set<string> }
  >();

  if (!args.targets || args.targets.length === 0) {
    for (const [key, config] of args.index.byScopeTable) {
      const parsed = parseRuleKey(key);
      if (parsed.table === '*') continue;

      const mergedKey = `${parsed.scope}\u001f${parsed.table}`;
      const existing = merged.get(mergedKey);
      if (existing) {
        for (const field of config.fields) existing.fields.add(field);
      } else {
        merged.set(mergedKey, {
          scope: parsed.scope,
          table: parsed.table,
          rowIdField: config.rowIdField,
          fields: new Set(config.fields),
        });
      }
    }
  } else {
    for (const target of args.targets) {
      const config = getRuleConfig(args.index, {
        scope: target.scope,
        table: target.table,
      });
      if (!config) {
        throw new Error(
          `No field encryption rule configured for ${target.scope}/${target.table}`
        );
      }

      const selectedFields = target.fields ?? Array.from(config.fields);
      if (selectedFields.length === 0) {
        throw new Error(
          `Refresh target ${target.scope}/${target.table} has no fields`
        );
      }

      for (const field of selectedFields) {
        if (!config.fields.has(field)) {
          throw new Error(
            `Field "${field}" is not configured for encryption in ${target.scope}/${target.table}`
          );
        }
      }

      const mergedKey = `${target.scope}\u001f${target.table}`;
      const existing = merged.get(mergedKey);
      if (existing) {
        if (existing.rowIdField !== config.rowIdField) {
          throw new Error(
            `Conflicting rowIdField for ${target.scope}/${target.table}: "${existing.rowIdField}" vs "${config.rowIdField}"`
          );
        }
        for (const field of selectedFields) existing.fields.add(field);
      } else {
        merged.set(mergedKey, {
          scope: target.scope,
          table: target.table,
          rowIdField: config.rowIdField,
          fields: new Set(selectedFields),
        });
      }
    }
  }

  return Array.from(merged.values()).map((target) => ({
    scope: target.scope,
    table: target.table,
    rowIdField: target.rowIdField,
    fields: Array.from(target.fields),
  }));
}

async function refreshEncryptedFields<DB extends SyncClientDb = SyncClientDb>(
  options: RefreshEncryptedFieldsOptions<DB>
): Promise<RefreshEncryptedFieldsResult> {
  const prefix = options.envelopePrefix ?? DEFAULT_PREFIX;
  if (!prefix.endsWith(':')) {
    throw new Error(
      'RefreshEncryptedFieldsOptions.envelopePrefix must end with ":"'
    );
  }

  const decryptionErrorMode = options.decryptionErrorMode ?? 'throw';
  const index = buildRuleIndex(options.rules ?? []);
  const targets = resolveRefreshTargets({
    index,
    targets: options.targets,
  });

  if (targets.length === 0) {
    return {
      tablesProcessed: 0,
      rowsScanned: 0,
      rowsUpdated: 0,
      fieldsUpdated: 0,
    };
  }

  const ctx: SyncClientPluginContext = {
    actorId: options.ctx?.actorId ?? 'local-refresh',
    clientId: options.ctx?.clientId ?? 'local-refresh',
  };

  let rowsScanned = 0;
  let rowsUpdated = 0;
  let fieldsUpdated = 0;
  const updatedRows: Array<{ table: string; rowId: string }> = [];

  await options.db.transaction().execute(async (trx) => {
    for (const target of targets) {
      const columns = [target.rowIdField, ...target.fields];
      const rowsResult = await sql<Record<string, unknown>>`
        select ${sql.join(
          columns.map((column) => sql.ref(column)),
          sql`, `
        )}
        from ${sql.table(target.table)}
      `.execute(trx);

      rowsScanned += rowsResult.rows.length;

      for (const row of rowsResult.rows) {
        if (!isRecord(row)) continue;

        const rowIdValue = row[target.rowIdField];
        if (rowIdValue === null || rowIdValue === undefined) continue;
        const rowId = String(rowIdValue);
        if (!rowId) continue;

        let hasCiphertext = false;
        for (const field of target.fields) {
          const value = row[field];
          if (typeof value === 'string' && value.startsWith(prefix)) {
            hasCiphertext = true;
            break;
          }
        }
        if (!hasCiphertext) continue;

        const nextRow = await transformRecordFields({
          ctx,
          index,
          keys: options.keys,
          prefix,
          decryptionErrorMode,
          mode: 'decrypt',
          scope: target.scope,
          table: target.table,
          rowId,
          record: row,
        });

        if (nextRow === row) continue;

        const assignments = [];
        let changedFields = 0;

        for (const field of target.fields) {
          if (!(field in nextRow)) continue;
          const previousValue = row[field];
          const nextValue = nextRow[field];
          if (nextValue === previousValue) continue;

          assignments.push(
            sql`${sql.ref(field)} = ${sql.val(coerceSqlValue(nextValue))}`
          );
          changedFields += 1;
        }

        if (assignments.length === 0) continue;

        await sql`
          update ${sql.table(target.table)}
          set ${sql.join(assignments, sql`, `)}
          where ${sql.ref(target.rowIdField)} = ${sql.val(
            coerceSqlValue(rowIdValue)
          )}
        `.execute(trx);

        rowsUpdated += 1;
        fieldsUpdated += changedFields;
        updatedRows.push({ table: target.table, rowId });
      }
    }
  });

  if (updatedRows.length > 0 && options.engine) {
    const deduped = new Map<string, { table: string; rowId: string }>();
    for (const row of updatedRows) {
      deduped.set(`${row.table}\u001f${row.rowId}`, row);
    }

    options.engine.recordLocalMutations(
      Array.from(deduped.values()).map((row) => ({
        table: row.table,
        rowId: row.rowId,
        op: 'upsert',
      }))
    );
  }

  return {
    tablesProcessed: targets.length,
    rowsScanned,
    rowsUpdated,
    fieldsUpdated,
  };
}

export function createFieldEncryptionPlugin(
  pluginOptions: FieldEncryptionPluginOptions
): FieldEncryptionPlugin {
  const name = pluginOptions.name ?? 'field-encryption';
  const prefix = pluginOptions.envelopePrefix ?? DEFAULT_PREFIX;
  const decryptionErrorMode = pluginOptions.decryptionErrorMode ?? 'throw';

  if (!prefix.endsWith(':')) {
    throw new Error(
      'FieldEncryptionPluginOptions.envelopePrefix must end with ":"'
    );
  }

  const index = buildRuleIndex(pluginOptions.rules ?? []);

  return {
    name,

    refreshEncryptedFields: <DB extends SyncClientDb = SyncClientDb>(
      options: FieldEncryptionPluginRefreshRequest<DB>
    ) =>
      refreshEncryptedFields({
        db: options.db,
        engine: options.engine,
        rules: pluginOptions.rules,
        keys: pluginOptions.keys,
        envelopePrefix: prefix,
        decryptionErrorMode,
        targets: options.targets,
        ctx: options.ctx,
      }),

    async beforePush(ctx, request): Promise<SyncPushRequest> {
      if ((pluginOptions.rules?.length ?? 0) === 0) return request;
      if ((request.operations?.length ?? 0) === 0) return request;

      const nextOps = await Promise.all(
        request.operations.map(async (op) => {
          if (op.op !== 'upsert') return op;
          if (!op.payload) return op;

          const payload = op.payload as Record<string, unknown>;
          const target = resolveScopeAndTable({
            index,
            identifier: op.table,
          });
          const nextPayload = await transformRecordFields({
            ctx,
            index,
            keys: pluginOptions.keys,
            prefix,
            decryptionErrorMode,
            mode: 'encrypt',
            scope: target.scope,
            table: target.table,
            rowId: op.row_id,
            record: payload,
          });

          if (nextPayload === payload) return op;
          return { ...op, payload: nextPayload };
        })
      );

      return { ...request, operations: nextOps };
    },

    async afterPush(
      ctx,
      args: { request: SyncPushRequest; response: SyncPushResponse }
    ): Promise<SyncPushResponse> {
      const { request, response } = args;
      if ((pluginOptions.rules?.length ?? 0) === 0) return response;
      if ((response.results?.length ?? 0) === 0) return response;

      const nextResults = await Promise.all(
        response.results.map(async (r) => {
          if (r.status !== 'conflict' || !('server_row' in r)) return r;
          if (r.server_row == null) return r;

          const op = request.operations[r.opIndex];
          if (!op) return r;

          if (!isRecord(r.server_row)) return r;
          const target = resolveScopeAndTable({
            index,
            identifier: op.table,
          });

          const nextRow = await transformRecordFields({
            ctx,
            index,
            keys: pluginOptions.keys,
            prefix,
            decryptionErrorMode,
            mode: 'decrypt',
            scope: target.scope,
            table: target.table,
            rowId: op.row_id,
            record: r.server_row,
          });

          if (nextRow === r.server_row) return r;
          return { ...r, server_row: nextRow };
        })
      );

      return { ...response, results: nextResults };
    },

    async afterPull(
      ctx,
      args: { request: SyncPullRequest; response: SyncPullResponse }
    ): Promise<SyncPullResponse> {
      const { response } = args;
      if ((pluginOptions.rules?.length ?? 0) === 0) return response;

      const nextSubscriptions = await Promise.all(
        response.subscriptions.map(async (sub) => {
          // Bootstrap snapshots
          if (sub.bootstrap) {
            const nextSnapshots = await Promise.all(
              (sub.snapshots ?? []).map(async (snapshot) => {
                const scope = snapshot.table;
                const rows = snapshot.rows ?? [];
                if (rows.length === 0) return snapshot;

                const nextRows = await Promise.all(
                  rows.map(async (row) => {
                    const table = inferSnapshotTable({ index, scope, row });
                    const config = getRuleConfig(index, { scope, table });
                    if (!config || config.fields.size === 0) return row;

                    const rowId = getSnapshotRowId({
                      row,
                      rowIdField: config.rowIdField,
                      scope,
                      table,
                    });

                    if (!isRecord(row)) return row;
                    const nextRow = await transformRecordFields({
                      ctx,
                      index,
                      keys: pluginOptions.keys,
                      prefix,
                      decryptionErrorMode,
                      mode: 'decrypt',
                      scope,
                      table,
                      rowId,
                      record: row,
                    });
                    return nextRow;
                  })
                );

                return { ...snapshot, rows: nextRows };
              })
            );

            return { ...sub, snapshots: nextSnapshots };
          }

          // Incremental commits
          const nextCommits = await Promise.all(
            (sub.commits ?? []).map(async (commit) => {
              const nextChanges = await Promise.all(
                (commit.changes ?? []).map(async (change) => {
                  if (change.op !== 'upsert') return change;
                  if (!isRecord(change.row_json)) return change;
                  const target = resolveScopeAndTable({
                    index,
                    identifier: change.table,
                  });

                  const nextRow = await transformRecordFields({
                    ctx,
                    index,
                    keys: pluginOptions.keys,
                    prefix,
                    decryptionErrorMode,
                    mode: 'decrypt',
                    scope: target.scope,
                    table: target.table,
                    rowId: change.row_id,
                    record: change.row_json,
                  });

                  if (nextRow === change.row_json) return change;
                  return { ...change, row_json: nextRow };
                })
              );
              return { ...commit, changes: nextChanges };
            })
          );

          return { ...sub, commits: nextCommits };
        })
      );

      return { ...response, subscriptions: nextSubscriptions };
    },
  };
}
