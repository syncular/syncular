/**
 * @syncular/demo - Client-side catalog_items table handler
 *
 * Read-only large-table demo.
 */

import { createClientHandler } from '@syncular/client';
import type { ClientDb } from '../types.generated';

export const catalogItemsClientHandler = createClientHandler<
  ClientDb,
  'catalog_items'
>({
  table: 'catalog_items',
  scopes: [
    { pattern: 'catalog:{catalog_id}', column: 'id' }, // Global scope - catalog_id doesn't filter rows
  ],
  // Override clearAll to delete all items
  clearAll: async (ctx) => {
    await ctx.trx.deleteFrom('catalog_items').execute();
  },
});
