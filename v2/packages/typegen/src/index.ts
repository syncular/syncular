/**
 * @syncular-v2/typegen — SQL migrations + syncular.json → neutral schema
 * IR (JSON) → generated TS module (REVISE B5). Dependency-free; the CLI
 * lives in `src/cli.ts` (bin `syncular-v2`).
 */
export * from './emit';
export * from './emit-dart';
export * from './emit-kotlin';
export * from './emit-swift';
export * from './errors';
export * from './generate';
export * from './ir';
export * from './manifest';
export * from './sql';
