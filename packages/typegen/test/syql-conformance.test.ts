import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  lexSyqlSource,
  parseSyqlSyntaxFile,
  SyqlFrontendError,
  toSyqlSemanticAst,
} from '../src';

interface Position {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

interface DiagnosticFixture {
  readonly code: string;
  readonly start: Position;
}

interface Manifest {
  readonly $schema: string;
  readonly language: 'SYQL';
  readonly revision: 1;
  readonly fixtureSchemaRevision: 1;
  readonly sqliteProfile: '3.46.0';
  readonly families: readonly {
    readonly kind: 'lexical' | 'syntax';
    readonly path: string;
  }[];
}

interface LexicalFixture {
  readonly $schema: string;
  readonly revision: 1;
  readonly cases: readonly {
    readonly name: string;
    readonly source: string;
    readonly tokens: readonly {
      readonly kind: string;
      readonly text: string;
      readonly start: Position;
      readonly end: Position;
    }[];
  }[];
  readonly invalid: readonly {
    readonly name: string;
    readonly source: string;
    readonly diagnostic: DiagnosticFixture;
  }[];
}

interface SyntaxFixture {
  readonly $schema: string;
  readonly revision: 1;
  readonly cases: readonly {
    readonly name: string;
    readonly source: string;
    readonly ast: unknown;
  }[];
  readonly invalid: readonly {
    readonly name: string;
    readonly source: string;
    readonly diagnostic: DiagnosticFixture;
  }[];
}

const root = resolve(import.meta.dir, '..', '..', '..', 'spec', 'syql');

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function frontendError(run: () => unknown): SyqlFrontendError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SyqlFrontendError);
    return error as SyqlFrontendError;
  }
  throw new Error('expected a SyqlFrontendError');
}

const manifestPath = resolve(root, 'manifest.json');
const manifest = readJson<Manifest>(manifestPath);

describe('normative SYQL revision-1 conformance fixtures', () => {
  test('manifest and every declared schema target are present', () => {
    expect(manifest).toMatchObject({
      language: 'SYQL',
      revision: 1,
      fixtureSchemaRevision: 1,
      sqliteProfile: '3.46.0',
    });
    expect(existsSync(resolve(dirname(manifestPath), manifest.$schema))).toBe(
      true,
    );
    expect(manifest.families.map((family) => family.kind)).toEqual([
      'lexical',
      'syntax',
    ]);

    for (const family of manifest.families) {
      const fixturePath = resolve(root, family.path);
      expect(existsSync(fixturePath)).toBe(true);
      const fixture = readJson<{ readonly $schema: string }>(fixturePath);
      expect(existsSync(resolve(dirname(fixturePath), fixture.$schema))).toBe(
        true,
      );
    }
  });

  test('lexical vectors pin exact tokens, text, spans, and diagnostics', () => {
    const family = manifest.families.find((item) => item.kind === 'lexical');
    if (family === undefined) throw new Error('missing lexical fixture family');
    const fixture = readJson<LexicalFixture>(resolve(root, family.path));
    expect(fixture.revision).toBe(1);

    for (const item of fixture.cases) {
      const tokens = lexSyqlSource(`${item.name}.syql`, item.source);
      expect(
        tokens.map((token) => ({
          kind: token.kind,
          text: token.text,
          start: token.span.start,
          end: token.span.end,
        })) as unknown,
      ).toEqual(item.tokens);
      expect(tokens.map((token) => token.text).join('')).toBe(item.source);
    }

    for (const item of fixture.invalid) {
      const error = frontendError(() =>
        lexSyqlSource(`${item.name}.syql`, item.source),
      );
      expect({ code: error.code, start: error.span.start }).toEqual(
        item.diagnostic,
      );
    }
  });

  test('syntax vectors pin semantic ASTs and primary diagnostics', () => {
    const family = manifest.families.find((item) => item.kind === 'syntax');
    if (family === undefined) throw new Error('missing syntax fixture family');
    const fixture = readJson<SyntaxFixture>(resolve(root, family.path));
    expect(fixture.revision).toBe(1);

    for (const item of fixture.cases) {
      const parsed = parseSyqlSyntaxFile(`${item.name}.syql`, item.source);
      expect(toSyqlSemanticAst(parsed) as unknown).toEqual(item.ast);
    }

    for (const item of fixture.invalid) {
      const error = frontendError(() =>
        parseSyqlSyntaxFile(`${item.name}.syql`, item.source),
      );
      expect({ code: error.code, start: error.span.start }).toEqual(
        item.diagnostic,
      );
    }
  });
});
