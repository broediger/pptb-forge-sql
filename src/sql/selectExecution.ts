import { generateFetchXml } from './generator';
import type { SelectStatement, WhereExpr, ColumnRef, AggregateExpr, InSubqueryExpr, LiteralValue } from './types';
import { isAggregateExpr, isJsonValueExpr } from './types';
import { getJsonValueColumns, applyJsonValues, type JsonValueColumn } from './jsonValue';
import {
    cleanRows,
    extractColumns,
    getRequestedColumns,
    resolveRequestedColumns,
    displayRequestedColumns,
    unresolvedVirtualColumns,
    rewriteVirtualColumns,
} from './columnResolution';
import {
    collectSubqueries,
    validateSubquery,
    subqueryScanStatement,
    extractSubqueryValues,
    planQueries,
    sortRows,
    IN_CHUNK_SIZE,
    MAX_SUBQUERY_ROWS,
} from './subquery';
import { planHaving, applyHaving, withPage, describeHaving, HAVING_PAGE_SIZE, MAX_HAVING_GROUPS } from './having';

/**
 * Runs a SELECT against Dataverse: subquery expansion, HAVING, the virtual
 * `xxxname` retries and the 50,000-record aggregate fallbacks. Dataverse is
 * reached only through the injected `query` function, so the same code runs
 * in the tool UI (`window.dataverseAPI`), in the headless MCP entry, and in
 * tests.
 */

const PAGING_COOKIE_KEY = '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie';

/** Raw `fetchXmlQuery` result: rows under `value` plus the paging cookie annotation. */
export interface FetchXmlQueryResult {
    value?: Record<string, unknown>[];
    [PAGING_COOKIE_KEY]?: string;
}
export type FetchXmlQueryFn = (fetchXml: string) => Promise<FetchXmlQueryResult>;

export interface SelectExecutionOptions {
    /** Rows (or groups) read so far, for live progress during multi-page reads. */
    onProgress?: (rowCount: number) => void;
    /** Called with the query's FetchXML before it's sent, so a failure can still show it. */
    onFetchXml?: (fetchXml: string) => void;
}

export interface SelectExecutionResult {
    rows: Record<string, unknown>[];
    columns: string[];
    /** FetchXML that produced the rows, annotated with comments when a client-side fallback ran. */
    fetchXml: string;
    /** Set when more rows are available via `fetchNextPage`. */
    pagingCookie: string | null;
    /** JSON_VALUE columns to apply to further pages. */
    jsonColumns: JsonValueColumn[];
    /** Short outcome description, e.g. "12 rows returned". */
    summary: string;
}

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
            return 'function' in expr.left ? expr : { ...expr, left: mapColumnRef(expr.left as ColumnRef, aliases) };
        case 'between':
        case 'in':
        case 'in_subquery':
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
 * Expose Dataverse attributes under their SQL4CDS-style names in result
 * rows (e.g. audit.objecttypecode also appears as objectidtype). Also
 * handles formatted/type annotation aliases that cleanRows has already
 * created (objecttypecode_formatted → objectidtype_formatted, etc.).
 */
