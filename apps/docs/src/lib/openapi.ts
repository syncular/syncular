import type { Document } from 'fumadocs-openapi';
import { createOpenAPI } from 'fumadocs-openapi/server';

import openapiSpec from '../../openapi.json';

export const openapi = createOpenAPI({
  input: () => ({
    './openapi.json': openapiSpec as Document,
  }),
});
