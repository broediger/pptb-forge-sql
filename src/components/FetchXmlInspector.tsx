import { useState } from 'react';
import Editor from '@monaco-editor/react';

interface FetchXmlInspectorProps {
    fetchXml: string | null;
    theme?: 'light' | 'dark';
}

export function FetchXmlInspector({ fetchXml, theme }: FetchXmlInspectorProps) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        if (!fetchXml) return;
        let success = false;
        try {
            if (window.toolboxAPI?.utils?.copyToClipboard) {
                await window.toolboxAPI.utils.copyToClipboard(fetchXml);
                success = true;
            } else {
                await navigator.clipboard.writeText(fetchXml);
                success = true;
            }
        } catch {
            // Primary method failed — try navigator.clipboard as fallback
            try {
                await navigator.clipboard.writeText(fetchXml);
                success = true;
            } catch {
                // Both methods failed — don't show "Copied!"
            }
        }
        if (success) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    if (fetchXml === null) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-xs text-neutral-400 select-none">Execute a query to see the generated FetchXML</p>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            {/* Toolbar */}
            <div className="flex items-center justify-between border-b border-neutral-700 bg-neutral-800 px-3 py-1.5">
                <span className="text-xs font-medium text-neutral-300">FetchXML</span>
                <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors
            bg-neutral-700 text-neutral-200 hover:bg-neutral-600 active:bg-neutral-500"
                >
                    {copied ? (
                        <>
                            <svg
                                className="h-3.5 w-3.5 text-green-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2.5}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                            <span className="text-green-400">Copied!</span>
                        </>
                    ) : (
                        <>
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
                                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-4 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                                />
                            </svg>
                            Copy
                        </>
                    )}
                </button>
            </div>

            {/* Monaco Editor */}
            <div className="min-h-0 flex-1">
                <Editor
                    height="100%"
                    language="xml"
                    value={fetchXml}
                    theme={theme === 'dark' ? 'vs-dark' : 'light'}
                    options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        lineNumbers: 'off',
                        scrollBeyondLastLine: false,
                        wordWrap: 'on',
                        fontSize: 12,
                    }}
                />
            </div>
        </div>
    );
}
