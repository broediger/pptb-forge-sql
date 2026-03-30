import React, { useMemo, useCallback, useRef, useState } from 'react';
import {
    useReactTable,
    getCoreRowModel,
    getSortedRowModel,
    flexRender,
    createColumnHelper,
    type SortingState,
    type ColumnDef,
    type Header,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';

interface ResultsGridProps {
    data: Record<string, unknown>[];
    columns: string[];
    onLoadMore?: () => void;
    hasMore?: boolean;
    isLoading?: boolean;
    isDark?: boolean;
    connectionUrl?: string | null;
}

// GUID pattern: 8-4-4-4-12 hex chars
const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isGuid(value: unknown): value is string {
    return typeof value === 'string' && GUID_REGEX.test(value);
}

/**
 * Resolve the entity logical name for a GUID column. Prefers the _type
 * annotation from the same row (e.g. _ownerid_value_type = "systemuser")
 * over guessing from the column name.
 */
function resolveEntityName(columnName: string, row: Record<string, unknown>): string | null {
    // Check for _xxxid_value_type annotation in the row data
    const lookupMatch = columnName.match(/^_(.+)_value$/);
    if (lookupMatch) {
        const typeKey = `${columnName}_type`;
        const typeVal = row[typeKey];
        if (typeof typeVal === 'string' && typeVal) return typeVal;
        // Fallback: strip "id" suffix
        const ref = lookupMatch[1];
        return ref.endsWith('id') ? ref.slice(0, -2) : ref;
    }
    // Primary key columns: entitynameid → entityname
    if (columnName.endsWith('id') && columnName.length > 2) {
        return columnName.slice(0, -2);
    }
    return null;
}

function formatCellValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function isNullish(value: unknown): boolean {
    return value === null || value === undefined;
}

// ── Column resize handle ──

function ResizeHandle<T>({ header, isDark }: { header: Header<T, unknown>; isDark: boolean }) {
    return (
        <div
            onMouseDown={header.getResizeHandler()}
            onTouchStart={header.getResizeHandler()}
            className={`absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none ${
                header.column.getIsResizing()
                    ? isDark
                        ? 'bg-blue-500'
                        : 'bg-blue-400'
                    : isDark
                      ? 'bg-gray-600 hover:bg-gray-500'
                      : 'bg-gray-300 hover:bg-gray-400'
            }`}
        />
    );
}

// ── Spinner component ──

function Spinner() {
    return (
        <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
    );
}

// ── Main component ──

const columnHelper = createColumnHelper<Record<string, unknown>>();

export const ResultsGrid: React.FC<ResultsGridProps> = ({
    data,
    columns,
    onLoadMore,
    hasMore = false,
    isLoading = false,
    isDark = false,
    connectionUrl,
}) => {
    const [sorting, setSorting] = useState<SortingState>([]);
    const tableContainerRef = useRef<HTMLDivElement>(null);

    const openRecord = useCallback(
        async (entityName: string, recordId: string) => {
            if (!connectionUrl) return;
            const base = connectionUrl.replace(/\/+$/, '');
            const url = `${base}/main.aspx?etn=${encodeURIComponent(entityName)}&id=${encodeURIComponent(recordId)}&pagetype=entityrecord`;

            // Open in the system default browser via a hidden PPTB terminal
            // (window.open stays inside Electron, so we shell out instead)
            try {
                const term = await window.toolboxAPI.terminal.create({
                    name: 'open-url',
                    visible: false,
                });
                // macOS: open, Windows: start, Linux: xdg-open
                const platform = navigator.platform.toLowerCase();
                const cmd = platform.includes('win')
                    ? `start "" "${url}"`
                    : platform.includes('linux')
                      ? `xdg-open "${url}"`
                      : `open "${url}"`;
                await window.toolboxAPI.terminal.execute(term.id, cmd);
                await window.toolboxAPI.terminal.close(term.id);
            } catch {
                // Fallback if terminal API is unavailable
                window.open(url, '_blank');
            }
        },
        [connectionUrl],
    );

    // Memoize which columns contain GUIDs based on the first row's values,
    // so the regex is not re-run for every cell on every render.
    const guidColumns = useMemo(() => {
        const set = new Set<string>();
        if (data.length === 0) return set;
        const sample = data[0];
        for (const col of columns) {
            if (isGuid(sample[col])) set.add(col);
        }
        return set;
    }, [data, columns]);

    const columnDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
        () =>
            columns.map((col) =>
                columnHelper.accessor((row) => row[col], {
                    id: col,
                    header: col,
                    enableSorting: true,
                    enableResizing: true,
                    size: 180,
                    minSize: 60,
                    maxSize: 600,
                    sortingFn: (rowA, rowB, columnId) => {
                        const a = rowA.getValue(columnId);
                        const b = rowB.getValue(columnId);
                        if (a === null || a === undefined) return 1;
                        if (b === null || b === undefined) return -1;
                        if (typeof a === 'number' && typeof b === 'number') {
                            return a < b ? -1 : a > b ? 1 : 0;
                        }
                        const aStr = formatCellValue(a).toLowerCase();
                        const bStr = formatCellValue(b).toLowerCase();
                        return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
                    },
                }),
            ),
        [columns],
    );

    // eslint-disable-next-line react-hooks/incompatible-library
    const table = useReactTable({
        data,
        columns: columnDefs,
        state: { sorting },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        columnResizeMode: 'onChange',
        enableColumnResizing: true,
    });

    const rowVirtualizer = useVirtualizer({
        count: table.getRowModel().rows.length,
        getScrollElement: () => tableContainerRef.current,
        estimateSize: () => 33, // approximate row height in px
        overscan: 15,
    });

    if (data.length === 0 && !isLoading) {
        return (
            <div
                className={`flex items-center justify-center py-12 text-sm italic ${isDark ? 'text-gray-400' : 'text-gray-400'}`}
            >
                No results
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Loading overlay when re-executing with existing results */}
            {isLoading && data.length > 0 && (
                <div
                    className={`flex items-center gap-2 px-3 py-1.5 text-xs border-b ${
                        isDark
                            ? 'bg-blue-950/40 border-blue-800/40 text-blue-300'
                            : 'bg-blue-50 border-blue-200 text-blue-600'
                    }`}
                >
                    <Spinner />
                    Executing query…
                </div>
            )}

            <div ref={tableContainerRef} className="overflow-auto flex-1">
                <table className="text-sm border-collapse" style={{ width: table.getCenterTotalSize() }}>
                    <thead>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr key={headerGroup.id} style={{ display: 'flex', width: table.getCenterTotalSize() }}>
                                {headerGroup.headers.map((header) => {
                                    const sorted = header.column.getIsSorted();
                                    return (
                                        <th
                                            key={header.id}
                                            className={`sticky top-0 text-left px-3 py-2 font-medium cursor-pointer select-none whitespace-nowrap z-10 relative ${
                                                isDark
                                                    ? 'bg-gray-800 text-gray-300 border-b border-r border-gray-600'
                                                    : 'bg-gray-100 text-gray-700 border-b border-r border-gray-300'
                                            }`}
                                            style={{ flex: 'none', width: header.getSize() }}
                                            onClick={header.column.getToggleSortingHandler()}
                                        >
                                            <span className="flex items-center gap-1">
                                                {flexRender(header.column.columnDef.header, header.getContext())}
                                                {sorted === 'asc' && <span className="text-gray-400">▲</span>}
                                                {sorted === 'desc' && <span className="text-gray-400">▼</span>}
                                            </span>
                                            <ResizeHandle header={header} isDark={isDark} />
                                        </th>
                                    );
                                })}
                            </tr>
                        ))}
                    </thead>
                    <tbody style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}>
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                            const row = table.getRowModel().rows[virtualRow.index];
                            return (
                                <tr
                                    key={row.id}
                                    data-index={virtualRow.index}
                                    ref={(node) => rowVirtualizer.measureElement(node)}
                                    style={{
                                        display: 'flex',
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        width: table.getCenterTotalSize(),
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                    className={
                                        virtualRow.index % 2 === 0 ? '' : isDark ? 'bg-gray-800/50' : 'bg-gray-50/50'
                                    }
                                >
                                    {row.getVisibleCells().map((cell) => {
                                        const rawValue = cell.getValue();
                                        const displayText = formatCellValue(rawValue);
                                        const isNull = isNullish(rawValue);
                                        const colId = cell.column.id;
                                        const guidValue = guidColumns.has(colId) && isGuid(rawValue) ? rawValue : null;
                                        const entityName = guidValue ? resolveEntityName(colId, row.original) : null;
                                        const canOpenRecord = guidValue && entityName && connectionUrl;

                                        return (
                                            <td
                                                key={cell.id}
                                                className={`px-3 py-1.5 truncate ${
                                                    isDark
                                                        ? 'border-b border-r border-gray-700 text-gray-200'
                                                        : 'border-b border-r border-gray-200 text-gray-800'
                                                }`}
                                                style={{
                                                    flex: 'none',
                                                    width: cell.column.getSize(),
                                                    maxWidth: cell.column.getSize(),
                                                }}
                                                title={isNull ? 'null' : displayText}
                                            >
                                                {isNull ? (
                                                    <span className="text-gray-400 italic">null</span>
                                                ) : canOpenRecord ? (
                                                    <span className="flex items-center gap-1">
                                                        <span className="truncate font-mono text-xs">
                                                            {displayText}
                                                        </span>
                                                        <button
                                                            onClick={() => openRecord(entityName, guidValue)}
                                                            className={`shrink-0 p-0.5 rounded transition-colors ${
                                                                isDark
                                                                    ? 'text-blue-400 hover:text-blue-300 hover:bg-blue-900/40'
                                                                    : 'text-blue-500 hover:text-blue-700 hover:bg-blue-50'
                                                            }`}
                                                            title={`Open ${entityName} record`}
                                                        >
                                                            <svg
                                                                className="h-3.5 w-3.5"
                                                                fill="none"
                                                                viewBox="0 0 24 24"
                                                                stroke="currentColor"
                                                                strokeWidth={2}
                                                            >
                                                                <path
                                                                    strokeLinecap="round"
                                                                    strokeLinejoin="round"
                                                                    d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                                                                />
                                                            </svg>
                                                        </button>
                                                    </span>
                                                ) : (
                                                    displayText
                                                )}
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {isLoading && data.length === 0 && (
                <div
                    className={`flex items-center justify-center gap-2 py-3 text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}
                >
                    <Spinner />
                    Loading...
                </div>
            )}

            {hasMore && onLoadMore && !isLoading && (
                <div className={`flex justify-center py-3 border-t ${isDark ? 'border-gray-700' : 'border-gray-100'}`}>
                    <button
                        onClick={onLoadMore}
                        className={`px-4 py-1.5 text-sm font-medium rounded border transition-colors cursor-pointer ${
                            isDark
                                ? 'text-gray-300 bg-gray-700 hover:bg-gray-600 border-gray-600'
                                : 'text-gray-600 bg-gray-100 hover:bg-gray-200 border-gray-200'
                        }`}
                    >
                        Load More
                    </button>
                </div>
            )}
        </div>
    );
};
