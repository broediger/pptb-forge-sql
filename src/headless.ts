import { tokenize, parseStatement, SqlParseError } from './sql';
import { executeSelect, type FetchXmlQueryFn } from './sql/selectExecution';

/**
 * Headless entry for the PPTB MCP server (`agents.headlessEntry` in
 * pptb.config.json). PPTB imports the built `dist/headless.js` in Node and
 * installs `window.dataverseAPI` / `window.toolboxAPI` for the connection the
 * agent picked before calling `invokeHeadless`.
 *
 * Only SELECT runs here: INSERT/UPDATE/DELETE need the preview and
 * confirmation the tool window gives (`DmlConfirmDialog`).
 */

const DEFAULT_MAX_ROWS = 500;
const MAX_ROWS_LIMIT = 5000;

interface HeadlessContext {
    toolName?: string;
    logger?: { info(message: string): void; error(message: string): void };
}

export interface HeadlessQueryResult extends Record<string, unknown> {
    status: 'success' | 'error';
    rows?: Record<string, unknown>[];
    columns?: string[];
    rowCount?: number;
    /** More rows exist than were returned (paging or `maxRows`); narrow the query or use TOP. */
    moreRecords?: boolean;
    fetchXml?: string;
    summary?: string;
    executionTimeMs?: number;
    error?: string;
}

const queryDataverse: FetchXmlQueryFn = async (fetchXml) => {
    if (typeof window === 'undefined' || !window.dataverseAPI) {
        throw new Error('Dataverse API not available. Invoke this tool through the Power Platform ToolBox MCP server.');
    }
    return window.dataverseAPI.fetchXmlQuery(fetchXml);
};

/** Clamp the caller's `maxRows` to 1..MAX_ROWS_LIMIT, defaulting when missing or invalid. */
export function resolveMaxRows(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return DEFAULT_MAX_ROWS;
    return Math.min(Math.floor(value), MAX_ROWS_LIMIT);
}

export async function runHeadlessQuery(
    input: Record<string, unknown>,
    query: FetchXmlQueryFn,
): Promise<HeadlessQueryResult> {
    const sql = typeof input.sql === 'string' ? input.sql.trim() : '';
    if (!sql) {
        return { status: 'error', error: 'Missing required parameter: sql.' };
    }
    const maxRows = resolveMaxRows(input.maxRows);

    const start = performance.now();
    let fetchXml: string | undefined;
    try {
        const parsed = parseStatement(tokenize(sql));
        if (parsed.type !== 'select') {
            return {
                status: 'error',
                error: `Only SELECT statements can be run through MCP. Run ${parsed.type.toUpperCase()} in the Forge SQL window, where changes are previewed and confirmed.`,
            };
        }

        const result = await executeSelect(parsed, query, {
            onFetchXml: (xml) => {
                fetchXml = xml;
            },
            // A client-side filtered read can stop once the agent's rows are found.
            rowLimit: maxRows,
        });
        // Keep only the result columns: rows also carry the raw OData keys the
        // grid hides, and Dataverse omits nulls, so fill those in explicitly.
        const rows = result.rows
            .slice(0, maxRows)
            .map((row) => Object.fromEntries(result.columns.map((col) => [col, row[col] ?? null])));
        const truncated = result.rows.length > rows.length;
        return {
            status: 'success',
            rows,
            columns: result.columns,
            rowCount: rows.length,
            moreRecords: truncated || result.pagingCookie !== null || result.limitNote !== undefined,
            fetchXml: result.fetchXml,
            summary: truncated
                ? `${result.summary}; returning the first ${rows.length}`
                : (result.limitNote ?? result.summary),
            executionTimeMs: Math.round(performance.now() - start),
        };
    } catch (err) {
        let error: string;
        if (err instanceof SqlParseError) {
            error = `SQL parse error at line ${err.line}, column ${err.column}: ${err.message.replace(/ \(line \d+, column \d+\)$/, '')}`;
        } else if (err instanceof Error) {
            error = err.message;
        } else {
            error = String(err);
        }
        return {
            status: 'error',
            error,
            fetchXml,
            executionTimeMs: Math.round(performance.now() - start),
        };
    }
}

export async function invokeHeadless(
    input: Record<string, unknown>,
    context: HeadlessContext = {},
): Promise<HeadlessQueryResult> {
    const result = await runHeadlessQuery(input, queryDataverse);
    if (result.status === 'success') {
        context.logger?.info(`${result.summary} in ${result.executionTimeMs}ms`);
    } else {
        context.logger?.error(result.error ?? 'Query failed');
    }
    return result;
}
