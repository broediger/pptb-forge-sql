import { generateFetchXml } from './generator';
import type { SelectStatement, WhereExpr, ColumnRef, InSubqueryExpr, LiteralValue } from './types';
import { isAggregateExpr, isColumnRef, isJsonValueExpr } from './types';
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
import { planHaving, applyHaving, withPage, HAVING_PAGE_SIZE, MAX_HAVING_GROUPS } from './having';
import { describeCondition } from './condition';
import { primaryKeyOf, withActivityKey } from './primaryKey';
import {
    AGGREGATE_LIMIT_CODE,
    SCAN_PAGE_SIZE,
    ClientAggregator,
    isAggregateLimitError,
    isPlainTableCount,
    keyValues,
    planClientAggregate,
    scanAfter,
    type ClientAggregatePlan,
} from './clientAggregate';
import {
    planVirtualFilter,
    assertVirtualFilterSupported,
    matchesVirtualFilter,
    finishVirtualFilter,
    hasMissingAttributes,
    quotedList,
    type MissingAttributes,
    type VirtualFilterPlan,
    emptyMissingAttributes,
    recordMissingAttribute,
    ATTRIBUTE_MISSING_CODE,
    MAX_VIRTUAL_FILTER_ROWS,
} from './virtualFilter';

/**
 * Runs a SELECT against Dataverse: subquery expansion, HAVING, the virtual
 * `xxxname` retries and the 50,000-record aggregate fallback (`clientAggregate.ts`). Dataverse is
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
    /**
     * Max rows returned when WHERE is filtered client-side (virtual name
     * columns), where Dataverse paging can't continue the filter. Defaults to
     * `DEFAULT_CLIENT_FILTER_ROWS`.
     */
    rowLimit?: number;
    /**
     * Checked before each page of a client-side aggregate scan (the 50,000-record
     * fallback); when it returns true the scan stops and the partial values are
     * returned with a `limitNote`.
     */
    isCancelled?: () => boolean;
    /** Rows read so far by a client-side aggregate scan. */
    onScanProgress?: (scannedRows: number) => void;
    /** Max rows a client-side aggregate scan may read before it fails; unlimited when unset. */
    maxScanRows?: number;
    /**
     * Record count of a table from RetrieveTotalRecordCount, for `SELECT COUNT(*)
     * FROM <table>` over the limit. Without it (or when it fails) the rows are counted.
     */
    totalRecordCount?: (table: string) => Promise<number | null>;
}

/** Rows returned by a client-side filtered query without TOP: one Dataverse page's worth. */
export const DEFAULT_CLIENT_FILTER_ROWS = 5000;

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
    /**
     * Set when more rows match than were returned and they can't be paged
     * (a client-side filter stopped at `rowLimit`): a note for the user.
     */
    limitNote?: string;
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

function isMissingAttributeError(err: unknown, attribute?: string): err is Error {
    if (!(err instanceof Error) || !err.message.includes(ATTRIBUTE_MISSING_CODE)) return false;
    return attribute === undefined || err.message.toLowerCase().includes(`'${attribute.toLowerCase()}'`);
}

/**
 * The attributes a 0x80041103 error says to avoid, added to `missing` (a new
 * set by default). Null when `err` isn't such an error or taught nothing new.
 */
function learnMissing(err: unknown, missing: MissingAttributes = emptyMissingAttributes()): MissingAttributes | null {
    return isMissingAttributeError(err) && recordMissingAttribute(missing, err) ? missing : null;
}

function fetchXmlOf(stmt: SelectStatement): string {
    return generateFetchXml(applyEntityAliases(stmt));
}

/**
 * Send page 1 of a scan ordered by the primary key. When Dataverse rejects
 * the guessed `<table>id` (a custom activity table), retry with `activityid`.
 * Returns the result and the FetchXML later pages must use.
 */
async function firstScanPage<T>(
    stmt: SelectStatement,
    run: (fetchXml: string) => Promise<T>,
    onFetchXml?: (fetchXml: string) => void,
): Promise<{ result: T; fetchXml: string }> {
    const fetchXml = fetchXmlOf(stmt);
    onFetchXml?.(fetchXml);
    try {
        return { result: await run(fetchXml), fetchXml };
    } catch (err) {
        const swapped = isMissingAttributeError(err, `${stmt.from.table}id`) ? withActivityKey(stmt) : null;
        if (!swapped) throw err;
        const activityFetchXml = fetchXmlOf(swapped);
        onFetchXml?.(activityFetchXml);
        return { result: await run(activityFetchXml), fetchXml: activityFetchXml };
    }
}

