import { useState, useCallback, useRef } from 'react';
import { tokenize, parseStatement, generateFetchXml, SqlParseError } from '../sql';
import type { SelectStatement, WhereExpr, ColumnRef, AggregateExpr } from '../sql/types';
import { isAggregateExpr } from '../sql/types';
import {
    cleanRows,
    extractColumns,
    getRequestedColumns,
    resolveRequestedColumns,
    unresolvedVirtualColumns,
    rewriteVirtualColumns,
} from '../sql/columnResolution';

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

/**
 * SQL4CDS-compatible attribute aliases per entity. The audit entity's
 * entity-type field is `objecttypecode` in Dataverse but SQL4CDS exposes
 * it as `objectidtype`.
 */
const ENTITY_ATTRIBUTE_ALIASES: Record<string, Record<string, string>> = {
    audit: {
        objectidtype: 'objecttypecode',
    },
};

function mapColumnRef(col: ColumnRef, aliases: Record<string, string>): ColumnRef {
    const mapped = aliases[col.column];
    return mapped ? { ...col, column: mapped } : col;
}

function mapWhere(expr: WhereExpr, aliases: Record<string, string>): WhereExpr {
    switch (expr.kind) {
        case 'comparison':
            return 'function' in expr.left
                ? expr
                : { ...expr, left: mapColumnRef(expr.left as ColumnRef, aliases) };
        case 'between':
        case 'in':
        case 'is_null':
            return { ...expr, column: mapColumnRef(expr.column, aliases) };
        case 'and':
        case 'or':
            return { ...expr, left: mapWhere(expr.left, aliases), right: mapWhere(expr.right, aliases) };
        case 'not':
            return { ...expr, expr: mapWhere(expr.expr, aliases) };
    }
}

/**
 * Apply entity-specific attribute aliases across SELECT, WHERE, GROUP BY,
 * and ORDER BY so queries written in SQL4CDS style resolve to the real
 * Dataverse attribute names.
 */
/**
 * Expose Dataverse attributes under their SQL4CDS-style names in result
 * rows (e.g. audit.objecttypecode also appears as objectidtype). Also
 * handles formatted/type annotation aliases that cleanRows has already
 * created (objecttypecode_formatted → objectidtype_formatted, etc.).
 */
function applyReverseEntityAliases(
    rows: Record<string, unknown>[],
    table: string,
): Record<string, unknown>[] {
    const aliases = ENTITY_ATTRIBUTE_ALIASES[table.toLowerCase()];
    if (!aliases || rows.length === 0) return rows;
    const entries = Object.entries(aliases); // [sqlName, realName]
    return rows.map((row) => {
        const out: Record<string, unknown> = { ...row };
        for (const [sqlName, realName] of entries) {
            for (const key of Object.keys(row)) {
                if (key === realName || key.startsWith(`${realName}_`)) {
                    const aliasedKey = sqlName + key.slice(realName.length);
                    if (!(aliasedKey in out)) out[aliasedKey] = row[key];
                }
            }
        }
        return out;
    });
}

function applyEntityAliases(stmt: SelectStatement): SelectStatement {
    const aliases = ENTITY_ATTRIBUTE_ALIASES[stmt.from.table.toLowerCase()];
    if (!aliases) return stmt;

    const columns = stmt.columns.map((col) => {
        if ('function' in col) {
            return { ...col, column: mapColumnRef(col.column, aliases) };
        }
        return mapColumnRef(col, aliases);
    });
    return {
        ...stmt,
        columns,
        where: stmt.where ? mapWhere(stmt.where, aliases) : stmt.where,
        having: stmt.having ? mapWhere(stmt.having, aliases) : stmt.having,
        groupBy: stmt.groupBy?.map((c) => mapColumnRef(c, aliases)),
        orderBy: stmt.orderBy?.map((o) => ({ ...o, column: mapColumnRef(o.column, aliases) })),
    };
}

