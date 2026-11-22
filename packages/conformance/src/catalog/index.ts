/**
 * The conformance catalog: breadth of the protocol gate
 * within skeleton scope. Every scenario carries its SPEC.md refs;
 * fine-grained permutations live in package-local tests, not here.
 */
import type { Scenario } from '../scenario';
import { backupRestoreScenarios } from './backup-restore';
import { blobScenarios } from './blobs';
import { bootstrapScenarios } from './bootstrap';
import { commitValidatorScenarios } from './commit-validators';
import { conflictScenarios } from './conflict';
import { convergenceScenarios } from './convergence';
import { crdtScenarios } from './crdt';
import { encryptionScenarios } from './encryption';
import { erasureScenarios } from './erasure';
import { errorScenarios } from './errors';
import { leaseScenarios } from './leases';
import { authorityScenarios } from './authority';
import { replaceScenarios } from './replace';
import { lifecycleScenarios } from './lifecycle';
import { localProjectionScenarios } from './local-projections';
import { localAuthorityScenarios } from './local-authority';
import { observationScenarios } from './observation';
import { offlineScenarios } from './offline';
import { deletePrecedenceScenarios } from './delete-precedence';
import { presenceScenarios } from './presence';
import { previousVersionScenarios } from './previous-version';
import { realtimeScenarios } from './realtime';
import { remoteProducerScenarios } from './remote-producer';
import { reconnectStormScenarios } from './reconnect-storm';
import { referenceScenarios } from './references';
import { roundFailureScenarios } from './round-failure';
import { sparseRowScenarios } from './sparse-rows';
import { schemaBumpScenarios } from './schema-bump';
import { scopeScenarios } from './scopes';
import { serverColumnScenarios } from './server-columns';
import { signedUrlScenarios } from './signed-url';
import { sqliteImageScenarios } from './sqlite-image';
import { unitScenarios } from './units';
import { validatorScenarios } from './validators';
import { vectorScenarios } from './vectors';
import { watermarkScenarios } from './watermark';
import { windowScenarios } from './window';
import { wsRoundScenarios } from './ws-rounds';

export const CATALOG: readonly Scenario[] = [
  ...backupRestoreScenarios,
  ...convergenceScenarios,
  ...offlineScenarios,
  ...observationScenarios,
  ...conflictScenarios,
  ...scopeScenarios,
  ...unitScenarios,
  ...bootstrapScenarios,
  ...sqliteImageScenarios,
  ...signedUrlScenarios,
  ...blobScenarios,
  ...crdtScenarios,
  ...encryptionScenarios,
  ...leaseScenarios,
  ...erasureScenarios,
  ...lifecycleScenarios,
  ...authorityScenarios,
  ...replaceScenarios,
  ...schemaBumpScenarios,
  ...previousVersionScenarios,
  ...realtimeScenarios,
  ...remoteProducerScenarios,
  ...wsRoundScenarios,
  ...presenceScenarios,
  ...reconnectStormScenarios,
  ...referenceScenarios,
  ...localAuthorityScenarios,
  ...localProjectionScenarios,
  ...roundFailureScenarios,
  ...deletePrecedenceScenarios,
  ...watermarkScenarios,
  ...sparseRowScenarios,
  ...windowScenarios,
  ...validatorScenarios,
  ...commitValidatorScenarios,
  ...serverColumnScenarios,
  ...errorScenarios,
  ...vectorScenarios,
];
