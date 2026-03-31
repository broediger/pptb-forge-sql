import { useRef, useCallback, useEffect } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import { createSqlCompletionProvider } from '../sql/completionProvider';

// Module-level flag so we only register the completion provider once, regardless
// of how many times SqlEditor mounts or remounts (Bug 6).
let completionProviderRegistered = false;

interface SqlEditorProps {
    onExecute: (sql: string) => void;
    onSave?: () => void;
    onOpen?: () => void;
    defaultValue?: string;
    editorRef?: React.MutableRefObject<MonacoType.editor.IStandaloneCodeEditor | null>;
    theme?: 'light' | 'dark';
}

export function SqlEditor({
    onExecute,
    onSave,
    onOpen,
    defaultValue = 'SELECT TOP 10 * FROM account',
    editorRef: externalEditorRef,
    theme,
}: SqlEditorProps) {
    const internalEditorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);

    // Keep a ref to the latest onExecute callback so the Ctrl+Enter keybinding
    // registered on mount always calls the current prop (Bug 4).
    const onExecuteRef = useRef(onExecute);
    useEffect(() => {
        onExecuteRef.current = onExecute;
    }, [onExecute]);

    const onSaveRef = useRef(onSave);
    useEffect(() => {
        onSaveRef.current = onSave;
    }, [onSave]);

    const onOpenRef = useRef(onOpen);
    useEffect(() => {
        onOpenRef.current = onOpen;
    }, [onOpen]);

    const handleExecute = useCallback(() => {
        const editor = internalEditorRef.current;
        if (!editor) return;

        // If text is selected, execute only the selection
        const selection = editor.getSelection();
        if (selection && !selection.isEmpty()) {
            const selectedText = editor.getModel()?.getValueInRange(selection) ?? '';
            if (selectedText.trim()) {
                onExecuteRef.current(selectedText);
                return;
            }
        }

        // No selection: find the statement at the cursor position
        // Statements are separated by blank lines or semicolons
        const fullText = editor.getValue();
        const cursorLine = editor.getPosition()?.lineNumber ?? 1;
        const lines = fullText.split('\n');

        // Split into statement blocks by blank lines
        const blocks: { startLine: number; endLine: number; text: string }[] = [];
        let blockStart = 0;
        let blockLines: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (trimmed === '' || trimmed === ';') {
                if (blockLines.length > 0) {
                    blocks.push({
                        startLine: blockStart + 1,
                        endLine: i,
                        text: blockLines.join('\n').replace(/;\s*$/, ''),
                    });
                    blockLines = [];
                }
                blockStart = i + 1;
            } else {
                if (blockLines.length === 0) blockStart = i;
                blockLines.push(lines[i]);
            }
        }
        if (blockLines.length > 0) {
            blocks.push({
                startLine: blockStart + 1,
                endLine: lines.length,
                text: blockLines.join('\n').replace(/;\s*$/, ''),
            });
        }

        // Find the block containing the cursor
        const currentBlock = blocks.find((b) => cursorLine >= b.startLine && cursorLine <= b.endLine);
        const sql = currentBlock?.text ?? fullText;
        onExecuteRef.current(sql.trim());
    }, []);

    const handleMount: OnMount = (editor, monaco) => {
        internalEditorRef.current = editor;
        if (externalEditorRef) externalEditorRef.current = editor;

        // Only register the completion provider once to avoid duplicates on remount (Bug 6).
        if (!completionProviderRegistered) {
            monaco.languages.registerCompletionItemProvider('sql', createSqlCompletionProvider());
            completionProviderRegistered = true;
        }

        // The command handler reads from the ref so it always calls the latest
        // onExecute even though this closure is created only once (Bug 4).
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
            handleExecute();
        });

        // Ctrl/Cmd+S → Save query
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            onSaveRef.current?.();
        });

        // Ctrl/Cmd+O → Open query
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, () => {
            onOpenRef.current?.();
        });
    };

    return (
        <div className="flex flex-col w-full rounded overflow-hidden border border-gray-700">
            <div
                className={`flex items-center gap-2 px-3 py-2 ${theme === 'dark' ? 'bg-gray-800' : 'bg-gray-200 text-gray-800'}`}
            >
                <button
                    onClick={handleExecute}
                    className="flex items-center gap-1.5 bg-green-600 hover:bg-green-500 active:bg-green-700 text-white text-sm font-medium px-3 py-1.5 rounded transition-colors"
                    title="Run query (Ctrl+Enter / Cmd+Enter)"
                >
                    <span className="text-base leading-none">▶</span>
                    <span>Run</span>
                </button>
                <div className="h-4 w-px bg-gray-600/50" />

                {onOpen && (
                    <button
                        onClick={onOpen}
                        className={`flex items-center gap-1 px-2 py-1.5 text-xs rounded transition-colors ${
                            theme === 'dark'
                                ? 'text-gray-300 hover:bg-gray-700 hover:text-gray-100'
                                : 'text-gray-600 hover:bg-gray-300 hover:text-gray-800'
                        }`}
                        title="Open query (Ctrl+O / Cmd+O)"
                    >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
                        </svg>
                        Open
                    </button>
                )}

                {onSave && (
                    <button
                        onClick={onSave}
                        className={`flex items-center gap-1 px-2 py-1.5 text-xs rounded transition-colors ${
                            theme === 'dark'
                                ? 'text-gray-300 hover:bg-gray-700 hover:text-gray-100'
                                : 'text-gray-600 hover:bg-gray-300 hover:text-gray-800'
                        }`}
                        title="Save query (Ctrl+S / Cmd+S)"
                    >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                        </svg>
                        Save
                    </button>
                )}

                <span className={`text-xs ml-auto ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>
                    Ctrl+Enter to execute
                </span>
            </div>
            <Editor
                height="200px"
                defaultLanguage="sql"
                defaultValue={defaultValue}
                theme={theme === 'dark' ? 'vs-dark' : 'light'}
                onMount={handleMount}
                options={{
                    minimap: { enabled: false },
                    fontSize: 14,
                    lineNumbers: 'on',
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                    automaticLayout: true,
                    tabSize: 2,
                    quickSuggestions: true,
                    suggestOnTriggerCharacters: true,
                }}
            />
        </div>
    );
}
