/** Revision-1 SYQL logical-to-physical lowering (§§15–17). */
import { TypegenError } from './errors';
import type { IrDocument } from './ir';
import { buildNamingMap } from './naming';
import {
  type AnalyzedQuery,
  analyzeStatement,
  type QueryBackend,
  type QueryDb,
  type QueryNamingOptions,
  type QueryParamType,
  type QuerySyqlExecutionPlan,
  type QuerySyqlMetadata,
  type QuerySyqlPlanBind,
  type QuerySyqlPublicInput,
  type QuerySyqlStatement,
} from './query';
import { lexSyqlSqlSource } from './syql-lexer';
import type {
  SyqlLogicalQuery,
  SyqlLogicalTemplateNode,
  SyqlLogicalWhenNode,
} from './syql-semantics';
import { syqlRangeEndBind, syqlRangeStartBind } from './syql-semantics';
import type { SyqlValidatedQuery } from './syql-validator';

export type SyqlLoweringErrorCode =
  | 'SYQL7001_ENUMERATION_LIMIT'
  | 'SYQL7002_INTERNAL_LOWERING';

export interface SyqlLoweringOptions {
  readonly backend?: QueryBackend;
  /** Maximum physical activation variants generated for diagnostics and a
   * forced variants backend. Sort profiles multiply this count. */
  readonly maxEnumeratedStatements?: number;
}

export interface SyqlLoweredQuery {
  readonly validated: SyqlValidatedQuery;
  readonly analysis: AnalyzedQuery;
  readonly selected: QuerySyqlExecutionPlan;
  readonly neutralized: QuerySyqlExecutionPlan;
  /** Omitted only when enumeration exceeds compiler resource policy. */
  readonly enumerated?: QuerySyqlExecutionPlan;
}

const DEFAULT_NAMING: QueryNamingOptions = {
  naming: 'camel',
  targets: ['ts'],
  backend: 'auto',
};
const DEFAULT_ENUMERATION_LIMIT = 256;
const LIMIT_BIND = '__syqlLimit';

interface ValueOwner {
  readonly kind: 'value' | 'group-member';
  readonly input: string;
  readonly member?: string;
  readonly type: QueryParamType;
}

function fail(
  code: SyqlLoweringErrorCode,
  query: SyqlLogicalQuery,
  message: string,
): never {
  throw new TypegenError(
    `${query.module.file} (query ${query.declaration.name})`,
    `${code}: ${message}`,
  );
}

function renderTemplate(
  nodes: readonly SyqlLogicalTemplateNode[],
  conditions: ReadonlyMap<SyqlLogicalWhenNode, number>,
  mode:
    | { readonly kind: 'neutralized' }
    | { readonly kind: 'enumerated'; readonly active: ReadonlySet<string> },
): string {
  return nodes
    .map((node) => {
      if (node.kind === 'sql') {
        return node.parts
          .map((part) => (part.kind === 'text' ? part.text : `:${part.name}`))
          .join('');
      }
      if (node.kind === 'predicate') {
        return `(${renderTemplate(node.body, conditions, mode)})`;
      }
      if (node.kind !== 'when') {
        throw new Error('revision-1 lowering found an unknown logical node');
      }
      const condition = conditions.get(node);
      if (condition === undefined) {
        throw new Error('revision-1 lowering lost a logical condition');
      }
      if (mode.kind === 'neutralized') {
        const predicate = renderTemplate(node.body, conditions, mode);
        return `case when :__syqlActive${condition} = 0 then 1 else (${predicate}) end`;
      }
      if (node.controls.every((control) => mode.active.has(control))) {
        return `(${renderTemplate(node.body, conditions, mode)})`;
      }
      return '1';
    })
    .join('');
}

