import { useState, useCallback, useRef, useEffect } from 'react';
import type * as MonacoType from 'monaco-editor';
import { SqlEditor } from './components/SqlEditor';
import { ResultsGrid } from './components/ResultsGrid';
import { StatusBar } from './components/StatusBar';
import { FetchXmlInspector } from './components/FetchXmlInspector';
import { QueryHistory } from './components/QueryHistory';
import { SchemaExplorer } from './components/SchemaExplorer';
import { DmlConfirmDialog } from './components/DmlConfirmDialog';
import { DmlProgress } from './components/DmlProgress';
import { SettingsPanel } from './components/SettingsPanel';
import { useQueryExecution } from './hooks/useQueryExecution';
import { useDmlExecution } from './hooks/useDmlExecution';
import { useHistoryStore } from './stores/historyStore';
import { useSchemaStore } from './stores/schemaStore';
import { useSettingsStore } from './stores/settingsStore';
import { exportToCsv, exportToJson } from './utils/export';
import { useConnection, useToolboxEvents } from './hooks/useToolboxAPI';
import { useTheme } from './hooks/useTheme';
import { tokenize, parseStatement } from './sql';

type ActiveTab = 'results' | 'fetchxml' | 'history';

interface TabResults {
    results: Record<string, unknown>[] | null;
    columns: string[];
    fetchXml: string | null;
    error: string | null;
    executionTime: number | null;
    rowCount: number | null;
    dmlResult: import('./hooks/useDmlExecution').DmlResult | null;
    dmlError: string | null;
}

const EMPTY_TAB_RESULTS: TabResults = {
    results: null, columns: [], fetchXml: null, error: null,
    executionTime: null, rowCount: null, dmlResult: null, dmlError: null,
};

interface QueryTab {
    id: string;
    label: string;
    sql: string;
}

