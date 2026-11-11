import type { AggregateExpr, ColumnRef, OrderByItem, SelectStatement, WhereExpr } from './types';
import { SqlParseError, isAggregateExpr, isJsonValueExpr } from './types';
import { groupByColumnAliases } from './generator';
import { primaryKeyOf } from './primaryKey';
import { sortRows } from './subquery';

// ── Client-side aggregation ──
//
// Dataverse refuses an aggregate query whose source rows exceed 50,000
// (0x8004e023, AggregateQueryRecordLimit). The fallback reads the same rows
// without aggregation, page by page, and computes COUNT/SUM/AVG/MIN/MAX and
// the GROUP BY groups here. Only the running totals are kept, not the rows.

/** Error code of Dataverse's 50,000-record aggregate limit. */
export const AGGREGATE_LIMIT_CODE = '0x8004e023';

/** Rows per page of the scan (Dataverse's maximum). */
export const SCAN_PAGE_SIZE = 5000;

export function isAggregateLimitError(err: unknown): err is Error {
    return err instanceof Error && err.message.toLowerCase().includes(AGGREGATE_LIMIT_CODE);
}

/** Where a column's values are found in a scanned row. */
interface ValueSource {
    /** Result key candidates, in order: the attribute, then its `_x_value` lookup form. */
    candidates: string[];
}

interface GroupColumn {
    source: ValueSource;
    /** Result key when the column is in the SELECT list. */
    outputKey?: string;
}

interface AggregateColumn {
    agg: AggregateExpr;
    /** Null for COUNT(*). */
    source: ValueSource | null;
    outputKey: string;
}

export interface ClientAggregatePlan {
    /**
     * The non-aggregate query to page through: the grouped and aggregated
     * columns plus the primary key of every table, ordered by those keys.
     */
    scanStmt: SelectStatement;
    /**
     * The ordering key columns (root primary key, then each join's), in the
     * form `scanStmt` uses. With joins one record can appear in several rows,
     * so the scan pages by these keys rather than with the paging cookie.
     */
    keyColumns: ColumnRef[];
    groupColumns: GroupColumn[];
    aggregates: AggregateColumn[];
    /** ORDER BY in terms of the result keys. */
    orderBy?: OrderByItem[];
    top?: number;
    /** No GROUP BY: one result row, even when nothing matches. */
    singleGroup: boolean;
}

/** Result key Dataverse uses for an aggregate (matches the generator's auto alias). */
function aggregateOutputKey(agg: AggregateExpr): string {
    return agg.alias ?? `${agg.function.toLowerCase()}_${agg.column.column === '*' ? 'all' : agg.column.column}`;
}

function sameColumn(a: ColumnRef, b: ColumnRef, refOf: (c: ColumnRef) => string): boolean {
    return a.column.toLowerCase() === b.column.toLowerCase() && refOf(a) === refOf(b);
}

/**
 * Plan the client-side evaluation of an aggregate SELECT. Returns null when the
 * statement has no aggregate and no GROUP BY. `stmt` must not carry HAVING:
 * the caller plans that with `planHaving` and applies it to the result rows.
 */
