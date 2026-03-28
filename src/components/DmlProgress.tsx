import type { DmlProgress as DmlProgressType } from '../hooks/useDmlExecution';

interface DmlProgressProps {
    progress: DmlProgressType;
    onCancel: () => void;
    isDark?: boolean;
}

export function DmlProgress({ progress, onCancel, isDark = false }: DmlProgressProps) {
    const { operation, total, completed, cancelled } = progress;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const operationLabel = operation.charAt(0) + operation.slice(1).toLowerCase();

    const containerClass = isDark
        ? 'bg-neutral-800 border-neutral-700 text-gray-100'
        : 'bg-white border-gray-200 text-gray-900';
    const subtextClass = isDark ? 'text-neutral-400' : 'text-gray-500';
    const trackClass = isDark ? 'bg-neutral-700' : 'bg-gray-200';
    const barColor =
        operation === 'DELETE'
            ? 'bg-red-500'
            : operation === 'UPDATE'
              ? 'bg-yellow-500'
              : 'bg-indigo-500';

    return (
        <div className={`rounded-lg border shadow-sm p-4 ${containerClass}`}>
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    {!cancelled && (
                        <svg
                            className={`animate-spin h-3.5 w-3.5 ${isDark ? 'text-neutral-400' : 'text-gray-400'}`}
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
                    )}
                    <span className="text-sm font-medium">
                        {cancelled ? 'Cancelled' : `${operationLabel}ing…`}
                    </span>
                </div>
                <span className={`text-xs font-mono ${subtextClass}`}>
                    {completed}/{total} ({pct}%)
                </span>
            </div>

            {/* Progress bar */}
            <div className={`w-full rounded-full h-1.5 overflow-hidden ${trackClass}`}>
                <div
                    className={`h-full rounded-full transition-all duration-150 ${barColor}`}
                    style={{ width: `${pct}%` }}
                />
            </div>

            {/* Cancel button */}
            {!cancelled && (
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
            )}
        </div>
    );
}
