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
import { encryptionScenarios } from './encryption';
import { errorScenarios } from './errors';
import { leaseScenarios } from './leases';
import { lifecycleScenarios } from './lifecycle';
import { observationScenarios } from './observation';
import { offlineScenarios } from './offline';
import { presenceScenarios } from './presence';
import { realtimeScenarios } from './realtime';
import { reconnectStormScenarios } from './reconnect-storm';
import { schemaBumpScenarios } from './schema-bump';
import { scopeScenarios } from './scopes';
import { signedUrlScenarios } from './signed-url';
import { sqliteImageScenarios } from './sqlite-image';
import { validatorScenarios } from './validators';
import { vectorScenarios } from './vectors';
import { windowScenarios } from './window';
import { wsRoundScenarios } from './ws-rounds';

export const CATALOG: readonly Scenario[] = [
  ...convergenceScenarios,
  ...offlineScenarios,
  ...observationScenarios,
  ...conflictScenarios,
  ...scopeScenarios,
  ...bootstrapScenarios,
  ...sqliteImageScenarios,
  ...signedUrlScenarios,
  ...blobScenarios,
  ...crdtScenarios,
  ...encryptionScenarios,
  ...leaseScenarios,
  ...lifecycleScenarios,
  ...schemaBumpScenarios,
  ...realtimeScenarios,
  ...wsRoundScenarios,
  ...presenceScenarios,
  ...reconnectStormScenarios,
  ...windowScenarios,
  ...validatorScenarios,
  ...errorScenarios,
  ...vectorScenarios,
];
