import { describe, expect, test } from 'bun:test';
import {
  PORTABLE_RELATIONAL_IDENTIFIER_MAX_BYTES,
  PortableRelationalIdentifierError,
  validatePortableRelationalIdentifier,
} from './relational-identifier';

describe('portable relational identifiers', () => {
  test('accepts exactly 63 UTF-8 bytes and rejects the next byte', () => {
    expect(PORTABLE_RELATIONAL_IDENTIFIER_MAX_BYTES).toBe(63);
    expect(() =>
      validatePortableRelationalIdentifier('index', 'i'.repeat(63)),
    ).not.toThrow();
    expect(() =>
      validatePortableRelationalIdentifier('index', 'i'.repeat(64)),
    ).toThrow(
      'exceeds 63 bytes (Postgres identifier limit; actual UTF-8 length: 64 bytes)',
    );
  });

  test('counts UTF-8 bytes rather than JavaScript string length', () => {
    let error: unknown;
    try {
      validatePortableRelationalIdentifier('index', 'ü'.repeat(32));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PortableRelationalIdentifierError);
    expect(error).toMatchObject({
      code: 'schema.invalid_identifier',
      failure: 'too-long',
      byteLength: 64,
    });
  });

  test('retains the relational namespace reservation', () => {
    expect(() =>
      validatePortableRelationalIdentifier('table', 'sync_changes'),
    ).toThrow(/reserved prefix/);
    expect(() =>
      validatePortableRelationalIdentifier('column', '_sync_payload'),
    ).toThrow(/reserved prefix/);
  });
});