function outerLimitOffset(sql: string, file: string): number {
  const tokens = lexSyqlSqlSource(file, sql).filter(
    (token) =>
      token.kind !== 'whitespace' &&
      token.kind !== 'line-comment' &&
      token.kind !== 'block-comment' &&
      token.kind !== 'eof',
  );
  let depth = 0;
  for (const token of tokens) {
    if (token.text === ')') depth -= 1;
    if (
      depth === 0 &&
      token.kind === 'identifier' &&
      (token.text.toLowerCase() === 'limit' ||
        token.text.toLowerCase() === 'offset')
    ) {
      return token.span.start.offset;
    }
    if (token.text === '(') depth += 1;
  }
  return sql.length;
}

function composeControls(
  sql: string,
  file: string,
  sortSql: string | undefined,
  limit: SyqlValidatedQuery['limit'],
): string {
  let out = sql.trim();
  if (sortSql !== undefined) {
    const insertion = outerLimitOffset(out, file);
    out = `${out.slice(0, insertion).trimEnd()} order by ${sortSql} ${out
      .slice(insertion)
      .trimStart()}`.trim();
  }
  if (limit !== undefined) {
    // `coalesce` gives the generator's metadata-only execution a valid value;
    // runtimes still validate and bind the effective size before execution.
    out = `${out.trimEnd()} limit min(coalesce(:${LIMIT_BIND}, ${limit.defaultSize}), ${limit.maxSize})`;
  }
  return out;
}

