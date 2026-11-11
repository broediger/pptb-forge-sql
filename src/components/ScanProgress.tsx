interface ScanProgressProps {
    /** Rows read so far. */
    scannedRows: number;
    onCancel: () => void;
    isDark?: boolean;
}

/**
 * Shown while an aggregate over Dataverse's 50,000-record limit is computed
 * client-side. Cancel stops after the current page and shows the partial values.
 */
export function ScanProgress({ scannedRows, onCancel, isDark = false }: ScanProgressProps) {
    const containerClass = isDark
        ? 'bg-neutral-800 border-neutral-700 text-gray-100'
        : 'bg-white border-gray-200 text-gray-900';
    const subtextClass = isDark ? 'text-neutral-400' : 'text-gray-500';
    const trackClass = isDark ? 'bg-neutral-700' : 'bg-gray-200';

    return (
        <div className={`rounded-lg border shadow-sm p-4 ${containerClass}`}>
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    <svg
                        className={`animate-spin h-3.5 w-3.5 ${isDark ? 'text-neutral-400' : 'text-gray-400'}`}
                        fill="none"
                        viewBox="0 0 24 24"
                    >
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                    </svg>
                    <span className="text-sm font-medium">Aggregating client-side…</span>
                </div>
                <span className={`text-xs font-mono ${subtextClass}`}>{scannedRows.toLocaleString()} rows read</span>
            </div>
            <p className={`text-xs mb-2 ${subtextClass}`}>
                Dataverse refused the aggregate (more than 50,000 records), so the rows are read page by page.
            </p>
            <div className={`w-full rounded-full h-1.5 overflow-hidden ${trackClass}`}>
                <div className="h-full w-full rounded-full bg-indigo-500 opacity-40 animate-pulse" />
            </div>
            <div className="flex justify-end mt-3">
                <button
                    onClick={onCancel}
                    className={`px-3 py-1 text-xs rounded transition-colors ${
                        isDark
                            ? 'bg-neutral-700 hover:bg-neutral-600 text-gray-300'
                            : 'bg-gray-100 hover:bg-gray-200 text-gray-600'
                    }`}
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}
