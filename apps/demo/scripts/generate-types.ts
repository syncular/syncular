/**
 * @syncular/demo - Generate TypeScript types from migrations
 *
 * Run: bun generate:types
 */

import { generateTypes } from '@syncular/typegen';
import { clientMigrations } from '../src/client/migrate';

async function main() {
  console.log('Generating client types from migrations...');

  const result = await generateTypes({
    migrations: clientMigrations,
    output: './src/client/types.generated.ts',
    extendsSyncClientDb: true,
  });

  console.log(`Generated ${result.outputPath}`);
  console.log(`  Schema version: ${result.currentVersion}`);
  console.log(`  Tables: ${result.tableCount}`);
}

main().catch((err) => {
  console.error('Failed to generate types:', err);
  process.exit(1);
});
