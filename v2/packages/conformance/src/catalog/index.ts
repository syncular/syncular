/**
 * The conformance catalog (REVISE B4): breadth of the v1 gate intent
 * within skeleton scope. Every scenario carries its SPEC.md refs;
 * fine-grained permutations live in package-local tests, not here.
 */
import type { Scenario } from '../scenario';
import { blobScenarios } from './blobs';
import { bootstrapScenarios } from './bootstrap';
import { conflictScenarios } from './conflict';
import { convergenceScenarios } from './convergence';
import { crdtScenarios } from './crdt';
import { errorScenarios } from './errors';
import { lifecycleScenarios } from './lifecycle';
import { offlineScenarios } from './offline';
import { realtimeScenarios } from './realtime';
import { scopeScenarios } from './scopes';
import { signedUrlScenarios } from './signed-url';
import { sqliteImageScenarios } from './sqlite-image';
import { vectorScenarios } from './vectors';
import { wsRoundScenarios } from './ws-rounds';

export const CATALOG: readonly Scenario[] = [
  ...convergenceScenarios,
  ...offlineScenarios,
  ...conflictScenarios,
  ...scopeScenarios,
  ...bootstrapScenarios,
  ...sqliteImageScenarios,
  ...signedUrlScenarios,
  ...blobScenarios,
  ...crdtScenarios,
  ...lifecycleScenarios,
  ...realtimeScenarios,
  ...wsRoundScenarios,
  ...errorScenarios,
  ...vectorScenarios,
];
