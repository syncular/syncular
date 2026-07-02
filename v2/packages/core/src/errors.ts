/**
 * Named decode errors (SPEC.md Conventions + §10).
 *
 * Every decode failure in the reference codec throws a `DecodeError` whose
 * `code` is a stable identifier from the SPEC.md §10 catalog (structural
 * failures use `sync.invalid_request`; frame-specific rules use their named
 * code, e.g. `sync.empty_commit`). Golden vector negative cases assert on
 * `code`, never on `message`.
 */
export class DecodeError extends Error {
  override readonly name = 'DecodeError';
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
