import type {
  QueryReactiveMetadata,
  QuerySyqlPlanBind,
  QuerySyqlPublicInput,
} from '../../../../packages/typegen/src/query';

export interface PlaygroundDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

export interface PlaygroundStatement {
  readonly sql: string;
  readonly positionalSql: string;
  readonly sortProfile?: string;
  readonly activationMask?: number;
  readonly activationLabel: string;
  readonly binds: readonly QuerySyqlPlanBind[];
}

export interface PlaygroundQuery {
  readonly name: string;
  readonly backend: 'variants' | 'neutralize';
  readonly defaultSortProfile?: string;
  readonly statements: readonly PlaygroundStatement[];
  readonly inputs: readonly QuerySyqlPublicInput[];
  readonly dependencies: QueryReactiveMetadata['dependencies'];
  readonly coverage: QueryReactiveMetadata['coverage'];
  readonly identity?: readonly string[];
}

export type PlaygroundWorkerRequest =
  | {
      readonly kind: 'compile';
      readonly requestId: number;
      readonly schemaId: string;
      readonly source: string;
    }
  | {
      readonly kind: 'format';
      readonly requestId: number;
      readonly source: string;
    };

export type PlaygroundWorkerResponse =
  | {
      readonly kind: 'ready';
    }
  | {
      readonly kind: 'compiled';
      readonly requestId: number;
      readonly elapsedMs: number;
      readonly queries: readonly PlaygroundQuery[];
    }
  | {
      readonly kind: 'formatted';
      readonly requestId: number;
      readonly source: string;
    }
  | {
      readonly kind: 'diagnostics';
      readonly requestId: number;
      readonly diagnostics: readonly PlaygroundDiagnostic[];
    };