export function planClientAggregate(stmt: SelectStatement): ClientAggregatePlan | null {
    const hasAggregate = stmt.columns.some(isAggregateExpr);
    if (!hasAggregate && !stmt.groupBy) return null;
    if (stmt.having) throw new Error('planClientAggregate: plan HAVING first');

    // Table reference → link alias ('' for the FROM table).
    const fromRefs = new Set([stmt.from.table.toLowerCase(), (stmt.from.alias ?? stmt.from.table).toLowerCase()]);
    const linkAlias = new Map<string, string>();
    for (const j of stmt.joins) {
        const alias = j.alias ?? j.table;
        linkAlias.set(j.table.toLowerCase(), alias);
        linkAlias.set(alias.toLowerCase(), alias);
    }
    const refOf = (col: ColumnRef): string => {
        if (!col.table || fromRefs.has(col.table.toLowerCase())) return '';
        const alias = linkAlias.get(col.table.toLowerCase());
        if (alias === undefined) throw new SqlParseError(`Unknown table reference '${col.table}'`, 0, 0);
        return alias;
    };

    const scanColumns: ColumnRef[] = [];
    const scanned = new Set<string>();
    const source = (col: ColumnRef): ValueSource => {
        const ref = refOf(col);
        const name = col.column.toLowerCase();
        const key = `${ref}.${name}`;
        if (!scanned.has(key)) {
            scanned.add(key);
            scanColumns.push(ref ? { table: ref, column: col.column } : { column: col.column });
        }
        const prefix = ref ? `${ref}.` : '';
        return { candidates: [`${prefix}${name}`, `${prefix}_${name}_value`] };
    };

    // Ordering keys: every table's primary key, so each scanned row is unique.
    const keyColumns: ColumnRef[] = [{ column: primaryKeyOf(stmt.from.table) }];
    for (const j of stmt.joins) keyColumns.push({ table: j.alias ?? j.table, column: primaryKeyOf(j.table) });
    for (const key of keyColumns) source(key);

    const groupBy = stmt.groupBy ?? [];
    const groupColumns: GroupColumn[] = groupBy.map((g) => ({ source: source(g) }));
    const groupAliases = groupByColumnAliases(stmt);
    const aggregates: AggregateColumn[] = [];
    const orderKeys = new Map<string, string>();

    stmt.columns.forEach((col, i) => {
        if (isJsonValueExpr(col)) {
            throw new SqlParseError('JSON_VALUE cannot be combined with aggregates or GROUP BY', 0, 0);
        }
        if (isAggregateExpr(col)) {
            const isStar = col.column.column === '*';
            if (isStar && col.distinct) throw new SqlParseError('COUNT(DISTINCT *) is not valid', 0, 0);
            if (isStar && col.function !== 'COUNT') {
                throw new SqlParseError(`${col.function}(*) is not valid; name a column`, 0, 0);
            }
            aggregates.push({
                agg: col,
                source: isStar ? null : source(col.column),
                outputKey: aggregateOutputKey(col),
            });
            return;
        }
        if (col.column === '*') {
            throw new SqlParseError('SELECT * cannot be combined with aggregates or GROUP BY', 0, 0);
        }
        const index = groupBy.findIndex((g) => sameColumn(g, col, refOf));
        if (index === -1) {
            const name = col.table ? `${col.table}.${col.column}` : col.column;
            throw new SqlParseError(`Column '${name}' must appear in GROUP BY or inside an aggregate function`, 0, 0);
        }
        const outputKey = col.alias ?? groupAliases[i] ?? col.column;
        groupColumns[index].outputKey ??= outputKey;
        orderKeys.set(`${refOf(col)}.${col.column.toLowerCase()}`, outputKey);
    });

    // ORDER BY a grouped column sorts by its result key (it may be renamed,
    // e.g. `t2_statuscode`); aliases and aggregate keys are already result keys.
    const orderBy = stmt.orderBy?.map((item) => {
        let key: string | undefined;
        try {
            key = orderKeys.get(`${refOf(item.column)}.${item.column.column.toLowerCase()}`);
        } catch {
            key = undefined;
        }
        return key ? { ...item, column: { column: key } } : item;
    });

    const scanStmt: SelectStatement = {
        type: 'select',
        columns: scanColumns,
        from: stmt.from,
        joins: stmt.joins,
        where: stmt.where,
        orderBy: keyColumns.map((column) => ({ column, direction: 'ASC' })),
    };

    return {
        scanStmt,
        keyColumns,
        groupColumns,
        aggregates,
        orderBy,
        top: stmt.top,
        singleGroup: groupBy.length === 0,
    };
}

// ── Keyset paging ──

function after(col: ColumnRef, value: unknown): WhereExpr {
    // ASC sorts NULL first, so every non-null value comes after a null one.
    if (value == null) return { kind: 'is_null', column: col, negated: true };
    return { kind: 'comparison', left: col, operator: '>', right: String(value) };
}

