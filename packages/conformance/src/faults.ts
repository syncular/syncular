/**
 * The transport-fault controller — canonical implementation lives in the
 * PUBLIC app test kit (`@syncular/testkit/faults`); the private conformance
 * harness re-exports it so both arm the SAME fault vocabulary (one
 * implementation, publishable dependency direction).
 */
export {
  seededRandom,
  seedFromName,
  TransportFault,
  TransportFaults,
} from '@syncular/testkit/faults';
