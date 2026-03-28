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
import { useQueryExecution } from './hooks/useQueryExecution';
import { useDmlExecution } from './hooks/useDmlExecution';
import { useHistoryStore } from './stores/historyStore';
import { useSchemaStore } from './stores/schemaStore';
import { exportToCsv, exportToJson } from './utils/export';
import { useConnection, useToolboxEvents } from './hooks/useToolboxAPI';
import { useTheme } from './hooks/useTheme';
import { tokenize, parseStatement } from './sql';

type ActiveTab = 'results' | 'fetchxml' | 'history';

export default function App() {
    const [activeTab, setActiveTab] = useState<ActiveTab>('results');
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

    const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);
    const pendingDmlSqlRef = useRef<string>('');

    const { theme, isDark } = useTheme();
    const { connection, isLoading: connectionLoading, refreshConnection } = useConnection();
    const { results, columns, fetchXml, error, isExecuting, executionTime, rowCount, pagingCookie, execute, loadNextPage } =
        useQueryExecution();
    const dml = useDmlExecution();
    const { addEntry } = useHistoryStore();
    const { reset: resetSchema } = useSchemaStore();

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

    // Add DML results to history when they resolve
    useEffect(() => {
        if (!dml.dmlResult) return;
        addEntry({
            sql: pendingDmlSqlRef.current,
            timestamp: Date.now(),
            executionTime: dml.dmlResult.executionTime,
            rowCount: dml.dmlResult.affectedCount,
            statementType: dml.dmlResult.operation,
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dml.dmlResult]);

    const handleExecute = useCallback(
        async (sql: string) => {
            const trimmed = sql.trim();
            if (!trimmed) return;

            setActiveTab('results');

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
                pendingDmlSqlRef.current = trimmed;
                await dml.execute(trimmed);
                return;
            }

            const result = await execute(trimmed);

            addEntry({
                sql: trimmed,
                timestamp: Date.now(),
                executionTime: result.executionTime ?? undefined,
                rowCount: result.rowCount ?? undefined,
                error: result.error ?? undefined,
                statementType: 'SELECT',
            });
        },
        [execute, addEntry, dml]
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
        if (!results) return;
        exportToCsv(results, columns);
    }, [results, columns]);

    const handleExportJson = useCallback(() => {
        if (!results) return;
        exportToJson(results);
    }, [results]);

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
                    {/* SQL Editor */}
                    <div className={`shrink-0 border-b ${isDark ? 'border-neutral-700' : 'border-gray-200'}`}>
                        <SqlEditor
                            onExecute={handleExecute}
                            editorRef={editorRef}
                            theme={theme}
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
                                {tab.id === 'results' && rowCount != null && (
                                    <span className={`ml-1.5 ${isDark ? 'text-neutral-500' : 'text-gray-400'}`}>({rowCount})</span>
                                )}
                            </button>
                        ))}

                        {/* Export buttons — only in Results tab when data exists */}
                        {activeTab === 'results' && results && results.length > 0 && (
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
                                ) : dml.dmlError ? (
                                    /* DML error */
                                    <div className="p-4">
                                        <div className={`rounded-md border p-3 ${isDark ? 'bg-red-950/40 border-red-800/50' : 'bg-red-50 border-red-200'}`}>
                                            <p className={`text-sm font-medium mb-1 ${isDark ? 'text-red-400' : 'text-red-700'}`}>DML error</p>
                                            <p className={`text-xs font-mono whitespace-pre-wrap ${isDark ? 'text-red-300' : 'text-red-600'}`}>{dml.dmlError}</p>
                                        </div>
                                    </div>
                                ) : dml.dmlResult ? (
                                    /* DML success card */
                                    <div className="p-4">
                                        <div className={`rounded-md border p-4 ${isDark ? 'bg-green-950/30 border-green-800/50' : 'bg-green-50 border-green-200'}`}>
                                            <div className="flex items-center gap-2 mb-2">
                                                <svg className={`h-4 w-4 shrink-0 ${isDark ? 'text-green-400' : 'text-green-600'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                </svg>
                                                <p className={`text-sm font-semibold ${isDark ? 'text-green-400' : 'text-green-700'}`}>
                                                    {dml.dmlResult.operation} successful
                                                </p>
                                            </div>
                                            <dl className={`text-xs space-y-1 ${isDark ? 'text-green-300' : 'text-green-700'}`}>
                                                <div className="flex gap-2">
                                                    <dt className="font-medium">Records affected:</dt>
                                                    <dd>{dml.dmlResult.affectedCount}</dd>
                                                </div>
                                                <div className="flex gap-2">
                                                    <dt className="font-medium">Execution time:</dt>
                                                    <dd>{dml.dmlResult.executionTime}ms</dd>
                                                </div>
                                                {dml.dmlResult.createdIds && dml.dmlResult.createdIds.length > 0 && (
                                                    <div className="flex gap-2">
                                                        <dt className="font-medium">Created ID{dml.dmlResult.createdIds.length > 1 ? 's' : ''}:</dt>
                                                        <dd className="font-mono break-all">{dml.dmlResult.createdIds.join(', ')}</dd>
                                                    </div>
                                                )}
                                            </dl>
                                        </div>
                                    </div>
                                ) : isExecuting && !results ? (
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
                                ) : error ? (
                                    <div className="p-4">
                                        <div className={`rounded-md border p-3 ${isDark ? 'bg-red-950/40 border-red-800/50' : 'bg-red-50 border-red-200'}`}>
                                            <p className={`text-sm font-medium mb-1 ${isDark ? 'text-red-400' : 'text-red-700'}`}>Query error</p>
                                            <p className={`text-xs font-mono whitespace-pre-wrap ${isDark ? 'text-red-300' : 'text-red-600'}`}>{error}</p>
                                        </div>
                                    </div>
                                ) : results ? (
                                    <ResultsGrid
                                        data={results}
                                        columns={columns}
                                        onLoadMore={pagingCookie ? loadNextPage : undefined}
                                        hasMore={pagingCookie != null}
                                        isLoading={isExecuting}
                                        isDark={isDark}
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
                                <FetchXmlInspector fetchXml={fetchXml} theme={theme} />
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
                        rowCount={rowCount}
                        executionTime={executionTime}
                        error={error}
                        isExecuting={isExecuting}
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
        </div>
    );
}
