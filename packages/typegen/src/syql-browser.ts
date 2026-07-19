/**
 * Browser-safe composition boundary for one virtual SYQL source file.
 *
 * The parser, semantic analyzer, validator, formatter, and lowerer are all
 * portable. Filesystem traversal and SQLite initialization are deliberately
 * left to the host: browsers provide an in-memory QueryDb, while Bun/Node can
 * keep using the normal project generator.
 */
import { formatSyql } from './fmt';
import type { IrDocument } from './ir';
import {
  type QueryBackend,
  type QueryDb,
  type QueryNamingOptions,
  synthesizeDdl,
} from './query';
import { SyqlFrontendError } from './syql-lexer';
import { lowerSyqlQuery, type SyqlLoweredQuery } from './syql-lowering';
import type { SyqlModuleGraph } from './syql-modules';
import { parseSyqlSyntaxFile } from './syql-parser';
import { analyzeSyqlSemantics } from './syql-semantics';
import { validateSyqlProgram } from './syql-validator';

export const SYQL_BROWSER_DEFAULT_FILE = '/playground.syql';

export type { IrDocument, QueryDb };
export { synthesizeDdl };

export interface CompileSyqlSourceOptions {
  readonly file?: string;
  readonly naming?: QueryNamingOptions;
  readonly backend?: QueryBackend;
}

export interface CompiledSyqlSource {
  readonly queries: readonly SyqlLoweredQuery[];
}

function singleFileGraph(file: string, source: string): SyqlModuleGraph {
  const module = parseSyqlSyntaxFile(file, source);
  const unsupportedImport = module.imports[0];
  if (unsupportedImport !== undefined) {
    throw new SyqlFrontendError(
      'PLAYGROUND_IMPORTS_UNAVAILABLE',
      unsupportedImport.span,
      'the browser playground supports one virtual file; declare reusable predicates in the same editor',
    );
  }
  return {
    root: '/',
    entries: [file],
    modules: [module],
    moduleByPath: new Map([[file, module]]),
    edges: [],
  };
}

/** Compile every query declaration in one virtual source file. */
export function compileSyqlSource(
  source: string,
  ir: IrDocument,
  db: QueryDb,
  options: CompileSyqlSourceOptions = {},
): CompiledSyqlSource {
  const file = options.file ?? SYQL_BROWSER_DEFAULT_FILE;
  const semantic = analyzeSyqlSemantics(singleFileGraph(file, source));
  const validated = validateSyqlProgram(semantic, ir, db, options.naming);
  return {
    queries: validated.queries.map((query) =>
      lowerSyqlQuery(query, ir, db, options.naming, {
        ...(options.backend === undefined ? {} : { backend: options.backend }),
      }),
    ),
  };
}

/** Format one virtual source file with the canonical SYQL formatter. */
export function formatSyqlSource(
  source: string,
  file = SYQL_BROWSER_DEFAULT_FILE,
): string {
  return formatSyql(file, source);
}
