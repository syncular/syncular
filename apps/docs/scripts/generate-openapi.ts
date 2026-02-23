import { generateFiles } from 'fumadocs-openapi';
import { createOpenAPI } from 'fumadocs-openapi/server';

import '../source.config';

const openapi = createOpenAPI({
  input: ['./openapi.json'],
});

await generateFiles({
  input: openapi,
  output: './content/docs/api',
  includeDescription: true,
});

console.log('OpenAPI spec generated');

process.exit(0);
