/**
 * Neutral schema IR (REVISE B5).
 *
 * The IR is a versioned, language-neutral JSON document: tables with the
 * six SPEC §2.4 column types (+ nullability + primary key), scope patterns
 * (§3.1), the schema-version history (§1.5 gating), subscription templates,
 * and a reserved `extensions` slot (the WP-49 apply/read-model hooks home —
 * empty today, present in the schema so later emitters share one shape).
 * Serialization is deterministic: fixed key order, sorted extension keys,
 * 2-space indent, trailing newline — so the IR file diffs cleanly and the
 * Swift/Kotlin emitters can hash it the same way the TS emitter does.
 */
import { createHash } from 'node:crypto';

export const IR_VERSION = 1;

/** The six §2.4 column types (wire tags 1..6, in this order). */
export type IrColumnType =
  | 'string'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'json'
  | 'bytes';

export interface IrColumn {
  readonly name: string;
  readonly type: IrColumnType;
  readonly nullable: boolean;
}

/** One §3.1 scope pattern, fully resolved (no re-parsing downstream). */
export interface IrScope {
  readonly pattern: string;
  readonly variable: string;
  readonly column: string;
}

export interface IrTable {
  readonly name: string;
  readonly primaryKey: string;
  /** Declaration order — this IS the §2.4 row-codec positional order. */
  readonly columns: readonly IrColumn[];
  readonly scopes: readonly IrScope[];
  /** Reserved per-table hook slot (WP-49); empty object for now. */
  readonly extensions: Readonly<Record<string, unknown>>;
}

export type IrScopeValue =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'parameter'; readonly name: string };

export interface IrSubscriptionScope {
  readonly variable: string;
  readonly values: readonly IrScopeValue[];
}

export interface IrSubscription {
  readonly name: string;
  readonly table: string;
  /** Sorted by variable for stable diffs. */
  readonly scopes: readonly IrSubscriptionScope[];
}

export interface IrSchemaVersion {
  readonly version: number;
  /** Migration names this version added, in application order. */
  readonly migrations: readonly string[];
}

export interface IrDocument {
  readonly irVersion: number;
  /** The current (latest) generated schema version (§1.5). */
  readonly schemaVersion: number;
  readonly schemaVersions: readonly IrSchemaVersion[];
  /** Manifest order — the handler-declared bootstrap order (§4.7). */
  readonly tables: readonly IrTable[];
  readonly subscriptions: readonly IrSubscription[];
  /** Reserved document-level hook slot (WP-49); empty object for now. */
  readonly extensions: Readonly<Record<string, unknown>>;
}

/** Recursively sort object keys so extension payloads serialize stably. */
export function canonicalizeExtensions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeExtensions);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      out[key] = canonicalizeExtensions(entry);
    }
    return out;
  }
  return value;
}

function canonicalScopeValue(value: IrScopeValue): Record<string, unknown> {
  return value.kind === 'literal'
    ? { kind: 'literal', value: value.value }
    : { kind: 'parameter', name: value.name };
}

/** Serialize with a fixed key order — byte-deterministic for equal IRs. */
export function serializeIr(ir: IrDocument): string {
  const doc = {
    irVersion: ir.irVersion,
    schemaVersion: ir.schemaVersion,
    schemaVersions: ir.schemaVersions.map((v) => ({
      version: v.version,
      migrations: v.migrations,
    })),
    tables: ir.tables.map((table) => ({
      name: table.name,
      primaryKey: table.primaryKey,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable,
      })),
      scopes: table.scopes.map((scope) => ({
        pattern: scope.pattern,
        variable: scope.variable,
        column: scope.column,
      })),
      extensions: canonicalizeExtensions(table.extensions),
    })),
    subscriptions: ir.subscriptions.map((sub) => ({
      name: sub.name,
      table: sub.table,
      scopes: sub.scopes.map((scope) => ({
        variable: scope.variable,
        values: scope.values.map(canonicalScopeValue),
      })),
    })),
    extensions: canonicalizeExtensions(ir.extensions),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Hash of the exact IR file bytes; stamped into generated modules. */
export function irHash(irJson: string): string {
  return `sha256:${createHash('sha256').update(irJson, 'utf8').digest('hex')}`;
}
