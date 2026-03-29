import { useRef, useCallback, useEffect } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import { createSqlCompletionProvider } from '../sql/completionProvider';

// Module-level flag so we only register the completion provider once, regardless
// of how many times SqlEditor mounts or remounts (Bug 6).
let completionProviderRegistered = false;

interface SqlEditorProps {
    onExecute: (sql: string) => void;
    defaultValue?: string;
    editorRef?: React.MutableRefObject<MonacoType.editor.IStandaloneCodeEditor | null>;
    theme?: 'light' | 'dark';
}

export function SqlEditor({
    onExecute,
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

    const handleExecute = useCallback(() => {
        const value = internalEditorRef.current?.getValue() ?? '';
        onExecuteRef.current(value);
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
            const value = editor.getValue();
            onExecuteRef.current(value);
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
                <span className={`text-xs ${theme === 'dark' ? 'text-gray-400' : 'text-gray-600'}`}>
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
