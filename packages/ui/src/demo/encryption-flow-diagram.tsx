'use client';

import { cn } from '../lib/cn';

export interface EncryptionFlowDiagramProps {
  className?: string;
}

function Arrow() {
  return (
    <svg className="w-8 h-6 text-neutral-600 flow-arrow" viewBox="0 0 32 24">
      <path
        d="M4 12h20m-5-5l5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
      />
    </svg>
  );
}

export function EncryptionFlowDiagram({
  className,
}: EncryptionFlowDiagramProps) {
  return (
    <div className={cn('panel', className)}>
      <div className="panel-header">
        <span className="panel-label">Encryption Architecture</span>
      </div>
      <div className="p-6">
        <div className="flex items-center justify-center gap-4 flex-wrap">
          {/* Passphrase */}
          <div className="text-center">
            <div className="font-mono text-[10px] text-neutral-400 mb-1">
              Passphrase
            </div>
            <div className="px-3 py-1.5 border border-border rounded font-mono text-xs text-white bg-panel-alt">
              &bull;&bull;&bull;&bull;&bull;&bull;&bull;
            </div>
          </div>

          <Arrow />

          {/* PBKDF2 */}
          <div className="text-center">
            <div className="font-mono text-[10px] text-neutral-400 mb-1">
              PBKDF2
            </div>
            <div className="px-3 py-1.5 border border-syncing/30 rounded font-mono text-xs text-syncing bg-syncing/[0.05]">
              100k iterations
            </div>
          </div>

          <Arrow />

          {/* Derived Key */}
          <div className="text-center">
            <div className="font-mono text-[10px] text-neutral-400 mb-1">
              Derived Key
            </div>
            <div className="px-3 py-1.5 border border-encrypt/30 rounded font-mono text-xs text-encrypt bg-encrypt/[0.05]">
              256-bit
            </div>
          </div>

          <Arrow />

          {/* XChaCha20 */}
          <div className="text-center">
            <div className="font-mono text-[10px] text-neutral-400 mb-1">
              XChaCha20
            </div>
            <div className="px-3 py-1.5 border border-flow/30 rounded font-mono text-xs text-flow bg-flow/[0.05]">
              encrypt/decrypt
            </div>
          </div>

          <Arrow />

          {/* Server */}
          <div className="text-center">
            <div className="font-mono text-[10px] text-neutral-400 mb-1">
              Server
            </div>
            <div className="px-3 py-1.5 border border-border rounded font-mono text-xs text-neutral-500 bg-panel-alt">
              ciphertext only
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
