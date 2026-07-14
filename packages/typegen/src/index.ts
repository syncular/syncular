/**
 * @syncular/typegen — SQL migrations + syncular.json → neutral schema
 * IR (JSON) → generated TS module (REVISE B5). Dependency-free; the CLI
 * lives in `src/cli.ts` (bin `syncular`).
 */
export * from './emit';
export * from './emit-dart';
export * from './emit-kotlin';
export * from './emit-queries';
export * from './emit-queries-dart';
export * from './emit-queries-kotlin';
export * from './emit-queries-swift';
export * from './emit-swift';
export * from './errors';
export * from './fmt';
export * from './generate';
export * from './ir';
export * from './lower';
export * from './lsp';
export * from './manifest';
export * from './naming';
export * from './query';
export * from './query-ir';
export * from './sql';
export * from './syql';
export * from './syql-ast';
export * from './syql-lexer';
export * from './syql-modules';
export * from './syql-parser';
export * from './syql-template-parser';