interface ClientAggregateRun {
    aggregator: ClientAggregator;
    pageCount: number;
    /** FetchXML of the first scan page, as sent. */
    scanFetchXml: string;
    /** Keyset paging (joins) instead of the paging cookie. */
    keyset: boolean;
    cancelled: boolean;
}

/**
 * Fallback for an aggregate query Dataverse rejects with the 50,000-record
 * limit (0x8004e023), as SQL 4 CDS does it: read the same rows without
 * aggregation, page by page, and aggregate client-side.
 *
 * The scan never relies on `@Microsoft.Dynamics.CRM.morerecords` (Dataverse
 * leaves it out on some queries that do have more pages) nor on page numbers
 * alone (they repeat rows across pages and stop at 50,000 records). Without
 * joins it pages with the paging cookie, ordered by the primary key. With
 * joins one record can appear in several rows while a cookie only tracks the
 * root record, so joined scans page by keyset: ordered by every table's
 * primary key, each page asks for the rows after the last key of the previous
 * one. A full page that comes back without a cookie continues by keyset too.
 */
async function runClientAggregate(
    query: FetchXmlQueryFn,
    plan: ClientAggregatePlan,
    options: SelectExecutionOptions,
): Promise<ClientAggregateRun> {
    const aggregator = new ClientAggregator(plan);
    const table = plan.scanStmt.from.table;
    let keyset = plan.scanStmt.joins.length > 0;
    let keyPlan = plan;
    let scanFetchXml = '';
    let pagingCookie: string | null = null;
    let lastKeys: unknown[] = [];
    const done = (pageCount: number, cancelled = false): ClientAggregateRun => ({
        aggregator,
        pageCount,
        scanFetchXml,
        keyset,
        cancelled,
    });
    const pageStmt = () => ({ ...keyPlan.scanStmt, top: SCAN_PAGE_SIZE });

    for (let page = 1; ; page++) {
        if (page > 1 && options.isCancelled?.()) return done(page - 1, true);
        let result!: FetchXmlQueryResult;
        try {
            if (page === 1) {
                // A guessed `<table>id` key that doesn't exist is an activity table's `activityid`.
                for (let attempt = 0; ; attempt++) {
                    scanFetchXml = fetchXmlOf(keyset ? pageStmt() : keyPlan.scanStmt);
                    options.onFetchXml?.(scanFetchXml);
                    try {
                        result = await query(scanFetchXml);
                        break;
                    } catch (err) {
                        const swapped = attempt < keyPlan.keyColumns.length ? swapActivityKey(keyPlan, err) : null;
                        if (!swapped) throw err;
                        keyPlan = swapped;
                    }
                }
            } else if (keyset) {
                result = await query(fetchXmlOf(scanAfter(pageStmt(), keyPlan.keyColumns, lastKeys)));
            } else {
                result = await query(injectPagingIntoFetchXml(scanFetchXml, pagingCookie!, page));
            }
        } catch (err) {
            if (page === 1) throw err;
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(
                `The client-side aggregate stopped on page ${page} after ${aggregator.scannedRows.toLocaleString('en-US')} rows: ${message}`,
            );
        }
        const raw = rawRows(result);
        const rows = applyReverseEntityAliases(cleanRows(raw), table);
        aggregator.add(rows);
        options.onProgress?.(aggregator.scannedRows);
        options.onScanProgress?.(aggregator.scannedRows);
        if (options.maxScanRows !== undefined && aggregator.scannedRows > options.maxScanRows) {
            throw new Error(
                `The aggregate exceeds Dataverse's 50,000-record limit, and computing it client-side would read more than ` +
                    `${options.maxScanRows.toLocaleString('en-US')} rows. Add filters to narrow it.`,
            );
        }
        if (raw.length === 0) return done(page);
        pagingCookie = keyset ? null : pagingCookieOf(result);
        if (pagingCookie) continue;
        // No cookie: a short page is the last one; a full page continues by keyset.
        if (raw.length < SCAN_PAGE_SIZE) return done(page);
        keyset = true;
        lastKeys = keyValues(rows[rows.length - 1], keyPlan);
    }
}

