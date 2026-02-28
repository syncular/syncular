/**
 * Fetches historical perf summary artifacts from previous workflow runs.
 *
 * Intended for CI usage before trend analysis.
 */

import path from 'node:path';

interface WorkflowRun {
  id: number;
  conclusion: string | null;
}

interface WorkflowRunsResponse {
  workflow_runs?: WorkflowRun[];
}

interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  archive_download_url: string;
}

interface ArtifactsResponse {
  artifacts?: Artifact[];
}

interface DownloadedHistoryItem {
  runId: number;
  artifactId: number;
  artifactName: string;
  summaryPath: string;
}

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number
): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function apiGet<T>(url: string, token: string): Promise<T | null> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    console.log(`GitHub API request failed: ${response.status} ${url}`);
    return null;
  }

  return (await response.json()) as T;
}

async function downloadArtifact(
  url: string,
  token: string,
  destination: string
): Promise<boolean> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    console.log(`Artifact download failed: ${response.status} ${url}`);
    return false;
  }

  const bytes = await response.arrayBuffer();
  await Bun.write(destination, new Uint8Array(bytes));
  return true;
}

async function main() {
  const token = Bun.env.GITHUB_TOKEN;
  const repository = Bun.env.GITHUB_REPOSITORY;

  if (!token || !repository) {
    console.log(
      'Missing GITHUB_TOKEN or GITHUB_REPOSITORY; skipping perf history fetch.'
    );
    console.log('PERF_HISTORY_COUNT=0');
    return;
  }

  const workflow = Bun.env.PERF_HISTORY_WORKFLOW ?? 'checks.yml';
  const branch = Bun.env.PERF_HISTORY_BRANCH ?? 'main';
  const event = Bun.env.PERF_HISTORY_EVENT ?? 'schedule';
  const artifactPrefix =
    Bun.env.PERF_HISTORY_ARTIFACT_PREFIX ?? 'perf-nightly-';
  const summaryFileName =
    Bun.env.PERF_HISTORY_SUMMARY_FILE ?? 'perf-nightly-summary.json';
  const outputDir = Bun.env.PERF_HISTORY_OUTPUT_DIR ?? 'perf-history';
  const maxFiles = parsePositiveInteger(Bun.env.PERF_HISTORY_MAX_FILES, 8);
  const runPageSize = parsePositiveInteger(
    Bun.env.PERF_HISTORY_RUN_PAGE_SIZE,
    40
  );
  const currentRunId = Number(Bun.env.GITHUB_RUN_ID ?? '0');

  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
  }

  await Bun.$`rm -rf ${outputDir}`;
  await Bun.$`mkdir -p ${outputDir}`;

  const runsUrl =
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/runs` +
    `?branch=${encodeURIComponent(branch)}` +
    `&event=${encodeURIComponent(event)}` +
    '&status=completed' +
    `&per_page=${runPageSize}`;

  const runsResponse = await apiGet<WorkflowRunsResponse>(runsUrl, token);
  const runs = runsResponse?.workflow_runs ?? [];

  const downloaded: DownloadedHistoryItem[] = [];

  for (const run of runs) {
    if (downloaded.length >= maxFiles) break;
    if (!Number.isFinite(run.id) || run.id <= 0) continue;
    if (run.id === currentRunId) continue;

    const artifactsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${run.id}/artifacts?per_page=100`;
    const artifactsResponse = await apiGet<ArtifactsResponse>(
      artifactsUrl,
      token
    );
    const artifacts = artifactsResponse?.artifacts ?? [];

    const artifact = artifacts.find(
      (candidate) =>
        !candidate.expired &&
        (candidate.name === `${artifactPrefix}${run.id}` ||
          candidate.name.startsWith(artifactPrefix))
    );

    if (!artifact) {
      continue;
    }

    const zipPath = path.join(outputDir, `${run.id}.zip`);
    const extractedDir = path.join(outputDir, `${run.id}`);

    const downloadedOk = await downloadArtifact(
      artifact.archive_download_url,
      token,
      zipPath
    );
    if (!downloadedOk) {
      continue;
    }

    await Bun.$`mkdir -p ${extractedDir}`;
    const unzipProc = Bun.spawn(['unzip', '-o', zipPath, '-d', extractedDir], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const unzipCode = await unzipProc.exited;
    if (unzipCode !== 0) {
      const stdout = await new Response(unzipProc.stdout).text();
      const stderr = await new Response(unzipProc.stderr).text();
      console.log(stdout);
      console.log(stderr);
      continue;
    }

    const primarySummaryPath = path.join(extractedDir, summaryFileName);
    const fallbackSummaryPath = path.join(extractedDir, 'perf-summary.json');

    const primaryExists = await Bun.file(primarySummaryPath).exists();
    const fallbackExists = await Bun.file(fallbackSummaryPath).exists();

    const sourceSummaryPath = primaryExists
      ? primarySummaryPath
      : fallbackExists
        ? fallbackSummaryPath
        : null;

    if (!sourceSummaryPath) {
      continue;
    }

    const targetSummaryPath = path.join(outputDir, `${run.id}.json`);
    await Bun.write(targetSummaryPath, Bun.file(sourceSummaryPath));

    downloaded.push({
      runId: run.id,
      artifactId: artifact.id,
      artifactName: artifact.name,
      summaryPath: targetSummaryPath,
    });
  }

  await Bun.write(
    path.join(outputDir, 'index.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        repository,
        workflow,
        branch,
        event,
        artifactPrefix,
        summaryFileName,
        downloaded,
      },
      null,
      2
    )
  );

  console.log(`Fetched ${downloaded.length} historical perf summaries.`);
  console.log(`PERF_HISTORY_COUNT=${downloaded.length}`);
}

void main();
