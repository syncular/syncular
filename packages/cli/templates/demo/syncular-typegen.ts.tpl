/**
 * Generate database types from demo migrations.
 */

import { generateTypes } from '@syncular/typegen';
import { demoMigrations } from '../src/shared/db';

async function main() {
  const result = await generateTypes({
    migrations: demoMigrations,
    output: './src/shared/types.generated.ts',
    extendsSyncClientDb: true,
  });

  console.log(`Generated ${result.outputPath}`);
  console.log(`Schema version: ${result.currentVersion}`);
  console.log(`Tables: ${result.tableCount}`);
}

main().catch((error) => {
  console.error('Type generation failed:', error);
  process.exit(1);
});