function applyReverseEntityAliases(rows: Record<string, unknown>[], table: string): Record<string, unknown>[] {
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

/**
 * Apply entity-specific attribute aliases across SELECT, WHERE, GROUP BY,
 * and ORDER BY so queries written in SQL4CDS style resolve to the real
 * Dataverse attribute names.
 */
function applyEntityAliases(stmt: SelectStatement): SelectStatement {
    const aliases = ENTITY_ATTRIBUTE_ALIASES[stmt.from.table.toLowerCase()];
    if (!aliases) return stmt;

    const columns = stmt.columns.map((col) => {
        if ('function' in col || isJsonValueExpr(col)) {
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
    return col.function === 'COUNT' && !col.distinct && !stmt.groupBy && !stmt.having && stmt.joins.length === 0;
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
        } else if (isJsonValueExpr(c)) {
            return null;
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

export function injectPagingIntoFetchXml(fetchXml: string, pagingCookie: string, page: number): string {
    const innerCookie = unwrapPagingCookie(pagingCookie);
    // Inner cookie is raw XML; XML-escape it for safe embedding in the attribute.
    const escapedCookie = xmlEscape(innerCookie);
    return fetchXml.replace(/^(\s*<fetch\b)([^>]*)(>)/, `$1$2 page="${page}" paging-cookie="${escapedCookie}"$3`);
}

function rawRows(result: FetchXmlQueryResult): Record<string, unknown>[] {
    return result.value ?? [];
}

function pagingCookieOf(result: FetchXmlQueryResult): string | null {
    return result[PAGING_COOKIE_KEY] ?? null;
}

/** Run one FetchXML request and return cleaned rows with JSON_VALUE columns applied. */
async function runFetchXml(
    query: FetchXmlQueryFn,
    fetchXml: string,
    jsonColumns: JsonValueColumn[],
): Promise<{ rows: Record<string, unknown>[]; pagingCookie: string | null }> {
    const result = await query(fetchXml);
    return { rows: applyJsonValues(cleanRows(rawRows(result)), jsonColumns), pagingCookie: pagingCookieOf(result) };
}

/**
 * Fetch the page after the one `pagingCookie` came from. Columns stay as
 * resolved for page 1, so callers only need the new rows.
 */
export function fetchNextPage(
    query: FetchXmlQueryFn,
    fetchXml: string,
    pagingCookie: string,
    page: number,
    jsonColumns: JsonValueColumn[],
): Promise<{ rows: Record<string, unknown>[]; pagingCookie: string | null }> {
    return runFetchXml(query, injectPagingIntoFetchXml(fetchXml, pagingCookie, page), jsonColumns);
}

/**
 * Fallback for `COUNT(*)` when Dataverse rejects the aggregate query with
 * the 50,000-source-record limit (0x8004e023). Re-issues the same SELECT as
 * a non-aggregate paged scan of the primary key and counts rows on the
 * client. Mirrors SQL4CDS's behaviour when the TDS endpoint is unavailable.
 */
async function runPagedCountFallback(
    query: FetchXmlQueryFn,
    stmt: SelectStatement,
    onProgress?: (rowCount: number) => void,
): Promise<{ total: number; pageCount: number; scanFetchXml: string }> {
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

    while (true) {
        const xml = page === 1 ? scanFetchXml : injectPagingIntoFetchXml(scanFetchXml, pagingCookie!, page);
        const result = await query(xml);
        const pageRows = rawRows(result);
        total += pageRows.length;
        pageCount += 1;
        onProgress?.(total);
        pagingCookie = pagingCookieOf(result);
        if (!pagingCookie || pageRows.length === 0) break;
        page += 1;
    }

    return { total, pageCount, scanFetchXml };
}

/**
 * Fallback for `SELECT <col>, COUNT(*) FROM <t> [WHERE …] GROUP BY <col>`
 * when Dataverse rejects the aggregate query with 0x8004e023. Pages
 * through the source rows requesting `<col>` plus the primary key (ordered
 * by the primary key for stable cursoring) and aggregates client-side.
 */
async function runPagedGroupByCountFallback(
    query: FetchXmlQueryFn,
    stmt: SelectStatement,
    groupColumn: ColumnRef,
    onProgress?: (rowCount: number) => void,
): Promise<{ counts: Map<string, number>; scannedRows: number; pageCount: number; scanFetchXml: string }> {
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
    // virtual-rewritten names by `executeSelect`), so don't re-rewrite here.
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

    while (true) {
        const xml = page === 1 ? scanFetchXml : injectPagingIntoFetchXml(scanFetchXml, pagingCookie!, page);
        const result = await query(xml);
        const rawPageRows = rawRows(result);
        const pageRows = applyReverseEntityAliases(cleanRows(rawPageRows), stmt.from.table);
        for (const row of pageRows) {
            const raw = row[groupColumn.column];
            const key = raw == null ? '' : String(raw);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        scannedRows += rawPageRows.length;
        pageCount += 1;
        onProgress?.(scannedRows);
        pagingCookie = pagingCookieOf(result);
        if (!pagingCookie || rawPageRows.length === 0) break;
        page += 1;
    }

    return { counts, scannedRows, pageCount, scanFetchXml };
}

/**
 * Read every page of a query. Used for subquery values and for split
 * queries, where the results must be complete before they're merged.
 */
async function fetchAllRows(
    query: FetchXmlQueryFn,
    stmt: SelectStatement,
    jsonColumns: JsonValueColumn[],
): Promise<{ rows: Record<string, unknown>[]; fetchXml: string }> {
    // Paging cookies need a stable order; TOP queries return one page.
    const needsOrder = !stmt.orderBy && !stmt.distinct && stmt.top === undefined;
    const scanStmt: SelectStatement = needsOrder
        ? { ...stmt, orderBy: [{ column: { column: `${stmt.from.table}id` }, direction: 'ASC' }] }
        : stmt;
    const fetchXml = generateFetchXml(applyEntityAliases(scanStmt));
    const rows: Record<string, unknown>[] = [];
    let page = 1;
    let pagingCookie: string | null = null;
    while (true) {
        const xml = page === 1 ? fetchXml : injectPagingIntoFetchXml(fetchXml, pagingCookie!, page);
        const result = await runFetchXml(query, xml, jsonColumns);
        rows.push(...applyReverseEntityAliases(result.rows, stmt.from.table));
        if (rows.length > MAX_SUBQUERY_ROWS) {
            throw new Error(
                `A subquery read more than ${MAX_SUBQUERY_ROWS.toLocaleString()} rows from '${stmt.from.table}'. Add filters to narrow it.`,
            );
        }
        pagingCookie = result.pagingCookie;
        if (!pagingCookie || result.rows.length === 0 || stmt.top !== undefined) break;
        page += 1;
    }
    return { rows, fetchXml };
}

/**
 * Read every page of an aggregate query. Aggregate results carry no paging
 * cookie, so pages are requested by number until a short page says there
 * are no more groups.
 */
async function fetchAllAggregatePages(
    query: FetchXmlQueryFn,
    fetchXml: string,
    onProgress?: (rowCount: number) => void,
): Promise<{ rows: Record<string, unknown>[]; pageCount: number }> {
    const rows: Record<string, unknown>[] = [];
    let page = 1;
    while (true) {
        const pageRows = rawRows(await query(withPage(fetchXml, page)));
        rows.push(...cleanRows(pageRows));
        if (rows.length > MAX_HAVING_GROUPS) {
            throw new Error(
                `The query produced more than ${MAX_HAVING_GROUPS.toLocaleString()} groups before HAVING was applied. Add filters to narrow it.`,
            );
        }
        onProgress?.(rows.length);
        if (pageRows.length < HAVING_PAGE_SIZE) break;
        page += 1;
    }
    return { rows, pageCount: page };
}

/**
 * Resolve `IN (SELECT …)` subqueries (including nested ones) to literal IN
 * lists. Returns the statement to run, or several when a long list had to
 * be split across queries.
 */
async function expandSubqueries(query: FetchXmlQueryFn, stmt: SelectStatement): Promise<SelectStatement[]> {
    const subqueries = collectSubqueries(stmt.where);
    if (subqueries.length === 0) return [stmt];
    const values = new Map<InSubqueryExpr, LiteralValue[]>();
    for (const sub of subqueries) {
        validateSubquery(sub.subquery);
        const rows: Record<string, unknown>[] = [];
        // Subquery scans must not get JSON_VALUE columns; those apply
        // only to the outer query's rows.
        for (const scan of await expandSubqueries(query, subqueryScanStatement(sub.subquery))) {
            rows.push(...(await fetchAllRows(query, scan, [])).rows);
        }
        values.set(sub, extractSubqueryValues(rows, sub.subquery));
    }
    return planQueries(stmt, values);
}

export async function executeSelect(
    parsed: SelectStatement,
    query: FetchXmlQueryFn,
    options: SelectExecutionOptions = {},
): Promise<SelectExecutionResult> {
    const { onProgress } = options;
    const sent = (xml: string): string => {
        options.onFetchXml?.(xml);
        return xml;
    };

    const plans = await expandSubqueries(query, parsed);
    const jsonColumns = getJsonValueColumns(parsed);
    if (plans.length > 1 && parsed.having) {
        throw new Error(
            `HAVING can't be combined with a subquery that returns more than ${IN_CHUNK_SIZE} values (the query would be split and the groups couldn't be merged).`,
        );
    }
    if (plans.length > 1) {
        // A subquery's IN list was split: run each part in full and
        // merge. Every row matches exactly one part, so the results
        // don't overlap; ORDER BY and TOP are applied after merging.
        let rows: Record<string, unknown>[] = [];
        let firstFetchXml = '';
        for (const plan of plans) {
            const part = await fetchAllRows(query, plan, jsonColumns);
            if (!firstFetchXml) firstFetchXml = part.fetchXml;
            rows.push(...part.rows);
            if (rows.length > MAX_SUBQUERY_ROWS) {
                throw new Error(
                    `The query returned more than ${MAX_SUBQUERY_ROWS.toLocaleString()} rows across its split parts. Add filters to narrow it.`,
                );
            }
            onProgress?.(rows.length);
        }
        if (parsed.orderBy) rows = sortRows(rows, parsed.orderBy);
        if (parsed.top !== undefined) rows = rows.slice(0, parsed.top);

        const requested = getRequestedColumns(parsed);
        const allColumns = extractColumns(rows, requested === null);
        const columns = requested ? displayRequestedColumns(requested, allColumns, rows) : allColumns;
        return {
            rows,
            columns,
            fetchXml:
                `<!-- A subquery returned more than ${IN_CHUNK_SIZE} values, so the query was split into ${plans.length} queries\n` +
                `     of up to ${IN_CHUNK_SIZE} values each and the results were merged client-side. First query: -->\n${firstFetchXml}`,
            pagingCookie: null,
            jsonColumns,
            summary: `${rows.length} rows returned from ${plans.length} split queries`,
        };
    }
    const stmt = plans[0];

    // HAVING: FetchXML can't express it. Read every group, then
    // filter (and apply TOP) client-side.
    const havingPlan = planHaving(stmt);
    if (havingPlan) {
        const fetchXml = sent(generateFetchXml(applyEntityAliases(havingPlan.stmt)));
        const havingText = describeHaving(havingPlan.having).replace(/--/g, '- -');
        let groups: Record<string, unknown>[];
        let annotatedFetchXml: string;
        try {
            const read = await fetchAllAggregatePages(query, fetchXml, onProgress);
            groups = applyReverseEntityAliases(read.rows, stmt.from.table);
            annotatedFetchXml =
                `<!-- HAVING ${havingText} is evaluated client-side (FetchXML has no HAVING).\n` +
                `     ${read.pageCount} page(s), ${groups.length} group(s) read. -->\n${fetchXml}`;
        } catch (queryErr) {
            // Same 50,000-record aggregate limit fallback as below,
            // for `SELECT <col>, COUNT(*) … GROUP BY <col> HAVING …`.
            const isAggregateLimit = queryErr instanceof Error && queryErr.message.includes('0x8004e023');
            const groupMatch = isAggregateLimit ? isSimpleGroupByCount(havingPlan.stmt) : null;
            if (!groupMatch) throw queryErr;
            const fallback = await runPagedGroupByCountFallback(
                query,
                havingPlan.stmt,
                groupMatch.groupColumn,
                onProgress,
            );
            const groupKey = groupMatch.groupColumn.alias ?? groupMatch.groupColumn.column;
            const countKey = groupMatch.aggregate.alias ?? 'count_all';
            groups = Array.from(fallback.counts.entries()).map(([value, count]) => ({
                [groupKey]: value === '' ? null : value,
                [countKey]: count,
            }));
            if (havingPlan.stmt.orderBy) groups = sortRows(groups, havingPlan.stmt.orderBy);
            annotatedFetchXml =
                `<!-- Aggregate GROUP BY count exceeded Dataverse's 50,000-record limit (0x8004e023).\n` +
                `     Recovered via paged scan: ${fallback.pageCount} page(s), ${fallback.scannedRows.toLocaleString()} row(s) scanned, ${fallback.counts.size} group(s) found, aggregated client-side.\n` +
                `     HAVING ${havingText} is evaluated client-side. -->\n` +
                `<!-- Original (rejected): -->\n${fetchXml}\n` +
                `<!-- Paged scan used for the GROUP BY: -->\n${fallback.scanFetchXml}`;
        }
        const rows = applyHaving(groups, havingPlan);
        const requested = getRequestedColumns(stmt);
        const allColumns = extractColumns(rows);
        const columns = requested ? displayRequestedColumns(requested, allColumns, rows) : allColumns;
        return {
            rows,
            columns,
            fetchXml: annotatedFetchXml,
            pagingCookie: null,
            jsonColumns,
            summary: `${rows.length} of ${groups.length} group(s) matched HAVING`,
        };
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
    let fetchXml = sent(generateFetchXml(applyEntityAliases(effectiveStmt)));

    let resultRows: Record<string, unknown>[];
    let pagingCookie: string | null;
    try {
        let queryResult: Awaited<ReturnType<typeof runFetchXml>>;
        try {
            queryResult = await runFetchXml(query, fetchXml, jsonColumns);
        } catch (attrErr) {
            const isAttrMissing = attrErr instanceof Error && attrErr.message.includes('0x80041103');
            const rewrittenStmt = isAttrMissing ? rewriteVirtualColumns(stmt) : stmt;
            if (!isAttrMissing || rewrittenStmt === stmt) {
                throw attrErr;
            }
            effectiveStmt = rewrittenStmt;
            fetchXml = sent(generateFetchXml(applyEntityAliases(effectiveStmt)));
            queryResult = await runFetchXml(query, fetchXml, jsonColumns);
        }
        resultRows = queryResult.rows;
        pagingCookie = queryResult.pagingCookie;
    } catch (queryErr) {
        // Aggregate-limit fallback. Dataverse rejects aggregate
        // queries that would scan more than 50,000 source records
        // (error 0x8004e023). For simple COUNT(*) we can rerun as
        // a paged scan and count client-side.
        const isAggregateLimit = queryErr instanceof Error && queryErr.message.includes('0x8004e023');
        if (!isAggregateLimit) {
            throw queryErr;
        }
        // Branch A: simple `COUNT(*)` / `COUNT(<col>)` — one number.
        if (isSimpleCount(effectiveStmt)) {
            const fallback = await runPagedCountFallback(query, effectiveStmt, onProgress);
            const agg = effectiveStmt.columns[0] as AggregateExpr;
            const alias = agg.alias ?? `count_${agg.column.column === '*' ? 'all' : agg.column.column}`;
            return {
                rows: [{ [alias]: fallback.total }],
                columns: [alias],
                fetchXml:
                    `<!-- Aggregate count exceeded Dataverse's 50,000-record limit (0x8004e023).\n` +
                    `     Recovered via paged scan: ${fallback.pageCount} page(s), ${fallback.total} row(s) counted client-side. -->\n` +
                    `<!-- Original (rejected): -->\n${fetchXml}\n` +
                    `<!-- Paged scan used for the count: -->\n${fallback.scanFetchXml}`,
                pagingCookie: null,
                jsonColumns,
                summary: `${fallback.total.toLocaleString()} rows counted via paged scan`,
            };
        }

        // Branch B: `SELECT <col>, COUNT(*) FROM <t> [WHERE …] GROUP BY <col>`.
        const groupMatch = isSimpleGroupByCount(effectiveStmt);
        if (groupMatch) {
            const fallback = await runPagedGroupByCountFallback(
                query,
                effectiveStmt,
                groupMatch.groupColumn,
                onProgress,
            );
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
            return {
                rows: fallbackRows,
                columns: [groupKey, countKey],
                fetchXml:
                    `<!-- Aggregate GROUP BY count exceeded Dataverse's 50,000-record limit (0x8004e023).\n` +
                    `     Recovered via paged scan: ${fallback.pageCount} page(s), ${fallback.scannedRows.toLocaleString()} row(s) scanned, ${fallback.counts.size} group(s) found, aggregated client-side. -->\n` +
                    `<!-- Original (rejected): -->\n${fetchXml}\n` +
                    `<!-- Paged scan used for the GROUP BY: -->\n${fallback.scanFetchXml}`,
                pagingCookie: null,
                jsonColumns,
                summary: `${fallback.counts.size} group(s) from ${fallback.scannedRows.toLocaleString()} row(s) scanned`,
            };
        }

        throw queryErr;
    }
    let rows = applyReverseEntityAliases(resultRows, stmt.from.table);

    // If the user specified explicit columns, resolve virtual names
    // (e.g. owneridname → _ownerid_value_formatted) and only show those.
    // For SELECT *, hide derived _formatted/_type/_nav columns.
    const isSelectStar = requestedCols === null;
    let allColumns = extractColumns(rows, isSelectStar);
    let columns: string[] = requestedCols ? resolveRequestedColumns(requestedCols, allColumns, rows) : allColumns;

    // Recover virtual `xxxname` columns that Dataverse silently dropped.
    // Requesting an unknown attribute like `owneridname` on its own
    // returns rows with no owner data and no 0x80041103 error, so the
    // literal-vs-rewrite retry above never fired. Rewrite just the
    // unresolved name columns to their base lookup/optionset
    // (owneridname → ownerid) and re-run once so the formatted value
    // comes back and resolves.
    if (requestedCols && effectiveStmt === stmt && rows.length > 0) {
        const unresolved = unresolvedVirtualColumns(requestedCols, allColumns, rows);
        if (unresolved.size > 0) {
            const rewritten = rewriteVirtualColumns(stmt, unresolved);
            if (rewritten !== stmt) {
                const retryFetchXml = generateFetchXml(applyEntityAliases(rewritten));
                try {
                    const retry = await runFetchXml(query, retryFetchXml, jsonColumns);
                    const retryRows = applyReverseEntityAliases(retry.rows, stmt.from.table);
                    const retryAllColumns = extractColumns(retryRows, isSelectStar);
                    const retryColumns = resolveRequestedColumns(requestedCols, retryAllColumns, retryRows);
                    // Only adopt the rewrite if it actually resolved more
                    // columns — otherwise keep the literal result so the
                    // clear "no readable columns" error still surfaces.
                    if (retryColumns.length > columns.length) {
                        effectiveStmt = rewritten;
                        fetchXml = retryFetchXml;
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

    // Show every requested column, including ones that are null in
    // every row (Dataverse omits nulls, so they have no result key).
    if (requestedCols) {
        columns = displayRequestedColumns(requestedCols, allColumns, rows);
    }

    return {
        rows,
        columns,
        fetchXml,
        pagingCookie,
        jsonColumns,
        summary: `${rows.length} rows returned`,
    };
}
