/**
 * The `sql` tagged template — the raw tier's composition helper
 * (DESIGN-queries.md I4). Structural injection safety: an interpolated
 * value can only ever become a `?` bind parameter; SQL text can only enter
 * through the literal template, `sql.ident()` (allowlist-gated) or a loud
 * `sql.raw()`. This helper is deliberately dumb plumbing and stays that
 * way — typed/composable queries are the `.syql` codegen tier's job, and
 * this module must never grow features that overlap it.
 *
 *   const q = sql`
 *     SELECT * FROM todos
 *     WHERE list_id = ${listId}
 *       ${status ? sql`AND status = ${status}` : sql.empty}
 *       AND id IN (${ids})
 *     ORDER BY ${sql.ident(orderCol, ['created_at', 'title'])} DESC`;
 *   client.query(q.text, q.params);
 */
import type { SqlValue } from './database';

/** A composed raw query: SQL text with `?` placeholders + bound params. */
export interface SqlFragment {
  readonly text: string;
  readonly params: readonly SqlValue[];
  /** Brand so fragments are distinguishable from user values. */
  readonly [SQL_FRAGMENT]: true;
}

const SQL_FRAGMENT = Symbol.for('syncular.sqlFragment');

function fragment(text: string, params: readonly SqlValue[]): SqlFragment {
  return { text, params, [SQL_FRAGMENT]: true };
}

function isFragment(value: unknown): value is SqlFragment {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[SQL_FRAGMENT] === true
  );
}

function isSqlValue(value: unknown): value is SqlValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value instanceof Uint8Array
  );
}

export type SqlInterpolation = SqlValue | SqlFragment | readonly SqlValue[];

/** Compose a raw query. Values bind; only literals/ident/raw become text. */
export function sql(
  strings: TemplateStringsArray,
  ...values: readonly SqlInterpolation[]
): SqlFragment {
  let text = '';
  const params: SqlValue[] = [];
  for (let i = 0; i < strings.length; i++) {
    text += strings[i] ?? '';
    if (i >= values.length) continue;
    const value = values[i];
    if (isFragment(value)) {
      text += value.text;
      params.push(...value.params);
    } else if (Array.isArray(value)) {
      // An array binds as a comma-joined parameter list — `IN (${ids})`.
      if (value.length === 0) {
        // `IN ()` is a SQLite syntax error; bind a never-matching list.
        text += 'SELECT NULL WHERE 0';
      } else {
        for (const [j, item] of value.entries()) {
          if (!isSqlValue(item)) {
            throw new TypeError(
              `sql\`\` array element ${j} is not a bindable SQL value`,
            );
          }
        }
        text += value.map(() => '?').join(', ');
        params.push(...(value as readonly SqlValue[]));
      }
    } else if (isSqlValue(value)) {
      text += '?';
      params.push(value);
    } else {
      // undefined, objects, functions — always a bug at the call site.
      throw new TypeError(
        `sql\`\` interpolation ${i} is not a bindable SQL value ` +
          `(got ${value === undefined ? 'undefined' : typeof value}). ` +
          'Bind a value, compose a sql`` fragment, or use ' +
          'sql.ident()/sql.raw() explicitly.',
      );
    }
  }
  return fragment(text, params);
}

/** The empty fragment — the neutral element for conditional composition. */
sql.empty = fragment('', []);

/**
 * An identifier (column/table name). The allowlist is MANDATORY —
 * identifiers cannot be bound, so the only safe source is a closed set the
 * caller wrote. The value is also shape-checked and quoted defensively.
 */
sql.ident = (value: string, allowlist: readonly string[]): SqlFragment => {
  if (!allowlist.includes(value)) {
    throw new RangeError(
      `sql.ident: ${JSON.stringify(value)} is not in the allowlist ` +
        `[${allowlist.join(', ')}]`,
    );
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new RangeError(
      `sql.ident: ${JSON.stringify(value)} is not a plain identifier`,
    );
  }
  return fragment(`"${value}"`, []);
};

/**
 * Verbatim SQL text. The loud escape hatch: never pass request/user/synced
 * data through here — that is the injection you were protected from.
 */
sql.raw = (text: string): SqlFragment => fragment(text, []);
