import {
  PluginPriority,
  type SyncChange,
  type SyncClientLocalMutationArgs,
  type SyncClientPlugin,
  type SyncClientWsDeliveryArgs,
  type SyncPullResponse,
  type SyncPullSubscriptionResponse,
  type SyncPushRequest,
} from '@syncular/client';
import * as Y from 'yjs';

export const YJS_PAYLOAD_KEY = '__yjs';

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type YjsFieldKind = 'text' | 'xml-fragment' | 'prosemirror';

export interface YjsClientFieldRule {
  table: string;
  field: string;
  /**
   * Column that stores canonical serialized Yjs state.
   * Example: "content_yjs_state"
   */
  stateColumn: string;
  /**
   * Container key inside the Yjs document. Defaults to `field`.
   */
  containerKey?: string;
  /**
   * Snapshot row id column. Defaults to `id`.
   */
  rowIdField?: string;
  /**
   * CRDT container type.
   */
  kind?: YjsFieldKind;
}

interface ResolvedYjsClientFieldRule extends YjsClientFieldRule {
  containerKey: string;
  rowIdField: string;
  kind: YjsFieldKind;
}

export interface YjsClientUpdateEnvelope {
  updateId: string;
  updateBase64: string;
}

export type YjsClientUpdateInput =
  | YjsClientUpdateEnvelope
  | readonly YjsClientUpdateEnvelope[];

export interface YjsClientPayloadEnvelope {
  [field: string]: YjsClientUpdateInput;
}

export interface BuildYjsTextUpdateArgs {
  previousStateBase64?: string | Uint8Array | null;
  nextText: string;
  containerKey?: string;
  updateId?: string;
}

export interface BuildYjsTextUpdateResult {
  update: YjsClientUpdateEnvelope;
  nextStateBase64: string;
  nextText: string;
}

export interface ApplyYjsTextUpdatesArgs {
  previousStateBase64?: string | Uint8Array | null;
  updates: readonly YjsClientUpdateEnvelope[];
  containerKey?: string;
}

export interface ApplyYjsTextUpdatesResult {
  nextStateBase64: string;
  text: string;
}

export interface CreateYjsClientPluginOptions {
  name?: string;
  rules: readonly YjsClientFieldRule[];
  envelopeKey?: string;
  priority?: number;
  /**
   * Throw when envelope payload references fields without matching rules.
   * @default true
   */
  strict?: boolean;
  /**
   * Remove the Yjs envelope key from outgoing/incoming records.
   * @default true
   */
  stripEnvelope?: boolean;
  /**
   * Remove the Yjs envelope key from push payloads.
   * Default inherits from `stripEnvelope`.
   */
  stripEnvelopeBeforePush?: boolean;
  /**
   * Remove the Yjs envelope key from local optimistic mutation payloads.
   * Default inherits from `stripEnvelope`.
   */
  stripEnvelopeBeforeApplyLocalMutations?: boolean;
}

