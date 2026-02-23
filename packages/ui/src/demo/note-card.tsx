'use client';

import { cn } from '../lib/cn';

export interface NoteCardProps {
  text: string;
  author: string;
  time: string;
  isCiphertext?: boolean;
  onDelete?: () => void;
  className?: string;
}

export function NoteCard({
  text,
  author,
  time,
  isCiphertext,
  onDelete,
  className,
}: NoteCardProps) {
  return (
    <div
      className={cn(
        'bg-panel-alt border border-[#1a1a1a] rounded-lg p-3 hover:border-[#282828] transition-[border-color]',
        className
      )}
    >
      {isCiphertext ? (
        <p className="font-mono text-[10px] text-encrypt/30 break-all">
          {text}
        </p>
      ) : (
        <p className="text-sm text-neutral-300">{text}</p>
      )}
      <div className="mt-2 flex items-center gap-2 text-neutral-600 font-mono text-[9px]">
        <span>by {author}</span>
        <span>&middot;</span>
        <span>{time}</span>
        {onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            className="ml-auto text-neutral-700 hover:text-offline transition-colors"
          >
            &times;
          </button>
        ) : null}
      </div>
    </div>
  );
}
