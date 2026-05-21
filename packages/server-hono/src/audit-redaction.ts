import {
  parseJsonValue,
  SYNC_CRDT_CHECKPOINTS_TABLE,
  SYNC_CRDT_UPDATES_TABLE,
} from '@syncular/server';

export type AuditChangeKind =
  | 'app_row'
  | 'delete'
  | 'blob_reference'
  | 'encrypted_field_envelope'
  | 'encrypted_crdt_update'
  | 'encrypted_crdt_checkpoint';

export interface AuditChangeRedaction {
  payload: 'omitted';
  reason: 'audit_redacted_by_default';
}

export interface AuditChangeSummary {
  changeKind: AuditChangeKind;
  fields: string[];
  scopeFields: string[];
  sensitiveFields: string[];
  redaction: AuditChangeRedaction;
}

export function summarizeAuditChange(args: {
  table: string;
  op: 'upsert' | 'delete';
  rowJson: unknown | null;
  scopes: unknown;
}): AuditChangeSummary {
  const row = parseJsonRecord(args.rowJson);
  const fields = Object.keys(row).sort();
  const sensitiveFields = detectSensitiveFields(row);

  return {
    changeKind: classifyAuditChange({
      table: args.table,
      op: args.op,
      row,
      sensitiveFields,
    }),
    fields,
    scopeFields: Object.keys(parseJsonRecord(args.scopes)).sort(),
    sensitiveFields,
    redaction: {
      payload: 'omitted',
      reason: 'audit_redacted_by_default',
    },
  };
}

function classifyAuditChange(args: {
  table: string;
  op: 'upsert' | 'delete';
  row: Record<string, unknown>;
  sensitiveFields: string[];
}): AuditChangeKind {
  if (args.table === SYNC_CRDT_UPDATES_TABLE) {
    return 'encrypted_crdt_update';
  }
  if (args.table === SYNC_CRDT_CHECKPOINTS_TABLE) {
    return 'encrypted_crdt_checkpoint';
  }
  if (args.op === 'delete') {
    return 'delete';
  }
  if (args.sensitiveFields.some((field) => isEncryptedFieldName(field))) {
    return 'encrypted_field_envelope';
  }
  if (args.sensitiveFields.length > 0) {
    return 'blob_reference';
  }
  return 'app_row';
}

function detectSensitiveFields(row: Record<string, unknown>): string[] {
  const sensitive = new Set<string>();

  for (const [field, value] of Object.entries(row)) {
    const parsed = parseJsonValue(value);
    if (isEncryptedFieldName(field) || isEncryptedEnvelope(parsed)) {
      sensitive.add(field);
      continue;
    }
    if (isBlobRef(parsed)) {
      sensitive.add(field);
    }
  }

  return Array.from(sensitive).sort();
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function isBlobRef(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.hash === 'string' &&
    record.hash.length > 0 &&
    (typeof record.size === 'number' || typeof record.size === 'bigint')
  );
}

function isEncryptedEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.ciphertext === 'string' &&
    (typeof record.key_id === 'string' || typeof record.keyId === 'string')
  );
}

function isEncryptedFieldName(field: string): boolean {
  return (
    field === 'ciphertext' ||
    field === 'key_id' ||
    field === 'keyId' ||
    field.endsWith('_encrypted') ||
    field.endsWith('_ciphertext')
  );
}