/** `plan` with the guessed `<table>id` key that `err` rejected replaced by `activityid`. */
function swapActivityKey(plan: ClientAggregatePlan, err: unknown): ClientAggregatePlan | null {
    const tableOf = (key: ColumnRef) =>
        key.table ? plan.scanStmt.joins.find((j) => (j.alias ?? j.table) === key.table)?.table : plan.scanStmt.from.table;
    const index = plan.keyColumns.findIndex((key) => {
        const t = tableOf(key);
        return !!t && key.column === `${t.toLowerCase()}id` && isMissingAttributeError(err, key.column);
    });
    if (index === -1) return null;
    const old = plan.keyColumns[index];
    const swapped: ColumnRef = { ...old, column: 'activityid' };
    const same = (c: ColumnRef) => c.column === old.column && (c.table ?? '') === (old.table ?? '');
    const keyColumns = plan.keyColumns.map((k, i) => (i === index ? swapped : k));
    return {
        ...plan,
        keyColumns,
        scanStmt: {
            ...plan.scanStmt,
            columns: plan.scanStmt.columns.map((c) => (isColumnRef(c) && same(c) ? swapped : c)) as ColumnRef[],
            orderBy: keyColumns.map((column) => ({ column, direction: 'ASC' })),
        },
    };
}

/**
 * `SELECT COUNT(*) FROM <table>` over the limit: Dataverse's record-count
 * snapshot, when the host can run RetrieveTotalRecordCount. Null to scan instead.
 */
async function snapshotCount(stmt: SelectStatement, options: SelectExecutionOptions): Promise<number | null> {
    if (!options.totalRecordCount || !isPlainTableCount(stmt)) return null;
    try {
        return await options.totalRecordCount(stmt.from.table);
    } catch {
        return null;
    }
}

function describeScan(run: ClientAggregateRun): string {
    const how = run.keyset
        ? 'paged by primary keys (keyset; the joins can repeat a record across rows)'
        : 'paged with the paging cookie';
    const stop = run.cancelled ? ' Cancelled: the values are partial.' : '';
    return (
        `     Computed client-side from a scan without aggregation, ${how}:\n` +
        `     ${run.pageCount} page(s), ${run.aggregator.scannedRows.toLocaleString('en-US')} row(s) read, ` +
        `${run.aggregator.groupCount.toLocaleString('en-US')} group(s).${stop}`
    );
}

function cancelledNote(run: ClientAggregateRun): string | undefined {
    return run.cancelled
        ? `Cancelled after ${run.aggregator.scannedRows.toLocaleString('en-US')} rows: these values cover only the rows read so far.`
        : undefined;
}

interface FetchAllRowsOptions {
    /** Max rows read (before `matches`) before giving up; defaults to the subquery limit. */
    maxRows?: number;
    /** Error message when `maxRows` is exceeded. */
    tooManyRows?: string;
    /** Keep only the rows passing this test (a client-side WHERE). */
    matches?: (row: Record<string, unknown>) => boolean;
    /** Stop reading once this many rows were kept (TOP after a client-side WHERE). */
    stopAfter?: number;
    /** Rows kept so far, after each page. */
    onProgress?: (rowCount: number) => void;
    /** The FetchXML of the first page, as sent (including the paging order). */
    onFetchXml?: (fetchXml: string) => void;
}

interface ReadAllResult {
    rows: Record<string, unknown>[];
    fetchXml: string;
    pageCount: number;
    /** Rows read from Dataverse, before `matches`. */
    scannedRows: number;
}

/**
 * Read every page of a query. Used for subquery values, for split queries,
 * and for client-side WHERE filters, where the results must be complete.
 */
