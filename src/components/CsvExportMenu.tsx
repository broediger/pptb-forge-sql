import { useEffect, useRef, useState } from 'react';
import type { CsvDelimiter } from '../utils/export';

interface CsvExportMenuProps {
    onExport: (delimiter: CsvDelimiter) => void;
    lastDelimiter: CsvDelimiter;
    exporting: boolean;
    disabled: boolean;
    isDark?: boolean;
}

const OPTIONS: { value: CsvDelimiter; label: string; hint: string }[] = [
    { value: ',', label: 'Comma (,)', hint: 'Standard CSV, decimal point (1.5)' },
    { value: ';', label: 'Semicolon (;)', hint: 'Excel in DE/AT/ES etc., decimal comma (1,5)' },
];

/** "CSV" export button that asks for the delimiter; the last-used one is marked. */
export function CsvExportMenu({ onExport, lastDelimiter, exporting, disabled, isDark = false }: CsvExportMenuProps) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Close on outside click or Escape
    useEffect(() => {
        if (!open) return;
        const handleMouseDown = (e: MouseEvent) => {
            if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', handleMouseDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handleMouseDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [open]);

    return (
        <div ref={containerRef} className="relative">
            <button
                onClick={() => setOpen((o) => !o)}
                disabled={disabled}
                aria-haspopup="menu"
                aria-expanded={open}
                className={`px-2.5 py-1 text-xs rounded transition-colors disabled:opacity-50 disabled:cursor-wait ${isDark ? 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'}`}
                title="Export as CSV"
            >
                {exporting ? 'Exporting…' : 'CSV ▾'}
            </button>
            {open && (
                <div
                    role="menu"
                    className={`absolute right-0 top-full mt-1 z-50 w-64 rounded-md border shadow-lg py-1 ${isDark ? 'bg-neutral-800 border-neutral-700' : 'bg-white border-gray-200'}`}
                >
                    {OPTIONS.map((opt) => (
                        <button
                            key={opt.value}
                            role="menuitem"
                            onClick={() => {
                                setOpen(false);
                                onExport(opt.value);
                            }}
                            className={`w-full flex items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors ${isDark ? 'text-gray-200 hover:bg-neutral-700' : 'text-gray-700 hover:bg-gray-100'}`}
                        >
                            <span className="w-3 shrink-0 text-indigo-500">
                                {opt.value === lastDelimiter ? '✓' : ''}
                            </span>
                            <span>
                                <span className="block font-medium">{opt.label}</span>
                                <span className={`block ${isDark ? 'text-neutral-400' : 'text-gray-500'}`}>
                                    {opt.hint}
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
