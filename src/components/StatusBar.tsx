import React from 'react';

interface StatusBarProps {
    rowCount: number | null;
    executionTime: number | null;
    error: string | null;
    isExecuting: boolean;
    isDark?: boolean;
}

export const StatusBar: React.FC<StatusBarProps> = ({
    rowCount,
    executionTime,
    error,
    isExecuting,
    isDark = false,
}) => {
    return (
        <div className={`flex items-center gap-4 px-3 py-1.5 text-xs border-t min-h-[28px] ${isDark ? 'bg-gray-800 text-gray-300 border-gray-700' : 'bg-gray-100 border-gray-200'}`}>
            {isExecuting ? (
                <span className="text-gray-500 animate-pulse">Executing...</span>
            ) : error ? (
                <span
                    className="text-red-600 truncate max-w-full"
                    title={error}
                >
                    {error}
                </span>
            ) : (
                <>
                    {rowCount !== null && (
                        <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>
                            {rowCount} {rowCount === 1 ? 'row' : 'rows'}
                        </span>
                    )}
                    {executionTime !== null && (
                        <span className={isDark ? 'text-gray-400' : 'text-gray-400'}>{executionTime} ms</span>
                    )}
                    {rowCount === null && executionTime === null && (
                        <span className={`italic ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Ready</span>
                    )}
                </>
            )}
        </div>
    );
};
