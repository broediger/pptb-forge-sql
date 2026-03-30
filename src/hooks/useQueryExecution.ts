import { useState, useCallback, useRef } from 'react';
import { tokenize, parseStatement, generateFetchXml, SqlParseError } from '../sql';
import type { SelectStatement } from '../sql/types';

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

// OData annotation suffixes → clean column name suffixes
const ANNOTATION_MAP: [RegExp, string][] = [
    [/@OData\.Community\.Display\.V1\.FormattedValue$/, '_formatted'],
    [/@Microsoft\.Dynamics\.CRM\.lookuplogicalname$/, '_type'],
    [/@Microsoft\.Dynamics\.CRM\.associatednavigationproperty$/, '_nav'],
];

/**
 * Transform Dataverse result rows:
 * 1. Rename OData annotation keys to readable suffixes
 * 2. Create friendly aliases for lookup columns:
 *    _ownerid_value         → also as ownerid (GUID)
 *    _ownerid_value_formatted → also as owneridname (display name)
 * 3. Create xxxname alias for any column's formatted value:
 *    accountratingcode_formatted → also as accountratingcodename
 * 4. Drop pure metadata keys (@odata.etag)
 */
function cleanRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    if (rows.length === 0) return rows;
    return rows.map((row) => {
        const cleaned: Record<string, unknown> = {};

        // First pass: keep plain keys and rename annotations
        for (const [key, value] of Object.entries(row)) {
            if (!key.includes('@')) {
                cleaned[key] = value;
                continue;
            }
            let renamed = false;
            for (const [pattern, suffix] of ANNOTATION_MAP) {
                if (pattern.test(key)) {
                    const baseCol = key.replace(pattern, '');
                    cleaned[baseCol + suffix] = value;
                    renamed = true;
                    break;
                }
            }
            if (!renamed) {
                /* drop unknown @-keys */
            }
        }

        return cleaned;
    });
}

/**
 * Extract columns for display. When isSelectStar is true, hide the
 * derived alias columns (_formatted, _type, _nav, xxxname from lookups)
 * to reduce noise — users can request them explicitly if needed.
 */
function extractColumns(rows: Record<string, unknown>[], isSelectStar = false): string[] {
    if (rows.length === 0) return [];
    const allKeys = Object.keys(rows[0]);
    if (!isSelectStar) return allKeys;
    return allKeys.filter(
        (k) => !k.endsWith('_formatted') && !k.endsWith('_type') && !k.endsWith('_nav'),
    );
}

/**
 * Derive the display columns from the original SELECT AST.
 * For `SELECT *`, returns null (meaning: show all columns from results).
 * For explicit columns, returns the list of requested names (including
 * virtual names like owneridname) so only those are displayed.
 */
function getRequestedColumns(stmt: SelectStatement): string[] | null {
    const hasStar = stmt.columns.some((c) => !('function' in c) && c.column === '*' && !c.table);
    if (hasStar) return null; // SELECT * → show everything

    return stmt.columns.map((c) => {
        if ('function' in c) {
            // Aggregate: use alias or auto-generated name
            return c.alias ?? `${c.function.toLowerCase()}_${c.column.column === '*' ? 'all' : c.column.column}`;
        }
        return c.alias ?? c.column;
    });
}

/**
 * Resolve user-requested column names to actual keys in the result data.
 * Virtual names like "owneridname" are mapped to their Dataverse annotation
 * equivalents (e.g. _ownerid_value_formatted) and exposed under the
 * user-friendly name by injecting the alias into each row.
 */
function resolveRequestedColumns(
    requested: string[],
    availableColumns: string[],
    sampleRow: Record<string, unknown>,
): string[] {
    const resolved: string[] = [];
    const allKeys = Object.keys(sampleRow);

    for (const col of requested) {
        if (availableColumns.includes(col)) {
            resolved.push(col);
            continue;
        }
        // Try virtual name resolution:
        // xxxname → _xxx_value_formatted  (lookup display name)
        // xxxname → xxx_formatted          (option set label)
        // xxxid   → _xxxid_value           (lookup GUID)
        if (col.endsWith('name') && col.length > 4) {
            const base = col.slice(0, -4);
            const lookupFmt = `_${base}_value_formatted`;
            const optionFmt = `${base}_formatted`;
            if (allKeys.includes(lookupFmt)) {
                resolved.push(lookupFmt);
                continue;
            }
            if (allKeys.includes(optionFmt)) {
                resolved.push(optionFmt);
                continue;
            }
        }
        // xxxid → _xxxid_value (lookup GUID without _value suffix)
        const lookupVal = `_${col}_value`;
        if (allKeys.includes(lookupVal)) {
            resolved.push(lookupVal);
            continue;
        }
        // Not found — skip
    }
    return resolved;
}

/**
 * Rewrite virtual column names in a SelectStatement before FetchXML generation.
 * Dataverse doesn't have `xxxname` attributes — they are formatted values of
 * the base lookup/optionset column. This rewrites the AST so the correct base
 * column is requested in FetchXML, and the friendly alias appears in results
 * via the cleanRows annotation mapping.
 *
 * Examples:
 *   owneridname  → ownerid  (lookup display name)
 *   statuscodename → statuscode (optionset label)
 */
function rewriteVirtualColumns(stmt: SelectStatement): SelectStatement {
    let changed = false;
    const newColumns = stmt.columns.map((col) => {
        if ('function' in col) return col; // aggregate — skip
        if (col.column === '*') return col;
        const name = col.column;
        // If column ends with 'name' and is more than just 'name', strip it
        if (name.length > 4 && name.endsWith('name')) {
            const base = name.slice(0, -4); // e.g. owneridname → ownerid
            changed = true;
            return { ...col, column: base };
        }
        return col;
    });
    return changed ? { ...stmt, columns: newColumns } : stmt;
}

function xmlEscape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function injectPagingIntoFetchXml(fetchXml: string, pagingCookie: string, page: number): string {
    // Dataverse already URL-encodes the paging cookie in its response, so we must
    // not URL-encode again. Instead, XML-escape the raw cookie for safe embedding
    // in an XML attribute value.
    const escapedCookie = xmlEscape(pagingCookie);
    return fetchXml.replace(/^(\s*<fetch\b)([^>]*)(>)/, `$1$2 page="${page}" paging-cookie="${escapedCookie}"$3`);
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
            const rows = cleanRows(result.value ?? []);
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
                // Capture originally requested columns before rewriting
                const requestedCols = getRequestedColumns(stmt);
                const rewritten = rewriteVirtualColumns(stmt);
                const fetchXml = generateFetchXml(rewritten);

                const { rows, pagingCookie } = await runFetchXml(fetchXml);

                const end = performance.now();
                const executionTime = Math.round(end - start);

                // If the user specified explicit columns, resolve virtual names
                // (e.g. owneridname → _ownerid_value_formatted) and only show those.
                // For SELECT *, hide derived _formatted/_type/_nav columns.
                const isSelectStar = requestedCols === null;
                const allColumns = extractColumns(rows, isSelectStar);
                let columns: string[];
                if (requestedCols) {
                    columns = resolveRequestedColumns(requestedCols, allColumns, rows[0] ?? {});
                } else {
                    columns = allColumns;
                }

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

        const paginatedFetchXml = injectPagingIntoFetchXml(snapshotFetchXml, snapshotPagingCookie, nextPage);

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

            const columns = allResults.length > 0 ? extractColumns(allResults) : snapshotColumns;

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
