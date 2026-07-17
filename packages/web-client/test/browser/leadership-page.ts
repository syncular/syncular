import {
  type CrossTabChannel,
  createSyncClientHandle,
  type LeadershipState,
} from '../../src/index';

const params = new URLSearchParams(location.search);
const suite = params.get('suite') ?? 'manual';
const instance = params.get('instance') ?? crypto.randomUUID();
const lockName = params.get('lock') ?? `browser-${suite}`;
const partition = params.get('partition');
const replicaId = params.get('replica');
const embeds = params.get('embed');

document.body.innerHTML = `
  <main>
    <h1>Syncular browser leadership fixture</h1>
    <output data-testid="state">starting</output>
    <output data-testid="call"></output>
    <output data-testid="embed-state"></output>
  </main>
`;

function requiredOutput(testId: string): HTMLOutputElement {
  const output = document.querySelector<HTMLOutputElement>(
    `[data-testid="${testId}"]`,
  );
  if (output === null) throw new Error(`fixture output ${testId} missing`);
  return output;
}

const stateOutput = requiredOutput('state');
const callOutput = requiredOutput('call');
const embedOutput = requiredOutput('embed-state');

function renderLeadership(state: LeadershipState): void {
  stateOutput.value = JSON.stringify({
    instance,
    role: state.state,
    ...state,
  });
  parent.postMessage(
    { kind: 'syncular-fixture-state', instance, state },
    location.origin,
  );
}

const channelFactory =
  partition === null
    ? undefined
    : (name: string): CrossTabChannel =>
        new BroadcastChannel(
          `${name}:partition:${partition}`,
        ) as unknown as CrossTabChannel;

const handle = await createSyncClientHandle({
  worker: () => {
    void fetch(
      `/opened?suite=${encodeURIComponent(suite)}&instance=${encodeURIComponent(instance)}`,
      { method: 'POST', keepalive: true },
    );
    return new Worker('/leadership-worker.js', { type: 'module' });
  },
  schema: { version: 1, tables: [] },
  database: { mode: 'persistent', name: `fixture-${suite}` },
  endpoints: { syncUrl: '/unused', segmentsUrl: '/unused' },
  autoSync: false,
  lockName,
  ...(replicaId === null
    ? {}
    : { replica: { mode: 'isolated' as const, id: replicaId } }),
  ...(channelFactory === undefined ? {} : { channelFactory }),
  followerCallTimeoutMs: 180,
  onLeadershipChange: renderLeadership,
});

renderLeadership(handle.leadership);
(window as Window & { syncularHandle?: typeof handle }).syncularHandle = handle;

if (handle.leadership.state === 'blocked') {
  const started = Date.now();
  try {
    await handle.query('SELECT 1');
    callOutput.value = 'unexpected-success';
  } catch (error) {
    callOutput.value = JSON.stringify({
      code:
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'unknown',
      elapsedMs: Date.now() - started,
    });
  }
}

if (embeds !== null) {
  window.addEventListener('message', (event) => {
    if (
      event.origin === location.origin &&
      typeof event.data === 'object' &&
      event.data !== null &&
      event.data.kind === 'syncular-fixture-state'
    ) {
      embedOutput.value = JSON.stringify(event.data);
    }
  });
  const iframe = document.createElement('iframe');
  iframe.title = 'isolated preview';
  iframe.src = `/?suite=${encodeURIComponent(suite)}&instance=preview&lock=${encodeURIComponent(lockName)}&replica=${encodeURIComponent(embeds)}`;
  document.body.append(iframe);
}

window.addEventListener('pagehide', () => {
  void handle.close();
});
