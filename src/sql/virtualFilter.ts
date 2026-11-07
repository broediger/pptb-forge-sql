import type { ColumnRef, OrderByItem, SelectExpr, SelectStatement, WhereExpr } from './types';
import { isAggregateExpr, isColumnRef } from './types';
import { columnText, evaluateCondition } from './condition';
import { isVirtualNameColumn } from './columnResolution';

// ── WHERE on virtual `xxxname` columns ──
//
// `owneridname`, `statecodename` and the like are display names: Dataverse
// returns them as formatted values of the base column (`ownerid`,
// `statecode`), and usually has no attribute by that name. A WHERE condition
// on one fails with 0x80041103. When that happens, the conditions on such
// columns are evaluated client-side instead: the query runs without them,
// pages are read with the base columns added, and the rows are filtered on
// the formatted values. TOP is applied after filtering, and an ORDER BY on
// such a column is sorted client-side.

/** Max rows read before the client-side filter is applied. */
export const MAX_VIRTUAL_FILTER_ROWS = 50_000;

/** Dataverse error code for an attribute that doesn't exist on the entity. */
export const ATTRIBUTE_MISSING_CODE = '0x80041103';

/**
 * Attributes Dataverse reported as nonexistent, as `entity.attribute`
 * (lowercase; `*.attribute` when the error didn't name the entity). `guess`
 * is set when an error didn't name the attribute at all: every `xxxname`
 * column in WHERE is then treated as virtual. `firstError` is the error that
 * started it, shown when a column turns out not to be a display name.
 */
export interface MissingAttributes {
    names: Set<string>;
    guess: boolean;
    firstError?: Error;
}

export function emptyMissingAttributes(): MissingAttributes {
    return { names: new Set(), guess: false };
}

/** Whether anything was learned yet. */
export function hasMissingAttributes(missing: MissingAttributes): boolean {
    return missing.guess || missing.names.size > 0;
}

/**
 * Record the attribute named in a 0x80041103 error, e.g. "'account' entity
 * doesn't contain attribute with Name = 'owneridname' and NameMapping =
 * 'Logical'". Returns false when nothing new was learned.
 */
export function recordMissingAttribute(missing: MissingAttributes, error: Error): boolean {
    missing.firstError ??= error;
    const full = error.message.match(/'([^']+)' entity doesn't contain attribute with Name = '([^']+)'/i);
    const bare = full ? null : error.message.match(/Name = '([^']+)'/i);
    const name = full ? `${full[1]}.${full[2]}` : bare ? `*.${bare[1]}` : null;
    if (name === null) {
        if (missing.guess) return false;
        missing.guess = true;
        return true;
    }
    const key = name.toLowerCase();
    if (missing.names.has(key)) return false;
    missing.names.add(key);
    return true;
}

/** `'a', 'b'` for messages. */
export function quotedList(names: string[]): string {
    return names.map((n) => `'${n}'`).join(', ');
}

export interface VirtualFilterPlan {
    /** The statement to send: WHERE without the client-side conditions, no TOP, plus base columns. */
    stmt: SelectStatement;
    /** Conditions evaluated client-side (the AND of the conjuncts moved out of WHERE). */
    filter: WhereExpr;
    top?: number;
    /** Set when ORDER BY uses a virtual column: every row is read and sorted client-side. */
    clientOrder?: OrderByItem[];
    /** Virtual columns the filter reads, as written (e.g. `c.competitoridname`). */
    virtualColumns: string[];
    /**
     * Virtual columns whose base column Dataverse rejected too (e.g. a typo
     * like `fulname`, base `ful`): not a display name, so the query can't run.
     */
    unresolved: string[];
    /** Result-key prefixes of columns added only for the filter; dropped from SELECT * results. */
    hiddenKeys: string[];
    /** Aliased display names (`owneridname AS owner`): copy the value at `key` to `alias`. */
    aliasCopies: { alias: string; key: string }[];
    /** Result key of each column the filter reads. */
    keyOf: (col: ColumnRef) => string;
}

function conjuncts(expr: WhereExpr): WhereExpr[] {
    return expr.kind === 'and' ? [...conjuncts(expr.left), ...conjuncts(expr.right)] : [expr];
}

function joinAnd(exprs: WhereExpr[]): WhereExpr | undefined {
    return exprs.length === 0 ? undefined : exprs.reduce((left, right) => ({ kind: 'and', left, right }));
}

