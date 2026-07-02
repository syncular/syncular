#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
          status:
            commandTimeline?.getAttribute(
              'data-syncular-command-timeline-proof-status'
            ) ?? null,
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
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const recordDiagnostic = (message) => {
    diagnostics.push(message);
    while (diagnostics.length > 20) diagnostics.shift();
  };

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
    if (
      resourceType !== 'document' &&
      resourceType !== 'fetch' &&
      resourceType !== 'script' &&
      resourceType !== 'worker' &&
      resourceType !== 'xhr'
    ) {
      return;
    }
    recordDiagnostic(
      formatBrowserDiagnostic(
        request.failure()?.errorText ?? 'Browser request failed',
        request.url()
      )
    );
  });

  try {
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
    console.log(
      `[csa-smoke] ${browserName} runtime matrix evidence passed: context=${probe.browserSupportPolicy.context} tier=${probe.deploymentPreflight.supportTier}`
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
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
