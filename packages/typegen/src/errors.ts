/** Fail-loud codegen error: every message names the offending construct. A
 * coded error carries a static message, its stable `code`, and the dynamic
 * values (table, column, …) in `details`. */
export class TypegenError extends Error {
  /** Input the error came from (a migration file, the manifest, …). */
  readonly source: string;
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    source: string,
    message: string,
    code?: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(`${source}: ${message}`);
    this.name = 'TypegenError';
    this.source = source;
    if (code !== undefined) this.code = code;
    if (details !== undefined) this.details = details;
  }
}