function columnRefs(expr: WhereExpr): ColumnRef[] {
    switch (expr.kind) {
        case 'comparison': {
            const right = expr.right !== null && typeof expr.right === 'object' ? [expr.right as ColumnRef] : [];
            return [...(isAggregateExpr(expr.left) ? [] : [expr.left]), ...right];
        }
        case 'between':
        case 'in':
        case 'in_subquery':
        case 'is_null':
            return [expr.column];
        case 'and':
        case 'or':
            return [...columnRefs(expr.left), ...columnRefs(expr.right)];
        case 'not':
            return columnRefs(expr.expr);
    }
}

/** How the statement's column references map to entities, result keys and known-missing attributes. */
function columnResolver(stmt: SelectStatement, missing: MissingAttributes) {
    const fromRef = (stmt.from.alias ?? stmt.from.table).toLowerCase();
    const findJoin = (table: string) => {
        const t = table.toLowerCase();
        return (
            stmt.joins.find((j) => j.alias?.toLowerCase() === t) ??
            stmt.joins.find((j) => !j.alias && j.table.toLowerCase() === t)
        );
    };
    /** null for the FROM table, the join for a joined table, undefined when unknown. */
    const joinOf = (col: ColumnRef) => {
        if (!col.table) return null;
        const t = col.table.toLowerCase();
        if (t === fromRef || t === stmt.from.table.toLowerCase()) return null;
        return findJoin(col.table);
    };
    const entityOf = (col: ColumnRef): string | null => {
        const join = joinOf(col);
        return join === null ? stmt.from.table : (join?.table ?? null);
    };
    const prefixOf = (col: ColumnRef): string => {
        const join = joinOf(col);
        if (join === null) return '';
        return `${join ? (join.alias ?? join.table) : col.table}.`;
    };
    const knownMissing = (col: ColumnRef): boolean => {
        const attr = col.column.toLowerCase();
        const entity = entityOf(col)?.toLowerCase();
        return missing.names.has(`*.${attr}`) || (entity !== undefined && missing.names.has(`${entity}.${attr}`));
    };
    return {
        prefixOf,
        knownMissing,
        sameEntity: (a: ColumnRef, b: ColumnRef) => prefixOf(a).toLowerCase() === prefixOf(b).toLowerCase(),
        onClient: (col: ColumnRef) => isVirtualNameColumn(col.column) && (knownMissing(col) || missing.guess),
        baseOf: (col: ColumnRef): ColumnRef => ({ table: col.table, column: col.column.slice(0, -4) }),
        keyOf: (col: ColumnRef) => `${prefixOf(col)}${col.column.toLowerCase()}`,
    };
}

function isGrouped(stmt: SelectStatement): boolean {
    return !!stmt.groupBy || !!stmt.distinct || stmt.columns.some(isAggregateExpr);
}

/**
 * Throw an explanation when WHERE uses a display name Dataverse rejected and
 * the query groups or aggregates: the filter would have to run client-side
 * before grouping, which FetchXML can't do.
 */
export function assertVirtualFilterSupported(stmt: SelectStatement, missing: MissingAttributes): void {
    if (!stmt.where || !isGrouped(stmt)) return;
    const r = columnResolver(stmt, missing);
    const confirmed = conjuncts(stmt.where)
        .flatMap(columnRefs)
        .filter((c) => r.onClient(c) && r.knownMissing(c));
    if (confirmed.length === 0) return;
    throw new Error(
        `Dataverse has no attribute ${quotedList([...new Set(confirmed.map(columnText))])}, so the condition would have to be ` +
            `evaluated client-side, which doesn't work together with GROUP BY, DISTINCT, aggregates or HAVING. ` +
            `Filter on the base column instead (e.g. its ID or option value).`,
    );
}

/**
 * Plan a SELECT whose WHERE uses virtual name columns Dataverse rejected.
 * Returns null when no WHERE condition is affected, so the caller can fall
 * back to its other retries.
 */
