/**
 * @syncular/server - Proxy Exports
 *
 * Server-side proxy functionality for database access.
 */

// Query execution
export {
  type ExecuteProxyQueryArgs,
  type ExecuteProxyQueryResult,
  executeProxyQuery,
} from './handler';
// Mutation detection
export { type DetectedMutation, detectMutation } from './mutation-detector';
// Oplog creation
// Registry
export { ProxyTableRegistry } from './registry';
// Types
