import { useState } from 'react';
import type { DmlConfirmation } from '../hooks/useDmlExecution';

interface DmlConfirmDialogProps {
    confirmation: DmlConfirmation;
    onConfirm: () => void;
    onCancel: () => void;
    isDark?: boolean;
}

export function DmlConfirmDialog({ confirmation, onConfirm, onCancel, isDark = false }: DmlConfirmDialogProps) {
    const [typeInput, setTypeInput] = useState('');

    const { operation, table, affectedCount, sampleRecords, typeToConfirm } = confirmation;
    const isDelete = operation === 'DELETE';

    const confirmDisabled = typeToConfirm ? typeInput !== table : false;

    const confirmBtnClass = isDelete
        ? 'bg-red-600 hover:bg-red-700 text-white'
        : 'bg-yellow-500 hover:bg-yellow-600 text-white';

    const overlayClass = isDark ? 'bg-black/60' : 'bg-black/40';
    const dialogClass = isDark
        ? 'bg-neutral-800 border border-neutral-700 text-gray-100'
        : 'bg-white border border-gray-200 text-gray-900';
    const subtextClass = isDark ? 'text-neutral-400' : 'text-gray-500';
    const inputClass = isDark
        ? 'bg-neutral-700 border-neutral-600 text-gray-100 placeholder-neutral-500 focus:border-indigo-500'
        : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-indigo-500';
    const tableHeaderClass = isDark ? 'bg-neutral-700 text-neutral-300' : 'bg-gray-100 text-gray-600';
    const tableCellClass = isDark ? 'border-neutral-700 text-neutral-300' : 'border-gray-200 text-gray-700';
    const tableRowEven = isDark ? 'bg-neutral-750' : 'bg-gray-50';

    const operationLabel = operation.charAt(0) + operation.slice(1).toLowerCase();

    // Determine sample columns to display (up to 5 fields, skip system fields)
    const sampleColumns: string[] = sampleRecords && sampleRecords.length > 0
        ? Object.keys(sampleRecords[0])
            .filter((k) => !k.startsWith('@'))
            .slice(0, 5)
        : [];

    return (
        <div className={`fixed inset-0 z-50 flex items-center justify-center ${overlayClass}`}>
            <div className={`rounded-lg shadow-xl w-full max-w-lg mx-4 p-5 ${dialogClass}`}>
                {/* Header */}
                <div className="flex items-center gap-3 mb-4">
                    <div className={`flex items-center justify-center w-9 h-9 rounded-full shrink-0 ${isDelete ? 'bg-red-100 text-red-600' : 'bg-yellow-100 text-yellow-600'}`}>
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                        </svg>
                    </div>
                    <div>
                        <h2 className="text-sm font-semibold">Confirm {operationLabel}</h2>
                        <p className={`text-xs ${subtextClass}`}>
                            This will {operation.toLowerCase()} {affectedCount} record{affectedCount !== 1 ? 's' : ''} in <span className="font-mono">{table}</span>
                        </p>
                    </div>
                </div>

                {/* Sample records preview for DELETE */}
                {isDelete && sampleRecords && sampleRecords.length > 0 && sampleColumns.length > 0 && (
                    <div className="mb-4">
                        <p className={`text-xs font-medium mb-1.5 ${subtextClass}`}>
                            Preview (first {sampleRecords.length} of {affectedCount} records to be deleted):
                        </p>
                        <div className="overflow-x-auto rounded border border-inherit">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr>
                                        {sampleColumns.map((col) => (
                                            <th
                                                key={col}
                                                className={`px-2 py-1.5 text-left font-medium truncate max-w-[120px] ${tableHeaderClass}`}
                                            >
                                                {col}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {sampleRecords.map((row, i) => (
                                        <tr key={i} className={i % 2 === 1 ? tableRowEven : ''}>
                                            {sampleColumns.map((col) => (
                                                <td
                                                    key={col}
                                                    className={`px-2 py-1.5 border-t truncate max-w-[120px] font-mono ${tableCellClass}`}
                                                >
                                                    {row[col] === null || row[col] === undefined
                                                        ? <span className={subtextClass}>null</span>
                                                        : String(row[col])}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* Type-to-confirm input */}
                {typeToConfirm && (
                    <div className="mb-4">
                        <label className={`text-xs font-medium block mb-1 ${subtextClass}`}>
                            Type <span className="font-mono font-semibold">{table}</span> to confirm:
                        </label>
                        <input
                            type="text"
                            value={typeInput}
                            onChange={(e) => setTypeInput(e.target.value)}
                            placeholder={table}
                            className={`w-full px-3 py-1.5 text-sm rounded border outline-none transition-colors ${inputClass}`}
                            autoFocus
                        />
                    </div>
                )}

                {/* Warning text */}
                <p className={`text-xs mb-5 ${subtextClass}`}>
                    {isDelete
                        ? 'Deleted records cannot be recovered. Make sure you have a backup if needed.'
                        : 'This operation will modify records in Dataverse. Proceed with caution.'}
                </p>

                {/* Actions */}
                <div className="flex justify-end gap-2">
                    <button
                        onClick={onCancel}
                        className={`px-4 py-1.5 text-sm rounded transition-colors ${
                            isDark
                                ? 'bg-neutral-700 hover:bg-neutral-600 text-gray-200'
                                : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                        }`}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        disabled={confirmDisabled}
                        className={`px-4 py-1.5 text-sm rounded font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${confirmBtnClass}`}
                    >
                        {operationLabel} {affectedCount} record{affectedCount !== 1 ? 's' : ''}
                    </button>
                </div>
            </div>
        </div>
    );
}
