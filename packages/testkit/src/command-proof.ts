export const SYNCULAR_COMMAND_PROOF_EVIDENCE_KEYS = [
  'outboxPersisted',
  'requestCorrelated',
  'syncAttemptObserved',
  'serverCommitObserved',
  'realtimeCursorObserved',
  'pullReasonObserved',
  'localApplyObserved',
  'localVisibilityObserved',
] as const;

export type SyncularCommandProofEvidenceKey =
  (typeof SYNCULAR_COMMAND_PROOF_EVIDENCE_KEYS)[number];

export type SyncularCommandProofKey =
  | SyncularCommandProofEvidenceKey
  | 'complete';

export type SyncularCommandProofShape = Partial<
  Record<SyncularCommandProofKey, unknown>
>;

export type SyncularCompleteCommandProof = Record<
  SyncularCommandProofKey,
  true
>;

export function missingCommandProofEvidence(
  proof: SyncularCommandProofShape | null | undefined,
  keys: readonly SyncularCommandProofKey[] = SYNCULAR_COMMAND_PROOF_EVIDENCE_KEYS
): SyncularCommandProofKey[] {
  return keys.filter((key) => proof?.[key] !== true);
}

export function hasCommandProofEvidence(
  proof: SyncularCommandProofShape | null | undefined,
  keys: readonly SyncularCommandProofKey[] = SYNCULAR_COMMAND_PROOF_EVIDENCE_KEYS
): boolean {
  return missingCommandProofEvidence(proof, keys).length === 0;
}

export function requireCommandProofEvidence<
  TProof extends SyncularCommandProofShape,
>(
  proof: TProof | null | undefined,
  keys: readonly SyncularCommandProofKey[] = SYNCULAR_COMMAND_PROOF_EVIDENCE_KEYS
): TProof {
  const missing = missingCommandProofEvidence(proof, keys);
  if (proof && missing.length === 0) return proof;
  throw new Error(commandProofFailureMessage(keys, missing));
}

export function requireCompleteCommandProof<
  TProof extends SyncularCommandProofShape,
>(proof: TProof | null | undefined): TProof & SyncularCompleteCommandProof {
  return requireCommandProofEvidence(proof, [
    ...SYNCULAR_COMMAND_PROOF_EVIDENCE_KEYS,
    'complete',
  ]) as TProof & SyncularCompleteCommandProof;
}

function commandProofFailureMessage(
  expected: readonly SyncularCommandProofKey[],
  missing: readonly SyncularCommandProofKey[]
): string {
  return `Expected Syncular command proof evidence [${expected.join(
    ', '
  )}] but missing: ${missing.length > 0 ? missing.join(', ') : 'none'}`;
}
