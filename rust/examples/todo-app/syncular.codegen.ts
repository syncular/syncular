import { writeSyncularCodegenJson } from '@syncular/typegen';
import { app } from './syncular.app';

await writeSyncularCodegenJson(
  app,
  new URL('./syncular.codegen.json', import.meta.url)
);
