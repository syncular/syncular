import type { PreferenceRow } from '@syncular/ui';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  ConnectionForm,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  PreferencesPanel,
  SectionCard,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ToggleGroup,
  ToggleGroupItem,
} from '@syncular/ui';
import { useEffect, useState } from 'react';
import { useConnection } from '../hooks/ConnectionContext';
import {
  useApiKeys,
  useCreateApiKeyMutation,
  useRevokeApiKeyMutation,
  useRotateApiKeyMutation,
} from '../hooks/useConsoleApi';
import {
  PAGE_SIZE_OPTIONS,
  REFRESH_INTERVAL_OPTIONS,
  usePreferences,
} from '../hooks/usePreferences';
import {
  DEFAULT_DEMO_CONSOLE_TOKEN,
  getDefaultDemoConnectionConfig,
} from '../lib/default-connection';

export function Config() {
  return (
    <div className="space-y-4 px-5 py-5">
      <ConnectionTab />
      <ApiKeysTab />
      <PreferencesTab />
    </div>
  );
}

function ConnectionTab() {
  const { config, disconnect, isConnected, error } = useConnection();

  const defaultServerUrl =
    getDefaultDemoConnectionConfig()?.serverUrl ?? 'http://localhost:3001/api';
  const defaultToken = DEFAULT_DEMO_CONSOLE_TOKEN;

  const [serverUrl, setServerUrl] = useState(
    config?.serverUrl ?? defaultServerUrl
  );
  const [token, setToken] = useState(config?.token ?? defaultToken);
  const [testLatency, setTestLatency] = useState<number | null>(null);
  const [_isTesting, setIsTesting] = useState(false);

  useEffect(() => {
    if (config?.serverUrl) {
      setServerUrl(config.serverUrl);
    }
    if (config?.token) {
      setToken(config.token);
    }
  }, [config?.serverUrl, config?.token]);

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestLatency(null);
    const start = performance.now();

    try {
      const response = await fetch(`${serverUrl}/console/stats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error('Failed to connect');
      }
      setTestLatency(Math.round(performance.now() - start));
    } catch {
      setTestLatency(-1);
    } finally {
      setIsTesting(false);
    }
  };

  const statusMessage =
    error ??
    (testLatency !== null
      ? testLatency < 0
        ? 'Connection failed'
        : `Connection successful (${testLatency}ms latency)`
      : undefined);

  return (
    <ConnectionForm
      isConnected={isConnected}
      serverUrl={serverUrl}
      onServerUrlChange={setServerUrl}
      consoleToken={token}
      onConsoleTokenChange={setToken}
      onDisconnect={disconnect}
      onTestConnection={handleTestConnection}
      statusMessage={statusMessage}
    />
  );
}

function ApiKeysTab() {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyType, setNewKeyType] = useState<'relay' | 'proxy' | 'admin'>(
    'relay'
  );
  const [newKeyActorId, setNewKeyActorId] = useState('');
  const [newKeyScopeKeys, setNewKeyScopeKeys] = useState('');
  const [createdSecretKey, setCreatedSecretKey] = useState<string | null>(null);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);
  const [rotatingKeyId, setRotatingKeyId] = useState<string | null>(null);
  const [rotatedSecretKey, setRotatedSecretKey] = useState<string | null>(null);

  const { data, isLoading, error } = useApiKeys();
  const createMutation = useCreateApiKeyMutation();
  const revokeMutation = useRevokeApiKeyMutation();
  const rotateMutation = useRotateApiKeyMutation();

  const handleCreate = async () => {
    try {
      const result = await createMutation.mutateAsync({
        name: newKeyName,
        keyType: newKeyType,
        actorId: newKeyActorId || undefined,
        scopeKeys: newKeyScopeKeys
          ? newKeyScopeKeys.split(',').map((scope) => scope.trim())
          : undefined,
      });
      setCreatedSecretKey(result.secretKey);
      setNewKeyName('');
      setNewKeyActorId('');
      setNewKeyScopeKeys('');
    } catch {
      // handled by mutation state
    }
  };

  const handleCopyKey = (key: string) => {
    navigator.clipboard.writeText(key);
    setCopiedKeyId(key);
    setTimeout(() => setCopiedKeyId(null), 2000);
  };

  const handleRevoke = async () => {
    if (!revokingKeyId) return;
    try {
      await revokeMutation.mutateAsync(revokingKeyId);
    } finally {
      setRevokingKeyId(null);
    }
  };

  const handleRotate = async () => {
    if (!rotatingKeyId) return;
    try {
      const result = await rotateMutation.mutateAsync(rotatingKeyId);
      setRotatedSecretKey(result.secretKey);
    } finally {
      setRotatingKeyId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-[200px] items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-[200px] items-center justify-center">
        <p className="text-danger">Failed to load API keys: {error.message}</p>
      </div>
    );
  }

  return (
    <>
      <SectionCard
        title="API Keys"
        description="Issue, rotate, and revoke console access keys."
        actions={
          <Button size="sm" onClick={() => setShowCreateDialog(true)}>
            Create Key
          </Button>
        }
      >
        {data?.items.length === 0 ? (
          <EmptyState message="No API keys yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>NAME</TableHead>
                <TableHead>TYPE</TableHead>
                <TableHead>KEY PREFIX</TableHead>
                <TableHead>CREATED</TableHead>
                <TableHead>ACTIONS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.items ?? []).map((apiKey) => (
                <TableRow key={apiKey.keyId}>
                  <TableCell className="font-medium">{apiKey.name}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        apiKey.keyType === 'admin'
                          ? 'flow'
                          : apiKey.keyType === 'proxy'
                            ? 'ghost'
                            : 'relay'
                      }
                    >
                      {apiKey.keyType}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-[11px]">
                      {apiKey.keyPrefix}...
                    </code>
                  </TableCell>
                  <TableCell className="text-neutral-500">
                    {new Date(apiKey.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => setRotatingKeyId(apiKey.keyId)}
                      >
                        Rotate
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setRevokingKeyId(apiKey.keyId)}
                      >
                        Revoke
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {/* Create API Key Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API Key</DialogTitle>
          </DialogHeader>

          {createdSecretKey ? (
            <SecretKeyReveal
              copiedKeyId={copiedKeyId}
              onClose={() => {
                setCreatedSecretKey(null);
                setShowCreateDialog(false);
              }}
              onCopy={handleCopyKey}
              secretKey={createdSecretKey}
              warning="Copy this key now. You will not be able to view it again."
            />
          ) : (
            <div className="px-5 py-4 flex flex-col gap-4">
              <Field>
                <FieldLabel htmlFor="api-key-name">Name</FieldLabel>
                <Input
                  id="api-key-name"
                  placeholder="Backend Relay Key"
                  value={newKeyName}
                  onChange={(event) => setNewKeyName(event.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel>Key type</FieldLabel>
                <ToggleGroup
                  value={[newKeyType]}
                  multiple={false}
                  onValueChange={(nextValues) => {
                    const nextValue = nextValues.find(
                      (value) => typeof value === 'string'
                    );
                    if (
                      nextValue === 'relay' ||
                      nextValue === 'proxy' ||
                      nextValue === 'admin'
                    ) {
                      setNewKeyType(nextValue);
                    }
                  }}
                >
                  <ToggleGroupItem value="relay">relay</ToggleGroupItem>
                  <ToggleGroupItem value="proxy">proxy</ToggleGroupItem>
                  <ToggleGroupItem value="admin">admin</ToggleGroupItem>
                </ToggleGroup>
              </Field>

              <Field>
                <FieldLabel htmlFor="api-key-actor-id">
                  Actor ID (optional)
                </FieldLabel>
                <FieldDescription>
                  Pin this key to a fixed actor ID
                </FieldDescription>
                <Input
                  id="api-key-actor-id"
                  placeholder="actor-123"
                  value={newKeyActorId}
                  onChange={(event) => setNewKeyActorId(event.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="api-key-scope-keys">
                  Scope keys (optional)
                </FieldLabel>
                <FieldDescription>
                  Comma-separated list of allowed scope keys
                </FieldDescription>
                <Input
                  id="api-key-scope-keys"
                  placeholder="scope-a, scope-b"
                  value={newKeyScopeKeys}
                  onChange={(event) => setNewKeyScopeKeys(event.target.value)}
                />
              </Field>

              <DialogFooter>
                <Button
                  variant="default"
                  onClick={() => setShowCreateDialog(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleCreate}
                  disabled={createMutation.isPending || !newKeyName}
                >
                  {createMutation.isPending ? (
                    <>
                      <Spinner size="sm" />
                      Creating...
                    </>
                  ) : (
                    'Create'
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Revoke Confirmation Dialog */}
      <Dialog
        open={revokingKeyId !== null}
        onOpenChange={() => setRevokingKeyId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API Key</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4">
            <Alert variant="destructive">
              <AlertDescription>
                Revoking a key immediately invalidates it for all requests.
              </AlertDescription>
            </Alert>
          </div>
          <DialogFooter>
            <Button variant="default" onClick={() => setRevokingKeyId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRevoke}
              disabled={revokeMutation.isPending}
            >
              {revokeMutation.isPending ? (
                <>
                  <Spinner size="sm" />
                  Revoking...
                </>
              ) : (
                'Revoke'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate Confirmation / Result Dialog */}
      <Dialog
        open={rotatingKeyId !== null || rotatedSecretKey !== null}
        onOpenChange={() => {
          setRotatingKeyId(null);
          setRotatedSecretKey(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate API Key</DialogTitle>
          </DialogHeader>

          {rotatedSecretKey ? (
            <SecretKeyReveal
              copiedKeyId={copiedKeyId}
              onClose={() => setRotatedSecretKey(null)}
              onCopy={handleCopyKey}
              secretKey={rotatedSecretKey}
              warning="The previous key has been invalidated. Store this replacement securely."
            />
          ) : (
            <>
              <div className="px-5 py-4">
                <p className="font-mono text-[10px] text-neutral-500">
                  Rotating a key invalidates the previous secret immediately.
                </p>
              </div>
              <DialogFooter>
                <Button
                  variant="default"
                  onClick={() => setRotatingKeyId(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleRotate}
                  disabled={rotateMutation.isPending}
                >
                  {rotateMutation.isPending ? (
                    <>
                      <Spinner size="sm" />
                      Rotating...
                    </>
                  ) : (
                    'Rotate'
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function PreferencesTab() {
  const { preferences, updatePreference, resetPreferences } = usePreferences();

  const rows: PreferenceRow[] = [
    {
      type: 'filter',
      label: 'Auto-refresh interval',
      options: REFRESH_INTERVAL_OPTIONS.map((o) => ({
        id: `${o.value}`,
        label: o.label,
      })),
      activeId: `${preferences.refreshInterval}`,
      onActiveChange: (id) =>
        updatePreference('refreshInterval', Number.parseInt(id, 10)),
    },
    {
      type: 'filter',
      label: 'Items per page',
      options: PAGE_SIZE_OPTIONS.map((o) => ({
        id: `${o.value}`,
        label: o.label,
      })),
      activeId: `${preferences.pageSize}`,
      onActiveChange: (id) =>
        updatePreference('pageSize', Number.parseInt(id, 10)),
    },
    {
      type: 'filter',
      label: 'Time format',
      options: [
        { id: 'relative', label: 'Relative' },
        { id: 'absolute', label: 'Absolute' },
      ],
      activeId: preferences.timeFormat,
      onActiveChange: (id) =>
        updatePreference('timeFormat', id as 'relative' | 'absolute'),
    },
    {
      type: 'toggle',
      label: 'Show sparklines',
      description: 'Display mini trend charts in dashboard metric cards',
      checked: preferences.showSparklines,
      onCheckedChange: (checked) => updatePreference('showSparklines', checked),
    },
  ];

  return <PreferencesPanel rows={rows} onResetDefaults={resetPreferences} />;
}

interface SecretKeyRevealProps {
  copiedKeyId: string | null;
  onClose: () => void;
  onCopy: (key: string) => void;
  secretKey: string;
  warning: string;
}

function SecretKeyReveal({
  copiedKeyId,
  onClose,
  onCopy,
  secretKey,
  warning,
}: SecretKeyRevealProps) {
  return (
    <div className="px-5 py-4 flex flex-col gap-4">
      <Alert variant="destructive">
        <AlertDescription>{warning}</AlertDescription>
      </Alert>

      <div className="flex items-center gap-2">
        <code className="flex-1 rounded-md border border-border bg-surface p-3 font-mono text-[11px] text-white break-all">
          {secretKey}
        </code>
        <Button variant="default" size="sm" onClick={() => onCopy(secretKey)}>
          {copiedKeyId === secretKey ? 'Copied' : 'Copy'}
        </Button>
      </div>

      <DialogFooter>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}
