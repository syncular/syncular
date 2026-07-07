/**
 * QueryIR serialization (DESIGN-queries.md §1): the frontend-agnostic,
 * deterministic JSON form of analyzed queries. This is the golden-fixture
 * format — equivalent inputs in any frontend (`.sql` today, `.syql` later)
 * must produce byte-identical IR JSON, the same trick the wire protocol
 * uses for the two cores. Fixed key order, 2-space indent, trailing
 * newline.
 *
 * Names are SQL-truth (`name`) plus the collision-checked language name
 * (`langName`, §5); `sql` is the LOWERED statement (what actually runs).
 */
import type { AnalyzedQuery } from './query';

/** Serialize analyzed queries as the deterministic QueryIR JSON document. */
export function serializeQueryIr(queries: readonly AnalyzedQuery[]): string {
  const doc = {
    queryIrVersion: 1,
    queries: queries.map((query) => ({
      name: query.name,
      file: query.file,
      sourceSql: query.sourceSql,
      sql: query.sql,
      positionalSql: query.positionalSql,
      params: query.params.map((param) => ({
        name: param.name,
        langName: param.langName,
        type: param.type,
        // §4 metadata — emitted only when set, so `.sql`-tier IR bytes are
        // unchanged from before the DSL existed.
        ...(param.optional === true ? { optional: true } : {}),
        ...(param.group !== undefined ? { group: param.group } : {}),
        ...(param.flag === true ? { flag: true } : {}),
      })),
      columns: query.columns.map((column) => ({
        name: column.name,
        langName: column.langName,
        type: column.type,
        nullable: column.nullable,
        fidelity: column.fidelity,
      })),
      tables: query.tables,
      // §6 knob metadata — emitted only when declared.
      ...(query.orderBy !== undefined
        ? {
            orderBy: {
              allowed: query.orderBy.allowed.map((c) => ({
                name: c.name,
                langName: c.langName,
              })),
              defaultColumn: query.orderBy.defaultColumn,
              defaultDir: query.orderBy.defaultDir,
            },
          }
        : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.positionalSqlBase !== undefined
        ? { positionalSqlBase: query.positionalSqlBase }
        : {}),
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
