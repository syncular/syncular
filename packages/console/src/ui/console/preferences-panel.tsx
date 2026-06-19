'use client';

import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/button';
import { Switch } from '../primitives/switch';

export type PreferenceOption = {
  id: string;
  label: string;
};

export type PreferenceFilterRow = {
  type: 'filter';
  label: string;
  options: PreferenceOption[];
  activeId: string;
  onActiveChange: (id: string) => void;
};

export type PreferenceToggleRow = {
  type: 'toggle';
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

export type PreferenceRow = PreferenceFilterRow | PreferenceToggleRow;

export type PreferencesPanelProps = ComponentPropsWithoutRef<'div'> & {
  rows: PreferenceRow[];
  onResetDefaults?: () => void;
};

const PreferencesPanel = forwardRef<HTMLDivElement, PreferencesPanelProps>(
  ({ className, rows, onResetDefaults, ...props }, ref) => (
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
        <span className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">
          Preferences
        </span>
        {onResetDefaults && (
          <Button variant="default" size="sm" onClick={onResetDefaults}>
            Reset defaults
          </Button>
        )}
      </div>

      {/* Body */}
      <div className="p-4 space-y-4">
        {rows.map((row, i) => (
          <PreferenceRowItem key={row.label} row={row} showDivider={i > 0} />
        ))}
      </div>
    </div>
  )
);
PreferencesPanel.displayName = 'PreferencesPanel';

function PreferenceRowItem({
  row,
  showDivider,
}: {
  row: PreferenceRow;
  showDivider: boolean;
}) {
  return (
    <>
      {showDivider && <div className="border-t border-border" />}
      <div className="flex items-center justify-between">
        {row.type === 'filter' ? (
          <>
            <span className="font-mono text-[11px] text-neutral-400">
              {row.label}
            </span>
            <div className="flex gap-0.5">
              {row.options.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => row.onActiveChange(opt.id)}
                  className={cn(
                    'font-mono text-[10px] border rounded-sm px-2.5 py-0.5 cursor-pointer transition-all',
                    opt.id === row.activeId
                      ? 'text-white border-border-bright bg-white/[0.03]'
                      : 'text-neutral-500 border-transparent hover:text-neutral-300'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div>
              <span className="font-mono text-[11px] text-neutral-400">
                {row.label}
              </span>
              {row.description && (
                <p className="font-mono text-[9px] text-neutral-600 mt-0.5">
                  {row.description}
                </p>
              )}
            </div>
            <Switch
              checked={row.checked}
              onCheckedChange={(val) => row.onCheckedChange(val)}
            />
          </>
        )}
      </div>
    </>
  );
}

export { PreferencesPanel };
