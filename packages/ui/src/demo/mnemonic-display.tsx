'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '../lib/cn';

export interface MnemonicDisplayProps {
  words: string[];
  copyValue?: string;
  className?: string;
  copyButtonTone?: 'default' | 'prominent';
}

function fallbackCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;

  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', 'true');
  el.style.position = 'fixed';
  el.style.left = '-9999px';
  document.body.appendChild(el);
  el.select();

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(el);
  }

  return ok;
}

export function MnemonicDisplay({
  words,
  copyValue,
  className,
  copyButtonTone = 'default',
}: MnemonicDisplayProps) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>(
    'idle'
  );

  const handleCopy = useCallback(async () => {
    const text = copyValue ?? words.join(' ');
    if (text.trim().length === 0) return;

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else if (!fallbackCopy(text)) {
        setCopyStatus('error');
        return;
      }
      setCopyStatus('copied');
    } catch {
      setCopyStatus(fallbackCopy(text) ? 'copied' : 'error');
    }
  }, [copyValue, words]);

  useEffect(() => {
    if (copyStatus === 'idle') return;
    const timeout = window.setTimeout(() => setCopyStatus('idle'), 1600);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
          Recovery Mnemonic
        </span>
        <button
          type="button"
          onClick={() => {
            void handleCopy();
          }}
          className={cn(
            'px-2.5 py-1 rounded font-mono text-[10px] uppercase tracking-wider transition-colors',
            copyButtonTone === 'prominent'
              ? 'border border-flow/40 bg-flow/[0.06] text-flow hover:bg-flow/[0.12]'
              : 'border border-encrypt/20 bg-encrypt/[0.08] text-encrypt hover:bg-encrypt/[0.14]'
          )}
        >
          {copyStatus === 'copied'
            ? 'Copied'
            : copyStatus === 'error'
              ? 'Copy Failed'
              : 'Copy Mnemonic'}
        </button>
      </div>
      <button
        type="button"
        aria-label="Copy mnemonic words"
        onClick={() => {
          void handleCopy();
        }}
        className="flex flex-wrap gap-2 cursor-copy"
      >
        {words.map((word, i) => (
          <span
            key={`${i}-${word}`}
            className="inline-flex items-center gap-1 px-2 py-[3px] bg-encrypt/[0.08] border border-encrypt/15 rounded-[4px] font-mono text-[11px] text-encrypt"
          >
            <span className="text-[9px] opacity-40">{i + 1}</span>
            {word}
          </span>
        ))}
      </button>
    </div>
  );
}