type RuleIndex = Map<string, Map<string, ResolvedYjsClientFieldRule>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function tryReadBase64TextFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  try {
    const decoded = new TextDecoder().decode(bytes).trim();
    if (!decoded || !BASE64_PATTERN.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function base64ToBytes(base64: string): Uint8Array {
  if (!BASE64_PATTERN.test(base64)) {
    throw new Error('Invalid base64 string');
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }

  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function stateValueToBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    const encoded = tryReadBase64TextFromBytes(value);
    if (encoded) return base64ToBytes(encoded);
    return value;
  }
  const str = readString(value);
  if (!str) return null;
  return base64ToBytes(str);
}

function stateValueToBase64(value: unknown): string | null {
  const str = readString(value);
  if (str) return str;
  if (value instanceof Uint8Array) {
    const encoded = tryReadBase64TextFromBytes(value);
    if (encoded) return encoded;
    return bytesToBase64(value);
  }
  return null;
}

function createDocFromState(stateValue: unknown): Y.Doc {
  const doc = new Y.Doc();
  const bytes = stateValueToBytes(stateValue);
  if (bytes && bytes.length > 0) {
    Y.applyUpdate(doc, bytes);
  }
  return doc;
}

function exportSnapshotBase64(doc: Y.Doc): string {
  return bytesToBase64(Y.encodeStateAsUpdate(doc));
}

function replaceText(doc: Y.Doc, containerKey: string, nextText: string): void {
  const text = doc.getText(containerKey);
  const currentLength = text.length;
  doc.transact(() => {
    if (currentLength > 0) {
      text.delete(0, currentLength);
    }
    if (nextText.length > 0) {
      text.insert(0, nextText);
    }
  });
}

function patchText(doc: Y.Doc, containerKey: string, nextText: string): void {
  const text = doc.getText(containerKey);
  const currentText = text.toString();
  if (currentText === nextText) return;

  const minLength = Math.min(currentText.length, nextText.length);
  let prefixLength = 0;
  while (
    prefixLength < minLength &&
    currentText.charCodeAt(prefixLength) === nextText.charCodeAt(prefixLength)
  ) {
    prefixLength += 1;
  }

  let currentSuffixStart = currentText.length;
  let nextSuffixStart = nextText.length;
  while (
    currentSuffixStart > prefixLength &&
    nextSuffixStart > prefixLength &&
    currentText.charCodeAt(currentSuffixStart - 1) ===
      nextText.charCodeAt(nextSuffixStart - 1)
  ) {
    currentSuffixStart -= 1;
    nextSuffixStart -= 1;
  }

  const deleteLength = currentSuffixStart - prefixLength;
  const insertSegment = nextText.slice(prefixLength, nextSuffixStart);

  doc.transact(() => {
    if (deleteLength > 0) {
      text.delete(prefixLength, deleteLength);
    }
    if (insertSegment.length > 0) {
      text.insert(prefixLength, insertSegment);
    }
  });
}

function ensureTextContainer(doc: Y.Doc, containerKey: string): string {
  return doc.getText(containerKey).toString();
}

function ensureXmlFragmentContainer(doc: Y.Doc, containerKey: string): string {
  return doc.getXmlFragment(containerKey).toString();
}

function materializeRuleValue(
  doc: Y.Doc,
  rule: ResolvedYjsClientFieldRule
): unknown {
  if (rule.kind === 'text') {
    return ensureTextContainer(doc, rule.containerKey);
  }
  return ensureXmlFragmentContainer(doc, rule.containerKey);
}

function seedRuleValueFromPayload(
  doc: Y.Doc,
  rule: ResolvedYjsClientFieldRule,
  source: Record<string, unknown>
): void {
  if (rule.kind !== 'text') return;
  const initialText = readString(source[rule.field]);
  if (initialText) {
    replaceText(doc, rule.containerKey, initialText);
  }
}

function buildRuleIndex(rules: readonly YjsClientFieldRule[]): {
  index: RuleIndex;
  normalizedRules: readonly ResolvedYjsClientFieldRule[];
} {
  const index: RuleIndex = new Map();
  const normalizedRules: ResolvedYjsClientFieldRule[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    if (!rule.table.trim()) {
      throw new Error('YjsClientFieldRule.table cannot be empty');
    }
    if (!rule.field.trim()) {
      throw new Error('YjsClientFieldRule.field cannot be empty');
    }
    if (!rule.stateColumn.trim()) {
      throw new Error('YjsClientFieldRule.stateColumn cannot be empty');
    }

    const key = `${rule.table}\u001f${rule.field}`;
    if (seen.has(key)) {
      throw new Error(
        `Duplicate Yjs client rule for table "${rule.table}", field "${rule.field}"`
      );
    }
    seen.add(key);

    const resolved: ResolvedYjsClientFieldRule = {
      ...rule,
      containerKey: rule.containerKey ?? rule.field,
      rowIdField: rule.rowIdField ?? 'id',
      kind: rule.kind ?? 'text',
    };
    normalizedRules.push(resolved);

    const tableRules = index.get(resolved.table) ?? new Map();
    tableRules.set(resolved.field, resolved);
    index.set(resolved.table, tableRules);
  }

  return { index, normalizedRules };
}

function rowFieldCacheKey(table: string, rowId: string, field: string): string {
  return `${table}\u001f${rowId}\u001f${field}`;
}

function resolveSnapshotRowId(
  row: Record<string, unknown>,
  rule: ResolvedYjsClientFieldRule
): string | null {
  const candidate = row[rule.rowIdField];
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : null;
}

function normalizeUpdateEnvelope(
  value: unknown,
  context: string
): YjsClientUpdateEnvelope {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }
  const updateId = readString(value.updateId);
  const updateBase64 = readString(value.updateBase64);
  if (!updateId) {
    throw new Error(`${context}.updateId must be a non-empty string`);
  }
  if (!updateBase64) {
    throw new Error(
      `${context}.updateBase64 must be a non-empty base64 string`
    );
  }
  return { updateId, updateBase64 };
}