async function fetchAllRows(
    query: FetchXmlQueryFn,
    stmt: SelectStatement,
    jsonColumns: JsonValueColumn[],
    options: FetchAllRowsOptions = {},
): Promise<ReadAllResult> {
    const maxRows = options.maxRows ?? MAX_SUBQUERY_ROWS;
    // Paging cookies need a stable, unique order: the primary key, after any
    // ORDER BY as a tiebreaker. TOP queries return one page; aggregates and
    // DISTINCT can't take an extra order column.
    const primaryKey = primaryKeyOf(stmt.from.table);
    const fromRef = (stmt.from.alias ?? stmt.from.table).toLowerCase();
    const ordersByKey = stmt.orderBy?.some(
        (o) =>
            o.column.column.toLowerCase() === primaryKey &&
            (!o.column.table || [fromRef, stmt.from.table.toLowerCase()].includes(o.column.table.toLowerCase())),
    );
    const canOrder = !stmt.distinct && stmt.top === undefined && !stmt.groupBy && !stmt.columns.some(isAggregateExpr);
    const scanStmt: SelectStatement =
        canOrder && !ordersByKey
            ? { ...stmt, orderBy: [...(stmt.orderBy ?? []), { column: { column: primaryKey }, direction: 'ASC' }] }
            : stmt;
    let fetchXml = '';
    const rows: Record<string, unknown>[] = [];
    let scannedRows = 0;
    let page = 1;
    let pagingCookie: string | null = null;
    // Set when a full page came back without a paging cookie: continue after
    // the last primary key instead (only when ordered by the key alone).
    let keysetStmt: SelectStatement | null = null;
    while (true) {
        let result: Awaited<ReturnType<typeof runFetchXml>>;
        if (page === 1) {
            ({ result, fetchXml } = await firstScanPage(
                scanStmt,
                (xml) => runFetchXml(query, xml, jsonColumns),
                options.onFetchXml,
            ));
        } else if (keysetStmt) {
            result = await runFetchXml(query, fetchXmlOf(keysetStmt), jsonColumns);
        } else {
            result = await runFetchXml(query, injectPagingIntoFetchXml(fetchXml, pagingCookie!, page), jsonColumns);
        }
        const pageRows = applyReverseEntityAliases(result.rows, stmt.from.table);
        scannedRows += pageRows.length;
        for (const row of pageRows) {
            if (!options.matches || options.matches(row)) rows.push(row);
        }
        options.onProgress?.(rows.length);
        if (options.stopAfter !== undefined && rows.length >= options.stopAfter) break;
        if (scannedRows > maxRows) {
            throw new Error(
                options.tooManyRows ??
                    `A subquery read more than ${maxRows.toLocaleString()} rows from '${stmt.from.table}'. Add filters to narrow it.`,
            );
        }
        pagingCookie = keysetStmt ? null : result.pagingCookie;
        if (result.rows.length === 0 || stmt.top !== undefined) break;
        if (!pagingCookie) {
            // Dataverse doesn't always say there are more pages: a full page
            // without a cookie may not be the last. Never fall back to page
            // numbers alone, which repeat rows across pages.
            if (result.rows.length < SCAN_PAGE_SIZE) break;
            // Page 1 may have swapped `<table>id` for `activityid`.
            const pagedStmt = fetchXml === fetchXmlOf(scanStmt) ? scanStmt : (withActivityKey(scanStmt) ?? scanStmt);
            const order = pagedStmt.orderBy ?? [];
            const key = order.length === 1 && !order[0].column.table ? order[0].column.column : null;
            if (!canOrder || stmt.joins.length > 0 || !key || order[0].direction !== 'ASC') {
                throw new Error(
                    `Dataverse returned a full page of ${SCAN_PAGE_SIZE.toLocaleString('en-US')} rows from '${stmt.from.table}' ` +
                        `without a paging cookie, so the remaining rows can't be read reliably. Add filters to narrow the query.`,
                );
            }
            const last = result.rows[result.rows.length - 1][key];
            if (last == null) throw new Error(`Paged scan of '${stmt.from.table}' returned a row without '${key}'.`);
            const after: WhereExpr = { kind: 'comparison', left: { column: key }, operator: '>', right: String(last) };
            keysetStmt = {
                ...pagedStmt,
                top: SCAN_PAGE_SIZE,
                where: pagedStmt.where ? { kind: 'and', left: pagedStmt.where, right: after } : after,
            };
        }
        page += 1;
    }
    return {
        rows: options.stopAfter !== undefined ? rows.slice(0, options.stopAfter) : rows,
        fetchXml,
        pageCount: page,
        scannedRows,
    };
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
        const learned = emptyMissingAttributes();
        // Subquery scans must not get JSON_VALUE columns; those apply
        // only to the outer query's rows.
        for (const scan of await expandSubqueries(query, subqueryScanStatement(sub.subquery))) {
            rows.push(...(await readAllRows(query, scan, [], learned)).rows);
        }
        values.set(sub, extractSubqueryValues(rows, sub.subquery));
    }
    return planQueries(stmt, values);
}

