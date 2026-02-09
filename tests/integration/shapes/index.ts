/**
 * Barrel export for integration test shapes
 */

export type {
  IntegrationClientDb as ClientDb,
  IntegrationServerDb as ServerDb,
} from '../harness/types';
export { projectsClientHandler } from './projects-client';
export { projectsServerShape } from './projects-server';
export { tasksClientHandler } from './tasks-client';
export { createTasksServerShape } from './tasks-server';
