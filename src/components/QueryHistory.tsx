import { useEffect, useState } from 'react';
import { useHistoryStore, type QueryHistoryEntry } from '../stores/historyStore';

interface QueryHistoryProps {
  onSelectQuery: (sql: string) => void;
  isDark?: boolean;
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);

  if (diffSeconds < 60) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;

  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: new Date(timestamp).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

function StatementTypeBadge({ type, isDark }: { type: QueryHistoryEntry['statementType']; isDark: boolean }) {
  if (!type) return null;

  const styles: Record<NonNullable<QueryHistoryEntry['statementType']>, string> = {
    SELECT: isDark
      ? 'bg-blue-900/60 text-blue-300 border border-blue-700/50'
      : 'bg-blue-100 text-blue-700 border border-blue-200',
    INSERT: isDark
      ? 'bg-green-900/60 text-green-300 border border-green-700/50'
      : 'bg-green-100 text-green-700 border border-green-200',
    UPDATE: isDark
      ? 'bg-amber-900/60 text-amber-300 border border-amber-700/50'
      : 'bg-amber-100 text-amber-700 border border-amber-200',
    DELETE: isDark
      ? 'bg-red-900/60 text-red-300 border border-red-700/50'
      : 'bg-red-100 text-red-700 border border-red-200',
  };

  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${styles[type]}`}>
      {type}
    </span>
  );
}

function HistoryEntryRow({
  entry,
  onSelect,
  onPin,
  onRemove,
  isDark = false,
}: {
  entry: QueryHistoryEntry;
  onSelect: () => void;
  onPin: () => void;
  onRemove: () => void;
  isDark?: boolean;
}) {
  const [hovered, setHovered] = useState(false);

  const truncatedSql =
    entry.sql.length > 80 ? entry.sql.slice(0, 80) + '…' : entry.sql;

  return (
    <div
      className={[
        'group relative flex cursor-pointer flex-col gap-1 rounded-md px-3 py-2 transition-colors',
        entry.pinned
          ? isDark
            ? 'bg-indigo-950/50 hover:bg-indigo-950/70 border border-indigo-800/40'
            : 'bg-indigo-50 hover:bg-indigo-100 border border-indigo-200'
          : isDark
            ? 'hover:bg-neutral-700/50 border border-transparent'
            : 'hover:bg-gray-100 border border-transparent',
      ].join(' ')}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Top row: time + badge + action buttons */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`text-xs shrink-0 ${isDark ? 'text-neutral-400' : 'text-gray-500'}`}>
            {formatRelativeTime(entry.timestamp)}
          </span>
          <StatementTypeBadge type={entry.statementType} isDark={isDark} />
        </div>
        <div className="flex items-center gap-1">
          {/* Pin button — always visible */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPin();
            }}
            title={entry.pinned ? 'Unpin' : 'Pin'}
            className={[
              'rounded p-0.5 text-sm transition-colors',
              entry.pinned
                ? 'text-indigo-400 hover:text-indigo-300'
                : isDark
                  ? 'text-neutral-500 hover:text-neutral-300'
                  : 'text-gray-400 hover:text-gray-600',
            ].join(' ')}
          >
            📌
          </button>
          {/* Delete button — visible on hover */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title="Remove"
            className={[
              'rounded px-1 py-0.5 text-xs font-bold transition-colors hover:text-red-400',
              isDark ? 'text-neutral-500' : 'text-gray-400',
              hovered ? 'opacity-100' : 'opacity-0',
            ].join(' ')}
          >
            ×
          </button>
        </div>
      </div>

      {/* SQL preview */}
      <p className={`font-mono text-xs leading-relaxed break-all ${isDark ? 'text-neutral-200' : 'text-gray-800'}`}>
        {truncatedSql}
      </p>

      {/* Meta: row count + execution time */}
      {(entry.rowCount != null || entry.executionTime != null || entry.error) && (
        <div className="flex items-center gap-3 text-xs">
          {entry.error ? (
            <span className="text-red-400 truncate">{entry.error}</span>
          ) : (
            <>
              {entry.rowCount != null && (
                <span className={isDark ? 'text-neutral-400' : 'text-gray-500'}>
                  {entry.rowCount} row{entry.rowCount !== 1 ? 's' : ''}
                </span>
              )}
              {entry.executionTime != null && (
                <span className={isDark ? 'text-neutral-500' : 'text-gray-400'}>{entry.executionTime}ms</span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function QueryHistory({ onSelectQuery, isDark = false }: QueryHistoryProps) {
  const store = useHistoryStore();
  const [search, setSearch] = useState('');

  useEffect(() => {
    store.loadFromSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = store.entries.filter((e) =>
    search.trim() === '' ? true : e.sql.toLowerCase().includes(search.toLowerCase())
  );

  // Pinned entries at top
  const pinned = filtered.filter((e) => e.pinned);
  const unpinned = filtered.filter((e) => !e.pinned);
  const sorted = [...pinned, ...unpinned];

  return (
    <div className={`flex h-full flex-col ${isDark ? 'bg-neutral-800' : 'bg-gray-50'}`}>
      {/* Header */}
      <div className={`flex items-center justify-between border-b px-3 py-2 ${isDark ? 'border-neutral-700' : 'border-gray-200'}`}>
        <span className={`text-xs font-semibold ${isDark ? 'text-neutral-200' : 'text-gray-700'}`}>
          History
          <span className={`ml-1.5 ${isDark ? 'text-neutral-500' : 'text-gray-400'}`}>({store.entries.length})</span>
        </span>
        <button
          onClick={() => store.clearHistory()}
          className={`rounded px-2 py-0.5 text-xs transition-colors ${isDark ? 'text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200' : 'text-gray-500 hover:bg-gray-200 hover:text-gray-700'}`}
          title="Clear non-pinned history"
        >
          Clear
        </button>
      </div>

      {/* Search */}
      <div className={`px-3 py-2 border-b ${isDark ? 'border-neutral-700' : 'border-gray-200'}`}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by SQL…"
          className={`w-full rounded px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-indigo-500 transition ${isDark ? 'bg-neutral-700 text-neutral-200 placeholder:text-neutral-500' : 'bg-white text-gray-700 placeholder:text-gray-400 border border-gray-200'}`}
        />
      </div>

      {/* Entry list */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {sorted.length === 0 ? (
          <p className={`mt-6 text-center text-xs select-none ${isDark ? 'text-neutral-500' : 'text-gray-400'}`}>
            {store.entries.length === 0
              ? 'No query history yet'
              : 'No results match your filter'}
          </p>
        ) : (
          sorted.map((entry) => (
            <HistoryEntryRow
              key={entry.id}
              entry={entry}
              onSelect={() => onSelectQuery(entry.sql)}
              onPin={() => store.togglePin(entry.id)}
              onRemove={() => store.removeEntry(entry.id)}
              isDark={isDark}
            />
          ))
        )}
      </div>
    </div>
  );
}
