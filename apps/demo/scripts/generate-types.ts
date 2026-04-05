/**
 * @syncular/demo - Generate TypeScript types from migrations
 *
 * Run: bun generate:types
 */

import { generateMigrationChecksums, generateTypes } from '@syncular/typegen';
import { clientMigrations } from '../src/client/migrations';
import { serverMigrations } from '../src/server/migrations';

async function main() {
  console.log('Generating client types from migrations...');

  const result = await generateTypes({
    migrations: clientMigrations,
    output: './src/client/types.generated.ts',
    extendsSyncClientDb: true,
  });

  const clientChecksums = await generateMigrationChecksums({
    migrations: clientMigrations,
    output: './src/client/migrate.checksums.generated.ts',
  });

  const serverChecksums = await generateMigrationChecksums({
    migrations: serverMigrations,
    output: './src/server/migrations.checksums.generated.ts',
  });

  console.log(`Generated ${result.outputPath}`);
  console.log(`  Schema version: ${result.currentVersion}`);
  console.log(`  Tables: ${result.tableCount}`);
  console.log(`Generated ${clientChecksums.outputPath}`);
  console.log(`  Checksums: ${clientChecksums.checksumCount}`);
  console.log(`Generated ${serverChecksums.outputPath}`);
  console.log(`  Checksums: ${serverChecksums.checksumCount}`);
}

main().catch((err) => {
  console.error('Failed to generate types:', err);
  process.exit(1);
});
