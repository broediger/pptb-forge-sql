import { useEffect } from 'react';
import { useSettingsStore } from '../stores/settingsStore';

interface SettingsPanelProps {
    isOpen: boolean;
    onClose: () => void;
    isDark?: boolean;
}

export function SettingsPanel({ isOpen, onClose, isDark = false }: SettingsPanelProps) {
    const { settings, updateSetting, loadFromToolbox } = useSettingsStore();

    // Load persisted settings when the panel first opens
    useEffect(() => {
        if (isOpen) {
            loadFromToolbox();
        }
    }, [isOpen, loadFromToolbox]);

    if (!isOpen) return null;

    const overlayClass = isDark ? 'bg-black/60' : 'bg-black/40';
    const dialogClass = isDark
        ? 'bg-neutral-800 border border-neutral-700 text-gray-100'
        : 'bg-white border border-gray-200 text-gray-900';
    const labelClass = isDark ? 'text-gray-300' : 'text-gray-700';
    const subtextClass = isDark ? 'text-neutral-400' : 'text-gray-500';
    const inputClass = isDark
        ? 'bg-neutral-700 border-neutral-600 text-gray-100 focus:border-indigo-500'
        : 'bg-white border-gray-300 text-gray-900 focus:border-indigo-500';
    const dividerClass = isDark ? 'border-neutral-700' : 'border-gray-200';

    return (
        <div className={`fixed inset-0 z-50 flex items-center justify-center ${overlayClass}`}>
            <div className={`rounded-lg shadow-xl w-full max-w-md mx-4 p-5 ${dialogClass}`}>
                {/* Header */}
                <div className="flex items-center justify-between mb-5">
                    <h2 className="text-sm font-semibold">Forge SQL Settings</h2>
                    <button
                        onClick={onClose}
                        className={`p-1 rounded transition-colors ${isDark ? 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
                        aria-label="Close settings"
                    >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Settings list */}
                <div className="space-y-5">
                    {/* Batch Size */}
                    <div>
                        <label className={`block text-xs font-medium mb-1.5 ${labelClass}`}>Batch Size</label>
                        <div className="flex items-center gap-2">
                            <span className={`text-xs ${subtextClass} shrink-0`}>
                                Insert/Update/Delete records in batches of
                            </span>
                            <input
                                type="number"
                                min={1}
                                max={1000}
                                value={settings.batchSize}
                                onChange={(e) => {
                                    const val = Math.max(1, Math.min(1000, parseInt(e.target.value, 10) || 1));
                                    updateSetting('batchSize', val);
                                }}
                                className={`w-20 px-2 py-1 text-sm rounded border outline-none transition-colors ${inputClass}`}
                            />
                            <span className={`text-xs ${subtextClass} shrink-0`}>records</span>
                        </div>
                    </div>

                    <div className={`border-t ${dividerClass}`} />

                    {/* Show FetchXML */}
                    <div>
                        <label className="flex items-start gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={settings.showFetchXml}
                                onChange={(e) => updateSetting('showFetchXml', e.target.checked)}
                                className="mt-0.5 h-4 w-4 rounded accent-indigo-500 cursor-pointer"
                            />
                            <span className={`text-xs ${labelClass}`}>
                                Auto-show FetchXML tab after query execution
                            </span>
                        </label>
                    </div>
                </div>

                {/* Footer */}
                <div className={`flex justify-end mt-6 pt-4 border-t ${dividerClass}`}>
                    <button
                        onClick={onClose}
                        className={`px-4 py-1.5 text-sm rounded font-medium transition-colors ${
                            isDark
                                ? 'bg-neutral-700 hover:bg-neutral-600 text-gray-200'
                                : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                        }`}
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
