import { useCallback, useState } from 'react';
import { resetAllDemoData } from '../client/demo-data-reset';

export function DemoResetAllButton(props: { className?: string }) {
  const { className } = props;
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleResetAll = useCallback(async () => {
    if (isResetting) return;

    const confirmed = window.confirm(
      'Reset all demo data? This clears backend and local client databases.'
    );
    if (!confirmed) return;

    setIsResetting(true);
    setError(null);

    try {
      await resetAllDemoData();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsResetting(false);
    }
  }, [isResetting]);

  const wrapperClassName = ['flex items-center gap-2', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapperClassName}>
      <button
        type="button"
        onClick={() => void handleResetAll()}
        disabled={isResetting}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-red-500/40 text-red-300 text-[10px] font-mono uppercase tracking-wider hover:bg-red-500/10 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isResetting ? 'Resetting...' : 'Reset All Data'}
      </button>
      {error ? (
        <span className="max-w-[280px] truncate font-mono text-[10px] text-red-300">
          {error}
        </span>
      ) : null}
    </div>
  );
}
