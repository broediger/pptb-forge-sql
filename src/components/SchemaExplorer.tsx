import { useEffect, useState } from 'react';
import { useSchemaStore, type EntityInfo } from '../stores/schemaStore';

interface SchemaExplorerProps {
  onInsertText?: (text: string) => void;
  isDark?: boolean;
  isConnected?: boolean;
}

const ATTRIBUTE_TYPE_COLORS: Record<string, string> = {
  String: 'bg-blue-900/60 text-blue-300',
  Memo: 'bg-blue-900/60 text-blue-300',
  Integer: 'bg-purple-900/60 text-purple-300',
  BigInt: 'bg-purple-900/60 text-purple-300',
  Decimal: 'bg-purple-900/60 text-purple-300',
  Double: 'bg-purple-900/60 text-purple-300',
  Money: 'bg-green-900/60 text-green-300',
  Boolean: 'bg-orange-900/60 text-orange-300',
  DateTime: 'bg-yellow-900/60 text-yellow-300',
  Lookup: 'bg-pink-900/60 text-pink-300',
  Owner: 'bg-pink-900/60 text-pink-300',
  Picklist: 'bg-teal-900/60 text-teal-300',
  State: 'bg-teal-900/60 text-teal-300',
  Status: 'bg-teal-900/60 text-teal-300',
  UniqueIdentifier: 'bg-neutral-700 text-neutral-300',
};

function attributeTypeColor(type: string): string {
  return ATTRIBUTE_TYPE_COLORS[type] ?? 'bg-neutral-700 text-neutral-400';
}

function EntityRow({
  entity,
  onInsertText,
}: {
  entity: EntityInfo;
  onInsertText?: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [attributeError, setAttributeError] = useState<string | null>(null);
  const schemaStore = useSchemaStore();
  const attributes = schemaStore.attributes.get(entity.logicalName);

  const handleToggle = async () => {
    if (!expanded && !attributes) {
      setAttributeError(null);
      await schemaStore.loadAttributes(entity.logicalName);
      // If the load failed, attributes won't be in the store — show a per-entity error.
      if (!useSchemaStore.getState().attributes.has(entity.logicalName)) {
        setAttributeError('Failed to load attributes.');
      }
    }
    setExpanded((v) => !v);
  };

  return (
    <div>
      {/* Entity row */}
      <div
        className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 hover:bg-neutral-700/60 transition-colors group"
        onClick={handleToggle}
      >
        {/* Expand chevron */}
        <svg
          className={[
            'h-3 w-3 shrink-0 text-neutral-500 transition-transform',
            expanded ? 'rotate-90' : '',
          ].join(' ')}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>

        {/* Entity name */}
        <button
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          onClick={(e) => {
            e.stopPropagation();
            onInsertText?.(entity.logicalName);
          }}
          title={`Insert "${entity.logicalName}"`}
        >
          <span className="truncate text-xs font-semibold text-neutral-100">
            {entity.logicalName}
          </span>
          {entity.displayName && entity.displayName !== entity.logicalName && (
            <span className="truncate text-xs text-neutral-500">
              {entity.displayName}
            </span>
          )}
        </button>
      </div>

      {/* Attributes */}
      {expanded && (
        <div className="ml-5 border-l border-neutral-700 pl-2">
          {attributeError ? (
            <div className="flex items-center gap-2 px-2 py-1.5">
              <span className="text-xs text-red-400">{attributeError}</span>
              <button
                className="rounded px-2 py-0.5 text-xs bg-neutral-700 text-neutral-200 hover:bg-neutral-600 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  setAttributeError(null);
                  schemaStore.loadAttributes(entity.logicalName).then(() => {
                    if (!useSchemaStore.getState().attributes.has(entity.logicalName)) {
                      setAttributeError('Failed to load attributes.');
                    }
                  });
                }}
              >
                Retry
              </button>
            </div>
          ) : !attributes ? (
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-600 border-t-indigo-400" />
              <span className="text-xs text-neutral-500">Loading…</span>
            </div>
          ) : attributes.length === 0 ? (
            <p className="px-2 py-1 text-xs text-neutral-500">No attributes</p>
          ) : (
            attributes.map((attr) => (
              <button
                key={attr.logicalName}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-neutral-700/50 transition-colors"
                onClick={() => onInsertText?.(attr.logicalName)}
                title={`Insert "${attr.logicalName}"`}
              >
                <span className="truncate text-xs text-neutral-300">
                  {attr.logicalName}
                </span>
                <span
                  className={[
                    'ml-auto shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none',
                    attributeTypeColor(attr.attributeType),
                  ].join(' ')}
                >
                  {attr.attributeType}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function SchemaExplorer({ onInsertText, isDark = false, isConnected = false }: SchemaExplorerProps) {
  const store = useSchemaStore();
  const [search, setSearch] = useState('');

  // Load entities only once the connection is ready, and auto-retry
  // when the connection arrives (covers the initial race where the
  // tool renders before PPTB has established the connection).
  useEffect(() => {
    if (isConnected && store.entities.length === 0 && !store.loading) {
      store.loadEntities();
    }
  }, [isConnected, store]);

  const filtered = store.entities.filter((e) =>
    search.trim() === ''
      ? true
      : e.logicalName.toLowerCase().includes(search.toLowerCase()) ||
        e.displayName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className={`flex h-full flex-col ${isDark ? 'bg-neutral-800' : 'bg-gray-50'}`}>
      {/* Header */}
      <div className={`flex items-center justify-between border-b px-3 py-2 ${isDark ? 'border-neutral-700' : 'border-gray-200'}`}>
        <span className={`text-xs font-semibold ${isDark ? 'text-neutral-200' : 'text-gray-700'}`}>
          Schema
          {store.entities.length > 0 && (
            <span className="ml-1.5 text-neutral-500">
              ({store.entities.length})
            </span>
          )}
        </span>
        {store.loading && (
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-600 border-t-indigo-400" />
        )}
      </div>

      {/* Search */}
      <div className={`border-b px-3 py-2 ${isDark ? 'border-neutral-700' : 'border-gray-200'}`}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter entities…"
          className={`w-full rounded px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-indigo-500 transition ${isDark ? 'bg-neutral-700 text-neutral-200 placeholder:text-neutral-500' : 'bg-white text-gray-700 placeholder:text-gray-400 border border-gray-200'}`}
        />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto py-1">
        {store.error ? (
          <div className="px-3 py-4">
            <p className="mb-2 text-xs text-red-400">{store.error}</p>
            <button
              onClick={() => store.loadEntities()}
              className={`rounded px-2.5 py-1 text-xs transition-colors ${isDark ? 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
            >
              Retry
            </button>
          </div>
        ) : store.loading && store.entities.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10">
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-neutral-600 border-t-indigo-400" />
            <p className="text-xs text-neutral-500">Loading entities…</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="mt-6 text-center text-xs text-neutral-500 select-none">
            {store.entities.length === 0
              ? 'No entities loaded'
              : 'No entities match your filter'}
          </p>
        ) : (
          filtered.map((entity) => (
            <EntityRow
              key={entity.logicalName}
              entity={entity}
              onInsertText={onInsertText}
            />
          ))
        )}
      </div>
    </div>
  );
}
