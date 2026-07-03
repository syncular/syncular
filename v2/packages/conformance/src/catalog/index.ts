/**
 * The conformance catalog (REVISE B4): breadth of the v1 gate intent
 * within skeleton scope. Every scenario carries its SPEC.md refs;
 * fine-grained permutations live in package-local tests, not here.
 */
import type { Scenario } from '../scenario';
import { bootstrapScenarios } from './bootstrap';
import { conflictScenarios } from './conflict';
import { convergenceScenarios } from './convergence';
import { errorScenarios } from './errors';
import { lifecycleScenarios } from './lifecycle';
import { offlineScenarios } from './offline';
import { realtimeScenarios } from './realtime';
import { scopeScenarios } from './scopes';
import { vectorScenarios } from './vectors';

export const CATALOG: readonly Scenario[] = [
  ...convergenceScenarios,
  ...offlineScenarios,
  ...conflictScenarios,
  ...scopeScenarios,
  ...bootstrapScenarios,
  ...lifecycleScenarios,
  ...realtimeScenarios,
  ...errorScenarios,
  ...vectorScenarios,
];
