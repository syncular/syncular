/**
 * @syncular/server - Proxy Exports
 *
 * Server-side proxy functionality for database access.
 */

// Query execution
export {
  type ExecuteProxyQueryResult,
  executeProxyQuery,
} from './handler';
// Mutation detection
export { detectMutation } from './mutation-detector';
// Oplog creation
// Registry
export { ProxyTableRegistry } from './registry';
// Types