function xmlEscape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Detect a SELECT shape that can fall back to a paged client-side count when
 * Dataverse rejects the aggregate query (error 0x8004e023: 50,000 row limit).
 * Conservative: a single `COUNT(*)` or `COUNT(<column>)` with no DISTINCT /
 * GROUP BY / HAVING / JOIN.
 */
function isSimpleCount(stmt: SelectStatement): boolean {
    if (stmt.columns.length !== 1) return false;
    const col = stmt.columns[0];
    if (!isAggregateExpr(col)) return false;
    return (
        col.function === 'COUNT' &&
        !col.distinct &&
        !stmt.groupBy &&
        !stmt.having &&
        stmt.joins.length === 0
    );
}

/**
 * Detect `SELECT <col>, COUNT(*) FROM <t> [WHERE …] GROUP BY <col> [ORDER BY …]`.
 * Same purpose as `isSimpleCount` but for grouped counts. The fallback pages
 * through the source rows and aggregates client-side. Conservative: exactly
 * one grouping column, one `COUNT(*)`, no JOIN, no HAVING.
 */
function isSimpleGroupByCount(stmt: SelectStatement): { groupColumn: ColumnRef; aggregate: AggregateExpr } | null {
    if (stmt.columns.length !== 2) return null;
    if (!stmt.groupBy || stmt.groupBy.length !== 1) return null;
    if (stmt.having) return null;
    if (stmt.joins.length !== 0) return null;
    const groupBy = stmt.groupBy[0];

    let groupColumn: ColumnRef | null = null;
    let aggregate: AggregateExpr | null = null;
    for (const c of stmt.columns) {
        if (isAggregateExpr(c)) {
            if (c.function !== 'COUNT' || c.column.column !== '*' || c.distinct) return null;
            aggregate = c;
        } else if (c.column === groupBy.column && (c.table ?? null) === (groupBy.table ?? null)) {
            groupColumn = c;
        } else {
            return null;
        }
    }
    if (!groupColumn || !aggregate) return null;
    return { groupColumn, aggregate };
}

/**
 * PPTB returns the Dataverse paging cookie wrapped in its own envelope:
 *   `<cookie pagenumber="N" pagingcookie="<double-url-encoded inner cookie>" istracking="False" />`
 * Dataverse, however, expects the raw inner cookie (`<cookie page="1">...</cookie>`)
 * XML-escaped inside the `paging-cookie` attribute on the `<fetch>` element.
 * Unwrap the envelope before injecting, otherwise Dataverse rejects page 2 with
 * 0x80041129 "Paging Cookie And Query Do Not Match".
 */
function unwrapPagingCookie(pptbCookie: string): string {
    const match = pptbCookie.match(/pagingcookie="([^"]*)"/);
    if (!match) return pptbCookie;
    try {
        return decodeURIComponent(decodeURIComponent(match[1]));
    } catch {
        return pptbCookie;
    }
}

