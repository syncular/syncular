/** Run the shared ClientDatabase contract under real Node and node:sqlite. */
import { runAdapterContract } from './adapter-contract.ts';
import { openNodeDatabase } from '../../src/node-database.ts';

try {
  runAdapterContract(openNodeDatabase);
  console.log('node-database: node:sqlite adapter passes the full contract');
} catch (error) {
  console.error('node-database: VERIFICATION FAILED');
  console.error(error);
  process.exit(1);
}
