/**
 * Server-side write-validation hooks (SPEC.md §6.7).
 *
 * An optional per-table `validate` callback that runs on push, AFTER the
 * row-codec decode (§6.1) and the §3.4 scope authorization, INSIDE the
 * commit transaction, once per operation. It is the seam for business
 * rules that scopes cannot express ("title ≤ 200 chars", "amount ≥ 0",
 * "status ∈ {…}"). A throw (or rejected promise) rejects the whole commit
 * atomically (§6.4) with a host-defined code the client surfaces unchanged
 * in its rejection record (§6.3).
 *
 * The feature is OFF by default (no `validators` on the config): the push
 * path pays only an `undefined` check per operation and builds no context
 * object — zero cost, the events-seam discipline.
 */
import {
  normalizeRejectionDetails,
  type RejectionDetails,
  type RowColumn,
  type RowValue,
} from '@syncular/core';

/**
 * §6.7 reserved code prefixes. A host validator code MUST NOT start with
 * any of these: they namespace the protocol's own error families (§10.2)
 * so a host code is always distinguishable from a `sync.*`/`blob.*` code.
 * Violating this is a server bug — `ValidationRejection` throws at
 * construction, not at push time, so it surfaces the moment the host code
 * is written.
 */
export const RESERVED_VALIDATION_CODE_PREFIXES: readonly string[] = [
  'sync.',
  'blob.',
  'presence.',
  'client.',
];

/**
 * The row a validator inspects, keyed by column name (§6.7). Column values
 * are the decoded `RowValue`s (bytes-typed columns are `Uint8Array`).
 * `crdt` columns hold the **merged** value that will persist (§5.10.3), not
 * the raw pushed bytes — a validator sees what the store will hold.
 */
export type ValidateRow = Readonly<Record<string, RowValue>>;

/** The operation kind a validator sees (§6.7). */
export type ValidateOpKind = 'upsert' | 'delete';

/**
 * One push operation as the validator sees it (§6.7). For an `upsert`,
 * `row` is the post-merge, post-scope-strip row that will be written and
 * `stored` is the prior stored row (or `undefined` on insert). For a
 * `delete`, `row` is `undefined` and `stored` is the row about to be
 * removed (a delete only reaches a validator when a stored row exists —
 * an absent-row delete is an idempotent no-op that never validates, §6.2).
 */
export interface ValidateOperation {
  readonly op: ValidateOpKind;
  readonly table: string;
  readonly rowId: string;
  /** The row to be written (upsert), keyed by column name; undefined on delete. */
  readonly row: ValidateRow | undefined;
  /** The currently-stored row (update/delete), keyed by column name; undefined on insert. */
  readonly stored: ValidateRow | undefined;
}

/** Ambient context a validator may consult (§6.7). */
export interface ValidateContext {
  /** Host-authenticated actor (§1.1) performing the write. */
  readonly actorId: string;
  /** The partition (§1.1) the commit targets. */
  readonly partition: string;
}

/**
 * A per-table validation hook (§6.7). Called once per push operation on
 * its table, after decode + scope authorization, inside the commit
 * transaction. Return (or resolve) to accept; **throw a
 * `ValidationRejection`** to reject the commit with a host code. Throwing
 * any other error is treated as a rejection with a generic
 * `sync.constraint_violation` code (a validator SHOULD throw
 * `ValidationRejection` to control the code). MUST NOT mutate the row.
 */
export type Validator = (
  op: ValidateOperation,
  ctx: ValidateContext,
) => void | Promise<void>;

/** Table name → validator (§6.7). Absent tables are unvalidated. */
export type ValidatorRegistry = Readonly<Record<string, Validator>>;

/**
 * The rejection a host validator throws to reject a commit with a chosen
 * code and message (§6.7). The code is checked at construction against the
 * reserved prefixes (§10.2): a host code that collides with the protocol's
 * families is a server bug and fails loud immediately.
 */
export class ValidationRejection extends Error {
  override readonly name = 'ValidationRejection';
  readonly code: string;
  /**
   * Bounded code-like metadata explicitly safe to replicate to authorized
   * clients. Never place diagnostic prose, secrets, or clinical values here.
   */
  readonly details: RejectionDetails | undefined;

  constructor(code: string, message?: string, details?: RejectionDetails) {
    super(message ?? code);
    if (code.length === 0) {
      throw new Error('ValidationRejection code must be non-empty (§6.7)');
    }
    for (const prefix of RESERVED_VALIDATION_CODE_PREFIXES) {
      if (code.startsWith(prefix)) {
        throw new Error(
          `ValidationRejection code ${JSON.stringify(code)} uses the reserved prefix ${JSON.stringify(prefix)} — host codes MUST NOT start with a protocol family (§6.7)`,
        );
      }
    }
    this.code = code;
    this.details =
      details === undefined ? undefined : normalizeRejectionDetails(details);
  }
}

/** Build the column-keyed row object a validator inspects (§6.7). */
export function toValidateRow(
  columns: readonly RowColumn[],
  values: readonly RowValue[],
): ValidateRow {
  const row: Record<string, RowValue> = {};
  columns.forEach((column, index) => {
    row[column.name] = values[index] ?? null;
  });
  return row;
}
