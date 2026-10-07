import type {
  QueryReactiveMetadata,
  QuerySyqlPlanBind,
  QuerySyqlPublicInput,
} from '../../../../packages/typegen/src/query';

export interface PlaygroundDiagnostic {
  readonly code: string;
  readonly message: string;
  /** The compiler's remediation instruction for a stable SYQL code. */
  readonly remedy?: string;
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

export interface PlaygroundColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

export interface PlaygroundQuery {
  readonly name: string;
  readonly sync: boolean;
  readonly backend: 'variants' | 'neutralize';
  /** One bit per activation control, in declaration order (variants). */
  readonly activationControls: readonly string[];
  readonly defaultSortProfile?: string;
  readonly statements: readonly PlaygroundStatement[];
  readonly inputs: readonly QuerySyqlPublicInput[];
  readonly columns: readonly PlaygroundColumn[];
  readonly dependencies: QueryReactiveMetadata['dependencies'];
  readonly coverage: QueryReactiveMetadata['coverage'];
  readonly identity?: readonly string[];
}

/** A value bound to one positional SQLite parameter. */
export type PlaygroundSqlValue = string | number | null;

export type PlaygroundWorkerRequest =
  | {
      readonly kind: 'compile';
      readonly requestId: number;
      readonly source: string;
    }
  | {
      readonly kind: 'format';
      readonly requestId: number;
      readonly source: string;
    }
  | {
      readonly kind: 'run';
      readonly requestId: number;
      readonly sql: string;
      readonly values: readonly PlaygroundSqlValue[];
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
      readonly kind: 'rows';
      readonly requestId: number;
      readonly elapsedMs: number;
      readonly columns: readonly string[];
      readonly rows: readonly (readonly PlaygroundSqlValue[])[];
    }
  | {
      readonly kind: 'diagnostics';
      readonly requestId: number;
      readonly diagnostics: readonly PlaygroundDiagnostic[];
    };
