import { useState, useCallback, useRef } from 'react';
import { tokenize, parseStatement, generateFetchXml, SqlParseError } from '../sql';

interface QueryExecutionState {
    results: Record<string, unknown>[] | null;
    columns: string[];
    fetchXml: string | null;
    error: string | null;
    isExecuting: boolean;
    executionTime: number | null;
    rowCount: number | null;
    pagingCookie: string | null;
}

export interface ExecuteResult {
    rowCount: number | null;
    executionTime: number | null;
    error: string | null;
}

interface QueryExecutionReturn extends QueryExecutionState {
    execute: (sql: string) => Promise<ExecuteResult>;
    loadNextPage: () => Promise<void>;
}

const PAGING_COOKIE_KEY = '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie';

function xmlEscape(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function injectPagingIntoFetchXml(fetchXml: string, pagingCookie: string, page: number): string {
    // Dataverse already URL-encodes the paging cookie in its response, so we must
    // not URL-encode again. Instead, XML-escape the raw cookie for safe embedding
    // in an XML attribute value.
    const escapedCookie = xmlEscape(pagingCookie);
    return fetchXml.replace(
        /^(\s*<fetch\b)([^>]*)(>)/,
        `$1$2 page="${page}" paging-cookie="${escapedCookie}"$3`,
    );
}

export function useQueryExecution(): QueryExecutionReturn {
    const [state, setState] = useState<QueryExecutionState>({
        results: null,
        columns: [],
        fetchXml: null,
        error: null,
        isExecuting: false,
        executionTime: null,
        rowCount: null,
        pagingCookie: null,
    });

    const pageRef = useRef<number>(1);
    const generationRef = useRef<number>(0);

    const runFetchXml = useCallback(
        async (fetchXml: string): Promise<{ rows: Record<string, unknown>[]; pagingCookie: string | null }> => {
            if (typeof window === 'undefined' || !window.dataverseAPI) {
                throw new Error('Dataverse API not available. Load this tool in Power Platform ToolBox.');
            }

            const result = await window.dataverseAPI.fetchXmlQuery(fetchXml);
            const rows = result.value ?? [];
            const pagingCookie = (result[PAGING_COOKIE_KEY] as string | undefined) ?? null;
            return { rows, pagingCookie };
        },
        [],
    );

    const execute = useCallback(
        async (sql: string): Promise<ExecuteResult> => {
            setState((prev) => ({
                ...prev,
                results: null,
                columns: [],
                fetchXml: null,
                error: null,
                isExecuting: true,
                executionTime: null,
                rowCount: null,
                pagingCookie: null,
            }));

            pageRef.current = 1;
            generationRef.current += 1;

            const start = performance.now();

            try {
                const tokens = tokenize(sql);
                const stmt = parseStatement(tokens);
                if (stmt.type !== 'select') {
                    throw new Error('This is a DML statement. Use the DML execution path.');
                }
                const fetchXml = generateFetchXml(stmt);

                const { rows, pagingCookie } = await runFetchXml(fetchXml);

                const end = performance.now();
                const executionTime = Math.round(end - start);

                const columns =
                    rows.length > 0
                        ? Object.keys(rows[0]).filter((key) => !key.includes('@'))
                        : [];

                setState((prev) => ({
                    ...prev,
                    results: rows,
                    columns,
                    fetchXml,
                    error: null,
                    executionTime,
                    rowCount: rows.length,
                    pagingCookie,
                    isExecuting: false,
                }));

                try {
                    window.toolboxAPI.utils.showNotification({
                        title: 'Query Complete',
                        body: `${rows.length} rows returned in ${executionTime}ms`,
                        type: 'success',
                    });
                } catch {
                    // toolboxAPI may not be available
                }

                return { rowCount: rows.length, executionTime, error: null };
            } catch (err) {
                const end = performance.now();
                const executionTime = Math.round(end - start);

                let errorMessage: string;

                if (err instanceof SqlParseError) {
                    errorMessage = `SQL parse error at line ${err.line}, column ${err.column}: ${err.message.replace(/ \(line \d+, column \d+\)$/, '')}`;
                } else if (err instanceof Error) {
                    errorMessage = err.message;
                } else {
                    errorMessage = String(err);
                }

                setState((prev) => ({
                    ...prev,
                    error: errorMessage,
                    executionTime,
                    isExecuting: false,
                }));

                try {
                    window.toolboxAPI.utils.showNotification({
                        title: 'Query Error',
                        body: errorMessage,
                        type: 'error',
                    });
                } catch {
                    // toolboxAPI may not be available
                }

                return { rowCount: null, executionTime, error: errorMessage };
            }
        },
        [runFetchXml],
    );

    const loadNextPage = useCallback(async (): Promise<void> => {
        // Capture a snapshot of the current state (fetchXml, pagingCookie, results,
        // columns) and the generation counter before doing any async work. The
        // generation counter lets us detect whether execute() was called while this
        // page load was in-flight.
        let snapshotFetchXml: string | null = null;
        let snapshotPagingCookie: string | null = null;
        let snapshotResults: Record<string, unknown>[] = [];
        let snapshotColumns: string[] = [];

        setState((prev) => {
            if (!prev.fetchXml || !prev.pagingCookie) return prev;
            snapshotFetchXml = prev.fetchXml;
            snapshotPagingCookie = prev.pagingCookie;
            snapshotResults = prev.results ?? [];
            snapshotColumns = prev.columns;
            return { ...prev, isExecuting: true, error: null };
        });

        if (!snapshotFetchXml || !snapshotPagingCookie) {
            return;
        }

        // Capture generation AFTER incrementing page so an overlapping execute()
        // will have bumped generationRef and we can detect the staleness.
        pageRef.current += 1;
        const nextPage = pageRef.current;
        const capturedGeneration = generationRef.current;

        const paginatedFetchXml = injectPagingIntoFetchXml(
            snapshotFetchXml,
            snapshotPagingCookie,
            nextPage,
        );

        const start = performance.now();

        try {
            const { rows, pagingCookie } = await runFetchXml(paginatedFetchXml);
            const end = performance.now();
            const executionTime = Math.round(end - start);

            // Discard results if a new execute() call has started since we began.
            if (generationRef.current !== capturedGeneration) {
                return;
            }

            const allResults = [...snapshotResults, ...rows];

            const columns =
                allResults.length > 0
                    ? Object.keys(allResults[0]).filter((key) => !key.includes('@'))
                    : snapshotColumns;

            setState((prev) => ({
                ...prev,
                results: allResults,
                columns,
                pagingCookie,
                rowCount: allResults.length,
                executionTime,
                isExecuting: false,
            }));
        } catch (err) {
            pageRef.current -= 1;

            let errorMessage: string;

            if (err instanceof SqlParseError) {
                errorMessage = `SQL parse error at line ${err.line}, column ${err.column}: ${err.message.replace(/ \(line \d+, column \d+\)$/, '')}`;
            } else if (err instanceof Error) {
                errorMessage = err.message;
            } else {
                errorMessage = String(err);
            }

            setState((prev) => ({
                ...prev,
                error: errorMessage,
                isExecuting: false,
            }));
        }
    }, [runFetchXml]);

    return {
        ...state,
        execute,
        loadNextPage,
    };
}