export function planVirtualFilter(stmt: SelectStatement, missing: MissingAttributes): VirtualFilterPlan | null {
    if (!stmt.where) return null;
    assertVirtualFilterSupported(stmt, missing);
    // Only a guess is left for grouped queries: leave them to the other retries.
    if (isGrouped(stmt)) return null;

    const r = columnResolver(stmt, missing);
    const parts = conjuncts(stmt.where);
    const clientParts = parts.filter((p) => columnRefs(p).some(r.onClient));
    if (clientParts.length === 0) return null;
    const clientRefs = clientParts.flatMap(columnRefs).filter(r.onClient);
    const clientOrder = stmt.orderBy?.some((o) => r.onClient(o.column)) ? stmt.orderBy : undefined;

    // Never request a column Dataverse said doesn't exist.
    const columns: SelectExpr[] = stmt.columns.filter(
        (c) => !isColumnRef(c) || c.column === '*' || !isVirtualNameColumn(c.column) || !r.knownMissing(c),
    );
    const isRequested = (col: ColumnRef) =>
        columns.some(
            (c) =>
                isColumnRef(c) &&
                (c.column === '*'
                    ? // An unqualified * fetches all attributes of the FROM table only.
                      c.table
                        ? r.sameEntity(c, col)
                        : r.prefixOf(col) === ''
                    : r.sameEntity(c, col) && !c.alias && c.column.toLowerCase() === col.column.toLowerCase()),
        );
    const hiddenKeys: string[] = [];
    const add = (col: ColumnRef, hidden: boolean) => {
        if (r.knownMissing(col) || isRequested(col)) return;
        columns.push({ table: col.table, column: col.column });
        if (hidden) hiddenKeys.push(r.keyOf(col));
    };
    /** Fetch what a client-side condition or sort reads. */
    const addForClient = (col: ColumnRef) => {
        if (r.onClient(col)) {
            add(r.baseOf(col), true);
            // Unconfirmed guess: the name may be a real attribute after all.
            if (!r.knownMissing(col)) add({ table: col.table, column: col.column }, true);
        } else {
            add(col, true);
        }
    };

    // A selected display name comes back with its base column, whether or not
    // Dataverse knows the `xxxname` attribute (an unknown one is ignored).
    for (const c of stmt.columns) {
        if (isColumnRef(c) && c.column !== '*' && isVirtualNameColumn(c.column)) add(r.baseOf(c), false);
    }
    for (const col of clientParts.flatMap(columnRefs)) addForClient(col);
    for (const item of clientOrder ?? []) addForClient(item.column);

    const aliasCopies = stmt.columns
        .filter((c): c is ColumnRef => isColumnRef(c) && !!c.alias && isVirtualNameColumn(c.column))
        .map((c) => ({ alias: c.alias!, key: r.keyOf(c) }));

    const { top, ...rest } = stmt;
    return {
        stmt: {
            ...rest,
            columns,
            where: joinAnd(parts.filter((p) => !clientParts.includes(p))),
            // A client-side sort reads every row; the scan orders by primary key.
            orderBy: clientOrder ? undefined : stmt.orderBy,
        },
        filter: joinAnd(clientParts)!,
        top,
        clientOrder,
        virtualColumns: [...new Set(clientRefs.map(columnText))],
        unresolved: [
            ...new Set(clientRefs.filter((c) => r.knownMissing(c) && r.knownMissing(r.baseOf(c))).map(columnText)),
        ],
        hiddenKeys,
        aliasCopies,
        keyOf: r.keyOf,
    };
}

/** Whether a fetched row satisfies the client-side conditions. */
export function matchesVirtualFilter(row: Record<string, unknown>, plan: VirtualFilterPlan): boolean {
    return (
        evaluateCondition(plan.filter, (o) => (isColumnRef(o) ? (row[plan.keyOf(o)] ?? null) : null), 'WHERE') === true
    );
}

/**
 * Shape matched rows for display: copy aliased display names to their alias
 * and, for SELECT *, drop the columns added only for the filter.
 */
export function finishVirtualFilter(
    rows: Record<string, unknown>[],
    plan: VirtualFilterPlan,
    isSelectStar: boolean,
): Record<string, unknown>[] {
    const strip = isSelectStar && plan.hiddenKeys.length > 0;
    if (!strip && plan.aliasCopies.length === 0) return rows;
    const isHidden = (key: string) =>
        plan.hiddenKeys.some((h) => key === h || key.startsWith(`${h}_`) || key === `${h}name`);
    return rows.map((row) => {
        const out = strip ? Object.fromEntries(Object.entries(row).filter(([key]) => !isHidden(key))) : { ...row };
        for (const { alias, key } of plan.aliasCopies) {
            if (!(alias in out) && key in row) out[alias] = row[key];
        }
        return out;
    });
}
