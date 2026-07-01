import { describe, expect, it } from 'bun:test';
import {
  hasCommandProofEvidence,
  missingCommandProofEvidence,
  requireCommandProofEvidence,
  requireCompleteCommandProof,
  SYNCULAR_COMMAND_PROOF_EVIDENCE_KEYS,
} from './command-proof';

describe('command proof assertions', () => {
  const completeProof = {
    outboxPersisted: true,
    requestCorrelated: true,
    syncAttemptObserved: true,
    serverCommitObserved: true,
    realtimeCursorObserved: true,
    pullReasonObserved: true,
    localApplyObserved: true,
    localVisibilityObserved: true,
    complete: true,
  };

  it('accepts complete command proof summaries', () => {
    expect(missingCommandProofEvidence(completeProof)).toEqual([]);
    expect(hasCommandProofEvidence(completeProof)).toBe(true);
    expect(requireCompleteCommandProof(completeProof)).toBe(completeProof);
  });

  it('supports subset assertions for partial E2E proofs', () => {
    const partialProof = {
      ...completeProof,
      complete: false,
      localVisibilityObserved: false,
    };

    expect(
      hasCommandProofEvidence(partialProof, [
        'outboxPersisted',
        'requestCorrelated',
        'realtimeCursorObserved',
      ])
    ).toBe(true);
    expect(
      requireCommandProofEvidence(partialProof, [
        'outboxPersisted',
        'realtimeCursorObserved',
      ])
    ).toBe(partialProof);
    expect(missingCommandProofEvidence(partialProof)).toEqual([
      'localVisibilityObserved',
    ]);
  });

  it('throws actionable assertion failures', () => {
    expect(() =>
      requireCommandProofEvidence(
        { outboxPersisted: true, requestCorrelated: false },
        ['outboxPersisted', 'requestCorrelated', 'realtimeCursorObserved']
      )
    ).toThrow(
      'Expected Syncular command proof evidence [outboxPersisted, requestCorrelated, realtimeCursorObserved] but missing: requestCorrelated, realtimeCursorObserved'
    );
    expect(() =>
      requireCompleteCommandProof({
        ...completeProof,
        realtimeCursorObserved: false,
      })
    ).toThrow('missing: realtimeCursorObserved');
  });

  it('exports the canonical evidence key order', () => {
    expect(SYNCULAR_COMMAND_PROOF_EVIDENCE_KEYS).toEqual([
      'outboxPersisted',
      'requestCorrelated',
      'syncAttemptObserved',
      'serverCommitObserved',
      'realtimeCursorObserved',
      'pullReasonObserved',
      'localApplyObserved',
      'localVisibilityObserved',
    ]);
  });
});
