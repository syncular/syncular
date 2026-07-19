import type { IrDocument } from '../../../../packages/typegen/src/ir';

export type SyqlCompletionKind =
  | 'column'
  | 'input'
  | 'keyword'
  | 'qualifier'
  | 'snippet'
  | 'table';

export interface SyqlCompletion {
  readonly label: string;
  readonly insertText: string;
  readonly kind: SyqlCompletionKind;
  readonly detail: string;
  readonly snippet?: true;
}

interface DeclarationContext {
  readonly kind: 'predicate' | 'query';
  readonly signature: string;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

interface TableBinding {
  readonly table: string;
  readonly qualifier: string;
  readonly columns: readonly ColumnInfo[];
}

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

const RESERVED_ALIAS = new Set([
  'cross',
  'group',
  'having',
  'inner',
  'join',
  'left',
  'limit',
  'on',
  'order',
  'outer',
  'right',
  'using',
  'where',
]);

const QUERY_SNIPPETS: readonly SyqlCompletion[] = [
  {
    label: 'select …',
    insertText: `select \${1:columns}\nfrom \${2:table}`,
    kind: 'snippet',
    detail: 'SQL projection and source',
    snippet: true,
  },
  {
    label: 'from …',
    insertText: `from \${1:table}`,
    kind: 'snippet',
    detail: 'SQL table source',
    snippet: true,
  },
  {
    label: 'where …',
    insertText: `where \${1:condition}`,
    kind: 'snippet',
    detail: 'SQL filter',
    snippet: true,
  },
  {
    label: 'and when (…) …',
    insertText: `and when(\${1:input}) \${2:condition}`,
    kind: 'snippet',
    detail: 'Conditional SYQL conjunct',
    snippet: true,
  },
  {
    label: 'order by …',
    insertText: `order by \${1:column} \${2|asc,desc|}`,
    kind: 'snippet',
    detail: 'Stable SQL ordering',
    snippet: true,
  },
  {
    label: 'order by profiles …',
    insertText: `order by \${1:sortBy} default \${2:newest} {
  \${2:newest}: \${3:created_at} desc, \${4:id} desc;
}`,
    kind: 'snippet',
    detail: 'Closed SYQL sort profiles',
    snippet: true,
  },
  {
    label: 'limit control …',
    insertText: `limit \${1:pageSize} default \${2:50} max \${3:200}`,
    kind: 'snippet',
    detail: 'Bounded SYQL limit input',
    snippet: true,
  },
];

const TOP_LEVEL_SNIPPETS: readonly SyqlCompletion[] = [
  {
    label: 'query …',
    insertText: `query \${1:name}(\${2}) {
  select \${3:id}
  from \${4:table};
}`,
    kind: 'snippet',
    detail: 'Declare a local read query',
    snippet: true,
  },
  {
    label: 'sync query …',
    insertText: `sync query \${1:name}(\${2}) {
  select \${3:id}
  from \${4:table}
  where \${5:scope_column} = :\${6:scopeValue};
}`,
    kind: 'snippet',
    detail: 'Declare a coverage-proven sync query',
    snippet: true,
  },
  {
    label: 'predicate …',
    insertText: `predicate \${1:name}(\${2:value}: \${3:string}) {
  \${4:column} = :\${2:value}
}`,
    kind: 'snippet',
    detail: 'Declare a reusable local predicate',
    snippet: true,
  },
];

function maskTrivia(source: string): string {
  const chars = [...source];
  let index = 0;
  while (index < chars.length) {
    if (chars[index] === '-' && chars[index + 1] === '-') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 2;
      while (index < chars.length && chars[index] !== '\n') {
        chars[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (chars[index] === '/' && chars[index + 1] === '*') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 2;
      while (
        index < chars.length &&
        !(chars[index] === '*' && chars[index + 1] === '/')
      ) {
        if (chars[index] !== '\n') chars[index] = ' ';
        index += 1;
      }
      if (index < chars.length) {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 2;
      }
      continue;
    }
    const quote = chars[index];
    if (quote === "'" || quote === '"' || quote === '`') {
      chars[index] = ' ';
      index += 1;
      while (index < chars.length) {
        const current = chars[index];
        if (current !== '\n') chars[index] = ' ';
        index += 1;
        if (current !== quote) continue;
        if (chars[index] === quote) {
          chars[index] = ' ';
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    index += 1;
  }
  return chars.join('');
}

function closingDelimiter(
  source: string,
  openIndex: number,
  open: string,
  close: string,
): number | undefined {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    else if (source[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function declarationAt(
  source: string,
  offset: number,
): DeclarationContext | undefined {
  const masked = maskTrivia(source);
  const declaration =
    /\b(?:sync\s+)?(query|predicate)\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/gi;
  let active: DeclarationContext | undefined;
  for (const match of masked.matchAll(declaration)) {
    if ((match.index ?? 0) >= offset) break;
    const openParen = masked.indexOf('(', match.index);
    const closeParen = closingDelimiter(masked, openParen, '(', ')');
    if (closeParen === undefined) continue;
    const bodyStart = masked.indexOf('{', closeParen);
    if (bodyStart < 0 || bodyStart >= offset) continue;
    const bodyEnd =
      closingDelimiter(masked, bodyStart, '{', '}') ?? source.length;
    if (offset > bodyEnd) continue;
    active = {
      kind: match[1]?.toLowerCase() === 'predicate' ? 'predicate' : 'query',
      signature: source.slice(openParen + 1, closeParen),
      bodyStart: bodyStart + 1,
      bodyEnd,
    };
  }
  return active;
}

function splitTopLevel(source: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index <= source.length; index += 1) {
    const char = source[index];
    if (char === '{' || char === '(' || char === '[') depth += 1;
    else if (char === '}' || char === ')' || char === ']') depth -= 1;
    if ((char === ',' && depth === 0) || index === source.length) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  return parts;
}

function declaredBinds(signature: string): readonly string[] {
  const names: string[] = [];
  for (const parameter of splitTopLevel(signature)) {
    const publicName = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(parameter)?.[1];
    if (publicName === undefined) continue;
    const group = /\{([\s\S]*)\}/.exec(parameter)?.[1];
    if (group === undefined) {
      names.push(publicName);
      continue;
    }
    for (const member of splitTopLevel(group)) {
      const memberName = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(member)?.[1];
      if (memberName !== undefined) names.push(memberName);
    }
  }
  return [...new Set(names)];
}

function tableInfo(ir: IrDocument, name: string): readonly ColumnInfo[] {
  const table = ir.tables.find((candidate) => candidate.name === name);
  if (table !== undefined) return table.columns;
  for (const owner of ir.tables) {
    const fts = owner.ftsIndexes.find((candidate) => candidate.name === name);
    if (fts !== undefined) {
      return [
        { name: '_syncular_source_id', type: 'string', nullable: false },
        ...fts.columns.map((column) => {
          const source = owner.columns.find(
            (candidate) => candidate.name === column,
          );
          return {
            name: column,
            type: source?.type ?? 'string',
            nullable: source?.nullable ?? true,
          };
        }),
      ];
    }
  }
  return [];
}

function tableBindings(
  source: string,
  ir: IrDocument,
): readonly TableBinding[] {
  const masked = maskTrivia(source);
  const bindings: TableBinding[] = [];
  const tableReference =
    /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  for (const match of masked.matchAll(tableReference)) {
    const table = match[1] as string;
    const authoredAlias = match[2];
    const qualifier =
      authoredAlias === undefined ||
      RESERVED_ALIAS.has(authoredAlias.toLowerCase())
        ? table
        : authoredAlias;
    const columns = tableInfo(ir, table);
    if (columns.length > 0) bindings.push({ table, qualifier, columns });
  }
  return bindings;
}

function tableCompletions(ir: IrDocument): readonly SyqlCompletion[] {
  const completions: SyqlCompletion[] = [];
  for (const table of ir.tables) {
    completions.push({
      label: table.name,
      insertText: table.name,
      kind: 'table',
      detail: `${table.columns.length} columns · primary key ${table.primaryKey}`,
    });
    for (const fts of table.ftsIndexes) {
      completions.push({
        label: fts.name,
        insertText: fts.name,
        kind: 'table',
        detail: `FTS5 projection of ${table.name}`,
      });
    }
  }
  return completions;
}

function columnCompletion(column: ColumnInfo, table: string): SyqlCompletion {
  return {
    label: column.name,
    insertText: column.name,
    kind: 'column',
    detail: `${table} · ${column.type}${column.nullable ? ' | null' : ''}`,
  };
}

function uniqueCompletions(
  completions: readonly SyqlCompletion[],
): readonly SyqlCompletion[] {
  const seen = new Set<string>();
  return completions.filter((completion) => {
    const key = `${completion.kind}\0${completion.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Tolerant completions for incomplete editor text; validation stays compiler-owned. */
export function syqlCompletions(
  source: string,
  offset: number,
  ir: IrDocument,
): readonly SyqlCompletion[] {
  const before = source.slice(0, offset);
  const declaration = declarationAt(source, offset);
  if (declaration === undefined) return TOP_LEVEL_SNIPPETS;

  const body = source.slice(declaration.bodyStart, declaration.bodyEnd);
  const bindings = tableBindings(body, ir);
  const bindPrefix = /:([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before);
  if (bindPrefix !== null) {
    return declaredBinds(declaration.signature).map((name) => ({
      label: name,
      insertText: name,
      kind: 'input',
      detail: `${declaration.kind} input`,
    }));
  }

  const qualified = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)?$/.exec(
    before,
  );
  if (qualified !== null) {
    const qualifier = qualified[1] as string;
    const binding = bindings.find(
      (candidate) =>
        candidate.qualifier.toLowerCase() === qualifier.toLowerCase(),
    );
    return (
      binding?.columns.map((column) =>
        columnCompletion(column, binding.table),
      ) ?? []
    );
  }

  if (/\b(?:from|join)\s+(?:[A-Za-z_][A-Za-z0-9_]*)?$/i.test(before)) {
    return tableCompletions(ir);
  }

  const columns = bindings.flatMap((binding) =>
    binding.columns.map((column) => columnCompletion(column, binding.table)),
  );
  const qualifiers = bindings.map((binding) => ({
    label: binding.qualifier,
    insertText: `${binding.qualifier}.`,
    kind: 'qualifier' as const,
    detail: `columns from ${binding.table}`,
  }));
  const inputs = declaredBinds(declaration.signature).map((name) => ({
    label: `:${name}`,
    insertText: `:${name}`,
    kind: 'input' as const,
    detail: `${declaration.kind} input`,
  }));
  return uniqueCompletions([
    ...columns,
    ...qualifiers,
    ...inputs,
    ...(declaration.kind === 'query' ? QUERY_SNIPPETS : []),
    {
      label: 'null',
      insertText: 'null',
      kind: 'keyword',
      detail: 'SQL null literal',
    },
  ]);
}
