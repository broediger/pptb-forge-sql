import type { AggregateExpr, ColumnRef, LiteralValue, WhereExpr } from './types';
import { SqlParseError, isAggregateExpr } from './types';

// ── Client-side condition evaluation ──
//
// Used where FetchXML can't express a condition: HAVING on grouped rows, and
// WHERE conditions on virtual `xxxname` columns. SQL three-valued logic: null
// means unknown, and only rows evaluating to true are kept.

export type Truth = boolean | null;

/** Value of a column or aggregate operand in the current row (null when absent). */
export type OperandValue = (operand: ColumnRef | AggregateExpr) => unknown;

/** Compare two non-null values; numeric when both sides look numeric, else case-insensitive text. */
function compare(a: unknown, b: unknown): number {
    if (typeof a === 'boolean' || typeof b === 'boolean') {
        // Dataverse returns two-option columns as booleans; SQL compares them with 1/0.
        const truthy = (v: unknown) => v === true || v === 1 || (typeof v === 'string' && /^(true|1)$/i.test(v));
        return Number(truthy(a)) - Number(truthy(b));
    }
    const na = typeof a === 'number' ? a : Number(a);
    const nb = typeof b === 'number' ? b : Number(b);
    const numeric = (typeof a === 'number' || typeof b === 'number') && !Number.isNaN(na) && !Number.isNaN(nb);
    if (numeric) return na - nb;
    const sa = String(a).toLowerCase();
    const sb = String(b).toLowerCase();
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * T-SQL LIKE as a regular expression: `%`, `_`, and character classes
 * `[abc]`, `[a-c]`, `[^a-c]` (so `[%]` matches a literal %). A `[` without a
 * closing `]` is literal.
 */
function likeToRegExp(pattern: string): RegExp {
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '%') source += '.*';
        else if (ch === '_') source += '.';
        else if (ch === '[') {
            const end = pattern.indexOf(']', i + 2);
            if (end === -1) {
                source += '\\[';
                continue;
            }
            let body = pattern.slice(i + 1, end);
            const negated = body.startsWith('^') && body.length > 1;
            if (negated) body = body.slice(1);
            // Keep `-` for ranges; escape what's special inside a class.
            source += `[${negated ? '^' : ''}${body.replace(/[\\\]^[]/g, '\\$&')}]`;
            i = end;
        } else source += escapeRegExp(ch);
    }
    return new RegExp(`^${source}$`, 'is');
}

function not(value: Truth): Truth {
    return value === null ? null : !value;
}

/**
 * Evaluate a condition on one row. `clause` names the clause in error
 * messages (e.g. 'HAVING').
 */
export function evaluateCondition(expr: WhereExpr, valueOf: OperandValue, clause = 'client-side conditions'): Truth {
    switch (expr.kind) {
        case 'comparison': {
            const left = valueOf(expr.left);
            const right =
                expr.right !== null && typeof expr.right === 'object'
                    ? valueOf(expr.right as ColumnRef)
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
            const value = valueOf(expr.column);
            if (value === null || expr.low === null || expr.high === null) return null;
            const inRange = compare(value, expr.low) >= 0 && compare(value, expr.high) <= 0;
            return expr.negated ? !inRange : inRange;
        }
        case 'in': {
            const value = valueOf(expr.column);
            if (value === null) return null;
            const found = expr.values.some((v) => v !== null && compare(value, v) === 0);
            if (found) return !expr.negated;
            // x NOT IN (..., NULL) is unknown when x matches nothing else.
            if (expr.values.includes(null)) return null;
            return !!expr.negated;
        }
        case 'is_null': {
            const isNull = valueOf(expr.column) === null;
            return expr.negated ? !isNull : isNull;
        }
        case 'in_subquery':
            throw new SqlParseError(`Subqueries (IN (SELECT ...)) are not supported in ${clause}`, 0, 0);
        case 'and': {
            const left = evaluateCondition(expr.left, valueOf, clause);
            if (left === false) return false;
            const right = evaluateCondition(expr.right, valueOf, clause);
            if (right === false) return false;
            return left === null || right === null ? null : true;
        }
        case 'or': {
            const left = evaluateCondition(expr.left, valueOf, clause);
            if (left === true) return true;
            const right = evaluateCondition(expr.right, valueOf, clause);
            if (right === true) return true;
            return left === null || right === null ? null : false;
        }
        case 'not':
            return not(evaluateCondition(expr.expr, valueOf, clause));
    }
}

/** A column as written: `table.column` or `column`. */
export function columnText(col: ColumnRef): string {
    return col.table ? `${col.table}.${col.column}` : col.column;
}

/** A readable form of a condition, for FetchXML inspector comments. */
export function describeCondition(expr: WhereExpr): string {
    const operand = (o: ColumnRef | AggregateExpr) =>
        isAggregateExpr(o)
            ? `${o.function}(${o.distinct ? 'DISTINCT ' : ''}${o.column.column === '*' ? '*' : columnText(o.column)})`
            : columnText(o);
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
            return `(${describeCondition(expr.left)} ${expr.kind.toUpperCase()} ${describeCondition(expr.right)})`;
        case 'not':
            return `NOT ${describeCondition(expr.expr)}`;
    }
}
