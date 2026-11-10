/**
 * The transport-fault controller. The canonical implementation lives in the
 * PUBLIC app test kit (`@syncular/testkit/faults`); the private conformance
 * harness extends it with the faults only its loopback honors (deferred pull
 * sections and the signed-URL hop), so both arm the same base vocabulary.
 */
import { TransportFaults as TestkitTransportFaults } from '@syncular/testkit/faults';

export {
  seededRandom,
  seedFromName,
  TransportFault,
} from '@syncular/testkit/faults';

export class TransportFaults extends TestkitTransportFaults {
  /** Return ACKs while withholding pull sections without advancing their cursors. */
  deferNextPulls = 0;
  /** Fail the next N signed-URL fetches (the CDN hop, §5.4). */
  dropNextUrlFetches = 0;
  /** Corrupt the next signed-URL fetch's bytes (§5.1 tamper). */
  corruptNextUrlFetch = false;
}
