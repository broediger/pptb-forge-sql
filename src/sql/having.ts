import type { AggregateExpr, ColumnRef, LiteralValue, SelectExpr, SelectStatement, WhereExpr } from './types';
import { SqlParseError, isAggregateExpr, isColumnRef } from './types';

// ── HAVING support ──
//
// FetchXML has no HAVING. The aggregate query runs without it, every page of
// groups is read, and the HAVING condition is evaluated client-side on the
// grouped rows. TOP is applied after filtering, since Dataverse would apply it
// before.

/** Rows per page when reading every page of an aggregate query. */
export const HAVING_PAGE_SIZE = 5000;

/** Max groups read before HAVING is applied. */
export const MAX_HAVING_GROUPS = 50_000;

export interface HavingPlan {
    /** The statement to send to Dataverse: no HAVING, no TOP, plus hidden columns. */
    stmt: SelectStatement;
    having: WhereExpr;
    top?: number;
    /** Result keys added only so HAVING can read them; removed before display. */
    hiddenKeys: string[];
    /** Result key of each column or aggregate referenced in HAVING. */
    keys: Map<string, string>;
}

function aggregateKey(agg: AggregateExpr): string {
    const col = agg.column.table ? `${agg.column.table}.${agg.column.column}` : agg.column.column;
    return `${agg.function.toLowerCase()}(${agg.distinct ? 'distinct ' : ''}${col})`;
}

function columnKey(col: ColumnRef): string {
    return col.table ? `${col.table}.${col.column}` : col.column;
}

/** Result key Dataverse uses for a column of an aggregate query (always aliased). */
function resultKey(expr: SelectExpr): string {
    if (isAggregateExpr(expr)) {
        return (
            expr.alias ?? `${expr.function.toLowerCase()}_${expr.column.column === '*' ? 'all' : expr.column.column}`
        );
    }
    const col = expr as ColumnRef;
    return col.alias ?? col.column;
}

function sameColumn(a: ColumnRef, b: ColumnRef): boolean {
    return a.column.toLowerCase() === b.column.toLowerCase() && (a.table ?? '') === (b.table ?? '');
}

/** Every column or aggregate operand in a HAVING tree. */
function collectOperands(expr: WhereExpr): (ColumnRef | AggregateExpr)[] {
    switch (expr.kind) {
        case 'comparison': {
            const right = expr.right;
            const isColumn = right !== null && typeof right === 'object';
            return isColumn ? [expr.left, right as ColumnRef] : [expr.left];
        }
        case 'between':
        case 'in':
        case 'is_null':
            return [expr.column];
        case 'in_subquery':
            throw new SqlParseError('Subqueries (IN (SELECT ...)) are not supported in HAVING', 0, 0);
        case 'and':
        case 'or':
            return [...collectOperands(expr.left), ...collectOperands(expr.right)];
        case 'not':
            return collectOperands(expr.expr);
    }
}

/**
 * Prepare a SELECT with HAVING for client-side evaluation. Aggregates or
 * grouping columns that HAVING references but the SELECT list doesn't are
 * added under hidden aliases. Returns null when there is no HAVING.
 */
