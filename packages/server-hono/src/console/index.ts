/**
 * @syncular/server-hono - Console API
 *
 * Provides monitoring and operations endpoints for the @syncular dashboard.
 */

// Re-export types from routes (which exports from schemas)
export type {
  ConsoleAuthResult,
  ConsoleEventEmitter,
} from './routes';
export {
  createConsoleEventEmitter,
  createConsoleRoutes,
  createTokenAuthenticator,
} from './routes';
