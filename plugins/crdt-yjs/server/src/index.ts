import * as Y from 'yjs';

export const YJS_PAYLOAD_KEY = '__yjs';

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type YjsFieldKind = 'text';

export interface YjsServerFieldRule {
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
   * CRDT container type (text for v1).
   */
  kind?: YjsFieldKind;
}

interface ResolvedYjsServerFieldRule extends YjsServerFieldRule {
  containerKey: string;
  rowIdField: string;
  kind: YjsFieldKind;
}

export interface YjsServerUpdateEnvelope {
  updateId: string;
  updateBase64: string;
}

export type YjsServerUpdateInput =
  | YjsServerUpdateEnvelope
  | readonly YjsServerUpdateEnvelope[];

export interface YjsServerPayloadEnvelope {
  [field: string]: YjsServerUpdateInput;
}

export interface BuildYjsTextUpdateArgs {
  previousStateBase64?: string | Uint8Array | null;
  nextText: string;
  containerKey?: string;
  updateId?: string;
}

export interface BuildYjsTextUpdateResult {
  update: YjsServerUpdateEnvelope;
  nextStateBase64: string;
  nextText: string;
}

export interface ApplyYjsTextUpdatesArgs {
  previousStateBase64?: string | Uint8Array | null;
  updates: readonly YjsServerUpdateEnvelope[];
  containerKey?: string;
}

export interface ApplyYjsTextUpdatesResult {
  nextStateBase64: string;
  text: string;
}

export interface CreateYjsServerModuleOptions {
  name?: string;
  rules: readonly YjsServerFieldRule[];
  envelopeKey?: string;
  /**
   * Throw when envelope payload references fields without matching rules.
   * @default true
   */
  strict?: boolean;
  /**
   * Remove the Yjs envelope key from processed payload/rows.
   * @default true
   */
  stripEnvelope?: boolean;
}

type RuleIndex = Map<string, Map<string, ResolvedYjsServerFieldRule>>;

export interface YjsServerApplyPayloadArgs {
  table: string;
  rowId: string;
  payload: Record<string, unknown>;
  existingRow?: Record<string, unknown> | null;
}

export interface YjsServerMaterializeRowArgs {
  table: string;
  row: Record<string, unknown>;
}

export interface YjsServerModule {
  name: string;
  rules: readonly YjsServerFieldRule[];
  envelopeKey: string;
  applyPayload(
    args: YjsServerApplyPayloadArgs
  ): Promise<Record<string, unknown>>;
  materializeRow(
    args: YjsServerMaterializeRowArgs
  ): Promise<Record<string, unknown>>;
}

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

function ensureTextContainer(doc: Y.Doc, containerKey: string): string {
  return doc.getText(containerKey).toString();
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

function createUpdateId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') {
    return randomUUID.call(globalThis.crypto);
  }
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 12);
  return `yjs-${ts}-${rnd}`;
}

function buildRuleIndex(rules: readonly YjsServerFieldRule[]): {
  index: RuleIndex;
  normalizedRules: readonly ResolvedYjsServerFieldRule[];
} {
  const index: RuleIndex = new Map();
  const normalizedRules: ResolvedYjsServerFieldRule[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    if (!rule.table.trim()) {
      throw new Error('YjsServerFieldRule.table cannot be empty');
    }
    if (!rule.field.trim()) {
      throw new Error('YjsServerFieldRule.field cannot be empty');
    }
    if (!rule.stateColumn.trim()) {
      throw new Error('YjsServerFieldRule.stateColumn cannot be empty');
    }

    const key = `${rule.table}\u001f${rule.field}`;
    if (seen.has(key)) {
      throw new Error(
        `Duplicate Yjs server rule for table "${rule.table}", field "${rule.field}"`
      );
    }
    seen.add(key);

    const resolved: ResolvedYjsServerFieldRule = {
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

function normalizeUpdateEnvelope(
  value: unknown,
  context: string
): YjsServerUpdateEnvelope {
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
): YjsServerUpdateEnvelope[] {
  if (Array.isArray(value)) {
    return value.map((entry, i) =>
      normalizeUpdateEnvelope(entry, `${context}[${i}]`)
    );
  }
  return [normalizeUpdateEnvelope(value, context)];
}

export async function applyYjsTextUpdates(
  args: ApplyYjsTextUpdatesArgs
): Promise<ApplyYjsTextUpdatesResult> {
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

export async function buildYjsTextUpdate(
  args: BuildYjsTextUpdateArgs
): Promise<BuildYjsTextUpdateResult> {
  const containerKey = args.containerKey ?? 'text';
  const doc = createDocFromState(args.previousStateBase64);
  try {
    const from = Y.encodeStateVector(doc);
    replaceText(doc, containerKey, args.nextText);
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

async function materializeRowFromState(args: {
  table: string;
  row: Record<string, unknown>;
  index: RuleIndex;
  envelopeKey: string;
  stripEnvelope: boolean;
}): Promise<Record<string, unknown>> {
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
      const nextText = ensureTextContainer(doc, rule.containerKey);
      if (source[rule.field] !== nextText) {
        ensureRow()[rule.field] = nextText;
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

async function applyYjsEnvelopeToPayload(args: {
  table: string;
  payload: Record<string, unknown>;
  existingRow?: Record<string, unknown> | null;
  index: RuleIndex;
  envelopeKey: string;
  stripEnvelope: boolean;
  strict: boolean;
}): Promise<Record<string, unknown>> {
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

      const source = nextPayload ?? args.payload;
      const existingSource = args.existingRow ?? null;
      const baseState =
        (existingSource
          ? stateValueToBase64(existingSource[rule.stateColumn])
          : null) ??
        stateValueToBase64(source[rule.stateColumn]) ??
        null;

      const doc = createDocFromState(baseState);
      try {
        if (!baseState) {
          const initialText = readString(source[rule.field]);
          if (initialText) {
            replaceText(doc, rule.containerKey, initialText);
          }
        }

        for (const update of updates) {
          Y.applyUpdate(doc, base64ToBytes(update.updateBase64));
        }

        const nextText = ensureTextContainer(doc, rule.containerKey);
        const nextStateBase64 = exportSnapshotBase64(doc);
        const target = ensurePayload();
        target[rule.field] = nextText;
        target[rule.stateColumn] = nextStateBase64;
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

export function createYjsServerModule(
  options: CreateYjsServerModuleOptions
): YjsServerModule {
  if (options.rules.length === 0) {
    throw new Error(
      'createYjsServerModule requires at least one table/field rule'
    );
  }

  const envelopeKey = options.envelopeKey ?? YJS_PAYLOAD_KEY;
  const strict = options.strict ?? true;
  const stripEnvelope = options.stripEnvelope ?? true;
  const { index } = buildRuleIndex(options.rules);

  return {
    name: options.name ?? 'crdt-yjs-server',
    rules: options.rules,
    envelopeKey,

    async applyPayload(args): Promise<Record<string, unknown>> {
      return await applyYjsEnvelopeToPayload({
        table: args.table,
        payload: args.payload,
        existingRow: args.existingRow,
        index,
        envelopeKey,
        stripEnvelope,
        strict,
      });
    },

    async materializeRow(args): Promise<Record<string, unknown>> {
      return await materializeRowFromState({
        table: args.table,
        row: args.row,
        index,
        envelopeKey,
        stripEnvelope,
      });
    },
  };
}
