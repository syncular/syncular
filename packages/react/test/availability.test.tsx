import { afterEach, describe, expect, test } from 'bun:test';
import {
  ClientSyncError,
  classifySyncAvailability,
  type SchemaFloor,
} from '@syncular/client';
import { act, render, waitFor } from '@testing-library/react';
import {
  createSyncClientResource,
  SyncProvider,
  useRawSql,
} from '../src/index';
import { FakeClient } from './fake-client';
import { installHappyDom } from './setup';

installHappyDom();

afterEach(() => {
  document.body.innerHTML = '';
});

function status(
  currentSchemaVersion: number,
  schemaFloor?: SchemaFloor,
  upgrading = false,
) {
  return {
    currentSchemaVersion,
    outbox: 0,
    upgrading,
    leaseState: undefined,
    schemaFloor,
    syncNeeded: false,
  } as const;
}

function BoundaryApp(props: { readonly client: FakeClient }) {
  return (
    <SyncProvider
      client={props.client}
      renderBoundary={(state) => (
        <span>
          boundary={state.state}
          {'reason' in state ? `:${state.reason}` : ''}
        </span>
      )}
    >
      <span>application</span>
    </SyncProvider>
  );
}

describe('availability classification', () => {
  test('classifies every ordered schema and leadership state', () => {
    expect(classifySyncAvailability(status(1))).toEqual({ state: 'ready' });
    expect(classifySyncAvailability(status(1, undefined, true))).toEqual({
      state: 'migrating',
      currentSchemaVersion: 1,
    });
    expect(
      classifySyncAvailability(
        status(1, { requiredSchemaVersion: 2, latestSchemaVersion: 3 }),
      ),
    ).toMatchObject({
      state: 'blocked',
      reason: 'client-upgrade-required',
      currentSchemaVersion: 1,
      requiredSchemaVersion: 2,
    });
    expect(
      classifySyncAvailability(
        status(3, { requiredSchemaVersion: 2, latestSchemaVersion: 2 }),
      ),
    ).toMatchObject({
      state: 'blocked',
      reason: 'server-behind',
      currentSchemaVersion: 3,
      latestServerSchemaVersion: 2,
    });
    expect(
      classifySyncAvailability(
        status(2, { requiredSchemaVersion: 1, latestSchemaVersion: 3 }),
      ),
    ).toMatchObject({
      state: 'blocked',
      reason: 'incompatible-schema',
      currentSchemaVersion: 2,
    });
    expect(
      classifySyncAvailability(status(4), {
        state: 'blocked',
        reason: 'leader-unreachable',
        code: 'client.follower_timeout',
        retryable: true,
      }),
    ).toEqual({
      state: 'blocked',
      reason: 'leader-unreachable',
      currentSchemaVersion: 4,
      retryable: true,
    });
  });
});

describe('SyncProvider availability boundary', () => {
  test('covers resource pending and retryable startup errors', async () => {
    let reject!: (error: unknown) => void;
    const pending = new Promise<FakeClient>((_resolve, fail) => {
      reject = fail;
    });
    const resource = createSyncClientResource(() => pending);
    const view = render(
      <SyncProvider
        client={resource}
        renderBoundary={(state, actions) => (
          <span>
            {state.state}
            {state.state === 'startup-error'
              ? `:${state.retryable}:${actions.retry !== undefined}`
              : ''}
          </span>
        )}
      >
        <span>application</span>
      </SyncProvider>,
    );
    expect(view.getByText('starting')).toBeDefined();
    await act(async () =>
      reject(new ClientSyncError('client.storage_busy', 'busy', true)),
    );
    await waitFor(() =>
      expect(view.getByText('startup-error:true:true')).toBeDefined(),
    );
    await resource.dispose();
  });

  for (const item of [
    {
      name: 'migration',
      configure(client: FakeClient) {
        client.setUpgrading(true);
      },
      expected: 'boundary=migrating',
    },
    {
      name: 'client behind',
      configure(client: FakeClient) {
        client.setSchemaFloor({
          requiredSchemaVersion: 2,
          latestSchemaVersion: 3,
        });
      },
      expected: 'boundary=blocked:client-upgrade-required',
    },
    {
      name: 'server behind',
      configure(client: FakeClient) {
        client.setCurrentSchemaVersion(3);
        client.setSchemaFloor({
          requiredSchemaVersion: 2,
          latestSchemaVersion: 2,
        });
      },
      expected: 'boundary=blocked:server-behind',
    },
    {
      name: 'incompatible schema',
      configure(client: FakeClient) {
        client.setCurrentSchemaVersion(2);
        client.setSchemaFloor({
          requiredSchemaVersion: 1,
          latestSchemaVersion: 3,
        });
      },
      expected: 'boundary=blocked:incompatible-schema',
    },
    {
      name: 'unreachable leader',
      configure(client: FakeClient) {
        client.setLeadership({
          state: 'blocked',
          reason: 'leader-unreachable',
          code: 'client.follower_timeout',
          retryable: true,
        });
      },
      expected: 'boundary=blocked:leader-unreachable',
    },
  ]) {
    test(`renders ${item.name}`, async () => {
      const client = new FakeClient();
      item.configure(client);
      const view = render(<BoundaryApp client={client} />);
      await waitFor(() => expect(view.getByText(item.expected)).toBeDefined());
      expect(view.queryByText('application')).toBeNull();
      view.unmount();
    });
  }

  test('automatically restores children when compatibility returns', async () => {
    const client = new FakeClient();
    client.setSchemaFloor({ requiredSchemaVersion: 2 });
    const view = render(<BoundaryApp client={client} />);
    await waitFor(() =>
      expect(
        view.getByText('boundary=blocked:client-upgrade-required'),
      ).toBeDefined(),
    );
    client.setSchemaFloor(undefined);
    act(() => client.emitStatus());
    await waitFor(() => expect(view.getByText('application')).toBeDefined());
  });
});

describe('query availability', () => {
  test('a terminal floor is blocked rather than loading with no rows', async () => {
    const client = new FakeClient();
    client.setSchemaFloor({ requiredSchemaVersion: 2 });
    const view = render(
      <SyncProvider client={client}>
        <QueryState />
      </SyncProvider>,
    );
    await waitFor(() =>
      expect(
        view.getByText('blocked:false:client-upgrade-required:0'),
      ).toBeDefined(),
    );
  });

  test('keeps prior rows while blocked and refreshes after recovery', async () => {
    const client = new FakeClient();
    client.setRows('tasks', [{ id: 't1' }]);
    const view = render(
      <SyncProvider client={client}>
        <QueryState />
      </SyncProvider>,
    );
    await waitFor(() =>
      expect(view.getByText('ready:false:ready:1')).toBeDefined(),
    );

    client.setSchemaFloor({ requiredSchemaVersion: 2 });
    act(() => client.emitStatus());
    await waitFor(() =>
      expect(
        view.getByText('blocked:false:client-upgrade-required:1'),
      ).toBeDefined(),
    );

    client.setSchemaFloor(undefined);
    act(() => client.emitStatus());
    await waitFor(() =>
      expect(view.getByText('ready:false:ready:1')).toBeDefined(),
    );
  });
});

function QueryState() {
  const query = useRawSql('SELECT * FROM tasks');
  return (
    <span>
      {query.phase}:{String(query.isLoading)}:
      {query.availability.state === 'blocked'
        ? query.availability.reason
        : query.availability.state}
      :{query.rows.length}
    </span>
  );
}
