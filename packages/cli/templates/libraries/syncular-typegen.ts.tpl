/**
 * Syncular type generation scaffold.
 *
 * Wire your migrations export and run via `bun run db:typegen`.
 */

import { generateTypes } from '@syncular/typegen';

async function main() {
  throw new Error('TODO: import your migrations and call generateTypes(...)');

  // Example:
  // const result = await generateTypes({
  //   migrations,
  //   output: './src/syncular/types.generated.ts',
  //   extendsSyncClientDb: true,
  // });
  // console.log(`Generated ${result.outputPath}`);
  // await generateTypes({
  //   migrations,
  //   output: './src/syncular/types.generated.ts',
  //   extendsSyncClientDb: true,
  // });
}

main().catch((error) => {
  console.error('Typegen failed:', error);
  process.exit(1);
});
