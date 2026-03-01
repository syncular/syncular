import { createCodeUsageGeneratorRegistry } from 'fumadocs-openapi/requests/generators';
import { createAPIPage } from 'fumadocs-openapi/ui';
import { openapi } from '@/lib/openapi';

const codeUsages = createCodeUsageGeneratorRegistry();

export const APIPage = createAPIPage(openapi, {
  codeUsages,
});