function normalizeUpdateEnvelopes(
  value: unknown,
  context: string
): YjsClientUpdateEnvelope[] {
  if (Array.isArray(value)) {
    return value.map((entry, i) =>
      normalizeUpdateEnvelope(entry, `${context}[${i}]`)
    );
  }
  return [normalizeUpdateEnvelope(value, context)];
}

function createUpdateId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') {
    return randomUUID.call(globalThis.crypto);
  }
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 12);
  return `yjs-${ts}-${rnd}`;
}

export function applyYjsTextUpdates(
  args: ApplyYjsTextUpdatesArgs
): ApplyYjsTextUpdatesResult {
  const containerKey = args.containerKey ?? 'text';
  const doc = createDocFromState(args.previousStateBase64);
  try {
    for (const update of args.updates) {
      Y.applyUpdate(doc, base64ToBytes(update.updateBase64));
    }
    const text = ensureTextContainer(doc, containerKey);
    const nextStateBase64 = exportSnapshotBase64(doc);
    return { nextStateBase64, text };
  } finally {
    doc.destroy();
  }
}

export function buildYjsTextUpdate(
  args: BuildYjsTextUpdateArgs
): BuildYjsTextUpdateResult {
  const containerKey = args.containerKey ?? 'text';
  const doc = createDocFromState(args.previousStateBase64);
  try {
    const from = Y.encodeStateVector(doc);
    patchText(doc, containerKey, args.nextText);
    const update = bytesToBase64(Y.encodeStateAsUpdate(doc, from));
    const nextText = ensureTextContainer(doc, containerKey);
    const nextStateBase64 = exportSnapshotBase64(doc);

    return {
      update: {
        updateId: args.updateId ?? createUpdateId(),
        updateBase64: update,
      },
      nextStateBase64,
      nextText,
    };
  } finally {
    doc.destroy();
  }
}

function materializeRowFromState(args: {
  table: string;
  rowId: string | null;
  row: Record<string, unknown>;
  index: RuleIndex;
  stateByRowField: Map<string, string>;
  envelopeKey: string;
  stripEnvelope: boolean;
}): Record<string, unknown> {
  const tableRules = args.index.get(args.table);
  if (!tableRules) {
    if (args.stripEnvelope && args.envelopeKey in args.row) {
      const next = { ...args.row };
      delete next[args.envelopeKey];
      return next;
    }
    return args.row;
  }

  let nextRow: Record<string, unknown> | null = null;
  const ensureRow = (): Record<string, unknown> => {
    if (nextRow) return nextRow;
    nextRow = { ...args.row };
    return nextRow;
  };

  for (const rule of tableRules.values()) {
    const source = nextRow ?? args.row;
    const stateBase64 = stateValueToBase64(source[rule.stateColumn]);
    if (!stateBase64) continue;

    const doc = createDocFromState(stateBase64);
    try {
      const nextValue = materializeRuleValue(doc, rule);
      if (source[rule.field] !== nextValue) {
        ensureRow()[rule.field] = nextValue;
      }
      if (args.rowId) {
        args.stateByRowField.set(
          rowFieldCacheKey(args.table, args.rowId, rule.field),
          stateBase64
        );
      }
    } finally {
      doc.destroy();
    }
  }

  if (args.stripEnvelope) {
    const source = nextRow ?? args.row;
    if (args.envelopeKey in source) {
      const target = ensureRow();
      delete target[args.envelopeKey];
    }
  }

  return nextRow ?? args.row;
}