export function planHaving(stmt: SelectStatement): HavingPlan | null {
    if (!stmt.having) return null;
    if (!stmt.groupBy && !stmt.columns.some(isAggregateExpr)) {
        throw new SqlParseError('HAVING requires GROUP BY or an aggregate in the SELECT list', 0, 0);
    }

    const columns = [...stmt.columns];
    const usedKeys = new Set(columns.filter((c) => !isColumnRef(c) || c.column !== '*').map(resultKey));
    const hiddenKeys: string[] = [];
    const keys = new Map<string, string>();
    const hiddenAlias = () => {
        let n = hiddenKeys.length + 1;
        while (usedKeys.has(`having_${n}`)) n += 1;
        const alias = `having_${n}`;
        usedKeys.add(alias);
        hiddenKeys.push(alias);
        return alias;
    };

    for (const operand of collectOperands(stmt.having)) {
        if (isAggregateExpr(operand)) {
            const key = aggregateKey(operand);
            if (keys.has(key)) continue;
            const selected = columns.find((c) => isAggregateExpr(c) && aggregateKey(c) === key);
            if (selected) {
                keys.set(key, resultKey(selected));
            } else {
                const alias = hiddenAlias();
                columns.push({ ...operand, alias });
                keys.set(key, alias);
            }
            continue;
        }
        const key = columnKey(operand);
        if (keys.has(key)) continue;
        const selected = columns.find((c) => isColumnRef(c) && sameColumn(c, operand));
        if (selected) {
            keys.set(key, resultKey(selected));
            continue;
        }
        if (!stmt.groupBy?.some((g) => sameColumn(g, operand))) {
            throw new SqlParseError(
                `Column '${key}' in HAVING must appear in GROUP BY or inside an aggregate function`,
                0,
                0,
            );
        }
        const alias = hiddenAlias();
        columns.push({ table: operand.table, column: operand.column, alias });
        keys.set(key, alias);
    }

    const { having, top, ...rest } = stmt;
    return { stmt: { ...rest, columns }, having, top, hiddenKeys, keys };
}

// ── Evaluation (SQL three-valued logic: null means unknown) ──

type Truth = boolean | null;

function operandValue(row: Record<string, unknown>, operand: ColumnRef | AggregateExpr, plan: HavingPlan): unknown {
    const key = plan.keys.get(isAggregateExpr(operand) ? aggregateKey(operand) : columnKey(operand));
    return key === undefined ? null : (row[key] ?? null);
}

