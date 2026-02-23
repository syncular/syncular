/**
 * @syncular/core - Data transformation hooks
 *
 * Provides interfaces for field-level transformations (e.g., encryption/decryption)
 * that can be applied during sync operations.
 */

/**
 * Direction of the transformation.
 * - 'toClient': Server → Client (e.g., decrypt for client)
 * - 'toServer': Client → Server (e.g., encrypt for server)
 */
export type TransformDirection = 'toClient' | 'toServer';

/**
 * Context passed to transform functions.
 */
export interface TransformContext {
  /** Direction of transformation */
  direction: TransformDirection;
  /** Scope name */
  scope: string;
  /** Table name */
  table: string;
  /** Row ID */
  rowId: string;
  /** User ID performing the operation */
  userId: string;
}

/**
 * A field transformer handles transformation of a single field.
 *
 * @example
 * const secretNotesTransformer: FieldTransformer = {
 *   field: 'secret_notes',
 *   async transform(value, ctx) {
 *     const key = await getUserEncryptionKey(ctx.userId);
 *     return ctx.direction === 'toClient'
 *       ? decrypt(value as string, key)
 *       : encrypt(value as string, key);
 *   }
 * };
 */
export interface FieldTransformer {
  /** Field name to transform */
  field: string;
  /**
   * Transform the field value.
   * @param value - Current field value
   * @param ctx - Transform context
   * @returns Transformed value
   */
  transform(value: unknown, ctx: TransformContext): Promise<unknown> | unknown;
}

/**
 * Configuration for transforms on a scope.
 */
export interface ScopeTransformConfig {
  /** Scope name this config applies to */
  scope: string;
  /** Field transformers for this scope */
  fields?: FieldTransformer[];
}

/**
 * Registry for managing data transforms.
 *
 * @example
 * const transforms = new TransformRegistry();
 *
 * transforms.register({
 *   scope: 'tasks',
 *   fields: [{
 *     field: 'secret_notes',
 *     async transform(value, ctx) {
 *       const key = await getUserEncryptionKey(ctx.userId);
 *       return ctx.direction === 'toClient'
 *         ? decrypt(value as string, key)
 *         : encrypt(value as string, key);
 *     }
 *   }]
 * });
 *
 * // Apply transforms to data
 * const transformed = await transforms.apply(
 *   [{ id: '1', secret_notes: 'encrypted...' }],
 *   { direction: 'toClient', scope: 'tasks', ... }
 * );
 */
export class TransformRegistry {
  private configs: Map<string, ScopeTransformConfig> = new Map();

  /**
   * Register transform config for a scope.
   * @throws If config for this scope is already registered
   */
  register(config: ScopeTransformConfig): void {
    if (this.configs.has(config.scope)) {
      throw new Error(
        `Transform config for scope "${config.scope}" is already registered`
      );
    }
    this.configs.set(config.scope, config);
  }

  /**
   * Unregister transform config by scope.
   * @returns true if config was found and removed
   */
  unregister(scope: string): boolean {
    return this.configs.delete(scope);
  }

  /**
   * Get config for a scope.
   */
  get(scope: string): ScopeTransformConfig | undefined {
    return this.configs.get(scope);
  }

  /**
   * Check if any transforms are registered for a scope.
   */
  hasTransforms(scope: string): boolean {
    const config = this.configs.get(scope);
    return config !== undefined && (config.fields?.length ?? 0) > 0;
  }

  /**
   * Get all registered configs.
   */
  getAll(): ScopeTransformConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * Apply transforms to a single row.
   *
   * @param row - Row data to transform
   * @param ctx - Transform context (without rowId, will be extracted from row)
   * @param rowIdField - Field name for row ID (default: 'id')
   * @returns Transformed row
   */
  async applyToRow<T extends Record<string, unknown>>(
    row: T,
    ctx: Omit<TransformContext, 'rowId'>,
    rowIdField = 'id'
  ): Promise<T> {
    const config = this.configs.get(ctx.scope);
    if (!config?.fields?.length) {
      return row;
    }

    const rowId = String(row[rowIdField] ?? '');
    const fullCtx: TransformContext = { ...ctx, rowId };
    const result = { ...row };

    for (const transformer of config.fields) {
      if (transformer.field in result) {
        try {
          result[transformer.field as keyof T] = (await transformer.transform(
            result[transformer.field],
            fullCtx
          )) as T[keyof T];
        } catch (err) {
          console.error(
            `[transforms] Error transforming field "${transformer.field}" for ${ctx.scope}:${rowId}:`,
            err
          );
          // Keep original value on error
        }
      }
    }

    return result;
  }

  /**
   * Apply transforms to multiple rows.
   *
   * @param rows - Array of rows to transform
   * @param ctx - Transform context (without rowId)
   * @param rowIdField - Field name for row ID (default: 'id')
   * @returns Transformed rows
   */
  async apply<T extends Record<string, unknown>>(
    rows: T[],
    ctx: Omit<TransformContext, 'rowId'>,
    rowIdField = 'id'
  ): Promise<T[]> {
    const config = this.configs.get(ctx.scope);
    if (!config?.fields?.length) {
      return rows;
    }

    return Promise.all(
      rows.map((row) => this.applyToRow(row, ctx, rowIdField))
    );
  }

  /**
   * Apply transforms to a mutation payload.
   *
   * @param payload - Mutation payload (may be partial row)
   * @param ctx - Full transform context
   * @returns Transformed payload
   */
  async applyToPayload<T extends Record<string, unknown>>(
    payload: T | null,
    ctx: TransformContext
  ): Promise<T | null> {
    if (!payload) return null;

    const config = this.configs.get(ctx.scope);
    if (!config?.fields?.length) {
      return payload;
    }

    const result = { ...payload };

    for (const transformer of config.fields) {
      if (transformer.field in result) {
        try {
          result[transformer.field as keyof T] = (await transformer.transform(
            result[transformer.field],
            ctx
          )) as T[keyof T];
        } catch (err) {
          console.error(
            `[transforms] Error transforming field "${transformer.field}" for ${ctx.scope}:${ctx.rowId}:`,
            err
          );
          // Keep original value on error
        }
      }
    }

    return result;
  }

  /**
   * Clear all registered configs.
   */
  clear(): void {
    this.configs.clear();
  }
}

/**
 * Create a new transform registry.
 */
export function createTransformRegistry(): TransformRegistry {
  return new TransformRegistry();
}
