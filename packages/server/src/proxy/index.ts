/**
 * @syncular/server - Proxy Exports
 *
 * Server-side proxy functionality for database access.
 */

// Oplog creation
// Collections
export {
  createProxyHandlerCollection,
  getProxyHandler,
  getProxyHandlerOrThrow,
  type ProxyHandlerCollection,
} from './collection';
// Query execution
export {
  type ExecuteProxyQueryArgs,
  type ExecuteProxyQueryResult,
  executeProxyQuery,
} from './handler';
// Mutation detection
export { type DetectedMutation, detectMutation } from './mutation-detector';
// Types