function equal(col: ColumnRef, value: unknown): WhereExpr {
    if (value == null) return { kind: 'is_null', column: col };
    return { kind: 'comparison', left: col, operator: '=', right: String(value) };
}

/**
 * The condition for the rows after `last` in key order, lexicographic across
 * all keys:
 *
 *   (k1 > v1) OR (k1 = v1 AND k2 > v2) OR (k1 = v1 AND k2 = v2 AND k3 > v3) …
 *
 * Each key keeps its table reference, so link-entity keys get `entityname`.
 * The comparisons run on the server: GUIDs follow SQL Server's
 * uniqueidentifier ordering, which a client-side string comparison wouldn't
 * match. A NULL key (an outer join without a match) compares explicitly: the
 * rows after it have a non-null value there, the rows equal to it are null.
 */
export function keysetCondition(keys: ColumnRef[], last: unknown[]): WhereExpr {
    const terms: WhereExpr[] = keys.map((key, i) => {
        let term = after(key, last[i]);
        for (let j = i - 1; j >= 0; j--) term = { kind: 'and', left: equal(keys[j], last[j]), right: term };
        return term;
    });
    return terms.reduce((left, right) => ({ kind: 'or', left, right }));
}

/**
 * A row's key values as one string, for spotting the same row twice. Only
 * equality is checked here; ordering is left to Dataverse.
 */
export function keyTuple(values: unknown[]): string {
    return JSON.stringify(values.map((v) => (v == null ? null : String(v).toLowerCase())));
}

/** `stmt` restricted to the rows after `last` (in key order). */
export function scanAfter(stmt: SelectStatement, keys: ColumnRef[], last: unknown[]): SelectStatement {
    const keyset = keysetCondition(keys, last);
    return { ...stmt, where: stmt.where ? { kind: 'and', left: stmt.where, right: keyset } : keyset };
}

// ── Accumulation ──

/** Value of a column in a scanned (cleaned) row, plus its formatted value. */
function read(row: Record<string, unknown>, src: ValueSource): { value: unknown; formatted: unknown } {
    const key = src.candidates.find((k) => k in row);
    if (key === undefined) return { value: null, formatted: undefined };
    // A lookup's formatted value sits on its `_x_value` key, an option set's on the attribute.
    const formattedKey = src.candidates.map((k) => `${k}_formatted`).find((k) => k in row);
    return { value: row[key] ?? null, formatted: formattedKey ? row[formattedKey] : undefined };
}

/** The key values of a scanned row, for keyset paging. */
export function keyValues(row: Record<string, unknown>, plan: ClientAggregatePlan): unknown[] {
    return plan.keyColumns.map((col) => {
        const prefix = col.table ? `${col.table}.` : '';
        const name = col.column.toLowerCase();
        return read(row, { candidates: [`${prefix}${name}`, `${prefix}_${name}_value`] }).value;
    });
}

/**
 * Text and GUIDs group case-insensitively, as in Dataverse's SQL collation;
 * numbers by value.
 */
function groupingKey(value: unknown): string {
    if (value == null) return 'n:';
    if (typeof value === 'number') return `d:${value}`;
    if (typeof value === 'boolean') return `d:${value ? 1 : 0}`;
    return `s:${String(value).toLowerCase()}`;
}

