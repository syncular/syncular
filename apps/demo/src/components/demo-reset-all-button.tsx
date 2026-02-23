import { Button } from '@syncular/ui/primitives';
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
      <Button
        type="button"
        onClick={() => void handleResetAll()}
        variant="destructive"
        size="sm"
        disabled={isResetting}
        className="whitespace-nowrap uppercase tracking-wider"
      >
        {isResetting ? 'Resetting...' : 'Reset All Data'}
      </Button>
      {error ? (
        <span className="max-w-[280px] truncate font-mono text-[10px] text-red-300">
          {error}
        </span>
      ) : null}
    </div>
  );
}
