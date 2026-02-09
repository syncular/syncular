'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';
import { Badge } from '../primitives/badge';
import { Button } from '../primitives/button';
import { Input } from '../primitives/input';

export type ConnectionFormProps = ComponentPropsWithoutRef<'div'> & {
  isConnected?: boolean;
  serverUrl: string;
  onServerUrlChange?: (value: string) => void;
  consoleToken: string;
  onConsoleTokenChange?: (value: string) => void;
  onDisconnect?: () => void;
  onTestConnection?: () => void;
  statusMessage?: string;
};

const ConnectionForm = forwardRef<HTMLDivElement, ConnectionFormProps>(
  (
    {
      className,
      isConnected = false,
      serverUrl,
      onServerUrlChange,
      consoleToken,
      onConsoleTokenChange,
      onDisconnect,
      onTestConnection,
      statusMessage,
      ...props
    },
    ref
  ) => (
    <div
      ref={ref}
      className={cn(
        'bg-panel border border-border rounded-lg hover:border-border-bright transition',
        className
      )}
      {...props}
    >
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full',
              isConnected ? 'bg-healthy' : 'bg-offline'
            )}
            style={isConnected ? { boxShadow: '0 0 4px #22c55e' } : undefined}
          />
          <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
            Connection
          </span>
        </div>
        <Badge variant={isConnected ? 'healthy' : 'offline'}>
          {isConnected ? 'Connected' : 'Disconnected'}
        </Badge>
      </div>

      {/* Body */}
      <div className="p-5 space-y-4">
        <p className="font-mono text-[10px] text-neutral-500">
          Configure the server endpoint and authentication token.
        </p>

        {/* Server URL */}
        <div>
          <label
            htmlFor="console-server-url"
            className="font-mono text-[9px] text-neutral-500 uppercase tracking-wider block mb-1.5"
          >
            Server URL
          </label>
          <Input
            id="console-server-url"
            variant="mono"
            value={serverUrl}
            onChange={(e) => onServerUrlChange?.(e.target.value)}
          />
        </div>

        {/* Console Token */}
        <div>
          <label
            htmlFor="console-token"
            className="font-mono text-[9px] text-neutral-500 uppercase tracking-wider block mb-1.5"
          >
            Console Token
          </label>
          <Input
            id="console-token"
            variant="mono"
            type="password"
            value={consoleToken}
            onChange={(e) => onConsoleTokenChange?.(e.target.value)}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <Button variant="destructive" size="md" onClick={onDisconnect}>
            Disconnect
          </Button>
          <Button variant="default" size="md" onClick={onTestConnection}>
            Test Connection
          </Button>
        </div>

        {/* Status message */}
        {statusMessage && (
          <div
            className={cn(
              'font-mono text-[10px]',
              isConnected ? 'text-healthy' : 'text-offline'
            )}
          >
            {statusMessage}
          </div>
        )}
      </div>
    </div>
  )
);
ConnectionForm.displayName = 'ConnectionForm';

export { ConnectionForm };
