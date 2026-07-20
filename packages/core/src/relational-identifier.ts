/**
 * Portable relational identifier rules shared by typegen and every server
 * runtime. PostgreSQL truncates identifiers after 63 UTF-8 bytes, while the
 * relational Syncular projection reserves its own table/column namespace.
 *
 * Keeping this validation in core prevents a generated schema from passing
 * typegen and then failing later when a server or testkit compiles it.
 */

export const PORTABLE_RELATIONAL_IDENTIFIER_MAX_BYTES = 63;

export type PortableRelationalIdentifierFailure =
  | 'empty'
  | 'reserved-prefix'
  | 'too-long';

export class PortableRelationalIdentifierError extends Error {
  readonly code = 'schema.invalid_identifier';

  constructor(
    readonly kind: string,
    readonly identifier: string,
    readonly failure: PortableRelationalIdentifierFailure,
    readonly byteLength: number,
  ) {
    const quoted = JSON.stringify(identifier);
    const message =
      failure === 'empty'
        ? `${kind} name must not be empty`
        : failure === 'reserved-prefix'
          ? `${kind} name ${quoted} uses a reserved prefix (sync_/_sync are the server storage namespace)`
          : `${kind} name ${quoted} exceeds ${PORTABLE_RELATIONAL_IDENTIFIER_MAX_BYTES} bytes (Postgres identifier limit; actual UTF-8 length: ${byteLength} bytes)`;
    super(message);
    this.name = 'PortableRelationalIdentifierError';
  }
}

/** Validate one identifier against the strictest supported relational host. */
export function validatePortableRelationalIdentifier(
  kind: string,
  identifier: string,
): void {
  const byteLength = new TextEncoder().encode(identifier).length;
  if (identifier.length === 0) {
    throw new PortableRelationalIdentifierError(
      kind,
      identifier,
      'empty',
      byteLength,
    );
  }
  const lower = identifier.toLowerCase();
  if (lower.startsWith('sync_') || lower.startsWith('_sync')) {
    throw new PortableRelationalIdentifierError(
      kind,
      identifier,
      'reserved-prefix',
      byteLength,
    );
  }
  if (byteLength > PORTABLE_RELATIONAL_IDENTIFIER_MAX_BYTES) {
    throw new PortableRelationalIdentifierError(
      kind,
      identifier,
      'too-long',
      byteLength,
    );
  }
}
