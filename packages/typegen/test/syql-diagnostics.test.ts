import { expect, test } from 'bun:test';
import {
  generateSyqlDiagnosticCatalog,
  SYQL_DIAGNOSTIC_REMEDIES,
  syqlDiagnosticRemedy,
} from '../src';

test('generates a stable sorted code-to-remedy catalog', () => {
  const catalog = generateSyqlDiagnosticCatalog();
  expect(catalog).toHaveLength(58);
  expect(catalog.map<string>(({ code }) => code)).toEqual(
    Object.keys(SYQL_DIAGNOSTIC_REMEDIES).sort(),
  );
  expect(catalog[0]).toEqual({
    code: 'SYQL1001_UNTERMINATED_STRING',
    remedy: 'Close the string literal with a matching single quote.',
  });
  expect(catalog.at(-1)).toEqual({
    code: 'SYQL_RUNTIME_UNKNOWN_INPUT',
    remedy: 'Remove the unknown key from the generated-query input object.',
  });
});

test('resolves known codes and leaves extension codes open', () => {
  expect(syqlDiagnosticRemedy('SYQL6002_INVALID_SQL')).toContain(
    'reported SQLite',
  );
  expect(syqlDiagnosticRemedy('SYQL9999_HOST_EXTENSION')).toBeUndefined();
});
