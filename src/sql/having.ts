import type { AggregateExpr, ColumnRef, SelectExpr, SelectStatement, WhereExpr } from './types';
import { SqlParseError, isAggregateExpr, isColumnRef } from './types';
import { evaluateCondition } from './condition';

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

function operandValue(row: Record<string, unknown>, operand: ColumnRef | AggregateExpr, plan: HavingPlan): unknown {
    const key = plan.keys.get(isAggregateExpr(operand) ? aggregateKey(operand) : columnKey(operand));
    return key === undefined ? null : (row[key] ?? null);
}

/**
 * Keep the grouped rows that satisfy HAVING, apply TOP, and drop the hidden
 * columns (and their `_formatted` annotations) added by planHaving.
 */
export function applyHaving(rows: Record<string, unknown>[], plan: HavingPlan): Record<string, unknown>[] {
    let kept = rows.filter(
        (row) => evaluateCondition(plan.having, (o) => operandValue(row, o, plan), 'HAVING') === true,
    );
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
