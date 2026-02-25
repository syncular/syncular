import type { PreferenceRow } from '@syncular/ui';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Checkbox,
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
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ToggleGroup,
  ToggleGroupItem,
} from '@syncular/ui';
import { useEffect, useMemo, useState } from 'react';
import {
  PAGE_SIZE_OPTIONS,
  REFRESH_INTERVAL_OPTIONS,
  useApiKeys,
  useBulkRevokeApiKeysMutation,
  useCreateApiKeyMutation,
  useLocalStorage,
  usePreferences,
  useRevokeApiKeyMutation,
  useRotateApiKeyMutation,
  useStageRotateApiKeyMutation,
} from '../hooks';
import { useConnection } from '../hooks/ConnectionContext';
import type {
  ConsoleApiKey,
  ConsoleApiKeyBulkRevokeResponse,
} from '../lib/types';

export function Config({ children }: { children?: import('react').ReactNode }) {
  return (
    <div className="space-y-4 px-5 py-5">
      <ConnectionTab />
      <ApiKeysTab />
      <PreferencesTab />
      {children}
    </div>
  );
}

function ConnectionTab() {
  const {
    clearError,
    config,
    connect,
    disconnect,
    error,
    isConnected,
    isConnecting,
  } = useConnection();

  const [serverUrl, setServerUrl] = useState(config?.serverUrl ?? '/api');
  const [token, setToken] = useState(config?.token ?? '');
  const [testLatency, setTestLatency] = useState<number | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [connectMessage, setConnectMessage] = useState<string | null>(null);
  const [clearSavedConfigOnDisconnect, setClearSavedConfigOnDisconnect] =
    useLocalStorage<boolean>('console:disconnect-clear-saved-config', false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlServer = params.get('server');
    let shouldReplaceUrl = false;

    if (urlServer) {
      setServerUrl(urlServer);
      params.delete('server');
      shouldReplaceUrl = true;
    }
    if (params.has('token')) {
      params.delete('token');
      shouldReplaceUrl = true;
    }
    if (shouldReplaceUrl) {
      const nextQuery = params.toString();
      const nextUrl = nextQuery
        ? `${window.location.pathname}?${nextQuery}`
        : window.location.pathname;
      window.history.replaceState({}, '', nextUrl);
    }
  }, []);

  useEffect(() => {
    if (config?.serverUrl) {
      setServerUrl(config.serverUrl);
    }
    if (config?.token) {
      setToken(config.token);
    }
  }, [config?.serverUrl, config?.token]);

  useEffect(() => {
    setConnectMessage(null);
  }, []);

  const handleSaveAndConnect = async () => {
    clearError();
    setTestLatency(null);

    const ok = await connect(
      {
        serverUrl: serverUrl.trim(),
        token: token.trim(),
      },
      { persistOverride: true }
    );

    setConnectMessage(
      ok
        ? 'Connected successfully and configuration saved.'
        : 'Failed to connect with the provided settings.'
    );
  };

  const handleDisconnect = () => {
    disconnect({ clearSavedConfig: clearSavedConfigOnDisconnect });
    if (clearSavedConfigOnDisconnect) {
      setServerUrl('/api');
      setToken('');
    }
    setConnectMessage(
      clearSavedConfigOnDisconnect
        ? 'Disconnected and saved credentials cleared.'
        : 'Disconnected.'
    );
    setTestLatency(null);
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestLatency(null);
    setConnectMessage(null);
    const start = performance.now();

    try {
      const targetServerUrl = serverUrl.trim();
      const targetToken = token.trim();

      if (!targetServerUrl || !targetToken) {
        throw new Error('Missing server URL or token');
      }

      const response = await fetch(`${targetServerUrl}/console/stats`, {
        headers: { Authorization: `Bearer ${targetToken}` },
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
    connectMessage ??
    (testLatency !== null
      ? testLatency < 0
        ? 'Connection failed'
        : `Connection successful (${testLatency}ms latency)`
      : undefined);

  return (
    <ConnectionForm
      isConnected={isConnected}
      isConnecting={isConnecting}
      isTestingConnection={isTesting}
      serverUrl={serverUrl}
      onServerUrlChange={setServerUrl}
      consoleToken={token}
      onConsoleTokenChange={setToken}
      onSaveAndConnect={handleSaveAndConnect}
      onDisconnect={handleDisconnect}
      onTestConnection={handleTestConnection}
      statusMessage={statusMessage}
    >
      <div className="px-5 pb-5 -mt-2">
        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
          <div>
            <p className="font-mono text-[10px] text-neutral-400">
              Clear saved credentials on disconnect
            </p>
            <p className="font-mono text-[9px] text-neutral-500">
              Removes stored server URL and token from this browser.
            </p>
          </div>
          <Switch
            checked={clearSavedConfigOnDisconnect}
            onCheckedChange={setClearSavedConfigOnDisconnect}
          />
        </div>
      </div>
    </ConnectionForm>
  );
}

type ApiKeyTypeFilter = 'all' | 'relay' | 'proxy' | 'admin';
type ApiKeyStatusFilter = 'all' | 'active' | 'revoked' | 'expiring';
type ApiKeyLifecycleStatus = 'active' | 'revoked' | 'expiring' | 'expired';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function parsePositiveInteger(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function formatOptionalDateTime(iso: string | null): string {
  if (!iso) return 'Never';
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return 'Invalid date';
  return new Date(timestamp).toLocaleString();
}

function summarizeScopeKeys(scopeKeys: string[]): string {
  if (scopeKeys.length === 0) return 'all scopes';
  if (scopeKeys.length <= 2) return scopeKeys.join(', ');
  return `${scopeKeys.slice(0, 2).join(', ')} +${scopeKeys.length - 2}`;
}

function getApiKeyLifecycleStatus(
  apiKey: ConsoleApiKey,
  expiringWindowDays: number
): ApiKeyLifecycleStatus {
  if (apiKey.revokedAt) return 'revoked';
  if (!apiKey.expiresAt) return 'active';

  const expiresAtMs = Date.parse(apiKey.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return 'active';

  const nowMs = Date.now();
  if (expiresAtMs <= nowMs) return 'expired';
  if (expiresAtMs <= nowMs + expiringWindowDays * MILLISECONDS_PER_DAY) {
    return 'expiring';
  }
  return 'active';
}

function getApiKeyStatusBadgeVariant(status: ApiKeyLifecycleStatus) {
  if (status === 'revoked') return 'destructive';
  if (status === 'expired') return 'offline';
  if (status === 'expiring') return 'syncing';
  return 'healthy';
}

function ApiKeysTab() {
  const [apiKeyTypeFilter, setApiKeyTypeFilter] =
    useState<ApiKeyTypeFilter>('all');
  const [apiKeyStatusFilter, setApiKeyStatusFilter] =
    useState<ApiKeyStatusFilter>('all');
  const [expiringWithinDaysInput, setExpiringWithinDaysInput] = useState('14');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showBulkRevokeDialog, setShowBulkRevokeDialog] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyType, setNewKeyType] = useState<'relay' | 'proxy' | 'admin'>(
    'relay'
  );
  const [newKeyActorId, setNewKeyActorId] = useState('');
  const [newKeyScopeKeys, setNewKeyScopeKeys] = useState('');
  const [newKeyExpiresInDays, setNewKeyExpiresInDays] = useState('');
  const [createdSecretKey, setCreatedSecretKey] = useState<string | null>(null);
  const [selectedKeyIds, setSelectedKeyIds] = useState<string[]>([]);
  const [bulkRevokeResult, setBulkRevokeResult] =
    useState<ConsoleApiKeyBulkRevokeResponse | null>(null);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);
  const [stagingRotateKey, setStagingRotateKey] =
    useState<ConsoleApiKey | null>(null);
  const [stagedRotateResult, setStagedRotateResult] = useState<{
    oldKeyId: string;
    oldKeyName: string;
    secretKey: string;
  } | null>(null);
  const [rotatingKeyId, setRotatingKeyId] = useState<string | null>(null);
  const [rotatedSecretKey, setRotatedSecretKey] = useState<string | null>(null);

  const parsedExpiringWithinDays = useMemo(
    () => parsePositiveInteger(expiringWithinDaysInput),
    [expiringWithinDaysInput]
  );
  const effectiveExpiringWithinDays = parsedExpiringWithinDays ?? 14;
  const parsedNewKeyExpiresInDays = useMemo(
    () => parsePositiveInteger(newKeyExpiresInDays),
    [newKeyExpiresInDays]
  );
  const hasNewKeyExpiry = newKeyExpiresInDays.trim().length > 0;
  const isNewKeyExpiryValid =
    !hasNewKeyExpiry || parsedNewKeyExpiresInDays !== null;

  const apiKeyQuery = useMemo(
    () => ({
      type: apiKeyTypeFilter === 'all' ? undefined : apiKeyTypeFilter,
      status: apiKeyStatusFilter === 'all' ? undefined : apiKeyStatusFilter,
      expiresWithinDays:
        apiKeyStatusFilter === 'expiring'
          ? effectiveExpiringWithinDays
          : undefined,
    }),
    [apiKeyTypeFilter, apiKeyStatusFilter, effectiveExpiringWithinDays]
  );

  const { data, isLoading, error } = useApiKeys(apiKeyQuery);
  const createMutation = useCreateApiKeyMutation();
  const bulkRevokeMutation = useBulkRevokeApiKeysMutation();
  const revokeMutation = useRevokeApiKeyMutation();
  const rotateMutation = useRotateApiKeyMutation();
  const stageRotateMutation = useStageRotateApiKeyMutation();

  useEffect(() => {
    const visibleKeyIds = new Set(
      (data?.items ?? []).map((apiKey) => apiKey.keyId)
    );
    setSelectedKeyIds((current) =>
      current.filter((keyId) => visibleKeyIds.has(keyId))
    );
  }, [data?.items]);

  const handleCreate = async () => {
    try {
      const parsedScopeKeys = newKeyScopeKeys
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0);

      const result = await createMutation.mutateAsync({
        name: newKeyName,
        keyType: newKeyType,
        actorId: newKeyActorId || undefined,
        scopeKeys: parsedScopeKeys.length > 0 ? parsedScopeKeys : undefined,
        expiresInDays: hasNewKeyExpiry
          ? (parsedNewKeyExpiresInDays ?? undefined)
          : undefined,
      });
      setCreatedSecretKey(result.secretKey);
      setNewKeyName('');
      setNewKeyActorId('');
      setNewKeyScopeKeys('');
      setNewKeyExpiresInDays('');
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

  const handleBulkRevoke = async () => {
    if (selectedKeyIds.length === 0) return;
    try {
      const result = await bulkRevokeMutation.mutateAsync({
        keyIds: selectedKeyIds,
      });
      setBulkRevokeResult(result);
      setSelectedKeyIds([]);
    } catch {
      // handled by mutation state
    }
  };

  const handleStageRotate = async () => {
    if (!stagingRotateKey) return;
    try {
      const result = await stageRotateMutation.mutateAsync(
        stagingRotateKey.keyId
      );
      setStagedRotateResult({
        oldKeyId: stagingRotateKey.keyId,
        oldKeyName: stagingRotateKey.name,
        secretKey: result.secretKey,
      });
    } catch {
      // handled by mutation state
    }
  };

  const handleFinalizeStagedRotate = async () => {
    if (!stagedRotateResult) return;
    try {
      await revokeMutation.mutateAsync(stagedRotateResult.oldKeyId);
    } finally {
      setStagedRotateResult(null);
      setStagingRotateKey(null);
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

  const selectableKeyIds = (data?.items ?? [])
    .filter((apiKey) => apiKey.revokedAt === null)
    .map((apiKey) => apiKey.keyId);
  const allSelectableChecked =
    selectableKeyIds.length > 0 &&
    selectableKeyIds.every((keyId) => selectedKeyIds.includes(keyId));
  const someSelectableChecked = selectedKeyIds.length > 0;
  const selectedKeyNames = (data?.items ?? [])
    .filter((apiKey) => selectedKeyIds.includes(apiKey.keyId))
    .map((apiKey) => apiKey.name);

  return (
    <>
      <SectionCard
        title="API Keys"
        description="Issue, rotate, revoke, and audit key lifecycle state."
        actions={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setShowBulkRevokeDialog(true)}
              disabled={selectedKeyIds.length === 0}
            >
              Revoke Selected ({selectedKeyIds.length})
            </Button>
            <Button size="sm" onClick={() => setShowCreateDialog(true)}>
              Create Key
            </Button>
          </div>
        }
      >
        <div className="mb-4 grid gap-3 lg:grid-cols-3">
          <Field>
            <FieldLabel>Type filter</FieldLabel>
            <ToggleGroup
              value={[apiKeyTypeFilter]}
              multiple={false}
              onValueChange={(nextValues) => {
                const nextValue = nextValues.find(
                  (value) => typeof value === 'string'
                );
                if (
                  nextValue === 'all' ||
                  nextValue === 'relay' ||
                  nextValue === 'proxy' ||
                  nextValue === 'admin'
                ) {
                  setApiKeyTypeFilter(nextValue);
                }
              }}
            >
              <ToggleGroupItem value="all">all</ToggleGroupItem>
              <ToggleGroupItem value="relay">relay</ToggleGroupItem>
              <ToggleGroupItem value="proxy">proxy</ToggleGroupItem>
              <ToggleGroupItem value="admin">admin</ToggleGroupItem>
            </ToggleGroup>
          </Field>

          <Field>
            <FieldLabel>Status filter</FieldLabel>
            <ToggleGroup
              value={[apiKeyStatusFilter]}
              multiple={false}
              onValueChange={(nextValues) => {
                const nextValue = nextValues.find(
                  (value) => typeof value === 'string'
                );
                if (
                  nextValue === 'all' ||
                  nextValue === 'active' ||
                  nextValue === 'revoked' ||
                  nextValue === 'expiring'
                ) {
                  setApiKeyStatusFilter(nextValue);
                }
              }}
            >
              <ToggleGroupItem value="all">all</ToggleGroupItem>
              <ToggleGroupItem value="active">active</ToggleGroupItem>
              <ToggleGroupItem value="revoked">revoked</ToggleGroupItem>
              <ToggleGroupItem value="expiring">expiring</ToggleGroupItem>
            </ToggleGroup>
          </Field>

          <Field>
            <FieldLabel htmlFor="api-key-expiring-window">
              Expiring window (days)
            </FieldLabel>
            <FieldDescription>
              Used when status filter is set to expiring.
            </FieldDescription>
            <Input
              id="api-key-expiring-window"
              placeholder="14"
              value={expiringWithinDaysInput}
              inputMode="numeric"
              onChange={(event) =>
                setExpiringWithinDaysInput(event.target.value)
              }
            />
            {parsedExpiringWithinDays === null &&
            expiringWithinDaysInput.trim().length > 0 ? (
              <p className="font-mono text-[10px] text-offline">
                Enter a positive whole number.
              </p>
            ) : null}
          </Field>
        </div>

        {data?.items.length === 0 ? (
          <EmptyState message="No API keys match the current filters." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28px]">
                  <Checkbox
                    checked={allSelectableChecked}
                    indeterminate={
                      !allSelectableChecked &&
                      someSelectableChecked &&
                      selectableKeyIds.length > 0
                    }
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setSelectedKeyIds(selectableKeyIds);
                      } else {
                        setSelectedKeyIds([]);
                      }
                    }}
                    aria-label="Select all active keys"
                  />
                </TableHead>
                <TableHead className="w-[100px]">NAME</TableHead>
                <TableHead className="w-[55px]">TYPE</TableHead>
                <TableHead className="w-[90px]">KEY PREFIX</TableHead>
                <TableHead className="w-[80px]">ACTOR</TableHead>
                <TableHead className="w-[100px]">SCOPES</TableHead>
                <TableHead className="w-[120px]">CREATED</TableHead>
                <TableHead className="w-[120px]">LAST USED</TableHead>
                <TableHead className="w-[120px]">EXPIRES</TableHead>
                <TableHead className="flex-1">STATUS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.items ?? []).map((apiKey) => {
                const lifecycleStatus = getApiKeyLifecycleStatus(
                  apiKey,
                  effectiveExpiringWithinDays
                );

                return (
                  <TableRow key={apiKey.keyId} className="group relative">
                    <TableCell className="w-[28px]">
                      <Checkbox
                        checked={selectedKeyIds.includes(apiKey.keyId)}
                        onCheckedChange={(checked) => {
                          setSelectedKeyIds((current) =>
                            checked
                              ? [...new Set([...current, apiKey.keyId])]
                              : current.filter(
                                  (keyId) => keyId !== apiKey.keyId
                                )
                          );
                        }}
                        aria-label={`Select ${apiKey.name}`}
                        disabled={apiKey.revokedAt !== null}
                      />
                    </TableCell>
                    <TableCell className="w-[100px] font-medium">
                      {apiKey.name}
                    </TableCell>
                    <TableCell className="w-[55px]">
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
                    <TableCell className="w-[90px]">
                      <code className="font-mono text-[11px]">
                        {apiKey.keyPrefix}...
                      </code>
                    </TableCell>
                    <TableCell className="w-[80px] text-neutral-500">
                      {apiKey.actorId ?? '-'}
                    </TableCell>
                    <TableCell className="w-[100px] text-neutral-500">
                      <code className="font-mono text-[10px]">
                        {summarizeScopeKeys(apiKey.scopeKeys)}
                      </code>
                    </TableCell>
                    <TableCell className="w-[120px] text-neutral-500">
                      {formatOptionalDateTime(apiKey.createdAt)}
                    </TableCell>
                    <TableCell className="w-[120px] text-neutral-500">
                      {formatOptionalDateTime(apiKey.lastUsedAt)}
                    </TableCell>
                    <TableCell className="w-[120px] text-neutral-500">
                      {formatOptionalDateTime(apiKey.expiresAt)}
                    </TableCell>
                    <TableCell className="flex-1">
                      <Badge
                        variant={getApiKeyStatusBadgeVariant(lifecycleStatus)}
                      >
                        {lifecycleStatus}
                      </Badge>
                    </TableCell>
                    {apiKey.revokedAt === null && (
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          type="button"
                          onClick={() => setStagingRotateKey(apiKey)}
                          className="px-1.5 py-0.5 rounded text-[9px] font-mono text-neutral-600 hover:text-white hover:bg-white/[0.05] cursor-pointer transition-colors"
                        >
                          stage
                        </button>
                        <button
                          type="button"
                          onClick={() => setRotatingKeyId(apiKey.keyId)}
                          className="px-1.5 py-0.5 rounded text-[9px] font-mono text-neutral-600 hover:text-white hover:bg-white/[0.05] cursor-pointer transition-colors"
                        >
                          rotate
                        </button>
                        <button
                          type="button"
                          onClick={() => setRevokingKeyId(apiKey.keyId)}
                          className="px-1.5 py-0.5 rounded text-[9px] font-mono text-neutral-600 hover:text-offline hover:bg-offline/10 cursor-pointer transition-colors"
                        >
                          revoke
                        </button>
                      </div>
                    )}
                  </TableRow>
                );
              })}
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

              <Field>
                <FieldLabel htmlFor="api-key-expires-days">
                  Expires in days (optional)
                </FieldLabel>
                <FieldDescription>
                  Leave empty to keep the key non-expiring.
                </FieldDescription>
                <Input
                  id="api-key-expires-days"
                  placeholder="30"
                  value={newKeyExpiresInDays}
                  inputMode="numeric"
                  onChange={(event) =>
                    setNewKeyExpiresInDays(event.target.value)
                  }
                />
                {!isNewKeyExpiryValid ? (
                  <p className="font-mono text-[10px] text-offline">
                    Enter a positive whole number.
                  </p>
                ) : null}
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
                  disabled={
                    createMutation.isPending ||
                    !newKeyName ||
                    !isNewKeyExpiryValid
                  }
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

      {/* Bulk Revoke Dialog */}
      <Dialog
        open={showBulkRevokeDialog}
        onOpenChange={(open) => {
          setShowBulkRevokeDialog(open);
          if (!open) {
            setBulkRevokeResult(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bulk Revoke API Keys</DialogTitle>
          </DialogHeader>

          {bulkRevokeResult ? (
            <div className="px-5 py-4 flex flex-col gap-3">
              <Alert variant="destructive">
                <AlertDescription>
                  Requested {bulkRevokeResult.requestedCount} keys. Revoked{' '}
                  {bulkRevokeResult.revokedCount}, already revoked{' '}
                  {bulkRevokeResult.alreadyRevokedCount}, not found{' '}
                  {bulkRevokeResult.notFoundCount}.
                </AlertDescription>
              </Alert>
              <DialogFooter>
                <Button
                  variant="primary"
                  onClick={() => {
                    setShowBulkRevokeDialog(false);
                    setBulkRevokeResult(null);
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <>
              <div className="px-5 py-4 flex flex-col gap-3">
                <Alert variant="destructive">
                  <AlertDescription>
                    This revokes selected keys immediately and cannot be undone.
                  </AlertDescription>
                </Alert>
                <p className="font-mono text-[10px] text-neutral-500">
                  Selected keys: {selectedKeyNames.slice(0, 5).join(', ')}
                  {selectedKeyNames.length > 5
                    ? ` +${selectedKeyNames.length - 5} more`
                    : ''}
                </p>
              </div>
              <DialogFooter>
                <Button
                  variant="default"
                  onClick={() => setShowBulkRevokeDialog(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleBulkRevoke}
                  disabled={
                    bulkRevokeMutation.isPending || selectedKeyIds.length === 0
                  }
                >
                  {bulkRevokeMutation.isPending ? (
                    <>
                      <Spinner size="sm" />
                      Revoking...
                    </>
                  ) : (
                    'Revoke Selected'
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Stage Rotate Dialog */}
      <Dialog
        open={stagingRotateKey !== null || stagedRotateResult !== null}
        onOpenChange={() => {
          setStagingRotateKey(null);
          setStagedRotateResult(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stage Rotate API Key</DialogTitle>
          </DialogHeader>

          {stagedRotateResult ? (
            <div className="px-5 py-4 flex flex-col gap-4">
              <Alert variant="default">
                <AlertDescription>
                  Replacement key created for {stagedRotateResult.oldKeyName}.
                  The old key is still active until you revoke it.
                </AlertDescription>
              </Alert>

              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-border bg-surface p-3 font-mono text-[11px] text-white break-all">
                  {stagedRotateResult.secretKey}
                </code>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => handleCopyKey(stagedRotateResult.secretKey)}
                >
                  {copiedKeyId === stagedRotateResult.secretKey
                    ? 'Copied'
                    : 'Copy'}
                </Button>
              </div>

              <DialogFooter>
                <Button
                  variant="default"
                  onClick={() => {
                    setStagedRotateResult(null);
                    setStagingRotateKey(null);
                  }}
                >
                  Keep Old Key Active
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleFinalizeStagedRotate}
                  disabled={revokeMutation.isPending}
                >
                  {revokeMutation.isPending ? (
                    <>
                      <Spinner size="sm" />
                      Revoking Old Key...
                    </>
                  ) : (
                    'Finalize and Revoke Old Key'
                  )}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <>
              <div className="px-5 py-4">
                <p className="font-mono text-[10px] text-neutral-500">
                  Staged rotation creates a replacement key now and keeps the
                  current key active until you explicitly revoke it.
                </p>
              </div>
              <DialogFooter>
                <Button
                  variant="default"
                  onClick={() => setStagingRotateKey(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleStageRotate}
                  disabled={stageRotateMutation.isPending || !stagingRotateKey}
                >
                  {stageRotateMutation.isPending ? (
                    <>
                      <Spinner size="sm" />
                      Staging...
                    </>
                  ) : (
                    'Create Replacement Key'
                  )}
                </Button>
              </DialogFooter>
            </>
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