interface VirtualFilterRead extends ReadAllResult {
    plan: VirtualFilterPlan;
    /** Set when `rowLimit` cut off further matches. */
    limitNote?: string;
}

/** Text safe inside an XML comment. */
function commentText(text: string): string {
    return text.replace(/--/g, '- -');
}

interface VirtualReadOptions extends Pick<FetchAllRowsOptions, 'onProgress' | 'onFetchXml'> {
    /** Max rows to return; unset to read every match (subqueries, split queries). */
    rowLimit?: number;
}

/**
 * WHERE on virtual `xxxname` columns (see `virtualFilter.ts`), once `missing`
 * holds at least one attribute Dataverse rejected. Each further 0x80041103
 * names another attribute to avoid; the query is re-planned until it runs, or
 * until re-planning no longer changes it. Returns null when no WHERE
 * condition is affected. A column that isn't a display name either (its base
 * column is rejected too, e.g. a typo) gets the first error.
 */
async function readWithVirtualFilter(
    query: FetchXmlQueryFn,
    stmt: SelectStatement,
    jsonColumns: JsonValueColumn[],
    missing: MissingAttributes,
    options: VirtualReadOptions = {},
): Promise<VirtualFilterRead | null> {
    let plan = planVirtualFilter(stmt, missing);
    if (!plan) return null;
    let planXml = fetchXmlOf(plan.stmt);
    const isSelectStar = getRequestedColumns(stmt) === null;

    while (true) {
        if (plan.unresolved.length > 0) {
            throw missing.firstError ?? new Error(`Dataverse has no attribute ${quotedList(plan.unresolved)}.`);
        }
        const current = plan;
        const cap = Math.min(current.top ?? Infinity, options.rowLimit ?? Infinity);
        try {
            const read = await fetchAllRows(query, current.stmt, jsonColumns, {
                maxRows: MAX_VIRTUAL_FILTER_ROWS,
                tooManyRows:
                    `Filtering on ${quotedList(current.virtualColumns)} is done client-side (Dataverse has no such attribute), ` +
                    `and the rest of the query matches more than ${MAX_VIRTUAL_FILTER_ROWS.toLocaleString()} rows. ` +
                    `Add filters on real columns to narrow it.`,
                matches: (row) => matchesVirtualFilter(row, current),
                // A client-side sort needs every row before the first can be picked.
                // Past the row limit, read one more match to know whether more exist.
                stopAfter:
                    current.clientOrder || cap === Infinity
                        ? undefined
                        : cap < (current.top ?? Infinity)
                          ? cap + 1
                          : cap,
                onProgress: options.onProgress,
                onFetchXml: options.onFetchXml,
            });
            let rows = current.clientOrder ? sortRows(read.rows, current.clientOrder) : read.rows;
            const more = rows.length > cap;
            rows = rows.slice(0, cap);
            // Cut off by the row limit rather than by TOP: tell the user.
            const limited = more && cap < (current.top ?? Infinity);
            return {
                ...read,
                rows: finishVirtualFilter(rows, current, isSelectStar),
                plan: current,
                limitNote: limited
                    ? `Showing the first ${rows.length.toLocaleString()} matches. More rows match, but the filter on ` +
                      `${quotedList(current.virtualColumns)} runs client-side and can't be paged: add TOP or filters on real columns.`
                    : undefined,
            };
        } catch (err) {
            if (!learnMissing(err, missing)) throw err;
            const next = planVirtualFilter(stmt, missing);
            if (!next) throw err;
            const nextXml = fetchXmlOf(next.stmt);
            if (nextXml === planXml && next.unresolved.length === 0) throw err;
            plan = next;
            planXml = nextXml;
        }
    }
}

/**
 * `fetchAllRows`, retried with a client-side filter when WHERE uses virtual
 * name columns. `learned` carries rejected attributes across related reads
 * (the parts of a split query), so each part doesn't fail first.
 */
async function readAllRows(
    query: FetchXmlQueryFn,
    stmt: SelectStatement,
    jsonColumns: JsonValueColumn[],
    learned: MissingAttributes = emptyMissingAttributes(),
): Promise<ReadAllResult> {
    if (hasMissingAttributes(learned)) {
        const read = await readWithVirtualFilter(query, stmt, jsonColumns, learned);
        if (read) return read;
    }
    try {
        return await fetchAllRows(query, stmt, jsonColumns);
    } catch (err) {
        if (!learnMissing(err, learned)) throw err;
        const read = await readWithVirtualFilter(query, stmt, jsonColumns, learned);
        if (!read) throw err;
        return read;
    }
}

