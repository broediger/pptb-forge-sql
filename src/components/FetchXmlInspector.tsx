import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { fetchXmlPrefill, toToolChoices, type ToolChoice } from '../utils/toolInvocation';

interface FetchXmlInspectorProps {
    fetchXml: string | null;
    theme?: 'light' | 'dark';
}

export function FetchXmlInspector({ fetchXml, theme }: FetchXmlInspectorProps) {
    const [copied, setCopied] = useState(false);
    const [tools, setTools] = useState<ToolChoice[]>([]);
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // Installed tools that accept FetchXML (#38). Hosts without the
    // invocation API, or without such tools, show no Send to button.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const found = await window.toolboxAPI?.invocation?.findToolsByCapability?.('fetchxml');
                if (!cancelled) setTools(toToolChoices(found));
            } catch {
                // invocation API not available
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!menuOpen) return;
        const close = (e: MouseEvent) => {
            if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [menuOpen]);

    // "Send to": open the tool with the FetchXML, without expecting data back.
    // The promise settles only when that tool closes, so it isn't awaited.
    const sendTo = (tool: ToolChoice) => {
        setMenuOpen(false);
        if (!fetchXml) return;
        const notifyFailure = (err: unknown) => {
            try {
                window.toolboxAPI.utils.showNotification({
                    title: `Could not open ${tool.name}`,
                    body: err instanceof Error ? err.message : String(err),
                    type: 'error',
                });
            } catch {
                // toolboxAPI may not be available
            }
        };
        // The host may lack launchTool (older PPTB), or it may throw synchronously.
        try {
            const invocation = window.toolboxAPI?.invocation;
            if (typeof invocation?.launchTool !== 'function') {
                notifyFailure(new Error('This version of Power Platform ToolBox cannot open other tools.'));
                return;
            }
            invocation.launchTool(tool.id, fetchXmlPrefill(fetchXml), { noReturn: true }).catch(notifyFailure);
        } catch (err) {
            notifyFailure(err);
        }
    };

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
                <div className="flex items-center gap-2">
                    {tools.length > 0 && (
                        <div ref={menuRef} className="relative">
                            <button
                                onClick={() => (tools.length === 1 ? sendTo(tools[0]) : setMenuOpen((o) => !o))}
                                title="Open this FetchXML in another tool"
                                className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors
            bg-neutral-700 text-neutral-200 hover:bg-neutral-600 active:bg-neutral-500"
                            >
                                {tools.length === 1 ? `Open in ${tools[0].name}` : 'Send to'}
                                {tools.length > 1 && (
                                    <svg
                                        className="h-3 w-3"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={2}
                                    >
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                                    </svg>
                                )}
                            </button>
                            {menuOpen && (
                                <div
                                    role="menu"
                                    className="absolute right-0 z-20 mt-1 min-w-[180px] rounded border border-neutral-600 bg-neutral-800 py-1 shadow-lg"
                                >
                                    {tools.map((tool) => (
                                        <button
                                            key={tool.id}
                                            role="menuitem"
                                            onClick={() => sendTo(tool)}
                                            className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-700"
                                        >
                                            {tool.name}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
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