function injectPagingIntoFetchXml(fetchXml: string, pagingCookie: string, page: number): string {
    const innerCookie = unwrapPagingCookie(pagingCookie);
    // Inner cookie is raw XML; XML-escape it for safe embedding in the attribute.
    const escapedCookie = xmlEscape(innerCookie);
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

    /**
     * Fallback for `COUNT(*)` when Dataverse rejects the aggregate query with
     * the 50,000-source-record limit (0x8004e023). Re-issues the same SELECT as
     * a non-aggregate paged scan of the primary key and counts rows on the
     * client. Mirrors SQL4CDS's behaviour when the TDS endpoint is unavailable.
     * Updates `rowCount` after each page so the status bar shows live progress.
     */
    const runPagedCountFallback = useCallback(
        async (stmt: SelectStatement): Promise<{ total: number; pageCount: number; scanFetchXml: string }> => {
            const agg = stmt.columns[0] as AggregateExpr;
            const idCol = `${stmt.from.table}id`;
            // For COUNT(<col>), SQL semantics ignore NULLs — preserve that in
            // the paged scan by adding `<col> IS NOT NULL` to the WHERE. For
            // COUNT(*), no extra filter is needed.
            let scanWhere = stmt.where;
            if (agg.column.column !== '*') {
                const notNull = { kind: 'is_null', column: agg.column, negated: true } as const;
                scanWhere = scanWhere ? { kind: 'and', left: scanWhere, right: notNull } : notNull;
            }
            // Paging cookies in Dataverse encode position by the query's <order>
            // elements. Without an explicit order, the second page errors with
            // 0x80041129 ("Paging Cookie And Query Do Not Match"). Pin the scan
            // to the primary key for stable cursoring.
            const stmtForScan: SelectStatement = {
                ...stmt,
                columns: [{ column: idCol }],
                distinct: false,
                where: scanWhere,
                orderBy: [{ column: { column: idCol }, direction: 'ASC' }],
            };
            // The caller already settled which column-name form Dataverse
            // accepts (literal vs. virtual rewrite), so don't re-apply
            // rewriteVirtualColumns here — doing so would re-strip names like
            // `orb_regardingobjectlogicalname` that are real attributes.
            const scanFetchXml = generateFetchXml(applyEntityAliases(stmtForScan));

            let total = 0;
            let page = 1;
            let pagingCookie: string | null = null;
            let pageCount = 0;

            // eslint-disable-next-line no-constant-condition
            while (true) {
                const xml = page === 1 ? scanFetchXml : injectPagingIntoFetchXml(scanFetchXml, pagingCookie!, page);
                const result = await window.dataverseAPI.fetchXmlQuery(xml);
                const pageRows = (result.value as unknown[] | undefined) ?? [];
                const rawCookie = result[PAGING_COOKIE_KEY] as string | undefined;
                total += pageRows.length;
                pageCount += 1;
                setState((prev) => ({ ...prev, rowCount: total }));
                pagingCookie = rawCookie ?? null;
                if (!pagingCookie || pageRows.length === 0) break;
                page += 1;
            }

            return { total, pageCount, scanFetchXml };
        },
        [],
    );

    /**
     * Fallback for `SELECT <col>, COUNT(*) FROM <t> [WHERE …] GROUP BY <col>`
     * when Dataverse rejects the aggregate query with 0x8004e023. Pages
     * through the source rows requesting `<col>` plus the primary key (ordered
     * by the primary key for stable cursoring) and aggregates client-side.
     */
    const runPagedGroupByCountFallback = useCallback(
        async (
            stmt: SelectStatement,
            groupColumn: ColumnRef,
        ): Promise<{ counts: Map<string, number>; scannedRows: number; pageCount: number; scanFetchXml: string }> => {
            const idCol = `${stmt.from.table}id`;
            // Strip aggregation, keep WHERE, add primary key order for paging.
            const stmtForScan: SelectStatement = {
                ...stmt,
                columns: [{ column: groupColumn.column }, { column: idCol }],
                distinct: false,
                groupBy: undefined,
                having: undefined,
                orderBy: [{ column: { column: idCol }, direction: 'ASC' }],
            };
            // Caller passes the effective stmt (already resolved to literal or
            // virtual-rewritten names by `execute`), so don't re-rewrite here.
            const scanFetchXml = generateFetchXml(applyEntityAliases(stmtForScan));

            const counts = new Map<string, number>();
            // For lookup columns Dataverse returns the GUID under `_<col>_value`
            // and exposes the friendly name via the `_formatted` annotation.
            // `cleanRows` exposes those as `<col>` (GUID) and `<col>name`. We
            // index by whichever key the user actually wrote — if both exist
            // we still bucket by the user's chosen key for correctness.
            let scannedRows = 0;
            let page = 1;
            let pagingCookie: string | null = null;
            let pageCount = 0;

            // eslint-disable-next-line no-constant-condition
            while (true) {
                const xml = page === 1 ? scanFetchXml : injectPagingIntoFetchXml(scanFetchXml, pagingCookie!, page);
                const result = await window.dataverseAPI.fetchXmlQuery(xml);
                const rawPageRows = (result.value as Record<string, unknown>[] | undefined) ?? [];
                const pageRows = applyReverseEntityAliases(cleanRows(rawPageRows), stmt.from.table);
                for (const row of pageRows) {
                    const raw = row[groupColumn.column];
                    const key = raw == null ? '' : String(raw);
                    counts.set(key, (counts.get(key) ?? 0) + 1);
                }
                scannedRows += rawPageRows.length;
                pageCount += 1;
                setState((prev) => ({ ...prev, rowCount: scannedRows }));
                const rawCookie = result[PAGING_COOKIE_KEY] as string | undefined;
                pagingCookie = rawCookie ?? null;
                if (!pagingCookie || rawPageRows.length === 0) break;
                page += 1;
            }

            return { counts, scannedRows, pageCount, scanFetchXml };
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
            let fetchXml: string | null = null;

            try {
                const tokens = tokenize(sql);
                const stmt = parseStatement(tokens);
                if (stmt.type !== 'select') {
                    throw new Error('This is a DML statement. Use the DML execution path.');
                }
                // Capture originally requested columns before any rewriting
                const requestedCols = getRequestedColumns(stmt);
                // Try the user's literal column names first. `rewriteVirtualColumns`
                // strips a trailing 'name' to map virtual lookup display names
                // (e.g. owneridname → ownerid), but many real attributes also
                // end with 'name' (e.g. orb_regardingobjectlogicalname,
                // fullname). If Dataverse rejects the literal request with
                // 0x80041103 ("attribute doesn't exist"), retry with the
                // virtual rewrite.
                // `effectiveStmt` tracks which column-name form Dataverse
                // accepted (literal vs. virtual rewrite) so any downstream
                // fallback path uses the same names instead of re-rewriting.
                let effectiveStmt = stmt;
                fetchXml = generateFetchXml(applyEntityAliases(effectiveStmt));

                let rawRows: Record<string, unknown>[];
                let pagingCookie: string | null;
                try {
                    let queryResult: Awaited<ReturnType<typeof runFetchXml>>;
                    try {
                        queryResult = await runFetchXml(fetchXml);
                    } catch (attrErr) {
                        const isAttrMissing =
                            attrErr instanceof Error && attrErr.message.includes('0x80041103');
                        const rewrittenStmt = isAttrMissing ? rewriteVirtualColumns(stmt) : stmt;
                        if (!isAttrMissing || rewrittenStmt === stmt) {
                            throw attrErr;
                        }
                        effectiveStmt = rewrittenStmt;
                        fetchXml = generateFetchXml(applyEntityAliases(effectiveStmt));
                        queryResult = await runFetchXml(fetchXml);
                    }
                    rawRows = queryResult.rows;
                    pagingCookie = queryResult.pagingCookie;
                } catch (queryErr) {
                    // Aggregate-limit fallback. Dataverse rejects aggregate
                    // queries that would scan more than 50,000 source records
                    // (error 0x8004e023). For simple COUNT(*) we can rerun as
                    // a paged scan and count client-side.
                    const isAggregateLimit =
                        queryErr instanceof Error && queryErr.message.includes('0x8004e023');
                    if (!isAggregateLimit) {
                        throw queryErr;
                    }
                    // Branch A: simple `COUNT(*)` / `COUNT(<col>)` — one number.
                    if (isSimpleCount(effectiveStmt)) {
                        const fallback = await runPagedCountFallback(effectiveStmt);
                        const agg = effectiveStmt.columns[0] as AggregateExpr;
                        const alias =
                            agg.alias ?? `count_${agg.column.column === '*' ? 'all' : agg.column.column}`;
                        const fallbackRows = [{ [alias]: fallback.total }];
                        const fallbackEnd = performance.now();
                        const fallbackExecutionTime = Math.round(fallbackEnd - start);
                        const annotatedFetchXml =
                            `<!-- Aggregate count exceeded Dataverse's 50,000-record limit (0x8004e023).\n` +
                            `     Recovered via paged scan: ${fallback.pageCount} page(s), ${fallback.total} row(s) counted client-side. -->\n` +
                            `<!-- Original (rejected): -->\n${fetchXml}\n` +
                            `<!-- Paged scan used for the count: -->\n${fallback.scanFetchXml}`;
                        setState((prev) => ({
                            ...prev,
                            results: fallbackRows,
                            columns: [alias],
                            fetchXml: annotatedFetchXml,
                            error: null,
                            executionTime: fallbackExecutionTime,
                            rowCount: 1,
                            pagingCookie: null,
                            isExecuting: false,
                        }));
                        try {
                            window.toolboxAPI.utils.showNotification({
                                title: 'Query Complete',
                                body: `${fallback.total.toLocaleString()} rows counted via paged scan in ${fallbackExecutionTime}ms`,
                                type: 'success',
                            });
                        } catch {
                            // toolboxAPI may not be available
                        }
                        return { rowCount: 1, executionTime: fallbackExecutionTime, error: null };
                    }

                    // Branch B: `SELECT <col>, COUNT(*) FROM <t> [WHERE …] GROUP BY <col>`.
                    const groupMatch = isSimpleGroupByCount(effectiveStmt);
                    if (groupMatch) {
                        const fallback = await runPagedGroupByCountFallback(effectiveStmt, groupMatch.groupColumn);
                        const groupKey = groupMatch.groupColumn.alias ?? groupMatch.groupColumn.column;
                        const countKey = groupMatch.aggregate.alias ?? 'count_all';
                        let fallbackRows: Record<string, unknown>[] = Array.from(fallback.counts.entries()).map(
                            ([value, count]) => ({
                                [groupKey]: value === '' ? null : value,
                                [countKey]: count,
                            }),
                        );
                        // Apply user-specified ORDER BY (on group column or count alias).
                        if (effectiveStmt.orderBy && effectiveStmt.orderBy.length > 0) {
                            const orderRef = effectiveStmt.orderBy[0].column.column;
                            const descending = effectiveStmt.orderBy[0].direction === 'DESC';
                            fallbackRows.sort((a, b) => {
                                const av = a[orderRef];
                                const bv = b[orderRef];
                                if (typeof av === 'number' && typeof bv === 'number') {
                                    return descending ? bv - av : av - bv;
                                }
                                const as = av == null ? '' : String(av);
                                const bs = bv == null ? '' : String(bv);
                                return descending ? bs.localeCompare(as) : as.localeCompare(bs);
                            });
                        }
                        // Apply TOP after the client-side sort so the truncated
                        // set matches what the aggregate query would have returned.
                        if (effectiveStmt.top !== undefined) {
                            fallbackRows = fallbackRows.slice(0, effectiveStmt.top);
                        }
                        const fallbackEnd = performance.now();
                        const fallbackExecutionTime = Math.round(fallbackEnd - start);
                        const annotatedFetchXml =
                            `<!-- Aggregate GROUP BY count exceeded Dataverse's 50,000-record limit (0x8004e023).\n` +
                            `     Recovered via paged scan: ${fallback.pageCount} page(s), ${fallback.scannedRows.toLocaleString()} row(s) scanned, ${fallback.counts.size} group(s) found, aggregated client-side. -->\n` +
                            `<!-- Original (rejected): -->\n${fetchXml}\n` +
                            `<!-- Paged scan used for the GROUP BY: -->\n${fallback.scanFetchXml}`;
                        setState((prev) => ({
                            ...prev,
                            results: fallbackRows,
                            columns: [groupKey, countKey],
                            fetchXml: annotatedFetchXml,
                            error: null,
                            executionTime: fallbackExecutionTime,
                            rowCount: fallbackRows.length,
                            pagingCookie: null,
                            isExecuting: false,
                        }));
                        try {
                            window.toolboxAPI.utils.showNotification({
                                title: 'Query Complete',
                                body: `${fallback.counts.size} group(s) from ${fallback.scannedRows.toLocaleString()} row(s) scanned in ${fallbackExecutionTime}ms`,
                                type: 'success',
                            });
                        } catch {
                            // toolboxAPI may not be available
                        }
                        return { rowCount: fallbackRows.length, executionTime: fallbackExecutionTime, error: null };
                    }

                    throw queryErr;
                }
                let rows = applyReverseEntityAliases(rawRows, stmt.from.table);

                // If the user specified explicit columns, resolve virtual names
                // (e.g. owneridname → _ownerid_value_formatted) and only show those.
                // For SELECT *, hide derived _formatted/_type/_nav columns.
                const isSelectStar = requestedCols === null;
                let allColumns = extractColumns(rows, isSelectStar);
                let columns: string[] = requestedCols
                    ? resolveRequestedColumns(requestedCols, allColumns, rows[0] ?? {})
                    : allColumns;

                // Recover virtual `xxxname` columns that Dataverse silently dropped.
                // Requesting an unknown attribute like `owneridname` on its own
                // returns rows with no owner data and no 0x80041103 error, so the
                // literal-vs-rewrite retry above never fired. Rewrite just the
                // unresolved name columns to their base lookup/optionset
                // (owneridname → ownerid) and re-run once so the formatted value
                // comes back and resolves.
                if (requestedCols && effectiveStmt === stmt && rows.length > 0) {
                    const unresolved = unresolvedVirtualColumns(requestedCols, allColumns, rows[0] ?? {});
                    if (unresolved.size > 0) {
                        const rewritten = rewriteVirtualColumns(stmt, unresolved);
                        if (rewritten !== stmt) {
                            const retryFetchXml = generateFetchXml(applyEntityAliases(rewritten));
                            try {
                                const retry = await runFetchXml(retryFetchXml);
                                const retryRows = applyReverseEntityAliases(retry.rows, stmt.from.table);
                                const retryAllColumns = extractColumns(retryRows, isSelectStar);
                                const retryColumns = resolveRequestedColumns(
                                    requestedCols,
                                    retryAllColumns,
                                    retryRows[0] ?? {},
                                );
                                // Only adopt the rewrite if it actually resolved more
                                // columns — otherwise keep the literal result so the
                                // clear "no readable columns" error still surfaces.
                                if (retryColumns.length > columns.length) {
                                    effectiveStmt = rewritten;
                                    fetchXml = retryFetchXml;
                                    rawRows = retry.rows;
                                    pagingCookie = retry.pagingCookie;
                                    rows = retryRows;
                                    allColumns = retryAllColumns;
                                    columns = retryColumns;
                                }
                            } catch {
                                // Rewrite re-run failed (e.g. the stripped base isn't a
                                // real attribute) — fall back to the literal result.
                            }
                        }
                    }
                }

                const end = performance.now();
                const executionTime = Math.round(end - start);

                // Dataverse returns rows but silently drops attributes when:
                //  - the column is encrypted and the query uses DISTINCT/aggregates
                //    (encrypted columns can't participate in either)
                //  - field-level security hides the attribute from this user
                //  - the attribute doesn't exist on the entity
                // Detect this and surface a clear error instead of an empty grid.
                if (rows.length > 0 && columns.length === 0) {
                    const requested = requestedCols?.join(', ') ?? '*';
                    const hasAggregate = stmt.columns.some((c) => 'function' in c);
                    const hint =
                        stmt.distinct || hasAggregate
                            ? ' This commonly happens when DISTINCT or aggregates are used on an encrypted column — try removing DISTINCT and the aggregate functions, or selecting the column directly.'
                            : ' The attribute(s) may be hidden by field-level security or not present on the entity.';
                    throw new Error(
                        `Query returned ${rows.length} row(s) but no readable columns for [${requested}] on '${stmt.from.table}'.${hint}`,
                    );
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