/** Compare two non-null values; numeric when both sides look numeric, else case-insensitive text. */
function compare(a: unknown, b: unknown): number {
    if (typeof a === 'boolean' || typeof b === 'boolean') {
        return Number(a === true || a === 'true') - Number(b === true || b === 'true');
    }
    const na = typeof a === 'number' ? a : Number(a);
    const nb = typeof b === 'number' ? b : Number(b);
    const numeric = (typeof a === 'number' || typeof b === 'number') && !Number.isNaN(na) && !Number.isNaN(nb);
    if (numeric) return na - nb;
    const sa = String(a).toLowerCase();
    const sb = String(b).toLowerCase();
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function likeToRegExp(pattern: string): RegExp {
    let source = '';
    for (const ch of pattern) {
        if (ch === '%') source += '.*';
        else if (ch === '_') source += '.';
        else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${source}$`, 'is');
}

function not(value: Truth): Truth {
    return value === null ? null : !value;
}

function evaluate(expr: WhereExpr, row: Record<string, unknown>, plan: HavingPlan): Truth {
    switch (expr.kind) {
        case 'comparison': {
            const left = operandValue(row, expr.left, plan);
            const right =
                expr.right !== null && typeof expr.right === 'object'
                    ? operandValue(row, expr.right as ColumnRef, plan)
                    : (expr.right as LiteralValue);
            if (left === null || right === null) return null;
            if (expr.operator === 'LIKE') return likeToRegExp(String(right)).test(String(left));
            const cmp = compare(left, right);
            switch (expr.operator) {
                case '=':
                    return cmp === 0;
                case '!=':
                    return cmp !== 0;
                case '<':
                    return cmp < 0;
                case '>':
                    return cmp > 0;
                case '<=':
                    return cmp <= 0;
                case '>=':
                    return cmp >= 0;
            }
            return null;
        }
        case 'between': {
            const value = operandValue(row, expr.column, plan);
            if (value === null || expr.low === null || expr.high === null) return null;
            const inRange = compare(value, expr.low) >= 0 && compare(value, expr.high) <= 0;
            return expr.negated ? !inRange : inRange;
        }
        case 'in': {
            const value = operandValue(row, expr.column, plan);
            if (value === null) return null;
            const found = expr.values.some((v) => v !== null && compare(value, v) === 0);
            if (found) return !expr.negated;
            // x NOT IN (..., NULL) is unknown when x matches nothing else.
            if (expr.values.includes(null)) return null;
            return !!expr.negated;
        }
        case 'is_null': {
            const isNull = operandValue(row, expr.column, plan) === null;
            return expr.negated ? !isNull : isNull;
        }
        case 'in_subquery':
            throw new SqlParseError('Subqueries (IN (SELECT ...)) are not supported in HAVING', 0, 0);
        case 'and': {
            const left = evaluate(expr.left, row, plan);
            if (left === false) return false;
            const right = evaluate(expr.right, row, plan);
            if (right === false) return false;
            return left === null || right === null ? null : true;
        }
        case 'or': {
            const left = evaluate(expr.left, row, plan);
            if (left === true) return true;
            const right = evaluate(expr.right, row, plan);
            if (right === true) return true;
            return left === null || right === null ? null : false;
        }
        case 'not':
            return not(evaluate(expr.expr, row, plan));
    }
}

/**
 * Keep the grouped rows that satisfy HAVING, apply TOP, and drop the hidden
 * columns (and their `_formatted` annotations) added by planHaving.
 */
export function applyHaving(rows: Record<string, unknown>[], plan: HavingPlan): Record<string, unknown>[] {
    let kept = rows.filter((row) => evaluate(plan.having, row, plan) === true);
    if (plan.top !== undefined) kept = kept.slice(0, plan.top);
    if (plan.hiddenKeys.length === 0) return kept;
    const hidden = new Set(plan.hiddenKeys);
    return kept.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
            const base = key.endsWith('_formatted') ? key.slice(0, -'_formatted'.length) : key;
            if (!hidden.has(key) && !hidden.has(base)) out[key] = value;
        }
        return out;
    });
}

/**
 * Request one page of an aggregate query. Aggregate results come without a
 * paging cookie, so pages are addressed by number.
 */
export function withPage(fetchXml: string, page: number, count = HAVING_PAGE_SIZE): string {
    return fetchXml.replace(/^(\s*<fetch\b)([^>]*)(>)/, `$1$2 page="${page}" count="${count}"$3`);
}

/** A readable form of the HAVING condition, for the FetchXML inspector comment. */
export function describeHaving(expr: WhereExpr): string {
    const operand = (o: ColumnRef | AggregateExpr) =>
        isAggregateExpr(o)
            ? `${o.function}(${o.distinct ? 'DISTINCT ' : ''}${o.column.column === '*' ? '*' : columnKey(o.column)})`
            : columnKey(o);
    const literal = (v: LiteralValue) => (v === null ? 'NULL' : typeof v === 'string' ? `'${v}'` : String(v));
    switch (expr.kind) {
        case 'comparison': {
            const right =
                expr.right !== null && typeof expr.right === 'object'
                    ? operand(expr.right as ColumnRef)
                    : literal(expr.right as LiteralValue);
            return `${operand(expr.left)} ${expr.operator} ${right}`;
        }
        case 'between':
            return `${operand(expr.column)} ${expr.negated ? 'NOT ' : ''}BETWEEN ${literal(expr.low)} AND ${literal(expr.high)}`;
        case 'in':
            return `${operand(expr.column)} ${expr.negated ? 'NOT ' : ''}IN (${expr.values.map(literal).join(', ')})`;
        case 'is_null':
            return `${operand(expr.column)} IS ${expr.negated ? 'NOT ' : ''}NULL`;
        case 'in_subquery':
            return `${operand(expr.column)} IN (SELECT ...)`;
        case 'and':
        case 'or':
            return `(${describeHaving(expr.left)} ${expr.kind.toUpperCase()} ${describeHaving(expr.right)})`;
        case 'not':
            return `NOT ${describeHaving(expr.expr)}`;
    }
}
