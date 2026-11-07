import { useState, useCallback, useRef } from 'react';
import { tokenize, parseStatement, SqlParseError } from '../sql';
import type { JsonValueColumn } from '../sql/jsonValue';
import { extractColumns } from '../sql/columnResolution';
import { executeSelect, fetchNextPage, type FetchXmlQueryFn } from '../sql/selectExecution';

interface QueryExecutionState {
    results: Record<string, unknown>[] | null;
    columns: string[];
    fetchXml: string | null;
    error: string | null;
    isExecuting: boolean;
    executionTime: number | null;
    rowCount: number | null;
    pagingCookie: string | null;
    /** More rows match but can't be paged (client-side filter); shown under the grid. */
    limitNote: string | null;
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

const queryDataverse: FetchXmlQueryFn = async (fetchXml) => {
    if (typeof window === 'undefined' || !window.dataverseAPI) {
        throw new Error('Dataverse API not available. Load this tool in Power Platform ToolBox.');
    }
    return window.dataverseAPI.fetchXmlQuery(fetchXml);
};

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
        limitNote: null,
    });

    const pageRef = useRef<number>(1);
    const generationRef = useRef<number>(0);
    // JSON_VALUE columns of the current query, applied to every fetched page.
    const jsonColumnsRef = useRef<JsonValueColumn[]>([]);

    const execute = useCallback(async (sql: string): Promise<ExecuteResult> => {
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
            limitNote: null,
        }));

        pageRef.current = 1;
        generationRef.current += 1;

        const start = performance.now();
        let fetchXml: string | null = null;

        try {
            const tokens = tokenize(sql);
            const parsed = parseStatement(tokens);
            if (parsed.type !== 'select') {
                throw new Error('This is a DML statement. Use the DML execution path.');
            }

            jsonColumnsRef.current = [];
            const result = await executeSelect(parsed, queryDataverse, {
                onProgress: (rowCount) => setState((prev) => ({ ...prev, rowCount })),
                onFetchXml: (xml) => {
                    fetchXml = xml;
                },
            });
            jsonColumnsRef.current = result.jsonColumns;

            const executionTime = Math.round(performance.now() - start);

            setState((prev) => ({
                ...prev,
                results: result.rows,
                columns: result.columns,
                fetchXml: result.fetchXml,
                error: null,
                executionTime,
                rowCount: result.rows.length,
                pagingCookie: result.pagingCookie,
                limitNote: result.limitNote ?? null,
                isExecuting: false,
            }));

            try {
                window.toolboxAPI.utils.showNotification({
                    title: 'Query Complete',
                    body: `${result.summary} in ${executionTime}ms`,
                    type: 'success',
                });
            } catch {
                // toolboxAPI may not be available
            }

            return { rowCount: result.rows.length, executionTime, error: null };
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
                fetchXml: fetchXml ?? prev.fetchXml,
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
    }, []);

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

        const start = performance.now();

        try {
            const { rows, pagingCookie } = await fetchNextPage(
                queryDataverse,
                snapshotFetchXml,
                snapshotPagingCookie,
                nextPage,
                jsonColumnsRef.current,
            );
            const end = performance.now();
            const executionTime = Math.round(end - start);

            // Discard results if a new execute() call has started since we began.
            if (generationRef.current !== capturedGeneration) {
                return;
            }

            const allResults = [...snapshotResults, ...rows];

            // Keep page 1's resolved columns so explicit selections (and the
            // raw source columns behind JSON_VALUE) stay hidden when paging.
            const columns = snapshotColumns.length > 0 ? snapshotColumns : extractColumns(allResults);

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
    }, []);

    return {
        ...state,
        execute,
        loadNextPage,
    };
}
