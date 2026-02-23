'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';
import { Input } from '../primitives/input';
import { Switch } from '../primitives/switch';

export type AlertThresholds = {
  p90Latency: number;
  errorRate: number;
  clientLag: number;
};

export type AlertsConfigProps = ComponentPropsWithoutRef<'div'> & {
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  thresholds: AlertThresholds;
  onThresholdsChange?: (thresholds: AlertThresholds) => void;
};

const AlertsConfig = forwardRef<HTMLDivElement, AlertsConfigProps>(
  (
    {
      className,
      enabled = true,
      onEnabledChange,
      thresholds,
      onThresholdsChange,
      ...props
    },
    ref
  ) => {
    function handleChange(key: keyof AlertThresholds, value: string) {
      const num = Number(value);
      if (Number.isFinite(num)) {
        onThresholdsChange?.({ ...thresholds, [key]: num });
      }
    }

    return (
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
            <span className="w-1.5 h-1.5 rounded-full bg-offline" />
            <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
              Alerts
            </span>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(val) => onEnabledChange?.(val)}
          />
        </div>

        {/* Fields */}
        <div className="p-4 space-y-3">
          <ThresholdRow
            label="P90 latency threshold"
            value={thresholds.p90Latency}
            onChange={(v) => handleChange('p90Latency', v)}
          />
          <ThresholdRow
            label="Error rate threshold"
            value={thresholds.errorRate}
            onChange={(v) => handleChange('errorRate', v)}
          />
          <ThresholdRow
            label="Client lag threshold"
            value={thresholds.clientLag}
            onChange={(v) => handleChange('clientLag', v)}
          />
        </div>
      </div>
    );
  }
);
AlertsConfig.displayName = 'AlertsConfig';

function ThresholdRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-[10px] text-neutral-500">{label}</span>
      <Input
        variant="mono"
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-[100px] text-[11px] px-2 py-1 text-right"
      />
    </div>
  );
}

export { AlertsConfig };
