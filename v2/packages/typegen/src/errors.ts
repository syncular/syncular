/** Fail-loud codegen error: every message names the offending construct. */
export class TypegenError extends Error {
  /** Input the error came from (a migration file, the manifest, …). */
  readonly source: string;

  constructor(source: string, message: string) {
    super(`${source}: ${message}`);
    this.name = 'TypegenError';
    this.source = source;
  }
}