export default function App() {
    const [activeTab, setActiveTab] = useState<ActiveTab>('results');
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);

    // Query tabs state
    const [queryTabs, setQueryTabs] = useState<QueryTab[]>([
        { id: '1', label: 'Query 1', sql: 'SELECT TOP 10 * FROM account' },
    ]);
    const [activeQueryTabId, setActiveQueryTabId] = useState<string>('1');
    const [nextTabNum, setNextTabNum] = useState<number>(2);
    const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState<string>('');

    const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);
    const pendingDmlSqlRef = useRef<string>('');
    const executingTabIdRef = useRef<string>('1'); // tracks which tab started the current execution

    // Per-tab result storage
    const [tabResults, setTabResults] = useState<Record<string, TabResults>>({ '1': { ...EMPTY_TAB_RESULTS } });
    const activeTabResults = tabResults[activeQueryTabId] ?? EMPTY_TAB_RESULTS;

    const { theme, isDark } = useTheme();
    const { connection, isLoading: connectionLoading, refreshConnection } = useConnection();
    const queryExec = useQueryExecution();
    const dml = useDmlExecution();
    const addEntry = useHistoryStore(s => s.addEntry);
    const resetSchema = useSchemaStore(s => s.reset);

    // Sync query execution state into the TAB THAT STARTED the execution (not the currently active tab)
    useEffect(() => {
        if (queryExec.results !== null || queryExec.error !== null || queryExec.fetchXml !== null) {
            const tabId = executingTabIdRef.current;
            setTabResults((prev) => ({
                ...prev,
                [tabId]: {
                    ...prev[tabId] ?? EMPTY_TAB_RESULTS,
                    results: queryExec.results,
                    columns: queryExec.columns,
                    fetchXml: queryExec.fetchXml,
                    error: queryExec.error,
                    executionTime: queryExec.executionTime,
                    rowCount: queryExec.rowCount,
                },
            }));
        }
    }, [queryExec.results, queryExec.error, queryExec.fetchXml, queryExec.executionTime, queryExec.rowCount, queryExec.columns]);

    // Sync DML results into the tab that started the execution
    useEffect(() => {
        if (dml.dmlResult !== null || dml.dmlError !== null) {
            const tabId = executingTabIdRef.current;
            setTabResults((prev) => ({
                ...prev,
                [tabId]: {
                    ...prev[tabId] ?? EMPTY_TAB_RESULTS,
                    dmlResult: dml.dmlResult,
                    dmlError: dml.dmlError,
                },
            }));
        }
    }, [dml.dmlResult, dml.dmlError]);

    // Listen for connection changes and reset schema
    const handleToolboxEvent = useCallback(
        (event: string) => {
            if (
                event === 'connection:updated' ||
                event === 'connection:created' ||
                event === 'connection:deleted'
            ) {
                refreshConnection();
                resetSchema();
            }
        },
        [refreshConnection, resetSchema]
    );

    useToolboxEvents(handleToolboxEvent);

    // Query tab management
    const addQueryTab = useCallback(() => {
        // Save current editor content to active tab before adding
        const currentSql = editorRef.current?.getValue() ?? '';
        setQueryTabs((prev) =>
            prev.map((t) => (t.id === activeQueryTabId ? { ...t, sql: currentSql } : t))
        );

        const newId = String(Date.now());
        const newLabel = `Query ${nextTabNum}`;
        const newSql = 'SELECT TOP 10 * FROM account';
        setNextTabNum((n) => n + 1);
        setQueryTabs((prev) => [...prev, { id: newId, label: newLabel, sql: newSql }]);
        setTabResults((prev) => ({ ...prev, [newId]: { ...EMPTY_TAB_RESULTS } }));
        setActiveQueryTabId(newId);
        // Set editor content after state updates have been scheduled
        setTimeout(() => {
            editorRef.current?.setValue(newSql);
            editorRef.current?.focus();
        }, 0);
    }, [activeQueryTabId, nextTabNum]);

    const closeQueryTab = useCallback(
        (id: string) => {
            setQueryTabs((prev) => {
                if (prev.length <= 1) return prev;
                const idx = prev.findIndex((t) => t.id === id);
                const next = prev.filter((t) => t.id !== id);
                if (id === activeQueryTabId) {
                    const neighborIdx = Math.min(idx, next.length - 1);
                    const neighbor = next[neighborIdx];
                    setActiveQueryTabId(neighbor.id);
                    setTimeout(() => {
                        editorRef.current?.setValue(neighbor.sql);
                        editorRef.current?.focus();
                    }, 0);
                }
                return next;
            });
            // Clean up results for the closed tab
            setTabResults((prev) => {
                const copy = { ...prev };
                delete copy[id];
                return copy;
            });
        },
        [activeQueryTabId]
    );

    const switchQueryTab = useCallback(
        (id: string) => {
            if (id === activeQueryTabId) return;
            // Save current editor content to departing tab
            const currentSql = editorRef.current?.getValue() ?? '';
            setQueryTabs((prev) =>
                prev.map((t) => (t.id === activeQueryTabId ? { ...t, sql: currentSql } : t))
            );
            setActiveQueryTabId(id);
            // Load the new tab's SQL into the editor
            setQueryTabs((prev) => {
                const tab = prev.find((t) => t.id === id);
                if (tab) {
                    setTimeout(() => {
                        editorRef.current?.setValue(tab.sql);
                        editorRef.current?.focus();
                    }, 0);
                }
                return prev;
            });
        },
        [activeQueryTabId]
    );

    // Ctrl+T / Cmd+T to add a new query tab
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 't') {
                e.preventDefault();
                addQueryTab();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [addQueryTab]);

    // Add DML results to history when they resolve
    useEffect(() => {
        if (!dml.dmlResult) return;
        addEntry({
            sql: pendingDmlSqlRef.current,
            timestamp: Date.now(),
            executionTime: activeTabResults.dmlResult!.executionTime,
            rowCount: activeTabResults.dmlResult!.affectedCount,
            statementType: activeTabResults.dmlResult!.operation,
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dml.dmlResult]);

    const handleExecute = useCallback(
        async (sql: string) => {
            const trimmed = sql.trim();
            if (!trimmed) return;

            setActiveTab('results');
            executingTabIdRef.current = activeQueryTabId;

            // Determine whether this is DML or SELECT by peeking at the first token
            let isDml = false;
            try {
                const tokens = tokenize(trimmed);
                const stmt = parseStatement(tokens);
                isDml = stmt.type === 'insert' || stmt.type === 'update' || stmt.type === 'delete';
            } catch {
                // If parsing fails entirely, fall through to execute() which will report the error
            }

            if (isDml) {
                // Clear SELECT results for this tab
                setTabResults((prev) => ({
                    ...prev,
                    [activeQueryTabId]: {
                        ...prev[activeQueryTabId] ?? EMPTY_TAB_RESULTS,
                        results: null, columns: [], fetchXml: null, error: null,
                        executionTime: null, rowCount: null,
                    },
                }));
                pendingDmlSqlRef.current = trimmed;
                await dml.execute(trimmed);
                return;
            }

            // Clear DML results for this tab
            dml.clearResult();
            setTabResults((prev) => ({
                ...prev,
                [activeQueryTabId]: {
                    ...prev[activeQueryTabId] ?? EMPTY_TAB_RESULTS,
                    dmlResult: null, dmlError: null,
                },
            }));

            const result = await queryExec.execute(trimmed);

            // Auto-switch to FetchXML tab if setting is enabled
            if (useSettingsStore.getState().settings.showFetchXml) {
                setActiveTab('fetchxml');
            }

            addEntry({
                sql: trimmed,
                timestamp: Date.now(),
                executionTime: result.executionTime ?? undefined,
                rowCount: result.rowCount ?? undefined,
                error: result.error ?? undefined,
                statementType: 'SELECT',
            });
        },
        [queryExec.execute, addEntry, dml, activeQueryTabId]
    );

    const handleSelectHistory = useCallback((sql: string) => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.setValue(sql);
        editor.focus();
        setActiveTab('results');
    }, []);

    const handleInsertText = useCallback((text: string) => {
        const editor = editorRef.current;
        if (!editor) return;
        const selection = editor.getSelection();
        const id = { major: 1, minor: 1 };
        const op = {
            identifier: id,
            range: selection ?? {
                startLineNumber: 1,
                startColumn: 1,
                endLineNumber: 1,
                endColumn: 1,
            },
            text,
            forceMoveMarkers: true,
        };
        editor.executeEdits('schema-explorer', [op]);
        editor.focus();
    }, []);

    const handleExportCsv = useCallback(() => {
        if (!activeTabResults.results) return;
        exportToCsv(activeTabResults.results, activeTabResults.columns);
    }, [activeTabResults.results, activeTabResults.columns]);

    const handleExportJson = useCallback(() => {
        if (!activeTabResults.results) return;
        exportToJson(activeTabResults.results);
    }, [activeTabResults.results]);

    // Connection status indicator
    const isConnected = !connectionLoading && connection != null;
    const connectionName = connection?.name ?? connection?.url ?? null;

    return (
        <div className={`h-screen w-screen flex flex-col overflow-hidden ${isDark ? 'bg-neutral-900 text-gray-100' : 'bg-white text-gray-900'}`}>
            {/* ── Header ────────────────────────────────────────────────── */}
            <header className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-neutral-700 shrink-0">
                <div className="flex items-center gap-2">
                    <svg
                        className="h-5 w-5 text-indigo-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 5.625c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"
                        />
                    </svg>
                    <span className="text-white font-semibold text-sm tracking-wide">Forge SQL</span>
                </div>

                <div className="h-4 w-px bg-neutral-700" />

                {/* Connection indicator */}
                <div className="flex items-center gap-1.5">
                    <span
                        className={[
                            'h-2 w-2 rounded-full shrink-0',
                            connectionLoading
                                ? 'bg-yellow-400 animate-pulse'
                                : isConnected
                                  ? 'bg-green-400'
                                  : 'bg-red-400',
                        ].join(' ')}
                    />
                    <span className="text-xs text-neutral-400 truncate max-w-xs">
                        {connectionLoading
                            ? 'Connecting…'
                            : isConnected && connectionName
                              ? connectionName
                              : isConnected
                                ? 'Connected'
                                : 'No connection'}
                    </span>
                </div>

                {/* Gear icon — settings */}
                <div className="ml-auto">
                    <button
                        onClick={() => setSettingsOpen((v) => !v)}
                        className="flex items-center justify-center h-7 w-7 rounded transition-colors text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/60"
                        title="Settings"
                        aria-label="Open settings"
                    >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                        </svg>
                    </button>
                </div>
            </header>

            {/* ── Body ──────────────────────────────────────────────────── */}
            <div className="flex flex-1 min-h-0">
                {/* ── Sidebar ─────────────────────────────────────────── */}
                <div
                    className={[
                        'flex flex-col border-r shrink-0 transition-all duration-200',
                        sidebarCollapsed ? 'w-8' : 'w-64',
                        isDark ? 'border-neutral-700 bg-gray-800' : 'border-gray-200 bg-gray-50',
                    ].join(' ')}
                >
                    {/* Sidebar toggle button */}
                    <button
                        onClick={() => setSidebarCollapsed((v) => !v)}
                        className={`flex items-center justify-center h-8 w-8 shrink-0 transition-colors self-end ${isDark ? 'text-neutral-500 hover:text-neutral-200 hover:bg-neutral-700/50' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-200/60'}`}
                        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                    >
                        <svg
                            className={`h-3.5 w-3.5 transition-transform ${sidebarCollapsed ? 'rotate-180' : ''}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                    </button>

                    {/* Schema explorer — hidden when collapsed */}
                    {!sidebarCollapsed && (
                        <div className="flex-1 min-h-0 overflow-hidden">
                            <SchemaExplorer onInsertText={handleInsertText} isDark={isDark} isConnected={isConnected} />
                        </div>
                    )}
                </div>

                {/* ── Main content ────────────────────────────────────── */}
                <div className="flex flex-1 flex-col min-w-0 min-h-0">
                    {/* Query tab bar */}
                    <div
                        className={`flex items-center shrink-0 border-b overflow-x-auto ${
                            isDark ? 'border-neutral-700 bg-gray-900' : 'border-gray-200 bg-gray-100'
                        }`}
                        style={{ scrollbarWidth: 'none' }}
                    >
                        {queryTabs.map((tab) => (
                            <div
                                key={tab.id}
                                className={[
                                    'group flex items-center gap-1 shrink-0 border-b-2 cursor-pointer select-none transition-colors',
                                    'text-xs px-3 py-1.5',
                                    activeQueryTabId === tab.id
                                        ? isDark
                                            ? 'border-indigo-500 text-indigo-400 bg-neutral-800'
                                            : 'border-indigo-500 text-indigo-600 bg-white'
                                        : isDark
                                          ? 'border-transparent text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/60'
                                          : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-200/60',
                                ].join(' ')}
                                onClick={() => {
                                    if (renamingTabId !== tab.id) {
                                        switchQueryTab(tab.id);
                                    }
                                }}
                                onDoubleClick={() => {
                                    setRenamingTabId(tab.id);
                                    setRenameValue(tab.label);
                                }}
                            >
                                {renamingTabId === tab.id ? (
                                    <input
                                        autoFocus
                                        value={renameValue}
                                        onChange={(e) => setRenameValue(e.target.value)}
                                        onBlur={() => {
                                            if (renameValue.trim()) {
                                                setQueryTabs((prev) =>
                                                    prev.map((t) =>
                                                        t.id === tab.id ? { ...t, label: renameValue.trim() } : t
                                                    )
                                                );
                                            }
                                            setRenamingTabId(null);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.currentTarget.blur();
                                            } else if (e.key === 'Escape') {
                                                setRenamingTabId(null);
                                            }
                                            e.stopPropagation();
                                        }}
                                        onClick={(e) => e.stopPropagation()}
                                        className={`text-xs w-24 outline-none border-b bg-transparent ${
                                            isDark
                                                ? 'text-indigo-300 border-indigo-500'
                                                : 'text-indigo-600 border-indigo-400'
                                        }`}
                                    />
                                ) : (
                                    <span>{tab.label}</span>
                                )}
                                {queryTabs.length > 1 && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            closeQueryTab(tab.id);
                                        }}
                                        className={`opacity-0 group-hover:opacity-100 flex items-center justify-center h-3.5 w-3.5 rounded transition-all ml-0.5 ${
                                            isDark
                                                ? 'text-neutral-500 hover:text-neutral-200 hover:bg-neutral-600'
                                                : 'text-gray-400 hover:text-gray-700 hover:bg-gray-300'
                                        }`}
                                        title="Close tab"
                                        aria-label={`Close ${tab.label}`}
                                    >
                                        <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                    </button>
                                )}
                            </div>
                        ))}

                        {/* Add new tab button */}
                        <button
                            onClick={addQueryTab}
                            className={`flex items-center justify-center h-6 w-6 ml-1 shrink-0 rounded transition-colors text-xs ${
                                isDark
                                    ? 'text-neutral-500 hover:text-neutral-200 hover:bg-neutral-700'
                                    : 'text-gray-400 hover:text-gray-700 hover:bg-gray-200'
                            }`}
                            title="New query tab (Ctrl+T / Cmd+T)"
                            aria-label="Add query tab"
                        >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                            </svg>
                        </button>
                    </div>

                    {/* SQL Editor */}
                    <div className={`shrink-0 border-b ${isDark ? 'border-neutral-700' : 'border-gray-200'}`}>
                        <SqlEditor
                            onExecute={handleExecute}
                            editorRef={editorRef}
                            theme={theme}
                            defaultValue={queryTabs.find((t) => t.id === activeQueryTabId)?.sql ?? 'SELECT TOP 10 * FROM account'}
                        />
                    </div>

                    {/* Tab bar */}
                    <div className={`flex items-center gap-0 border-b shrink-0 px-2 ${isDark ? 'border-neutral-700 bg-neutral-900' : 'border-gray-200 bg-gray-50'}`}>
                        {(
                            [
                                { id: 'results', label: 'Results' },
                                { id: 'fetchxml', label: 'FetchXML' },
                                { id: 'history', label: 'History' },
                            ] as { id: ActiveTab; label: string }[]
                        ).map((tab) => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={[
                                    'px-4 py-2 text-xs font-medium border-b-2 transition-colors',
                                    activeTab === tab.id
                                        ? 'border-indigo-500 text-indigo-500'
                                        : isDark
                                          ? 'border-transparent text-neutral-400 hover:text-neutral-200'
                                          : 'border-transparent text-gray-500 hover:text-gray-700',
                                ].join(' ')}
                            >
                                {tab.label}
                                {tab.id === 'results' && activeTabResults.rowCount != null && (
                                    <span className={`ml-1.5 ${isDark ? 'text-neutral-500' : 'text-gray-400'}`}>({activeTabResults.rowCount})</span>
                                )}
                            </button>
                        ))}

                        {/* Export buttons — only in Results tab when data exists */}
                        {activeTab === 'results' && activeTabResults.results && activeTabResults.results.length > 0 && (
                            <div className="ml-auto flex items-center gap-1 pr-2">
                                <button
                                    onClick={handleExportCsv}
                                    className={`px-2.5 py-1 text-xs rounded transition-colors ${isDark ? 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'}`}
                                    title="Export as CSV"
                                >
                                    CSV
                                </button>
                                <button
                                    onClick={handleExportJson}
                                    className={`px-2.5 py-1 text-xs rounded transition-colors ${isDark ? 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'}`}
                                    title="Export as JSON"
                                >
                                    JSON
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Tab content */}
                    <div className={`flex-1 min-h-0 overflow-auto ${isDark ? 'bg-gray-900' : 'bg-white'}`}>
                        {activeTab === 'results' && (
                            <>
                                {/* DML progress indicator */}
                                {dml.progress && (
                                    <div className="p-4">
                                        <DmlProgress
                                            progress={dml.progress}
                                            onCancel={dml.cancelExecution}
                                            isDark={isDark}
                                        />
                                    </div>
                                )}

                                {/* DML executing spinner (before progress kicks in) */}
                                {dml.isExecuting && !dml.progress && !dml.confirmationNeeded ? (
                                    <div className={`flex h-full items-center justify-center gap-2 text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                        <svg className="animate-spin h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                        </svg>
                                        Executing…
                                    </div>
                                ) : activeTabResults.dmlError ? (
                                    /* DML error */
                                    <div className="p-4">
                                        <div className={`rounded-md border p-3 ${isDark ? 'bg-red-950/40 border-red-800/50' : 'bg-red-50 border-red-200'}`}>
                                            <p className={`text-sm font-medium mb-1 ${isDark ? 'text-red-400' : 'text-red-700'}`}>DML error</p>
                                            <p className={`text-xs font-mono whitespace-pre-wrap ${isDark ? 'text-red-300' : 'text-red-600'}`}>{activeTabResults.dmlError}</p>
                                        </div>
                                    </div>
                                ) : activeTabResults.dmlResult ? (
                                    /* DML success card */
                                    <div className="p-4">
                                        <div className={`rounded-md border p-4 ${isDark ? 'bg-green-950/30 border-green-800/50' : 'bg-green-50 border-green-200'}`}>
                                            <div className="flex items-center gap-2 mb-2">
                                                <svg className={`h-4 w-4 shrink-0 ${isDark ? 'text-green-400' : 'text-green-600'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                </svg>
                                                <p className={`text-sm font-semibold ${isDark ? 'text-green-400' : 'text-green-700'}`}>
                                                    {activeTabResults.dmlResult!.operation} successful
                                                </p>
                                            </div>
                                            <dl className={`text-xs space-y-1 ${isDark ? 'text-green-300' : 'text-green-700'}`}>
                                                <div className="flex gap-2">
                                                    <dt className="font-medium">Records affected:</dt>
                                                    <dd>{activeTabResults.dmlResult!.affectedCount}</dd>
                                                </div>
                                                <div className="flex gap-2">
                                                    <dt className="font-medium">Execution time:</dt>
                                                    <dd>{activeTabResults.dmlResult!.executionTime}ms</dd>
                                                </div>
                                                {activeTabResults.dmlResult!.createdIds && activeTabResults.dmlResult!.createdIds.length > 0 && (
                                                    <div className="flex gap-2">
                                                        <dt className="font-medium">Created ID{activeTabResults.dmlResult!.createdIds.length > 1 ? 's' : ''}:</dt>
                                                        <dd className="font-mono break-all">{activeTabResults.dmlResult!.createdIds.join(', ')}</dd>
                                                    </div>
                                                )}
                                            </dl>
                                        </div>
                                    </div>
                                ) : queryExec.isExecuting && !activeTabResults.results ? (
                                    /* SELECT executing spinner */
                                    <div className={`flex h-full items-center justify-center gap-2 text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                        <svg
                                            className="animate-spin h-4 w-4 text-gray-400"
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
                                        Executing…
                                    </div>
                                ) : activeTabResults.error ? (
                                    <div className="p-4">
                                        <div className={`rounded-md border p-3 ${isDark ? 'bg-red-950/40 border-red-800/50' : 'bg-red-50 border-red-200'}`}>
                                            <p className={`text-sm font-medium mb-1 ${isDark ? 'text-red-400' : 'text-red-700'}`}>Query error</p>
                                            <p className={`text-xs font-mono whitespace-pre-wrap ${isDark ? 'text-red-300' : 'text-red-600'}`}>{activeTabResults.error}</p>
                                        </div>
                                    </div>
                                ) : activeTabResults.results ? (
                                    <ResultsGrid
                                        data={activeTabResults.results}
                                        columns={activeTabResults.columns}
                                        onLoadMore={queryExec.pagingCookie ? queryExec.loadNextPage : undefined}
                                        hasMore={queryExec.pagingCookie != null}
                                        isLoading={queryExec.isExecuting}
                                        isDark={isDark}
                                        connectionUrl={connection?.url}
                                    />
                                ) : (
                                    <div className="flex h-full items-center justify-center">
                                        <p className={`text-sm select-none ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                                            Run a query to see results
                                        </p>
                                    </div>
                                )}
                            </>
                        )}

                        {activeTab === 'fetchxml' && (
                            <div className={`h-full ${isDark ? 'bg-[#1e1e1e]' : 'bg-white'}`}>
                                <FetchXmlInspector fetchXml={activeTabResults.fetchXml} theme={theme} />
                            </div>
                        )}

                        {activeTab === 'history' && (
                            <div className="h-full">
                                <QueryHistory onSelectQuery={handleSelectHistory} isDark={isDark} />
                            </div>
                        )}
                    </div>

                    {/* Status bar */}
                    <StatusBar
                        rowCount={activeTabResults.rowCount}
                        executionTime={activeTabResults.executionTime}
                        error={activeTabResults.error}
                        isExecuting={queryExec.isExecuting || dml.isExecuting}
                        isDark={isDark}
                    />
                </div>
            </div>

            {/* DML confirmation dialog — rendered as a portal-like overlay */}
            {dml.confirmationNeeded && (
                <DmlConfirmDialog
                    confirmation={dml.confirmationNeeded}
                    onConfirm={dml.confirmExecution}
                    onCancel={dml.cancelExecution}
                    isDark={isDark}
                />
            )}

            {/* Settings panel */}
            <SettingsPanel
                isOpen={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                isDark={isDark}
            />
        </div>
    );
}
