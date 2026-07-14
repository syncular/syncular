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
      readonly explicitPresence: readonly boolean[];
      readonly body: readonly SyqlSemanticTemplateNode[];
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
      readonly default?: false;
    }
  | {
      readonly kind: 'range';
      readonly name: string;
      readonly optional: boolean;
      readonly type?: SyqlSemanticType;
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
      readonly sync: boolean;
      readonly syncBy?: {
        readonly qualifier: string;
        readonly column: string;
      };
      readonly parameters: readonly SyqlSemanticQueryParameter[];
      readonly statement: SyqlSemanticTemplate;
      readonly sort?: {
        readonly control: string;
        readonly defaultProfile: string;
        readonly profiles: readonly {
          readonly name: string;
          readonly order: SyqlSemanticTemplate;
        }[];
      };
      readonly limit?: {
        readonly control: string;
        readonly defaultSize: number;
        readonly maxSize: number;
      };
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
  if (parameter.kind === 'range') {
    const type = semanticType(parameter.type);
    return {
      kind: 'range',
      name: parameter.name,
      optional: parameter.optional,
      ...(type === undefined ? {} : { type }),
    };
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
    ...(parameter.default === undefined ? {} : { default: parameter.default }),
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
      explicitPresence: node.explicitPresence,
      body: semanticNodes(node.body.nodes),
    };
  }
  return undefined;
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
    sync: declaration.sync,
    ...(declaration.syncBy === undefined
      ? {}
      : {
          syncBy: {
            qualifier: declaration.syncBy.qualifier,
            column: declaration.syncBy.column,
          },
        }),
    parameters: declaration.parameters.map(semanticParameter),
    statement: semanticTemplate(declaration.statement),
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
    ...(declaration.limit === undefined
      ? {}
      : {
          limit: {
            control: declaration.limit.control,
            defaultSize: declaration.limit.defaultSize,
            maxSize: declaration.limit.maxSize,
          },
        }),
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
