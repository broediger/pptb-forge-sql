import type { ColumnRef, InSubqueryExpr, LiteralValue, OrderByItem, SelectStatement, WhereExpr } from './types';
import { SqlParseError, isAggregateExpr, isJsonValueExpr } from './types';
import { getRequestedColumns, resolveColumnKey } from './columnResolution';

// ── IN (SELECT …) support ──
//
// FetchXML has no subqueries. The query runner executes each subquery first,
// collects the values of its single column, and inlines them as a literal IN
// list. Long lists are split across several outer queries (see planQueries),
// since each value adds to the FetchXML request size.

/** Max values inlined into one IN condition before the outer query is split. */
export const IN_CHUNK_SIZE = 250;

/** Max rows read from a subquery. */
export const MAX_SUBQUERY_ROWS = 50_000;

/** Subqueries in a WHERE tree (not descending into the subqueries themselves). */
export function collectSubqueries(expr: WhereExpr | undefined): InSubqueryExpr[] {
    if (!expr) return [];
    switch (expr.kind) {
        case 'in_subquery':
            return [expr];
        case 'and':
        case 'or':
            return [...collectSubqueries(expr.left), ...collectSubqueries(expr.right)];
        case 'not':
            return collectSubqueries(expr.expr);
        default:
            return [];
    }
}

/** A subquery must return exactly one column. */
export function validateSubquery(sub: SelectStatement): void {
    if (sub.columns.length !== 1) {
        throw new SqlParseError(
            `A subquery in IN (...) must select exactly one column, but selects ${sub.columns.length}`,
            0,
            0,
        );
    }
    const col = sub.columns[0];
    if (isJsonValueExpr(col)) {
        throw new SqlParseError('JSON_VALUE is not supported in a subquery', 0, 0);
    }
    if (!isAggregateExpr(col) && col.column === '*') {
        throw new SqlParseError('A subquery in IN (...) must select a single column, not *', 0, 0);
    }
}

/**
 * The statement used to read all of a subquery's values. Order doesn't matter
 * for IN, so non-aggregate subqueries are ordered by primary key (Dataverse
 * paging cookies need a stable order) and DISTINCT is dropped in favour of
 * de-duplicating client-side.
 */
export function subqueryScanStatement(sub: SelectStatement): SelectStatement {
    const isAggregate = sub.columns.some(isAggregateExpr) || !!sub.groupBy;
    if (isAggregate || sub.top !== undefined) return sub;
    return {
        ...sub,
        distinct: false,
        orderBy: [{ column: { column: `${sub.from.table}id` }, direction: 'ASC' }],
    };
}

