import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  SectionCard,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@syncular/ui';
import { useState } from 'react';
import {
  useBlobDownload,
  useBlobs,
  useDeleteBlobMutation,
} from '../hooks/useConsoleApi';

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDateTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

export function Storage() {
  const [prefixInput, setPrefixInput] = useState('');
  const [activePrefix, setActivePrefix] = useState<string | undefined>(
    undefined
  );
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const { data, isLoading, error } = useBlobs({
    prefix: activePrefix,
    cursor,
    limit: 100,
  });
  const deleteMutation = useDeleteBlobMutation();
  const download = useBlobDownload();

  function handleFilter() {
    const trimmed = prefixInput.trim();
    setActivePrefix(trimmed.length > 0 ? trimmed : undefined);
    setCursor(undefined);
    setCursorHistory([]);
  }

  function handleClearFilter() {
    setPrefixInput('');
    setActivePrefix(undefined);
    setCursor(undefined);
    setCursorHistory([]);
  }

  function handleNextPage() {
    if (data?.cursor) {
      setCursorHistory((prev) => [...prev, cursor ?? '']);
      setCursor(data.cursor);
    }
  }

  function handlePrevPage() {
    setCursorHistory((prev) => {
      const next = [...prev];
      const prevCursor = next.pop();
      setCursor(prevCursor && prevCursor.length > 0 ? prevCursor : undefined);
      return next;
    });
  }

  function handleDelete() {
    if (!deletingKey) return;
    deleteMutation.mutate(deletingKey, {
      onSuccess: () => setDeletingKey(null),
    });
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 px-5 py-5">
        <div className="flex items-center justify-center h-[200px]">
          <Spinner size="lg" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4 px-5 py-5">
        <div className="flex items-center justify-center h-[200px]">
          <p className="text-danger font-mono text-[11px]">
            Failed to load storage items: {error.message}
          </p>
        </div>
      </div>
    );
  }

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4 px-5 py-5">
      <SectionCard
        title="Storage"
        actions={
          <div className="flex items-center gap-2">
            <Input
              placeholder="Prefix filter..."
              value={prefixInput}
              onChange={(e) => setPrefixInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleFilter();
              }}
              className="h-7 w-48 text-xs"
            />
            <Button variant="default" size="sm" onClick={handleFilter}>
              Filter
            </Button>
            {activePrefix && (
              <Button variant="ghost" size="sm" onClick={handleClearFilter}>
                Clear
              </Button>
            )}
          </div>
        }
      >
        {items.length === 0 ? (
          <EmptyState
            message={
              activePrefix
                ? `No storage items matching prefix "${activePrefix}".`
                : 'No storage items found.'
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Uploaded</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((blob) => (
                    <TableRow key={blob.key}>
                      <TableCell
                        className="font-mono text-xs max-w-[320px]"
                        title={blob.key}
                      >
                        {blob.key}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-neutral-400 whitespace-nowrap">
                        {formatFileSize(blob.size)}
                      </TableCell>
                      <TableCell>
                        {blob.httpMetadata?.contentType ? (
                          <Badge variant="ghost">
                            {blob.httpMetadata.contentType}
                          </Badge>
                        ) : (
                          <span className="text-neutral-500 text-xs">--</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-neutral-400">
                        {formatDateTime(blob.uploaded)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void download(blob.key)}
                          >
                            Download
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeletingKey(blob.key)}
                          >
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between px-2 py-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={cursorHistory.length === 0}
                onClick={handlePrevPage}
              >
                Previous
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!data?.truncated}
                onClick={handleNextPage}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </SectionCard>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deletingKey !== null}
        onOpenChange={() => setDeletingKey(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Storage Item</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 flex flex-col gap-4">
            <p className="font-mono text-[11px] text-neutral-300">
              Are you sure you want to delete{' '}
              <span className="font-mono text-white">{deletingKey}</span>?
            </p>
            <p className="font-mono text-[10px] text-neutral-500">
              This action cannot be undone.
            </p>
          </div>
          <DialogFooter>
            <Button variant="default" onClick={() => setDeletingKey(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <>
                  <Spinner size="sm" /> Deleting...
                </>
              ) : (
                'Delete'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
