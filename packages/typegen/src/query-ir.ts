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
    queryIrVersion: 3,
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
      })),
      columns: query.columns.map((column) => ({
        name: column.name,
        langName: column.langName,
        type: column.type,
        nullable: column.nullable,
        fidelity: column.fidelity,
        ...(column.origin !== undefined ? { origin: column.origin } : {}),
      })),
      tables: query.tables,
      reactive: {
        dependencies: query.reactive.dependencies.map((dependency) => ({
          table: dependency.table,
          scopes: dependency.scopes.map((scope) => ({
            variable: scope.variable,
            pattern: scope.pattern,
            params: scope.params,
          })),
        })),
        coverage: query.reactive.coverage.map((coverage) => ({
          table: coverage.table,
          variable: coverage.variable,
          units: coverage.units,
          fixedScopes: coverage.fixedScopes.map((scope) => ({
            variable: scope.variable,
            params: scope.params,
          })),
        })),
        ...(query.reactive.rowKey !== undefined
          ? { rowKey: query.reactive.rowKey }
          : {}),
      },
      ...(query.syql === undefined
        ? {}
        : {
            syql: {
              revision: query.syql.revision,
              inputs: query.syql.inputs.map((input) => {
                if (input.kind === 'value') return { ...input };
                if (input.kind === 'group') {
                  return {
                    kind: input.kind,
                    name: input.name,
                    langName: input.langName,
                    members: input.members.map((member) => ({ ...member })),
                  };
                }
                if (input.kind === 'sort') {
                  return {
                    kind: input.kind,
                    name: input.name,
                    langName: input.langName,
                    defaultProfile: input.defaultProfile,
                    profiles: input.profiles.map((profile) => ({ ...profile })),
                  };
                }
                return { ...input };
              }),
              plan: {
                backend: query.syql.plan.backend,
                activationControls: query.syql.plan.activationControls,
                conditions: query.syql.plan.conditions.map((condition) => ({
                  controls: condition.controls,
                  ...(condition.bind === undefined
                    ? {}
                    : { bind: condition.bind }),
                })),
                statements: query.syql.plan.statements.map((statement) => ({
                  ...(statement.sortProfile === undefined
                    ? {}
                    : { sortProfile: statement.sortProfile }),
                  ...(statement.activationMask === undefined
                    ? {}
                    : { activationMask: statement.activationMask }),
                  sql: statement.sql,
                  positionalSql: statement.positionalSql,
                  binds: statement.binds.map((bind) => ({ ...bind })),
                })),
              },
              ...(query.syql.identity === undefined
                ? {}
                : { identity: query.syql.identity }),
            },
          }),
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
