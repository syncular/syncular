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

/**
 * A value the row codec cannot encode (SPEC.md §7.1 authoring validation,
 * §6.1 push payloads). Structural failures stay plain `Error`s; this class
 * marks exactly the value refusals, so a client can classify them without
 * inspecting message text.
 */
export class EncodeError extends Error {
  override readonly name = 'EncodeError';
  readonly code = 'sync.invalid_request';
}
