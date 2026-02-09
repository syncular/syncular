'use client';

import {
  type ChangeEvent,
  forwardRef,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from 'react';
import { cn } from '../lib/cn';

interface UploadAreaProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  onChange?: (files: FileList | null) => void;
  label?: string;
  children?: ReactNode;
}

export const UploadArea = forwardRef<HTMLInputElement, UploadAreaProps>(
  (
    {
      className,
      onChange,
      label = 'Click to upload media',
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    const [isDragging, setIsDragging] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const setInputRef = useCallback(
      (node: HTMLInputElement | null) => {
        inputRef.current = node;
        if (typeof ref === 'function') {
          ref(node);
          return;
        }
        if (ref) {
          ref.current = node;
        }
      },
      [ref]
    );

    const handleDragOver = (e: React.DragEvent<HTMLButtonElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
    };

    const handleDrop = (e: React.DragEvent<HTMLButtonElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      onChange?.(e.dataTransfer.files);
    };

    const handleDragLeave = () => {
      setIsDragging(false);
    };

    const handleClick = () => {
      if (disabled) return;
      inputRef.current?.click();
    };

    const handleInputClick = (e: React.MouseEvent<HTMLInputElement>) => {
      e.currentTarget.value = '';
    };

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
      onChange?.(e.target.files);
    };

    return (
      <>
        <input
          ref={setInputRef}
          type="file"
          className="sr-only"
          onClick={handleInputClick}
          onChange={handleChange}
          disabled={disabled}
          {...props}
        />
        <button
          type="button"
          className={cn(
            'w-full relative border border-dashed border-border-bright rounded-lg p-4 text-center cursor-pointer transition-colors',
            disabled && 'cursor-not-allowed opacity-60',
            isDragging && 'border-flow/40 bg-flow/[0.02]',
            !isDragging &&
              !disabled &&
              'hover:border-flow/40 hover:bg-flow/[0.02]',
            className
          )}
          onClick={handleClick}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragLeave={handleDragLeave}
          disabled={disabled}
          aria-label={label}
        >
          {children ?? (
            <>
              <svg
                className="w-6 h-6 mx-auto mb-2 text-neutral-600"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <div className="font-mono text-[10px] text-neutral-500">
                {label}
              </div>
            </>
          )}
        </button>
      </>
    );
  }
);

UploadArea.displayName = 'UploadArea';
