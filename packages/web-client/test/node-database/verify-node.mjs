/** Run the shared ClientDatabase contract under real Node and node:sqlite. */
import { runAdapterContract } from './adapter-contract.ts';
import { StatementSync } from 'node:sqlite';
import { openNodeDatabase } from '../../src/node-database.ts';

try {
  await runAdapterContract(openNodeDatabase);
  // A Node older than 22.16 has no `columns()`: the adapter refuses to open.
  const columns = Object.getOwnPropertyDescriptor(
    StatementSync.prototype,
    'columns',
  );
  delete StatementSync.prototype.columns;
  let refused;
  try {
    openNodeDatabase().close();
  } catch (error) {
    refused = error;
  } finally {
    Object.defineProperty(StatementSync.prototype, 'columns', columns);
  }
  if (refused?.code !== 'client.storage_unavailable') {
    throw new Error('openNodeDatabase must refuse a Node without columns()');
  }
  console.log('node-database: node:sqlite adapter passes the full contract');
} catch (error) {
  console.error('node-database: VERIFICATION FAILED');
  console.error(error);
  process.exit(1);
}
