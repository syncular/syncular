/** Stable, span-free semantic AST used by revision-1 conformance fixtures. */
import { isSyqlTrivia, type SyqlToken } from './syql-lexer';
import type {
  SyqlDeclaration,
  SyqlGroupMember,
  SyqlQueryParameter,
  SyqlSyntaxFile,
  SyqlTemplate,
  SyqlValueType,
} from './syql-parser';
import type { SyqlEmbeddedNode } from './syql-template-parser';

export interface SyqlSemanticToken {
  readonly kind: SyqlToken['kind'];
  readonly text: string;
}

export interface SyqlSemanticType {
  readonly base: SyqlValueType['base'];
  readonly nullable: boolean;
}

export type SyqlSemanticTemplateNode =
  | {
      readonly kind: 'sql';
      readonly tokens: readonly SyqlSemanticToken[];
    }
  | {
      readonly kind: 'predicate-call';
      readonly name: string;
      readonly arguments: readonly string[];
    }
  | {
      readonly kind: 'when';
      readonly controls: readonly string[];
      readonly body: readonly SyqlSemanticTemplateNode[];
    }
  | {
      readonly kind: 'scope' | 'cover';
      readonly bindings: readonly {
        readonly qualifier: string;
        readonly column: string;
        readonly operator: 'equal' | 'in';
        readonly values: readonly string[];
      }[];
    };

export interface SyqlSemanticTemplate {
  readonly mode: SyqlTemplate['tree']['mode'];
  readonly nodes: readonly SyqlSemanticTemplateNode[];
}

export type SyqlSemanticQueryParameter =
  | {
      readonly kind: 'value';
      readonly name: string;
      readonly optional: boolean;
      readonly type?: SyqlSemanticType;
    }
  | {
      readonly kind: 'switch';
      readonly name: string;
      readonly optional: true;
    }
  | {
      readonly kind: 'group';
      readonly name: string;
      readonly optional: true;
      readonly members: readonly {
        readonly name: string;
        readonly type?: SyqlSemanticType;
      }[];
    };

export type SyqlSemanticDeclaration =
  | {
      readonly kind: 'predicate';
      readonly name: string;
      readonly parameters: readonly {
        readonly name: string;
        readonly type?: SyqlSemanticType;
      }[];
      readonly body: SyqlSemanticTemplate;
    }
  | {
      readonly kind: 'query';
      readonly name: string;
      readonly parameters: readonly SyqlSemanticQueryParameter[];
      readonly sql: SyqlSemanticTemplate;
      readonly sort?: {
        readonly control: string;
        readonly defaultProfile: string;
        readonly profiles: readonly {
          readonly name: string;
          readonly order: SyqlSemanticTemplate;
        }[];
      };
      readonly page?: {
        readonly control: string;
        readonly defaultSize: number;
        readonly maxSize: number;
      };
      readonly identity?: readonly string[];
    };

export interface SyqlSemanticFile {
  readonly kind: 'syql-file';
  readonly revision: 1;
  readonly imports: readonly {
    readonly path: string;
    readonly items: readonly {
      readonly imported: string;
      readonly local: string;
    }[];
  }[];
  readonly declarations: readonly SyqlSemanticDeclaration[];
}

function semanticType(
  type: SyqlValueType | undefined,
): SyqlSemanticType | undefined {
  return type === undefined
    ? undefined
    : { base: type.base, nullable: type.nullable };
}

function semanticMember(member: SyqlGroupMember): {
  readonly name: string;
  readonly type?: SyqlSemanticType;
} {
  const type = semanticType(member.type);
  return { name: member.name, ...(type === undefined ? {} : { type }) };
}

function semanticParameter(
  parameter: SyqlQueryParameter,
): SyqlSemanticQueryParameter {
  if (parameter.kind === 'switch') {
    return { kind: 'switch', name: parameter.name, optional: true };
  }
  if (parameter.kind === 'group') {
    return {
      kind: 'group',
      name: parameter.name,
      optional: true,
      members: parameter.members.map(semanticMember),
    };
  }
  const type = semanticType(parameter.type);
  return {
    kind: 'value',
    name: parameter.name,
    optional: parameter.optional,
    ...(type === undefined ? {} : { type }),
  };
}

function semanticRawTokens(
  tokens: readonly SyqlToken[],
): readonly SyqlSemanticToken[] {
  return tokens
    .filter((token) => !isSyqlTrivia(token))
    .map((token) => ({ kind: token.kind, text: token.text }));
}

function semanticNode(
  node: SyqlEmbeddedNode,
): SyqlSemanticTemplateNode | undefined {
  if (node.kind === 'raw') {
    const tokens = semanticRawTokens(node.tokens);
    return tokens.length === 0 ? undefined : { kind: 'sql', tokens };
  }
  if (node.kind === 'predicate-call') {
    return {
      kind: 'predicate-call',
      name: node.name,
      arguments: node.arguments.map((argument) => argument.name),
    };
  }
  if (node.kind === 'when') {
    return {
      kind: 'when',
      controls: node.controls,
      body: semanticNodes(node.body.nodes),
    };
  }
  return {
    kind: node.kind,
    bindings: node.bindings.map((binding) => ({
      qualifier: binding.column.qualifier,
      column: binding.column.name,
      operator: binding.operator,
      values: binding.values.map((value) => value.name),
    })),
  };
}

function semanticNodes(
  nodes: readonly SyqlEmbeddedNode[],
): readonly SyqlSemanticTemplateNode[] {
  return nodes.flatMap((node) => {
    const semantic = semanticNode(node);
    return semantic === undefined ? [] : [semantic];
  });
}

function semanticTemplate(template: SyqlTemplate): SyqlSemanticTemplate {
  return {
    mode: template.tree.mode,
    nodes: semanticNodes(template.tree.nodes),
  };
}

function semanticDeclaration(
  declaration: SyqlDeclaration,
): SyqlSemanticDeclaration {
  if (declaration.kind === 'predicate') {
    return {
      kind: 'predicate',
      name: declaration.name,
      parameters: declaration.parameters.map((parameter) => {
        const type = semanticType(parameter.type);
        return {
          name: parameter.name,
          ...(type === undefined ? {} : { type }),
        };
      }),
      body: semanticTemplate(declaration.body),
    };
  }
  return {
    kind: 'query',
    name: declaration.name,
    parameters: declaration.parameters.map(semanticParameter),
    sql: semanticTemplate(declaration.sql.body),
    ...(declaration.sort === undefined
      ? {}
      : {
          sort: {
            control: declaration.sort.control,
            defaultProfile: declaration.sort.defaultProfile,
            profiles: declaration.sort.profiles.map((profile) => ({
              name: profile.name,
              order: semanticTemplate(profile.order),
            })),
          },
        }),
    ...(declaration.page === undefined
      ? {}
      : {
          page: {
            control: declaration.page.control,
            defaultSize: declaration.page.defaultSize,
            maxSize: declaration.page.maxSize,
          },
        }),
    ...(declaration.identity === undefined
      ? {}
      : { identity: declaration.identity.fields }),
  };
}

/** Return the stable syntax/semantic AST pinned by `spec/syql` fixtures. */
export function toSyqlSemanticAst(file: SyqlSyntaxFile): SyqlSemanticFile {
  return {
    kind: 'syql-file',
    revision: 1,
    imports: file.imports.map((declaration) => ({
      path: declaration.path,
      items: declaration.items.map((item) => ({
        imported: item.imported,
        local: item.local,
      })),
    })),
    declarations: file.declarations.map(semanticDeclaration),
  };
}
