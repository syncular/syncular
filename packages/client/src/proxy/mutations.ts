/**
 * @syncular/client - Proxy mutations
 *
 * Exposes the same Proxy-based mutation interface as the offline client,
 * but pushes commits to the server immediately (no local outbox/db writes).
 */

import {
  createPushMutations,
  type MutationsApi,
  type PushCommitConfig,
} from '../mutations';

export function createProxyMutations<DB extends Record<string, any>>(
  config: PushCommitConfig
): MutationsApi<DB, undefined> {
  return createPushMutations(config);
}