function transformPushPayload(args: {
  table: string;
  rowId: string;
  payload: Record<string, unknown>;
  index: RuleIndex;
  stateByRowField: Map<string, string>;
  envelopeKey: string;
  stripEnvelope: boolean;
  strict: boolean;
}): Record<string, unknown> {
  const tableRules = args.index.get(args.table);
  const rawEnvelope = args.payload[args.envelopeKey];

  if (!tableRules) {
    if (rawEnvelope !== undefined && args.strict) {
      throw new Error(
        `Yjs envelope provided for table "${args.table}" without matching rules`
      );
    }
    if (args.stripEnvelope && rawEnvelope !== undefined) {
      const next = { ...args.payload };
      delete next[args.envelopeKey];
      return next;
    }
    return args.payload;
  }

  let nextPayload: Record<string, unknown> | null = null;
  const ensurePayload = (): Record<string, unknown> => {
    if (nextPayload) return nextPayload;
    nextPayload = { ...args.payload };
    return nextPayload;
  };

  const sourceEnvelope = rawEnvelope;
  if (sourceEnvelope !== undefined && !isRecord(sourceEnvelope)) {
    throw new Error(
      `Yjs payload key "${args.envelopeKey}" must be an object for table "${args.table}"`
    );
  }

  for (const rule of tableRules.values()) {
    const source = nextPayload ?? args.payload;
    const stateBase64 = stateValueToBase64(source[rule.stateColumn]);
    if (stateBase64) {
      args.stateByRowField.set(
        rowFieldCacheKey(args.table, args.rowId, rule.field),
        stateBase64
      );
    }
  }

  if (sourceEnvelope) {
    for (const [field, rawUpdateInput] of Object.entries(sourceEnvelope)) {
      const rule = tableRules.get(field);
      if (!rule) {
        if (args.strict) {
          throw new Error(
            `No Yjs rule found for envelope field "${field}" on table "${args.table}"`
          );
        }
        continue;
      }

      const updates = normalizeUpdateEnvelopes(
        rawUpdateInput,
        `yjs.${args.table}.${field}`
      );
      const cacheKey = rowFieldCacheKey(args.table, args.rowId, rule.field);
      const source = nextPayload ?? args.payload;
      const baseState =
        stateValueToBase64(source[rule.stateColumn]) ??
        args.stateByRowField.get(cacheKey) ??
        null;

      const doc = createDocFromState(baseState);
      try {
        if (!baseState) {
          seedRuleValueFromPayload(doc, rule, source);
        }

        for (const update of updates) {
          Y.applyUpdate(doc, base64ToBytes(update.updateBase64));
        }

        const nextValue = materializeRuleValue(doc, rule);
        const nextStateBase64 = exportSnapshotBase64(doc);
        const target = ensurePayload();
        target[rule.field] = nextValue;
        target[rule.stateColumn] = nextStateBase64;
        args.stateByRowField.set(cacheKey, nextStateBase64);
      } finally {
        doc.destroy();
      }
    }
  }

  if (args.stripEnvelope) {
    const source = nextPayload ?? args.payload;
    if (args.envelopeKey in source) {
      const target = ensurePayload();
      delete target[args.envelopeKey];
    }
  }

  return nextPayload ?? args.payload;
}

function transformPullSubscription(args: {
  sub: SyncPullSubscriptionResponse;
  index: RuleIndex;
  stateByRowField: Map<string, string>;
  envelopeKey: string;
  stripEnvelope: boolean;
}): SyncPullSubscriptionResponse {
  const nextSnapshots = (args.sub.snapshots ?? []).map((snapshot) => ({
    ...snapshot,
    rows: (snapshot.rows ?? []).map((row) => {
      if (!isRecord(row)) return row;
      const tableRules = args.index.get(snapshot.table);
      if (!tableRules) {
        return materializeRowFromState({
          table: snapshot.table,
          rowId: null,
          row,
          index: args.index,
          stateByRowField: args.stateByRowField,
          envelopeKey: args.envelopeKey,
          stripEnvelope: args.stripEnvelope,
        });
      }

      let rowId: string | null = null;
      for (const rule of tableRules.values()) {
        rowId = resolveSnapshotRowId(row, rule);
        if (rowId) break;
      }

      return materializeRowFromState({
        table: snapshot.table,
        rowId,
        row,
        index: args.index,
        stateByRowField: args.stateByRowField,
        envelopeKey: args.envelopeKey,
        stripEnvelope: args.stripEnvelope,
      });
    }),
  }));

  const nextCommits = (args.sub.commits ?? []).map((commit) => ({
    ...commit,
    changes: (commit.changes ?? []).map((change) => {
      if (change.op !== 'upsert' || !isRecord(change.row_json)) return change;
      const nextRow = materializeRowFromState({
        table: change.table,
        rowId: change.row_id,
        row: change.row_json,
        index: args.index,
        stateByRowField: args.stateByRowField,
        envelopeKey: args.envelopeKey,
        stripEnvelope: args.stripEnvelope,
      });
      if (nextRow === change.row_json) return change;
      return { ...change, row_json: nextRow };
    }),
  }));

  return {
    ...args.sub,
    snapshots: nextSnapshots,
    commits: nextCommits,
  };
}

