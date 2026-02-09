'use client';

import { cn } from '../lib/cn';

export interface EncryptedBadgeProps {
  locked: boolean;
  label?: string;
  className?: string;
}

export function EncryptedBadge({
  locked,
  label,
  className,
}: EncryptedBadgeProps) {
  const resolvedLabel = label ?? (locked ? 'E2EE Active' : 'decrypted');

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[3px] font-mono text-[9px] uppercase tracking-[0.5px]',
        locked
          ? 'bg-encrypt/10 border border-encrypt/20 text-encrypt'
          : 'bg-healthy/10 border border-healthy/20 text-healthy',
        className
      )}
    >
      {locked ? (
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      ) : (
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {resolvedLabel}
    </span>
  );
}