/**
 * Dataverse returns rows but silently drops attributes when the column is
 * encrypted and the query uses DISTINCT/aggregates, when field-level security
 * hides it, or when it doesn't exist. Throw a clear error instead of showing
 * an empty grid.
 */
function assertReadableColumns(
    stmt: SelectStatement,
    requestedCols: string[] | null,
    rowCount: number,
    resolvedCount: number,
): void {
    if (rowCount === 0 || resolvedCount > 0) return;
    const requested = requestedCols?.join(', ') ?? '*';
    const hasAggregate = stmt.columns.some((c) => 'function' in c);
    const hint =
        stmt.distinct || hasAggregate
            ? ' This commonly happens when DISTINCT or aggregates are used on an encrypted column — try removing DISTINCT and the aggregate functions, or selecting the column directly.'
            : ' The attribute(s) may be hidden by field-level security or not present on the entity.';
    throw new Error(
        `Query returned ${rowCount} row(s) but no readable columns for [${requested}] on '${stmt.from.table}'.${hint}`,
    );
}

function virtualFilterResult(
    stmt: SelectStatement,
    read: VirtualFilterRead,
    jsonColumns: JsonValueColumn[],
): SelectExecutionResult {
    const requestedCols = getRequestedColumns(stmt);
    const allColumns = extractColumns(read.rows, requestedCols === null);
    if (requestedCols) {
        const resolved = resolveRequestedColumns(requestedCols, allColumns, read.rows);
        assertReadableColumns(stmt, requestedCols, read.rows.length, resolved.length);
    }
    const columns = requestedCols ? displayRequestedColumns(requestedCols, allColumns, read.rows) : allColumns;
    const virtualList = quotedList(read.plan.virtualColumns);
    const top = read.plan.top;
    const stop = read.limitNote
        ? ' (stopped at the row limit)'
        : top !== undefined && read.rows.length >= top && !read.plan.clientOrder
          ? ' (stopped at TOP)'
          : '';
    const sorted = read.plan.clientOrder ? ' ORDER BY is sorted client-side.' : '';
    return {
        rows: read.rows,
        columns,
        fetchXml:
            `<!-- WHERE ${commentText(describeCondition(read.plan.filter))} is evaluated client-side: Dataverse has no attribute ` +
            `${commentText(virtualList)} (${ATTRIBUTE_MISSING_CODE}),\n` +
            `     so it's read as the display name of its base column.${sorted} ${read.pageCount} page(s), ` +
            `${read.scannedRows} row(s) read, ${read.rows.length} matched${stop}. -->\n` +
            read.fetchXml,
        pagingCookie: null,
        jsonColumns,
        summary: `${read.rows.length} of ${read.scannedRows} rows matched the client-side filter on ${virtualList}`,
        limitNote: read.limitNote,
    };
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
        const learned = emptyMissingAttributes();
        for (const plan of plans) {
            const part = await readAllRows(query, plan, jsonColumns, learned);
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
        const havingText = commentText(describeCondition(havingPlan.having));
        let groups: Record<string, unknown>[];
        let annotatedFetchXml: string;
        let havingNote: string | undefined;
        try {
            const read = await fetchAllAggregatePages(query, fetchXml, onProgress);
            groups = applyReverseEntityAliases(read.rows, stmt.from.table);
            annotatedFetchXml =
                `<!-- HAVING ${havingText} is evaluated client-side (FetchXML has no HAVING).\n` +
                `     ${read.pageCount} page(s), ${groups.length} group(s) read. -->\n${fetchXml}`;
        } catch (queryErr) {
            // A WHERE on a virtual name column can't be filtered client-side
            // before grouping; planVirtualFilter explains that.
            const missing = learnMissing(queryErr);
            if (missing) {
                assertVirtualFilterSupported(havingPlan.stmt, missing);
                throw queryErr;
            }
            // Over the 50,000-record limit: aggregate client-side (see below),
            // then HAVING on the groups.
            const plan = isAggregateLimitError(queryErr) ? planClientAggregate(havingPlan.stmt) : null;
            if (!plan) throw queryErr;
            const run = await runClientAggregate(query, plan, options);
            groups = run.aggregator.rows(true);
            havingNote = cancelledNote(run);
            annotatedFetchXml =
                `<!-- The aggregate exceeded Dataverse's 50,000-record limit (${AGGREGATE_LIMIT_CODE}).\n` +
                `${describeScan(run)}\n` +
                `     HAVING ${havingText} is evaluated client-side. -->\n` +
                `<!-- Original (rejected): -->\n${fetchXml}\n` +
                `<!-- First page of the scan: -->\n${run.scanFetchXml}`;
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
            summary: `${rows.length} of ${groups.length} group(s) matched HAVING${havingNote ? ' (partial: cancelled)' : ''}`,
            limitNote: havingNote,
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
            const isAttrMissing = isMissingAttributeError(attrErr);
            const missing = learnMissing(attrErr);
            if (missing) {
                const read = await readWithVirtualFilter(query, stmt, jsonColumns, missing, {
                    onProgress,
                    onFetchXml: options.onFetchXml,
                    rowLimit: options.rowLimit ?? DEFAULT_CLIENT_FILTER_ROWS,
                });
                if (read) return virtualFilterResult(stmt, read, jsonColumns);
            }
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
        // Dataverse rejects an aggregate over more than 50,000 source records
        // (0x8004e023). A plain table count comes from the record-count
        // snapshot; anything else is aggregated client-side from a scan.
        if (!isAggregateLimitError(queryErr)) throw queryErr;
        const snapshot = await snapshotCount(effectiveStmt, options);
        if (snapshot !== null) {
            const key = getRequestedColumns(effectiveStmt)![0];
            return {
                rows: [{ [key]: snapshot }],
                columns: [key],
                fetchXml:
                    `<!-- The count exceeded Dataverse's 50,000-record limit (${AGGREGATE_LIMIT_CODE}).\n` +
                    `     Taken from RetrieveTotalRecordCount instead: Dataverse's record-count snapshot,\n` +
                    `     which can lag recent changes. -->\n${fetchXml}`,
                pagingCookie: null,
                jsonColumns,
                summary: `${snapshot.toLocaleString('en-US')} rows (RetrieveTotalRecordCount snapshot)`,
            };
        }
        const plan = planClientAggregate(effectiveStmt);
        if (plan) {
            const run = await runClientAggregate(query, plan, options);
            const rows = run.aggregator.rows();
            const requested = getRequestedColumns(effectiveStmt);
            const columns = requested
                ? displayRequestedColumns(requested, extractColumns(rows), rows)
                : extractColumns(rows);
            const limitNote = cancelledNote(run);
            return {
                rows,
                columns,
                fetchXml:
                    `<!-- The aggregate exceeded Dataverse's 50,000-record limit (${AGGREGATE_LIMIT_CODE}).\n` +
                    `${describeScan(run)} -->\n` +
                    `<!-- Original (rejected): -->\n${fetchXml}\n` +
                    `<!-- First page of the scan: -->\n${run.scanFetchXml}`,
                pagingCookie: null,
                jsonColumns,
                summary:
                    `${rows.length} row(s) aggregated client-side from ${run.aggregator.scannedRows.toLocaleString('en-US')} rows read` +
                    (limitNote ? ' (partial: cancelled)' : ''),
                limitNote,
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

    assertReadableColumns(stmt, requestedCols, rows.length, columns.length);

    // Show every requested column, including ones that are null in
    // every row (Dataverse omits nulls, so they have no result key).
    if (requestedCols) {
        columns = displayRequestedColumns(requestedCols, allColumns, rows);
    }

    // Dataverse doesn't always flag more pages: a full page without a cookie
    // may not be everything, and page numbers alone would repeat rows.
    const fullPageWithoutCookie =
        !pagingCookie && effectiveStmt.top === undefined && resultRows.length >= SCAN_PAGE_SIZE;
    return {
        rows,
        columns,
        fetchXml,
        pagingCookie,
        jsonColumns,
        summary: `${rows.length} rows returned`,
        limitNote: fullPageWithoutCookie
            ? `Showing the first ${resultRows.length.toLocaleString('en-US')} rows. Dataverse sent no paging cookie, so ` +
              `more rows may match but can't be loaded reliably: add TOP, filters, or an aggregate.`
            : undefined,
    };
}