function compare(a: unknown, b: unknown): number {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const sa = String(a).toLowerCase();
    const sb = String(b).toLowerCase();
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function toNumber(value: unknown): number | null {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const n = Number(value);
    return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(n) ? n : null;
}

interface AggregateState {
    count: number;
    sum: number;
    min: unknown;
    max: unknown;
    /** DISTINCT values by grouping key. */
    distinct?: Map<string, unknown>;
}

interface Group {
    values: unknown[];
    formatted: unknown[];
    states: AggregateState[];
}

function newState(agg: AggregateExpr): AggregateState {
    return { count: 0, sum: 0, min: null, max: null, distinct: agg.distinct ? new Map() : undefined };
}

function add(state: AggregateState, agg: AggregateColumn, row: Record<string, unknown>): void {
    if (!agg.source) {
        state.count += 1; // COUNT(*)
        return;
    }
    const { value } = read(row, agg.source);
    if (value == null) return;
    if (state.distinct) {
        const key = groupingKey(value);
        if (!state.distinct.has(key)) state.distinct.set(key, value);
        return;
    }
    state.count += 1;
    if (agg.agg.function === 'SUM' || agg.agg.function === 'AVG') {
        const n = toNumber(value);
        if (n !== null) state.sum += n;
    }
    if (state.min === null || compare(value, state.min) < 0) state.min = value;
    if (state.max === null || compare(value, state.max) > 0) state.max = value;
}

function finish(state: AggregateState, agg: AggregateExpr): unknown {
    let values: unknown[] | null = null;
    if (state.distinct) values = [...state.distinct.values()];
    const count = values ? values.length : state.count;
    switch (agg.function) {
        case 'COUNT':
            return count;
        case 'SUM':
        case 'AVG': {
            if (count === 0) return null;
            const sum = values ? values.reduce<number>((s, v) => s + (toNumber(v) ?? 0), 0) : state.sum;
            return agg.function === 'SUM' ? sum : sum / count;
        }
        case 'MIN':
        case 'MAX': {
            if (!values) return agg.function === 'MIN' ? state.min : state.max;
            let best: unknown = null;
            for (const v of values) {
                if (best === null || (agg.function === 'MIN' ? compare(v, best) < 0 : compare(v, best) > 0)) best = v;
            }
            return best;
        }
    }
}

/** Running totals for a client-side aggregate. Feed it scanned rows, then read `rows()`. */
export class ClientAggregator {
    private readonly groups = new Map<string, Group>();
    scannedRows = 0;

    constructor(private readonly plan: ClientAggregatePlan) {}

    get groupCount(): number {
        return this.groups.size;
    }

    add(rows: Record<string, unknown>[]): void {
        const { plan } = this;
        for (const row of rows) {
            this.scannedRows += 1;
            const read_ = plan.groupColumns.map((g) => read(row, g.source));
            const key = read_.map((r) => groupingKey(r.value)).join('|');
            let group = this.groups.get(key);
            if (!group) {
                group = {
                    values: read_.map((r) => r.value),
                    formatted: read_.map((r) => r.formatted),
                    states: plan.aggregates.map((a) => newState(a.agg)),
                };
                this.groups.set(key, group);
            }
            plan.aggregates.forEach((a, i) => add(group.states[i], a, row));
        }
    }

    /**
     * The result rows, keyed like Dataverse's aggregate result (grouped columns
     * also get `_formatted` and `…name` keys when a formatted value came back).
     * ORDER BY and TOP are applied unless `raw` (HAVING filters first).
     */
    rows(raw = false): Record<string, unknown>[] {
        const { plan } = this;
        const groups = [...this.groups.values()];
        if (groups.length === 0 && plan.singleGroup) {
            groups.push({ values: [], formatted: [], states: plan.aggregates.map((a) => newState(a.agg)) });
        }
        let rows = groups.map((group) => {
            const out: Record<string, unknown> = {};
            plan.groupColumns.forEach((g, i) => {
                if (!g.outputKey) return;
                out[g.outputKey] = group.values[i];
                const formatted = group.formatted[i];
                if (formatted !== undefined && formatted !== null) {
                    out[`${g.outputKey}_formatted`] = formatted;
                    if (!(`${g.outputKey}name` in out)) out[`${g.outputKey}name`] = formatted;
                }
            });
            plan.aggregates.forEach((a, i) => {
                out[a.outputKey] = finish(group.states[i], a.agg);
            });
            return out;
        });
        if (raw) return plan.orderBy ? sortRows(rows, plan.orderBy) : rows;
        if (plan.orderBy) rows = sortRows(rows, plan.orderBy);
        if (plan.top !== undefined) rows = rows.slice(0, plan.top);
        return rows;
    }
}
