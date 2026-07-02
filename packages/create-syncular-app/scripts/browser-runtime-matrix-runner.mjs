#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';

const browserTypes = { chromium, firefox, webkit };

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      args.set(key.slice(2), 'true');
      continue;
    }
    args.set(key.slice(2), value);
    index += 1;
  }
  return args;
}

function requiredArg(args, name) {
  const value = args.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function formatBrowserDiagnostic(message, url, lineNumber, columnNumber) {
  const location =
    lineNumber === undefined
      ? ''
      : `:${lineNumber + 1}${columnNumber === undefined ? '' : `:${columnNumber + 1}`}`;
  return url ? `${message} (${url}${location})` : message;
}

function isCanceledRequestFailure(message) {
  return (
    message === 'net::ERR_ABORTED' ||
    message === 'NS_BINDING_ABORTED' ||
    message.toLowerCase().includes('request cancelled') ||
    message.toLowerCase().includes('request canceled')
  );
}

async function writeFailureArtifact(path, artifact) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

async function readMatrixProbe(page, diagnostics) {
  return page.evaluate(
    ({ diagnostics: browserDiagnostics }) => {
      const readTextArray = (element, name) => {
        const value = element?.getAttribute(name) ?? '';
        if (value === '') return [];
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed)
            ? parsed.filter((item) => typeof item === 'string')
            : [];
        } catch {
          return value.split(',').filter(Boolean);
        }
      };
      const readNumber = (element, name) => {
        const value = element?.getAttribute(name) ?? null;
        if (value === null || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : null;
      };
      const text = document.body?.innerText ?? '';
      const deployment = document.querySelector(
        '[data-syncular-deployment-preflight-status]'
      );
      const policy = document.querySelector(
        '[data-syncular-browser-support-policy-status]'
      );
      const supportBundle = document.querySelector(
        '[data-syncular-support-bundle-status]'
      );
      const browserHealth = document.querySelector(
        '[data-syncular-browser-health-status]'
      );
      const commandTimeline = document.querySelector(
        '[data-syncular-command-timeline-proof-status]'
      );
      const starterTimeline = document.querySelector(
        '[data-syncular-starter-bootstrap-status]'
      );
      const lifecycleResume = document.querySelector(
        '[data-syncular-lifecycle-resume-status]'
      );
      const readLifecycleResumeNumber = (name) => {
        const value = lifecycleResume?.getAttribute(name) ?? null;
        if (value === null || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : null;
      };
      const localRecovery = document.querySelector(
        '[data-syncular-local-recovery-proof-status]'
      );
      const storageRecovery = document.querySelector(
        '[data-syncular-storage-recovery-proof-status]'
      );

      const policyReasonCodesText =
        policy?.getAttribute(
          'data-syncular-browser-support-policy-reason-codes'
        ) ?? '';
      const policyReasonCodes =
        policyReasonCodesText === ''
          ? []
          : policyReasonCodesText.split(',').filter(Boolean);
      const durableHealthLine = text.includes('indexedDb durable');
      const memoryStorageHealthLine = text.includes('memory storage');
      const schemaLine = text.includes('schema v');
      const preflightFailure = text.includes(
        'Syncular browser preflight failed'
      );
      const databaseOpening = text.includes('Opening local database');
      const supportBundleStatus =
        supportBundle?.getAttribute(
          'data-syncular-support-bundle-status'
        ) ?? null;
      const supportBundleRedacted =
        supportBundle?.getAttribute(
          'data-syncular-support-bundle-redacted'
        ) ?? null;
      const deploymentStatus =
        deployment?.getAttribute(
          'data-syncular-deployment-preflight-status'
        ) ?? null;
      const policyStatus =
        policy?.getAttribute(
          'data-syncular-browser-support-policy-status'
        ) ?? null;
      const commandTimelineStatus =
        commandTimeline?.getAttribute(
          'data-syncular-command-timeline-proof-status'
        ) ?? null;
      const commandTimelineErrorCode =
        commandTimeline?.getAttribute(
          'data-syncular-command-timeline-proof-error-code'
        ) ?? null;
      const starterCommandTimelineStatus =
        starterTimeline?.getAttribute(
          'data-syncular-starter-command-timeline-status'
        ) ?? null;
      const starterLocalVisibilityStatus =
        starterTimeline?.getAttribute(
          'data-syncular-starter-local-visibility-status'
        ) ?? null;
      const starterLocalVisibilityErrorCode =
        starterTimeline?.getAttribute(
          'data-syncular-starter-local-visibility-error-code'
        ) ?? null;
      const lifecycleResumeStatus =
        lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-status') ??
        null;
      const lifecycleResumeCount =
        readLifecycleResumeNumber('data-syncular-lifecycle-resume-count') ?? 0;
      const lifecycleResumeReason =
        lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-reason') ??
        null;
      const lifecycleResumeError =
        lifecycleResume?.getAttribute('data-syncular-lifecycle-resume-error') ??
        null;
      const lifecycleResumeLockName =
        lifecycleResume?.getAttribute(
          'data-syncular-lifecycle-resume-lock-name'
        ) ?? null;
      const lifecycleResumeLockRequired =
        lifecycleResume?.getAttribute(
          'data-syncular-lifecycle-resume-lock-required'
        ) ?? null;
      const lifecycleResumeLockState =
        lifecycleResume?.getAttribute(
          'data-syncular-lifecycle-resume-lock-state'
        ) ?? null;
      const lifecycleResumeLockTimeoutMs = readLifecycleResumeNumber(
        'data-syncular-lifecycle-resume-lock-timeout-ms'
      );
      const lifecyclePauseCount =
        readLifecycleResumeNumber('data-syncular-lifecycle-pause-count') ?? 0;
      const lifecyclePauseReason =
        lifecycleResume?.getAttribute('data-syncular-lifecycle-pause-reason') ??
        null;
      const lifecyclePausePagehidePersisted =
        lifecycleResume?.getAttribute(
          'data-syncular-lifecycle-pause-pagehide-persisted'
        ) ?? null;
      const lifecyclePauseShutdownSignalCount =
        readLifecycleResumeNumber(
          'data-syncular-lifecycle-pause-shutdown-signal-count'
        ) ?? 0;
      const lifecyclePauseVisibilityState =
        lifecycleResume?.getAttribute(
          'data-syncular-lifecycle-pause-visibility-state'
        ) ?? null;
      const errors = [];
      if (browserDiagnostics.length > 0) {
        errors.push(...browserDiagnostics);
      }
      if (preflightFailure) errors.push('preflight failed');
      if (databaseOpening && text.includes('Error')) {
        errors.push('database open failed');
      }
      if (deploymentStatus === 'failed') {
        errors.push('deployment preflight failed');
      }
      if (deploymentStatus === 'not-ready') {
        errors.push('deployment preflight not ready');
      }
      if (policyStatus === 'not-met') {
        errors.push('browser support policy not met');
      }
      if (supportBundleStatus === 'failed') {
        errors.push('support bundle export failed');
      }
      if (supportBundleStatus !== null && supportBundleRedacted !== 'true') {
        errors.push('support bundle was not redacted');
      }
      if (lifecycleResumeStatus === 'failed') {
        errors.push(
          lifecycleResumeError
            ? `lifecycle resume failed: ${lifecycleResumeError}`
            : 'lifecycle resume failed'
        );
      }
      if (commandTimelineStatus === 'failed') {
        errors.push(
          commandTimelineErrorCode
            ? `command timeline proof failed: ${commandTimelineErrorCode}`
            : 'command timeline proof failed'
        );
      }
      if (starterLocalVisibilityStatus === 'failed') {
        errors.push(
          starterLocalVisibilityErrorCode
            ? `local visibility failed: ${starterLocalVisibilityErrorCode}`
            : 'local visibility failed'
        );
      }

      return {
        ready:
          (durableHealthLine || memoryStorageHealthLine) &&
          schemaLine &&
          deploymentStatus !== null &&
          policyStatus !== null &&
          supportBundleStatus !== null &&
          supportBundleRedacted === 'true' &&
          browserHealth !== null &&
          commandTimeline !== null &&
          starterTimeline !== null &&
          lifecycleResume !== null &&
          localRecovery !== null &&
          storageRecovery !== null &&
          !databaseOpening &&
          !preflightFailure,
        errors,
        markers: {
          databaseOpening,
          durableHealthLine,
          memoryStorageHealthLine,
          preflightFailure,
          schemaLine,
        },
        deploymentPreflight: {
          actionCount: Number(
            deployment?.getAttribute(
              'data-syncular-deployment-preflight-action-count'
            ) ?? 0
          ),
          availableBytes: readNumber(
            deployment,
            'data-syncular-deployment-preflight-available-bytes'
          ),
          displayMode:
            deployment?.getAttribute(
              'data-syncular-deployment-preflight-display-mode'
            ) ?? null,
          installedApp:
            deployment?.getAttribute(
              'data-syncular-deployment-preflight-installed-app'
            ) ?? null,
          issueCount: Number(
            deployment?.getAttribute(
              'data-syncular-deployment-preflight-issue-count'
            ) ?? 0
          ),
          persistence:
            deployment?.getAttribute(
              'data-syncular-deployment-preflight-persistence'
            ) ?? null,
          quotaBytes: readNumber(
            deployment,
            'data-syncular-deployment-preflight-quota-bytes'
          ),
          quotaPressure:
            deployment?.getAttribute(
              'data-syncular-deployment-preflight-quota-pressure'
            ) ?? null,
          serviceWorker:
            deployment?.getAttribute(
              'data-syncular-deployment-preflight-service-worker'
            ) ?? null,
          serviceWorkerControlled:
            deployment?.getAttribute(
              'data-syncular-deployment-preflight-service-worker-controlled'
            ) ?? null,
          status: deploymentStatus,
          supportTier:
            deployment?.getAttribute(
              'data-syncular-deployment-preflight-support-tier'
            ) ?? null,
          usageBytes: readNumber(
            deployment,
            'data-syncular-deployment-preflight-usage-bytes'
          ),
          usageRatio: readNumber(
            deployment,
            'data-syncular-deployment-preflight-usage-ratio'
          ),
        },
        browserSupportPolicy: {
          context:
            policy?.getAttribute(
              'data-syncular-browser-support-policy-context'
            ) ?? null,
          expectedPersistence:
            policy?.getAttribute(
              'data-syncular-browser-support-policy-expected-persistence'
            ) ?? null,
          expectedSupportTier:
            policy?.getAttribute(
              'data-syncular-browser-support-policy-expected-support-tier'
            ) ?? null,
          knownRisks: readTextArray(
            policy,
            'data-syncular-browser-support-policy-known-risks'
          ),
          nextSteps: readTextArray(
            policy,
            'data-syncular-browser-support-policy-next-steps'
          ),
          observedPersistence:
            policy?.getAttribute(
              'data-syncular-browser-support-policy-observed-persistence'
            ) ?? null,
          observedSupportTier:
            policy?.getAttribute(
              'data-syncular-browser-support-policy-observed-support-tier'
            ) ?? null,
          policy:
            policy?.getAttribute(
              'data-syncular-browser-support-policy-policy'
            ) ?? null,
          preflightRequired:
            policy?.getAttribute(
              'data-syncular-browser-support-policy-preflight-required'
            ) ?? null,
          reasonCodes: policyReasonCodes,
          requiredEvidence: readTextArray(
            policy,
            'data-syncular-browser-support-policy-required-evidence'
          ),
          status: policyStatus,
        },
        browserHealth: {
          lifecycleStage:
            browserHealth?.getAttribute(
              'data-syncular-browser-health-lifecycle-stage'
            ) ?? null,
          status:
            browserHealth?.getAttribute(
              'data-syncular-browser-health-status'
            ) ?? null,
        },
        commandTimeline: {
          complete:
            commandTimeline?.getAttribute(
              'data-syncular-command-timeline-proof-complete'
            ) === 'true',
          count: Number(
            commandTimeline?.getAttribute(
              'data-syncular-command-timeline-proof-count'
            ) ?? 0
          ),
          durationMs: readNumber(
            commandTimeline,
            'data-syncular-command-timeline-proof-duration-ms'
          ),
          eventCount: Number(
            commandTimeline?.getAttribute(
              'data-syncular-command-timeline-proof-event-count'
            ) ?? 0
          ),
          localApplyObserved:
            commandTimeline?.getAttribute(
              'data-syncular-command-timeline-proof-local-apply-observed'
            ) === 'true',
          localVisibilityObserved:
            commandTimeline?.getAttribute(
              'data-syncular-command-timeline-proof-local-visibility-observed'
            ) === 'true',
          localVisibilityState:
            commandTimeline?.getAttribute(
              'data-syncular-command-timeline-proof-local-visibility-state'
            ) ?? null,
          missingEvidence: readTextArray(
            commandTimeline,
            'data-syncular-command-timeline-proof-missing-evidence'
          ),
          outboxPersisted:
            commandTimeline?.getAttribute(
              'data-syncular-command-timeline-proof-outbox-persisted'
            ) === 'true',
          status: commandTimelineStatus,
        },
        starterTimeline: {
          commandTimelineStatus: starterCommandTimelineStatus,
          localVisibilityMs: readNumber(
            starterTimeline,
            'data-syncular-starter-local-visibility-ms'
          ),
          localVisibilityStatus: starterLocalVisibilityStatus,
        },
        lifecyclePause: {
          count: lifecyclePauseCount,
          pagehidePersisted: lifecyclePausePagehidePersisted,
          reason: lifecyclePauseReason,
          shutdownSignalCount: lifecyclePauseShutdownSignalCount,
          visibilityState: lifecyclePauseVisibilityState,
        },
        lifecycleResume: {
          count: lifecycleResumeCount,
          error: lifecycleResumeError,
          lockName: lifecycleResumeLockName,
          lockRequired: lifecycleResumeLockRequired,
          lockState: lifecycleResumeLockState,
          lockTimeoutMs: lifecycleResumeLockTimeoutMs,
          reason: lifecycleResumeReason,
          status: lifecycleResumeStatus,
        },
        supportBundle: {
          issueCount: Number(
            supportBundle?.getAttribute(
              'data-syncular-support-bundle-issue-count'
            ) ?? 0
          ),
          redacted: supportBundleRedacted,
          sectionCount: Number(
            supportBundle?.getAttribute(
              'data-syncular-support-bundle-section-count'
            ) ?? 0
          ),
          status: supportBundleStatus,
        },
        textExcerpt: text.slice(0, 4000),
      };
    },
    { diagnostics }
  );
}

async function submitMatrixTask(page, title) {
  await page.evaluate((taskTitle) => {
    const input = document.querySelector('input[aria-label="New task"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Task input not found');
    }
    input.value = taskTitle;
    const form = input.closest('form');
    if (!(form instanceof HTMLFormElement)) {
      throw new Error('Task form not found');
    }
    form.requestSubmit();
  }, title);
}

