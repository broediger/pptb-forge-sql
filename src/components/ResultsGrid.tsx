import React, { useMemo } from 'react';
import {
    useReactTable,
    getCoreRowModel,
    getSortedRowModel,
    flexRender,
    createColumnHelper,
    type SortingState,
    type ColumnDef,
} from '@tanstack/react-table';

interface ResultsGridProps {
    data: Record<string, unknown>[];
    columns: string[];
    onLoadMore?: () => void;
    hasMore?: boolean;
    isLoading?: boolean;
    isDark?: boolean;
}

function formatCellValue(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

function isNullish(value: unknown): boolean {
    return value === null || value === undefined;
}

const columnHelper = createColumnHelper<Record<string, unknown>>();

export const ResultsGrid: React.FC<ResultsGridProps> = ({
    data,
    columns,
    onLoadMore,
    hasMore = false,
    isLoading = false,
    isDark = false,
}) => {
    const [sorting, setSorting] = React.useState<SortingState>([]);

    const columnDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
        () =>
            columns.map((col) =>
                columnHelper.accessor((row) => row[col], {
                    id: col,
                    header: col,
                    enableSorting: true,
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
                })
            ),
        [columns]
    );

    const table = useReactTable({
        data,
        columns: columnDefs,
        state: { sorting },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
    });

    if (data.length === 0 && !isLoading) {
        return (
            <div className={`flex items-center justify-center py-12 text-sm italic ${isDark ? 'text-gray-400' : 'text-gray-400'}`}>
                No results
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            <div className="overflow-auto max-h-[calc(100vh-16rem)] flex-1">
                <table className="w-full text-sm border-collapse">
                    <thead>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr key={headerGroup.id}>
                                {headerGroup.headers.map((header) => {
                                    const sorted = header.column.getIsSorted();
                                    return (
                                        <th
                                            key={header.id}
                                            className={`sticky top-0 text-left px-3 py-2 font-medium border-b cursor-pointer select-none whitespace-nowrap z-10 ${isDark ? 'bg-gray-800 text-gray-300' : 'bg-gray-100 text-gray-700'}`}
                                            onClick={header.column.getToggleSortingHandler()}
                                        >
                                            <span className="flex items-center gap-1">
                                                {flexRender(
                                                    header.column.columnDef.header,
                                                    header.getContext()
                                                )}
                                                {sorted === 'asc' && (
                                                    <span className="text-gray-400">▲</span>
                                                )}
                                                {sorted === 'desc' && (
                                                    <span className="text-gray-400">▼</span>
                                                )}
                                                {!sorted && (
                                                    <span className="text-gray-300 opacity-0 group-hover:opacity-100">
                                                        ▲
                                                    </span>
                                                )}
                                            </span>
                                        </th>
                                    );
                                })}
                            </tr>
                        ))}
                    </thead>
                    <tbody>
                        {table.getRowModel().rows.map((row, rowIndex) => (
                            <tr
                                key={row.id}
                                className={rowIndex % 2 === 0 ? '' : isDark ? 'bg-gray-800/50' : 'bg-gray-50/50'}
                            >
                                {row.getVisibleCells().map((cell) => {
                                    const rawValue = cell.getValue();
                                    const displayText = formatCellValue(rawValue);
                                    const isNull = isNullish(rawValue);

                                    return (
                                        <td
                                            key={cell.id}
                                            className={`px-3 py-1.5 border-b truncate max-w-xs ${isDark ? 'border-gray-700 text-gray-200' : 'border-gray-100 text-gray-800'}`}
                                            title={isNull ? 'null' : displayText}
                                        >
                                            {isNull ? (
                                                <span className="text-gray-400 italic">null</span>
                                            ) : (
                                                displayText
                                            )}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {isLoading && (
                <div className="flex items-center justify-center gap-2 py-3 text-sm text-gray-500">
                    <svg
                        className="animate-spin h-4 w-4 text-gray-400"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                    >
                        <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                        />
                        <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                    </svg>
                    Loading...
                </div>
            )}

            {hasMore && onLoadMore && !isLoading && (
                <div className={`flex justify-center py-3 border-t ${isDark ? 'border-gray-700' : 'border-gray-100'}`}>
                    <button
                        onClick={onLoadMore}
                        className={`px-4 py-1.5 text-sm font-medium rounded border transition-colors cursor-pointer ${isDark ? 'text-gray-300 bg-gray-700 hover:bg-gray-600 border-gray-600' : 'text-gray-600 bg-gray-100 hover:bg-gray-200 border-gray-200'}`}
                    >
                        Load More
                    </button>
                </div>
            )}
        </div>
    );
};