function transformWsChanges(args: {
  changes: SyncChange[];
  index: RuleIndex;
  stateByRowField: Map<string, string>;
  envelopeKey: string;
  stripEnvelope: boolean;
}): SyncChange[] {
  return args.changes.map((change) => {
    if (change.op !== 'upsert' || !isRecord(change.row_json)) return change;
    const nextRow = materializeRowFromState({
      table: change.table,
      rowId: change.row_id,
      row: change.row_json,
      index: args.index,
      stateByRowField: args.stateByRowField,
      envelopeKey: args.envelopeKey,
      stripEnvelope: args.stripEnvelope,
    });
    if (nextRow === change.row_json) return change;
    return { ...change, row_json: nextRow };
  });
}

export function createYjsClientPlugin(
  options: CreateYjsClientPluginOptions
): SyncClientPlugin {
  if (options.rules.length === 0) {
    throw new Error(
      'createYjsClientPlugin requires at least one table/field rule'
    );
  }

  const envelopeKey = options.envelopeKey ?? YJS_PAYLOAD_KEY;
  const strict = options.strict ?? true;
  const stripEnvelope = options.stripEnvelope ?? true;
  const stripEnvelopeBeforePush =
    options.stripEnvelopeBeforePush ?? stripEnvelope;
  const stripEnvelopeBeforeApplyLocalMutations =
    options.stripEnvelopeBeforeApplyLocalMutations ?? stripEnvelope;
  const { index } = buildRuleIndex(options.rules);
  const stateByRowField = new Map<string, string>();

  return {
    name: options.name ?? 'crdt-yjs-client',
    priority: options.priority ?? PluginPriority.DEFAULT,

    beforePush(_ctx, request): SyncPushRequest {
      const nextOperations = request.operations.map((op) => {
        if (op.op !== 'upsert') return op;
        if (!isRecord(op.payload)) return op;

        const nextPayload = transformPushPayload({
          table: op.table,
          rowId: op.row_id,
          payload: op.payload,
          index,
          stateByRowField,
          envelopeKey,
          stripEnvelope: stripEnvelopeBeforePush,
          strict,
        });

        if (nextPayload === op.payload) return op;
        return { ...op, payload: nextPayload };
      });

      return { ...request, operations: nextOperations };
    },

    beforeApplyLocalMutations(
      _ctx,
      args: SyncClientLocalMutationArgs
    ): SyncClientLocalMutationArgs {
      const nextOperations = args.operations.map((op) => {
        if (op.op !== 'upsert') return op;
        if (!isRecord(op.payload)) return op;

        const nextPayload = transformPushPayload({
          table: op.table,
          rowId: op.row_id,
          payload: op.payload,
          index,
          stateByRowField,
          envelopeKey,
          stripEnvelope: stripEnvelopeBeforeApplyLocalMutations,
          strict,
        });

        if (nextPayload === op.payload) return op;
        return { ...op, payload: nextPayload };
      });

      return { ...args, operations: nextOperations };
    },

    afterPull(_ctx, args: { response: SyncPullResponse }): SyncPullResponse {
      const nextSubscriptions = args.response.subscriptions.map((sub) =>
        transformPullSubscription({
          sub,
          index,
          stateByRowField,
          envelopeKey,
          stripEnvelope,
        })
      );

      return {
        ...args.response,
        subscriptions: nextSubscriptions,
      };
    },

    beforeApplyWsChanges(
      _ctx,
      args: SyncClientWsDeliveryArgs
    ): SyncClientWsDeliveryArgs {
      const nextChanges = transformWsChanges({
        changes: args.changes,
        index,
        stateByRowField,
        envelopeKey,
        stripEnvelope,
      });

      return {
        ...args,
        changes: nextChanges,
      };
    },
  };
}