async function dispatchMatrixLifecycleEvent(page, type) {
  await page.evaluate((eventType) => {
    if (eventType === 'pagehide' || eventType === 'pageshow') {
      let event;
      if (typeof PageTransitionEvent === 'function') {
        event = new PageTransitionEvent(eventType, { persisted: true });
      } else {
        event = new Event(eventType);
        Object.defineProperty(event, 'persisted', { value: true });
      }
      window.dispatchEvent(event);
      return;
    }
    window.dispatchEvent(new Event(eventType));
  }, type);
}

async function waitForMatrixLifecyclePause(args) {
  const deadline = Date.now() + 15_000;
  let lastProbe = null;
  while (Date.now() < deadline) {
    const probe = await readMatrixProbe(args.page, args.diagnostics);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeFailureArtifact(args.failureArtifact, {
        browser: args.browserName,
        generatedAt: new Date().toISOString(),
        metrics: args.metrics,
        probe,
        reason: `${args.browserName}-runtime-matrix-lifecycle-pause-errors`,
        supportContext: args.supportContext,
        url: args.url,
      });
      throw new Error(
        `Built preview ${args.browserName} lifecycle pause proof failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifact}`
      );
    }
    const pagehidePersistedMatches =
      args.expectedPagehidePersisted === undefined ||
      probe.lifecyclePause.pagehidePersisted === args.expectedPagehidePersisted;
    const shutdownSignalMatches =
      args.expectedShutdownSignalCount === undefined ||
      probe.lifecyclePause.shutdownSignalCount >=
        args.expectedShutdownSignalCount;
    if (
      probe.lifecyclePause.count >= args.expectedCount &&
      probe.lifecyclePause.reason === args.expectedReason &&
      pagehidePersistedMatches &&
      shutdownSignalMatches
    ) {
      return probe;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await writeFailureArtifact(args.failureArtifact, {
    browser: args.browserName,
    generatedAt: new Date().toISOString(),
    metrics: args.metrics,
    probe: lastProbe,
    reason: `${args.browserName}-runtime-matrix-${args.timeoutReason}`,
    supportContext: args.supportContext,
    url: args.url,
  });
  throw new Error(
    `Timed out waiting for built preview ${args.browserName} lifecycle pause (${args.expectedReason}). Failure artifact: ${args.failureArtifact}`
  );
}

async function waitForMatrixLifecycleResume(args) {
  const deadline = Date.now() + 15_000;
  let lastProbe = null;
  while (Date.now() < deadline) {
    const probe = await readMatrixProbe(args.page, args.diagnostics);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeFailureArtifact(args.failureArtifact, {
        browser: args.browserName,
        generatedAt: new Date().toISOString(),
        metrics: args.metrics,
        probe,
        reason: `${args.browserName}-runtime-matrix-lifecycle-resume-errors`,
        supportContext: args.supportContext,
        url: args.url,
      });
      throw new Error(
        `Built preview ${args.browserName} lifecycle resume proof failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifact}`
      );
    }
    if (
      probe.lifecycleResume.status === 'complete' &&
      probe.lifecycleResume.count >= args.expectedCount &&
      probe.lifecycleResume.reason === args.expectedReason
    ) {
      return probe;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await writeFailureArtifact(args.failureArtifact, {
    browser: args.browserName,
    generatedAt: new Date().toISOString(),
    metrics: args.metrics,
    probe: lastProbe,
    reason: `${args.browserName}-runtime-matrix-${args.timeoutReason}`,
    supportContext: args.supportContext,
    url: args.url,
  });
  throw new Error(
    `Timed out waiting for built preview ${args.browserName} lifecycle resume (${args.expectedReason}). Failure artifact: ${args.failureArtifact}`
  );
}

async function proveMatrixLifecycleSignals(args) {
  const initialProbe = await readMatrixProbe(args.page, args.diagnostics);
  const pagehideCount = initialProbe.lifecyclePause.count + 1;
  await dispatchMatrixLifecycleEvent(args.page, 'pagehide');
  await waitForMatrixLifecyclePause({
    ...args,
    expectedCount: pagehideCount,
    expectedPagehidePersisted: 'true',
    expectedReason: 'pagehide',
    timeoutReason: 'lifecycle-pagehide-timeout',
  });

  const pageshowCount = initialProbe.lifecycleResume.count + 1;
  await dispatchMatrixLifecycleEvent(args.page, 'pageshow');
  await waitForMatrixLifecycleResume({
    ...args,
    expectedCount: pageshowCount,
    expectedReason: 'pageshow',
    timeoutReason: 'lifecycle-pageshow-timeout',
  });

  await dispatchMatrixLifecycleEvent(args.page, 'online');
  await waitForMatrixLifecycleResume({
    ...args,
    expectedCount: pageshowCount + 1,
    expectedReason: 'online',
    timeoutReason: 'lifecycle-online-timeout',
  });

  const freezeCount = pagehideCount + 1;
  await dispatchMatrixLifecycleEvent(args.page, 'freeze');
  await waitForMatrixLifecyclePause({
    ...args,
    expectedCount: freezeCount,
    expectedReason: 'freeze',
    timeoutReason: 'lifecycle-freeze-timeout',
  });

  await dispatchMatrixLifecycleEvent(args.page, 'resume');
  await waitForMatrixLifecycleResume({
    ...args,
    expectedCount: pageshowCount + 2,
    expectedReason: 'resume',
    timeoutReason: 'lifecycle-resume-event-timeout',
  });

  await dispatchMatrixLifecycleEvent(args.page, 'beforeunload');
  return waitForMatrixLifecyclePause({
    ...args,
    expectedCount: freezeCount + 1,
    expectedReason: 'beforeunload',
    expectedShutdownSignalCount:
      initialProbe.lifecyclePause.shutdownSignalCount + 1,
    timeoutReason: 'lifecycle-beforeunload-timeout',
  });
}

async function waitForMatrixLocalWriteProof(args) {
  const deadline = Date.now() + 20_000;
  let lastProbe = null;
  while (Date.now() < deadline) {
    const probe = await readMatrixProbe(args.page, args.diagnostics);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeFailureArtifact(args.failureArtifact, {
        browser: args.browserName,
        generatedAt: new Date().toISOString(),
        metrics: args.metrics,
        probe,
        reason: `${args.browserName}-runtime-matrix-local-write-errors`,
        supportContext: args.supportContext,
        title: args.title,
        url: args.url,
      });
      throw new Error(
        `Built preview ${args.browserName} local write proof failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifact}`
      );
    }
    const textHasTitle = probe.textExcerpt.includes(args.title);
    const proof = probe.commandTimeline;
    if (
      textHasTitle &&
      probe.starterTimeline.localVisibilityStatus === 'visible' &&
      probe.starterTimeline.localVisibilityMs !== null &&
      probe.starterTimeline.commandTimelineStatus === 'complete' &&
      proof.status === 'complete' &&
      proof.count >= args.expectedCommandCount &&
      proof.durationMs !== null &&
      proof.eventCount >= 3 &&
      proof.outboxPersisted &&
      proof.localApplyObserved &&
      proof.localVisibilityObserved &&
      proof.localVisibilityState === 'visible' &&
      !proof.missingEvidence.includes('outbox-status') &&
      !proof.missingEvidence.includes('local-apply') &&
      !proof.missingEvidence.includes('local-visibility')
    ) {
      return probe;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await writeFailureArtifact(args.failureArtifact, {
    browser: args.browserName,
    generatedAt: new Date().toISOString(),
    metrics: args.metrics,
    probe: lastProbe,
    reason: `${args.browserName}-runtime-matrix-local-write-timeout`,
    supportContext: args.supportContext,
    title: args.title,
    url: args.url,
  });
  throw new Error(
    `Timed out waiting for built preview ${args.browserName} local write proof. Failure artifact: ${args.failureArtifact}`
  );
}

async function waitForMatrixTaskText(args) {
  const deadline = Date.now() + 20_000;
  let lastProbe = null;
  const proofName = args.proofName ?? 'reload persistence';
  const reasonSuffix = args.reasonSuffix ?? 'reload';
  while (Date.now() < deadline) {
    const probe = await readMatrixProbe(args.page, args.diagnostics);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeFailureArtifact(args.failureArtifact, {
        browser: args.browserName,
        generatedAt: new Date().toISOString(),
        metrics: args.metrics,
        probe,
        reason: `${args.browserName}-runtime-matrix-${reasonSuffix}-errors`,
        supportContext: args.supportContext,
        title: args.title,
        url: args.url,
      });
      throw new Error(
        `Built preview ${args.browserName} ${proofName} proof failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifact}`
      );
    }
    if (probe.ready && probe.textExcerpt.includes(args.title)) {
      return probe;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await writeFailureArtifact(args.failureArtifact, {
    browser: args.browserName,
    generatedAt: new Date().toISOString(),
    metrics: args.metrics,
    probe: lastProbe,
    reason: `${args.browserName}-runtime-matrix-${reasonSuffix}-timeout`,
    supportContext: args.supportContext,
    title: args.title,
    url: args.url,
  });
  throw new Error(
    `Timed out waiting for built preview ${args.browserName} ${proofName} proof. Failure artifact: ${args.failureArtifact}`
  );
}

async function waitForMatrixEvidence(args) {
  const deadline = Date.now() + 60_000;
  let lastProbe = null;
  while (Date.now() < deadline) {
    const probe = await readMatrixProbe(args.page, args.diagnostics);
    lastProbe = probe;
    if (probe.errors.length > 0) {
      await writeFailureArtifact(args.failureArtifact, {
        browser: args.browserName,
        generatedAt: new Date().toISOString(),
        metrics: args.metrics,
        probe,
        reason: `${args.browserName}-runtime-matrix-errors`,
        supportContext: args.supportContext,
        url: args.url,
      });
      throw new Error(
        `Built preview ${args.browserName} runtime matrix failed: ${probe.errors.join(
          ', '
        )}. Failure artifact: ${args.failureArtifact}`
      );
    }
    if (
      probe.ready &&
      ['ready', 'warning'].includes(probe.deploymentPreflight.status) &&
      probe.deploymentPreflight.supportTier !== null &&
      probe.browserSupportPolicy.context === args.supportContext &&
      probe.browserSupportPolicy.expectedSupportTier === 'unknown' &&
      probe.browserSupportPolicy.expectedPersistence === 'unknown' &&
      probe.browserSupportPolicy.policy === 'preflight-required' &&
      probe.browserSupportPolicy.status === 'warning' &&
      probe.browserSupportPolicy.reasonCodes.includes(
        'browser_support.target_evidence_required'
      )
    ) {
      return probe;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await writeFailureArtifact(args.failureArtifact, {
    browser: args.browserName,
    generatedAt: new Date().toISOString(),
    metrics: args.metrics,
    probe: lastProbe,
    reason: `${args.browserName}-runtime-matrix-timeout`,
    supportContext: args.supportContext,
    url: args.url,
  });
  throw new Error(
    `Timed out waiting for built preview ${args.browserName} runtime matrix evidence. Failure artifact: ${args.failureArtifact}`
  );
}

function attachPageDiagnostics(page, browserName, recordDiagnostic) {
  page.on('console', (message) => {
    const text = message.text();
    if (text.includes('[syncular-starter]')) {
      console.log(
        `[csa-smoke] ${browserName} console ${message.type()}: ${text}`
      );
    }
    if (message.type() === 'error') {
      recordDiagnostic(formatBrowserDiagnostic(text));
    }
  });
  page.on('pageerror', (error) => {
    recordDiagnostic(formatBrowserDiagnostic(error.message));
  });
  page.on('requestfailed', (request) => {
    const resourceType = request.resourceType();
    const errorText = request.failure()?.errorText ?? 'Browser request failed';
    if (isCanceledRequestFailure(errorText)) {
      return;
    }
    if (
      resourceType !== 'document' &&
      resourceType !== 'fetch' &&
      resourceType !== 'script' &&
      resourceType !== 'worker' &&
      resourceType !== 'xhr'
    ) {
      return;
    }
    recordDiagnostic(formatBrowserDiagnostic(errorText, request.url()));
  });
}

async function openPersistentMatrixContext(browserType, profileDir) {
  return browserType.launchPersistentContext(profileDir, { headless: true });
}

async function openMatrixPage(context, browserName, recordDiagnostic) {
  const page = context.pages()[0] ?? (await context.newPage());
  attachPageDiagnostics(page, browserName, recordDiagnostic);
  return page;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const browserName = requiredArg(args, 'browser');
  const browserType = browserTypes[browserName];
  if (!browserType) {
    throw new Error(`Unsupported Playwright browser: ${browserName}`);
  }
  const url = requiredArg(args, 'url');
  const supportContext = requiredArg(args, 'support-context');
  const failureArtifact = requiredArg(args, 'failure-artifact');
  const metricsJson = args.get('metrics-json') ?? '{}';
  const metrics = JSON.parse(metricsJson);
  const diagnostics = [];
  const profileDir = join(
    dirname(failureArtifact),
    `${browserName}-runtime-matrix-profile`
  );
  let context = null;
  let page = null;
  const recordDiagnostic = (message) => {
    diagnostics.push(message);
    while (diagnostics.length > 20) diagnostics.shift();
  };

  try {
    await rm(profileDir, { force: true, recursive: true });
    await mkdir(profileDir, { recursive: true });
    context = await openPersistentMatrixContext(browserType, profileDir);
    page = await openMatrixPage(context, browserName, recordDiagnostic);
    await page.goto(url, { timeout: 60_000, waitUntil: 'load' });
    const probe = await waitForMatrixEvidence({
      browserName,
      diagnostics,
      failureArtifact,
      metrics,
      page,
      supportContext,
      url,
    });
    const lifecycleProbe = await proveMatrixLifecycleSignals({
      browserName,
      diagnostics,
      failureArtifact,
      metrics,
      page,
      supportContext,
      url,
    });
    const title = `${browserName} matrix local write ${Date.now()}`;
    await submitMatrixTask(page, title);
    const writeProbe = await waitForMatrixLocalWriteProof({
      browserName,
      diagnostics,
      expectedCommandCount: probe.commandTimeline.count + 1,
      failureArtifact,
      metrics,
      page,
      supportContext,
      title,
      url,
    });
    await page.reload({ timeout: 60_000, waitUntil: 'load' });
    await waitForMatrixEvidence({
      browserName,
      diagnostics,
      failureArtifact,
      metrics,
      page,
      supportContext,
      url,
    });
    await waitForMatrixTaskText({
      browserName,
      diagnostics,
      failureArtifact,
      metrics,
      page,
      supportContext,
      title,
      url,
    });
    await page.close();
    page = await context.newPage();
    attachPageDiagnostics(page, browserName, recordDiagnostic);
    await page.goto(url, { timeout: 60_000, waitUntil: 'load' });
    await waitForMatrixEvidence({
      browserName,
      diagnostics,
      failureArtifact,
      metrics,
      page,
      supportContext,
      url,
    });
    await waitForMatrixTaskText({
      browserName,
      diagnostics,
      failureArtifact,
      metrics,
      page,
      proofName: 'same-context reopen persistence',
      reasonSuffix: 'same-context-reopen',
      supportContext,
      title,
      url,
    });
    await context.close();
    context = await openPersistentMatrixContext(browserType, profileDir);
    page = await openMatrixPage(context, browserName, recordDiagnostic);
    await page.goto(url, { timeout: 60_000, waitUntil: 'load' });
    await waitForMatrixEvidence({
      browserName,
      diagnostics,
      failureArtifact,
      metrics,
      page,
      supportContext,
      url,
    });
    await waitForMatrixTaskText({
      browserName,
      diagnostics,
      failureArtifact,
      metrics,
      page,
      proofName: 'persistent-profile reopen persistence',
      reasonSuffix: 'persistent-profile-reopen',
      supportContext,
      title,
      url,
    });
    console.log(
      `[csa-smoke] ${browserName} runtime matrix evidence passed: context=${probe.browserSupportPolicy.context} tier=${probe.deploymentPreflight.supportTier} lifecycleResumeCount=${lifecycleProbe.lifecycleResume.count} localWriteCount=${writeProbe.commandTimeline.count} sameContextReopen=passed persistentProfileReopen=passed`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(`Failure artifact: ${failureArtifact}`)) {
      await writeFailureArtifact(failureArtifact, {
        browser: browserName,
        diagnostics,
        error: message,
        generatedAt: new Date().toISOString(),
        metrics,
        reason: `${browserName}-runtime-matrix-runner-error`,
        supportContext,
        url,
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await context?.close().catch(() => undefined);
    await rm(profileDir, { force: true, recursive: true }).catch(
      () => undefined
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
