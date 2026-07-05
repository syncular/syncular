/**
 * The transport-fault controller, re-exported from the conformance harness
 * (`@syncular-v2/conformance/faults`) — NOT duplicated. The app test kit
 * arms the SAME fault vocabulary the reference pairing does:
 *
 * - `dropNextRequests` / `dropNextResponses` — lose a request or its ack;
 * - `duplicateNextRequest` — replay a request (idempotency-cache exercise);
 * - `truncateNextResponse` / `truncateNextSegmentDownload` — cut bytes short;
 * - `corrupt()` — flip a seeded byte (§5.1 tamper).
 *
 * The `./faults` subpath keeps this import off the driver/catalog module
 * graph (it needs only the controller + PRNG).
 */
export {
  seededRandom,
  seedFromName,
  TransportFault,
  TransportFaults,
} from '@syncular-v2/conformance/faults';