/** Distinct non-null values of the subquery's column, in first-seen order. */
export function extractSubqueryValues(rows: Record<string, unknown>[], sub: SelectStatement): LiteralValue[] {
    const name = getRequestedColumns(sub)?.[0];
    if (!name) return [];
    const seen = new Set<string>();
    const values: LiteralValue[] = [];
    for (const row of rows) {
        const keys = Object.keys(row);
        const key = resolveColumnKey(name, keys, keys);
        if (!key) continue;
        const value = row[key];
        // NULLs never match IN, so they're skipped
        if (value === null || value === undefined) continue;
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
        const id = `${typeof value}:${String(value)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        values.push(value);
    }
    return values;
}

// Always-false / always-true conditions for an empty IN / NOT IN list.
function alwaysFalse(column: ColumnRef): WhereExpr {
    return {
        kind: 'and',
        left: { kind: 'is_null', column },
        right: { kind: 'is_null', column, negated: true },
    };
}

function alwaysTrue(column: ColumnRef): WhereExpr {
    return {
        kind: 'or',
        left: { kind: 'is_null', column },
        right: { kind: 'is_null', column, negated: true },
    };
}

/** Replace each subquery with a literal IN list of its values. */
export function substituteSubqueries(expr: WhereExpr, values: Map<InSubqueryExpr, LiteralValue[]>): WhereExpr {
    switch (expr.kind) {
        case 'in_subquery': {
            const list = values.get(expr);
            if (!list) throw new Error('Subquery values were not resolved');
            if (list.length === 0) return expr.negated ? alwaysTrue(expr.column) : alwaysFalse(expr.column);
            return { kind: 'in', column: expr.column, values: list, negated: expr.negated };
        }
        case 'and':
        case 'or':
            return {
                ...expr,
                left: substituteSubqueries(expr.left, values),
                right: substituteSubqueries(expr.right, values),
            };
        case 'not':
            return { ...expr, expr: substituteSubqueries(expr.expr, values) };
        default:
            return expr;
    }
}

/**
 * Whether a subquery's list can be split across separate queries whose results
 * are concatenated: only a non-negated IN reached from the WHERE root through
 * AND alone. Then every result row matches exactly one chunk.
 */
function isSplittable(expr: WhereExpr, target: InSubqueryExpr): boolean {
    if (expr === target) return !target.negated;
    if (expr.kind === 'and') return isSplittable(expr.left, target) || isSplittable(expr.right, target);
    return false;
}

/**
 * Turn a statement with resolved subquery values into the statements to run:
 * one, or several when a single IN list is longer than `chunkSize`.
 */
export function planQueries(
    stmt: SelectStatement,
    values: Map<InSubqueryExpr, LiteralValue[]>,
    chunkSize = IN_CHUNK_SIZE,
): SelectStatement[] {
    if (!stmt.where || values.size === 0) return [stmt];

    const long = [...values.entries()].filter(([, list]) => list.length > chunkSize);
    if (long.length === 0) return [{ ...stmt, where: substituteSubqueries(stmt.where, values) }];

    const describe = ([sub, list]: [InSubqueryExpr, LiteralValue[]]) =>
        `'${sub.column.table ? sub.column.table + '.' : ''}${sub.column.column}' (${list.length.toLocaleString()} values)`;

    if (long.length > 1) {
        throw new SqlParseError(
            `Only one subquery may return more than ${chunkSize} values, but ${long.map(describe).join(' and ')} do. Narrow one of them.`,
            0,
            0,
        );
    }
    const [target, list] = long[0];
    if (!isSplittable(stmt.where, target)) {
        throw new SqlParseError(
            `The subquery for ${describe(long[0])} returned more than ${chunkSize} values. That's only supported for IN combined with AND, not NOT IN, OR or NOT (...). Narrow the subquery.`,
            0,
            0,
        );
    }
    if (stmt.columns.some(isAggregateExpr) || stmt.groupBy) {
        throw new SqlParseError(
            `The subquery for ${describe(long[0])} returned more than ${chunkSize} values, so the query has to be split, which doesn't work with aggregates or GROUP BY. Narrow the subquery.`,
            0,
            0,
        );
    }

    const plans: SelectStatement[] = [];
    for (let i = 0; i < list.length; i += chunkSize) {
        const chunkValues = new Map(values);
        chunkValues.set(target, list.slice(i, i + chunkSize));
        plans.push({ ...stmt, where: substituteSubqueries(stmt.where, chunkValues) });
    }
    return plans;
}

function compareValues(a: unknown, b: unknown): number {
    // NULLs sort first, as in SQL Server
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
    return String(a).localeCompare(String(b));
}

/** Client-side ORDER BY, used when results from split queries are merged. */
export function sortRows(rows: Record<string, unknown>[], orderBy: OrderByItem[]): Record<string, unknown>[] {
    const keyFor = (row: Record<string, unknown>, col: ColumnRef) => {
        const name = col.table ? `${col.table}.${col.column}` : col.column;
        const keys = Object.keys(row);
        const key = resolveColumnKey(name, keys, keys) ?? resolveColumnKey(col.column, keys, keys);
        return key ? row[key] : null;
    };
    return [...rows].sort((a, b) => {
        for (const item of orderBy) {
            const cmp = compareValues(keyFor(a, item.column), keyFor(b, item.column));
            if (cmp !== 0) return item.direction === 'DESC' ? -cmp : cmp;
        }
        return 0;
    });
}