function distinctBindNames(sql: string, file: string): readonly string[] {
  const names: string[] = [];
  for (const token of lexSyqlSqlSource(file, sql)) {
    if (token.kind !== 'bind') continue;
    const name = token.text.slice(1);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function headersFor(
  names: readonly string[],
  valueOwners: ReadonlyMap<string, ValueOwner>,
  conditionBinds: ReadonlyMap<string, number>,
  limit: SyqlValidatedQuery['limit'],
  query: SyqlLogicalQuery,
): string {
  return names
    .map((name) => {
      const value = valueOwners.get(name);
      if (value !== undefined) return `-- param :${name} ${value.type}`;
      if (conditionBinds.has(name)) return `-- param :${name} boolean`;
      if (name === LIMIT_BIND && limit !== undefined)
        return `-- param :${name} integer`;
      return fail(
        'SYQL7002_INTERNAL_LOWERING',
        query,
        `generated SQL contains unresolved bind :${name}`,
      );
    })
    .join('\n');
}

function planBind(
  name: string,
  valueOwners: ReadonlyMap<string, ValueOwner>,
  conditionBinds: ReadonlyMap<string, number>,
  conditions: readonly SyqlLogicalWhenNode[],
  limit: SyqlValidatedQuery['limit'],
  query: SyqlLogicalQuery,
): QuerySyqlPlanBind {
  const value = valueOwners.get(name);
  if (value?.kind === 'value') {
    return { kind: 'value', name, type: value.type, input: value.input };
  }
  if (value?.kind === 'group-member' && value.member !== undefined) {
    return {
      kind: 'group-member',
      name,
      type: value.type,
      input: value.input,
      member: value.member,
    };
  }
  const condition = conditionBinds.get(name);
  if (condition !== undefined) {
    return {
      kind: 'condition-active',
      name,
      type: 'boolean',
      condition,
      controls: (conditions[condition] as SyqlLogicalWhenNode).controls,
    };
  }
  if (name === LIMIT_BIND && limit !== undefined) {
    return {
      kind: 'limit',
      name,
      type: 'integer',
      input: limit.control,
    };
  }
  return fail(
    'SYQL7002_INTERNAL_LOWERING',
    query,
    `cannot describe generated bind :${name}`,
  );
}

function publicInputs(
  validated: SyqlValidatedQuery,
  naming: QueryNamingOptions,
): readonly QuerySyqlPublicInput[] {
  const query = validated.logical;
  const declaration = query.declaration;
  const publicNames = [
    ...declaration.parameters.map((parameter) => parameter.name),
    ...(declaration.sort === undefined ? [] : [declaration.sort.control]),
    ...(declaration.limit === undefined ? [] : [declaration.limit.control]),
  ];
  const mapped = new Map(
    buildNamingMap(
      publicNames,
      naming.naming,
      query.module.file,
      `query ${declaration.name} public inputs`,
      naming.targets,
    ).map((entry) => [entry.sqlName, entry.langName]),
  );
  const result: QuerySyqlPublicInput[] = declaration.parameters.map(
    (parameter) => {
      const langName = mapped.get(parameter.name) as string;
      if (parameter.kind === 'range') {
        const type = validated.bindTypes.get(
          syqlRangeStartBind(parameter.name),
        );
        if (type === undefined) {
          return fail(
            'SYQL7002_INTERNAL_LOWERING',
            query,
            `range ${parameter.name} has no resolved element type`,
          );
        }
        return {
          kind: 'group',
          name: parameter.name,
          langName,
          members: [
            {
              name: 'start',
              langName: 'start',
              type: type.base,
              nullable: type.nullable,
            },
            {
              name: 'end',
              langName: 'end',
              type: type.base,
              nullable: type.nullable,
            },
          ],
        };
      }
      if (parameter.kind === 'group') {
        const members = buildNamingMap(
          parameter.members.map((member) => member.name),
          naming.naming,
          query.module.file,
          `query ${declaration.name} group ${parameter.name}`,
          naming.targets,
        );
        return {
          kind: 'group',
          name: parameter.name,
          langName,
          members: parameter.members.map((member, index) => {
            const type = validated.bindTypes.get(member.name);
            if (type === undefined) {
              return fail(
                'SYQL7002_INTERNAL_LOWERING',
                query,
                `group member ${parameter.name}.${member.name} has no resolved type`,
              );
            }
            return {
              name: member.name,
              langName: (members[index] as { readonly langName: string })
                .langName,
              type: type.base,
              nullable: type.nullable,
            };
          }),
        };
      }
      const type = validated.bindTypes.get(parameter.name);
      if (type === undefined) {
        return fail(
          'SYQL7002_INTERNAL_LOWERING',
          query,
          `input ${parameter.name} has no resolved type`,
        );
      }
      return {
        kind: 'value',
        name: parameter.name,
        langName,
        type: type.base,
        nullable: type.nullable,
        required: !parameter.optional && parameter.default === undefined,
        ...(parameter.default === undefined
          ? {}
          : { default: parameter.default }),
      };
    },
  );
  if (validated.sort !== undefined) {
    const profiles = buildNamingMap(
      validated.sort.profiles.map((profile) => profile.name),
      naming.naming,
      query.module.file,
      `query ${declaration.name} sort profiles`,
      naming.targets,
    );
    result.push({
      kind: 'sort',
      name: validated.sort.control,
      langName: mapped.get(validated.sort.control) as string,
      defaultProfile: validated.sort.defaultProfile,
      profiles: validated.sort.profiles.map((profile, index) => ({
        name: profile.name,
        langName: (profiles[index] as { readonly langName: string }).langName,
      })),
    });
  }
  if (validated.limit !== undefined) {
    result.push({
      kind: 'limit',
      name: validated.limit.control,
      langName: mapped.get(validated.limit.control) as string,
      defaultSize: validated.limit.defaultSize,
      maxSize: validated.limit.maxSize,
    });
  }
  return result;
}

function valueOwners(
  validated: SyqlValidatedQuery,
): ReadonlyMap<string, ValueOwner> {
  const owners = new Map<string, ValueOwner>();
  for (const parameter of validated.logical.declaration.parameters) {
    if (parameter.kind === 'range') {
      for (const [name, member] of [
        [syqlRangeStartBind(parameter.name), 'start'],
        [syqlRangeEndBind(parameter.name), 'end'],
      ] as const) {
        const type = validated.bindTypes.get(name);
        if (type === undefined) continue;
        owners.set(name, {
          kind: 'group-member',
          input: parameter.name,
          member,
          type: type.base,
        });
      }
    } else if (parameter.kind === 'group') {
      for (const member of parameter.members) {
        const type = validated.bindTypes.get(member.name);
        if (type === undefined) continue;
        owners.set(member.name, {
          kind: 'group-member',
          input: parameter.name,
          member: member.name,
          type: type.base,
        });
      }
    } else {
      const type = validated.bindTypes.get(parameter.name);
      if (type === undefined) continue;
      owners.set(parameter.name, {
        kind: 'value',
        input: parameter.name,
        type: type.base,
      });
    }
  }
  return owners;
}

function activationControls(query: SyqlLogicalQuery): readonly string[] {
  const used = new Set(
    query.conditions.flatMap((condition) => condition.controls),
  );
  return query.declaration.parameters
    .map((parameter) => parameter.name)
    .filter((name) => used.has(name));
}

function lowerStatement(
  validated: SyqlValidatedQuery,
  ir: IrDocument,
  db: QueryDb,
  naming: QueryNamingOptions,
  sql: string,
  sortProfile: string | undefined,
  activationMask: number | undefined,
  owners: ReadonlyMap<string, ValueOwner>,
  conditionBinds: ReadonlyMap<string, number>,
): {
  readonly statement: QuerySyqlStatement;
  readonly analysis: AnalyzedQuery;
} {
  const query = validated.logical;
  const location = `${query.module.file} (query ${query.declaration.name}, generated)`;
  const names = distinctBindNames(sql, location);
  const headers = headersFor(
    names,
    owners,
    conditionBinds,
    validated.limit,
    query,
  );
  const candidate = headers.length === 0 ? sql : `${headers}\n${sql}`;
  const analyzed = analyzeStatement(
    query.declaration.name,
    location,
    candidate,
    ir,
    db,
    {
      ...naming,
      internalParams: [
        ...conditionBinds.keys(),
        ...(validated.limit === undefined ? [] : [LIMIT_BIND]),
        ...[...owners.keys()].filter((name) => name.startsWith('__syqlRange')),
      ],
    },
  );
  const namedSql =
    headers.length === 0
      ? analyzed.sql.trim()
      : analyzed.sql.slice(headers.length).trimStart();
  const bindNames = distinctBindNames(namedSql, location);
  return {
    statement: {
      ...(sortProfile === undefined ? {} : { sortProfile }),
      ...(activationMask === undefined ? {} : { activationMask }),
      sql: namedSql,
      positionalSql: analyzed.positionalSql,
      binds: bindNames.map((name) =>
        planBind(
          name,
          owners,
          conditionBinds,
          query.conditions,
          validated.limit,
          query,
        ),
      ),
    },
    analysis: { ...analyzed, sourceSql: namedSql, sql: namedSql },
  };
}

function sortProfiles(
  validated: SyqlValidatedQuery,
): readonly { readonly name?: string; readonly sql?: string }[] {
  return validated.sort === undefined
    ? [{}]
    : validated.sort.profiles.map((profile) => ({
        name: profile.name,
        sql: profile.sql,
      }));
}

/** Lower one validated revision-1 query and prepare every generated physical
 * statement. The selected plan is embedded into the returned shared QueryIR
 * query; the second plan is retained for equivalence conformance tests. */
export function lowerSyqlQuery(
  validated: SyqlValidatedQuery,
  ir: IrDocument,
  db: QueryDb,
  naming: QueryNamingOptions = DEFAULT_NAMING,
  options: SyqlLoweringOptions = {},
): SyqlLoweredQuery {
  const logical = validated.logical;
  const conditions = new Map(
    logical.conditions.map((condition, index) => [condition, index]),
  );
  const controls = activationControls(logical);
  const owners = valueOwners(validated);
  const conditionBinds = new Map(
    logical.conditions.map((_, index) => [`__syqlActive${index}`, index]),
  );
  const profiles = sortProfiles(validated);
  const neutralStatements: QuerySyqlStatement[] = [];
  let neutralDefault: AnalyzedQuery | undefined;
  for (const profile of profiles) {
    const body = renderTemplate(logical.template, conditions, {
      kind: 'neutralized',
    });
    const sql = composeControls(
      body,
      logical.module.file,
      profile.sql,
      validated.limit,
    );
    const lowered = lowerStatement(
      validated,
      ir,
      db,
      naming,
      sql,
      profile.name,
      undefined,
      owners,
      conditionBinds,
    );
    neutralStatements.push(lowered.statement);
    if (
      neutralDefault === undefined ||
      profile.name === validated.sort?.defaultProfile
    ) {
      neutralDefault = lowered.analysis;
    }
  }
  const neutralized: QuerySyqlExecutionPlan = {
    backend: 'neutralize',
    activationControls: controls,
    conditions: logical.conditions.map((condition, index) => ({
      controls: condition.controls,
      bind: `__syqlActive${index}`,
    })),
    statements: neutralStatements,
  };

  const maxStatements =
    options.maxEnumeratedStatements ?? DEFAULT_ENUMERATION_LIMIT;
  const activationCount = 2 ** controls.length;
  const enumeratedCount = activationCount * profiles.length;
  let enumerated: QuerySyqlExecutionPlan | undefined;
  let enumeratedDefault: AnalyzedQuery | undefined;
  if (
    Number.isSafeInteger(activationCount) &&
    enumeratedCount <= maxStatements
  ) {
    const statements: QuerySyqlStatement[] = [];
    for (let mask = 0; mask < activationCount; mask += 1) {
      const active = new Set(
        controls.filter((_, index) => (mask & (2 ** index)) !== 0),
      );
      for (const profile of profiles) {
        const body = renderTemplate(logical.template, conditions, {
          kind: 'enumerated',
          active,
        });
        const sql = composeControls(
          body,
          logical.module.file,
          profile.sql,
          validated.limit,
        );
        const lowered = lowerStatement(
          validated,
          ir,
          db,
          naming,
          sql,
          profile.name,
          mask,
          owners,
          new Map(),
        );
        statements.push(lowered.statement);
        if (
          mask === 0 &&
          (enumeratedDefault === undefined ||
            profile.name === validated.sort?.defaultProfile)
        ) {
          enumeratedDefault = lowered.analysis;
        }
      }
    }
    enumerated = {
      backend: 'variants',
      activationControls: controls,
      conditions: logical.conditions.map((condition) => ({
        controls: condition.controls,
      })),
      statements,
    };
  }

  const policy = options.backend ?? naming.backend ?? 'auto';
  let selected: QuerySyqlExecutionPlan;
  let canonical: AnalyzedQuery;
  if (policy === 'variants') {
    if (enumerated === undefined || enumeratedDefault === undefined) {
      return fail(
        'SYQL7001_ENUMERATION_LIMIT',
        logical,
        `${enumeratedCount} generated statements exceed the compiler limit ${maxStatements}; use auto/neutralize or raise the diagnostic limit`,
      );
    }
    selected = enumerated;
    canonical = enumeratedDefault;
  } else if (
    policy === 'auto' &&
    controls.length <= 2 &&
    enumerated !== undefined &&
    enumeratedDefault !== undefined
  ) {
    selected = enumerated;
    canonical = enumeratedDefault;
  } else {
    selected = neutralized;
    canonical = neutralDefault as AnalyzedQuery;
  }

  const metadata: QuerySyqlMetadata = {
    revision: 1,
    inputs: publicInputs(validated, naming),
    plan: selected,
    ...(validated.identity === undefined
      ? {}
      : { identity: validated.identity }),
  };
  const analysis: AnalyzedQuery = {
    ...canonical,
    file: logical.module.file,
    reactive: validated.reactive,
    syql: metadata,
  };
  return {
    validated,
    analysis,
    selected,
    neutralized,
    ...(enumerated === undefined ? {} : { enumerated }),
  };
}
