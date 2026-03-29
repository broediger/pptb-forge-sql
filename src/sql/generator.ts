import {
    SelectStatement,
    SelectExpr,
    ColumnRef,
    AggregateExpr,
    WhereExpr,
    LiteralValue,
    SqlParseError,
    isAggregateExpr,
} from './types';

// ── XML escaping ──

function xmlEscape(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function literalToString(value: LiteralValue): string {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
}

// ── Negate a comparison operator (for NOT pushdown) ──

const NEGATE_OP: Record<string, string> = {
    eq: 'neq',
    neq: 'eq',
    lt: 'ge',
    ge: 'lt',
    gt: 'le',
    le: 'gt',
    like: 'not-like',
    'not-like': 'like',
};

// ── SQL operator → FetchXML operator ──

const OP_MAP: Record<string, string> = {
    '=': 'eq',
    '!=': 'neq',
    '<': 'lt',
    '>': 'gt',
    '<=': 'le',
    '>=': 'ge',
    LIKE: 'like',
};

// ── Resolve the left side of a comparison for condition generation ──

function resolveConditionLeft(left: ColumnRef | AggregateExpr): {
    attr: string;
    entityName?: string;
    isAggregate: boolean;
    aggregateFn?: string;
} {
    if (isAggregateExpr(left)) {
        const agg = left as AggregateExpr;
        const fn = agg.function.toLowerCase();
        const colName = agg.column.column === '*' ? '' : agg.column.column;
        const alias = agg.alias ?? `${fn}_${colName || 'all'}`;
        return { attr: alias, isAggregate: true, aggregateFn: fn };
    }
    const col = left as ColumnRef;
    return {
        attr: col.column,
        entityName: col.table,
        isAggregate: false,
    };
}

// ── WHERE → filter XML ──

function generateCondition(expr: WhereExpr, indent: string, aggregateAliasMap?: Map<string, string>): string {
    switch (expr.kind) {
        case 'comparison': {
            const resolved = resolveConditionLeft(expr.left);
            let attr: string;

            if (resolved.isAggregate && aggregateAliasMap) {
                // Look up the auto-generated alias for this aggregate
                const agg = expr.left as AggregateExpr;
                const key = aggregateKey(agg);
                attr = xmlEscape(aggregateAliasMap.get(key) ?? resolved.attr);
            } else {
                attr = xmlEscape(resolved.attr);
            }

            const right = expr.right;

            // Column-to-column comparison is not supported in FetchXML
            if (right !== null && typeof right === 'object' && 'column' in right) {
                throw new SqlParseError(
                    `Column-to-column comparison in WHERE/HAVING is not supported in FetchXML`,
                    0,
                    0,
                );
            }

            const entityAttr = resolved.entityName ? ` entityname="${xmlEscape(resolved.entityName)}"` : '';

            // NULL literal comparison: = NULL → operator="null", != NULL → operator="not-null"
            if (right === null) {
                const nullOp = expr.operator === '=' ? 'null' : 'not-null';
                return `${indent}<condition attribute="${attr}"${entityAttr} operator="${nullOp}" />`;
            }

            const op = OP_MAP[expr.operator] ?? expr.operator;
            const val = xmlEscape(literalToString(right as LiteralValue));
            return `${indent}<condition attribute="${attr}"${entityAttr} operator="${op}" value="${val}" />`;
        }

        case 'is_null': {
            const attr = xmlEscape(expr.column.column);
            const entityAttr = expr.column.table ? ` entityname="${xmlEscape(expr.column.table)}"` : '';
            const op = expr.negated ? 'not-null' : 'null';
            return `${indent}<condition attribute="${attr}"${entityAttr} operator="${op}" />`;
        }

        case 'between': {
            const attr = xmlEscape(expr.column.column);
            const entityAttr = expr.column.table ? ` entityname="${xmlEscape(expr.column.table)}"` : '';
            const op = expr.negated ? 'not-between' : 'between';
            const low = xmlEscape(literalToString(expr.low));
            const high = xmlEscape(literalToString(expr.high));
            return (
                `${indent}<condition attribute="${attr}"${entityAttr} operator="${op}">\n` +
                `${indent}  <value>${low}</value>\n` +
                `${indent}  <value>${high}</value>\n` +
                `${indent}</condition>`
            );
        }

        case 'in': {
            const attr = xmlEscape(expr.column.column);
            const entityAttr = expr.column.table ? ` entityname="${xmlEscape(expr.column.table)}"` : '';
            const op = expr.negated ? 'not-in' : 'in';
            const values = expr.values
                .map((v) => `${indent}  <value>${xmlEscape(literalToString(v))}</value>`)
                .join('\n');
            return (
                `${indent}<condition attribute="${attr}"${entityAttr} operator="${op}">\n` +
                values +
                '\n' +
                `${indent}</condition>`
            );
        }

        case 'and':
        case 'or': {
            const type = expr.kind;
            const left = generateCondition(expr.left, indent + '  ', aggregateAliasMap);
            const right = generateCondition(expr.right, indent + '  ', aggregateAliasMap);
            return `${indent}<filter type="${type}">\n` + left + '\n' + right + '\n' + `${indent}</filter>`;
        }

        case 'not': {
            // Push negation down to the inner expression
            return generateNegated(expr.expr, indent, aggregateAliasMap);
        }
    }
}

// ── Generate the negated form of a WHERE expression ──

function generateNegated(expr: WhereExpr, indent: string, aggregateAliasMap?: Map<string, string>): string {
    switch (expr.kind) {
        case 'comparison': {
            const resolved = resolveConditionLeft(expr.left);
            let attr: string;

            if (resolved.isAggregate && aggregateAliasMap) {
                const agg = expr.left as AggregateExpr;
                const key = aggregateKey(agg);
                attr = xmlEscape(aggregateAliasMap.get(key) ?? resolved.attr);
            } else {
                attr = xmlEscape(resolved.attr);
            }

            const right = expr.right;

            if (right !== null && typeof right === 'object' && 'column' in right) {
                throw new SqlParseError(
                    `Column-to-column comparison in WHERE/HAVING is not supported in FetchXML`,
                    0,
                    0,
                );
            }

            const entityAttr = resolved.entityName ? ` entityname="${xmlEscape(resolved.entityName)}"` : '';

            // NULL literal comparison (negated): NOT (= NULL) → not-null, NOT (!= NULL) → null
            if (right === null) {
                const nullOp = expr.operator === '=' ? 'not-null' : 'null';
                return `${indent}<condition attribute="${attr}"${entityAttr} operator="${nullOp}" />`;
            }

            const baseOp = OP_MAP[expr.operator] ?? expr.operator;
            const op = NEGATE_OP[baseOp] ?? baseOp;
            const val = xmlEscape(literalToString(right as LiteralValue));
            return `${indent}<condition attribute="${attr}"${entityAttr} operator="${op}" value="${val}" />`;
        }

        case 'is_null': {
            const attr = xmlEscape(expr.column.column);
            const entityAttr = expr.column.table ? ` entityname="${xmlEscape(expr.column.table)}"` : '';
            const op = expr.negated ? 'null' : 'not-null'; // flip
            return `${indent}<condition attribute="${attr}"${entityAttr} operator="${op}" />`;
        }

        case 'between': {
            const attr = xmlEscape(expr.column.column);
            const entityAttr = expr.column.table ? ` entityname="${xmlEscape(expr.column.table)}"` : '';
            const op = expr.negated ? 'between' : 'not-between'; // flip
            const low = xmlEscape(literalToString(expr.low));
            const high = xmlEscape(literalToString(expr.high));
            return (
                `${indent}<condition attribute="${attr}"${entityAttr} operator="${op}">\n` +
                `${indent}  <value>${low}</value>\n` +
                `${indent}  <value>${high}</value>\n` +
                `${indent}</condition>`
            );
        }

        case 'in': {
            const attr = xmlEscape(expr.column.column);
            const entityAttr = expr.column.table ? ` entityname="${xmlEscape(expr.column.table)}"` : '';
            const op = expr.negated ? 'in' : 'not-in'; // flip
            const values = expr.values
                .map((v) => `${indent}  <value>${xmlEscape(literalToString(v))}</value>`)
                .join('\n');
            return (
                `${indent}<condition attribute="${attr}"${entityAttr} operator="${op}">\n` +
                values +
                '\n' +
                `${indent}</condition>`
            );
        }

        case 'and':
        case 'or': {
            // De Morgan's law: NOT (A AND B) = (NOT A) OR (NOT B)
            const flippedType = expr.kind === 'and' ? 'or' : 'and';
            const left = generateNegated(expr.left, indent + '  ', aggregateAliasMap);
            const right = generateNegated(expr.right, indent + '  ', aggregateAliasMap);
            return `${indent}<filter type="${flippedType}">\n` + left + '\n' + right + '\n' + `${indent}</filter>`;
        }

        case 'not': {
            // Double negation cancels out
            return generateCondition(expr.expr, indent, aggregateAliasMap);
        }
    }
}

// ── Build a stable key for matching aggregates ──

function aggregateKey(agg: AggregateExpr): string {
    const col = agg.column.table ? `${agg.column.table}.${agg.column.column}` : agg.column.column;
    return `${agg.function.toLowerCase()}(${col})`;
}

// ── Attribute generation ──

function generateAttributeLine(
    expr: SelectExpr,
    groupByColumns: Set<string>,
    indent: string,
    autoAlias?: string,
    entityName?: string,
): string {
    if (isAggregateExpr(expr)) {
        const fn = expr.function.toLowerCase();
        const alias = expr.alias ?? autoAlias;
        const aliasPart = alias ? ` alias="${xmlEscape(alias)}"` : '';
        const distinct = expr.distinct ? ` distinct="true"` : '';
        // COUNT(*): use entityid convention (entityname + "id") instead of name="*"
        if (expr.column.column === '*') {
            const idCol = entityName ? xmlEscape(entityName + 'id') : 'id';
            return `${indent}<attribute name="${idCol}" aggregate="${fn}"${distinct}${aliasPart} />`;
        }
        const name = xmlEscape(expr.column.column);
        return `${indent}<attribute name="${name}" aggregate="${fn}"${distinct}${aliasPart} />`;
    }

    // ColumnRef
    const col = expr as ColumnRef;
    if (col.column === '*') {
        return ''; // wildcard — handled separately as <all-attributes />
    }
    const name = xmlEscape(col.column);
    const alias = col.alias ? ` alias="${xmlEscape(col.alias)}"` : '';
    const isGroupBy =
        groupByColumns.has(col.column) || (col.table ? groupByColumns.has(`${col.table}.${col.column}`) : false);
    const groupby = isGroupBy ? ` groupby="true"` : '';
    return `${indent}<attribute name="${name}"${groupby}${alias} />`;
}

// ── Main generator ──

export function generateFetchXml(ast: SelectStatement): string {
    const lines: string[] = [];

    // Build the set of GROUP BY column names for quick lookup
    const groupByColumns = new Set<string>();
    if (ast.groupBy) {
        for (const col of ast.groupBy) {
            groupByColumns.add(col.column);
            if (col.table) groupByColumns.add(`${col.table}.${col.column}`);
        }
    }

    // Build auto-alias map for aggregates (used to reference them in HAVING conditions)
    const aggregateAliasMap = new Map<string, string>();
    for (const col of ast.columns) {
        if (isAggregateExpr(col)) {
            const key = aggregateKey(col);
            const colName = col.column.column === '*' ? 'all' : col.column.column;
            const alias = col.alias ?? `${col.function.toLowerCase()}_${colName}`;
            aggregateAliasMap.set(key, alias);
        }
    }

    // Check if any column is an aggregate expression
    const hasAggregate = ast.columns.some(isAggregateExpr);

    // <fetch> opening tag
    const fetchAttrs: string[] = [];
    if (ast.top !== undefined) fetchAttrs.push(`top="${ast.top}"`);
    // Distinct is omitted when aggregates are present (Dataverse rejects both together)
    if (ast.distinct && !hasAggregate) fetchAttrs.push(`distinct="true"`);
    // aggregate="true" is set when any aggregate function appears in the SELECT list
    if (hasAggregate) fetchAttrs.push(`aggregate="true"`);
    const fetchOpen = fetchAttrs.length > 0 ? `<fetch ${fetchAttrs.join(' ')}>` : `<fetch>`;

    lines.push(fetchOpen);

    // <entity>
    lines.push(`  <entity name="${xmlEscape(ast.from.table)}">`);

    // Separate columns by which entity they belong to
    const fromAlias = ast.from.alias ?? ast.from.table;

    // Build a map of join table/alias → columns
    const joinColumnMap = new Map<string, SelectExpr[]>();
    const mainColumns: SelectExpr[] = [];

    for (const col of ast.columns) {
        if (isAggregateExpr(col)) {
            const tableRef = col.column.table;
            if (tableRef && tableRef !== ast.from.table && tableRef !== fromAlias) {
                const arr = joinColumnMap.get(tableRef) ?? [];
                arr.push(col);
                joinColumnMap.set(tableRef, arr);
            } else {
                mainColumns.push(col);
            }
        } else {
            const cr = col as ColumnRef;
            if (cr.column === '*' && !cr.table) {
                mainColumns.push(cr);
            } else if (cr.table && cr.table !== ast.from.table && cr.table !== fromAlias) {
                const arr = joinColumnMap.get(cr.table) ?? [];
                arr.push(cr);
                joinColumnMap.set(cr.table, arr);
            } else {
                mainColumns.push(cr);
            }
        }
    }

    // Check if we have a wildcard — if so, emit <all-attributes />
    const hasWildcard = mainColumns.some(
        (c) => !isAggregateExpr(c) && (c as ColumnRef).column === '*' && !(c as ColumnRef).table,
    );

    if (hasWildcard) {
        lines.push(`    <all-attributes />`);
    } else {
        for (const col of mainColumns) {
            // Auto-generate alias for aggregates that need one
            let autoAlias: string | undefined;
            if (isAggregateExpr(col) && !col.alias) {
                const key = aggregateKey(col);
                autoAlias = aggregateAliasMap.get(key);
            }
            const line = generateAttributeLine(col, groupByColumns, '    ', autoAlias, ast.from.table);
            if (line) lines.push(line);
        }
    }

    // JOIN link-entities
    for (const join of ast.joins) {
        if (join.type === 'RIGHT') {
            throw new SqlParseError(
                'RIGHT JOIN is not supported in FetchXML. Restructure the query to use LEFT JOIN instead.',
                0,
                0,
            );
        }

        const joinRef = join.alias ?? join.table;
        const linkType = join.type === 'LEFT' || join.type === 'OUTER' ? 'outer' : 'inner';
        const name = xmlEscape(join.table);
        const alias = join.alias ? ` alias="${xmlEscape(join.alias)}"` : '';

        // Resolve ON condition to determine from/to attributes
        // FetchXML: from = attribute on the link-entity, to = attribute on the parent entity
        let fromAttr = '';
        let toAttr = '';
        const on = join.on;
        if (on.kind === 'comparison' && on.operator === '=') {
            const leftCol = on.left;
            const rightRef = on.right;
            if (isAggregateExpr(leftCol)) {
                throw new SqlParseError('Aggregate in JOIN ON condition is not supported', 0, 0);
            }
            if (rightRef !== null && typeof rightRef === 'object' && 'column' in rightRef) {
                const rRef = rightRef as ColumnRef;
                const joinTableOrAlias = join.alias ?? join.table;
                if (rRef.table && (rRef.table === join.table || rRef.table === joinTableOrAlias)) {
                    // Right side is the joined entity
                    fromAttr = rRef.column; // link-entity's attribute
                    toAttr = leftCol.column; // parent entity's attribute
                } else if (leftCol.table && (leftCol.table === join.table || leftCol.table === joinTableOrAlias)) {
                    // Left side is the joined entity
                    fromAttr = leftCol.column; // link-entity's attribute
                    toAttr = rRef.column; // parent entity's attribute
                } else {
                    // Fallback: assume left is parent, right is link-entity
                    toAttr = leftCol.column;
                    fromAttr = rRef.column;
                }
            }
        }

        const fromPart = fromAttr ? ` from="${xmlEscape(fromAttr)}"` : '';
        const toPart = toAttr ? ` to="${xmlEscape(toAttr)}"` : '';

        // Columns belonging to this join
        const joinCols = joinColumnMap.get(joinRef) ?? [];
        const joinHasWildcard = joinCols.some((c) => !isAggregateExpr(c) && (c as ColumnRef).column === '*');

        if (joinCols.length === 0) {
            lines.push(`    <link-entity name="${name}"${fromPart}${toPart} link-type="${linkType}"${alias} />`);
        } else if (joinHasWildcard) {
            lines.push(`    <link-entity name="${name}"${fromPart}${toPart} link-type="${linkType}"${alias}>`);
            lines.push(`      <all-attributes />`);
            lines.push(`    </link-entity>`);
        } else {
            lines.push(`    <link-entity name="${name}"${fromPart}${toPart} link-type="${linkType}"${alias}>`);
            for (const col of joinCols) {
                const line = generateAttributeLine(col, groupByColumns, '      ');
                if (line) lines.push(line);
            }
            lines.push(`    </link-entity>`);
        }
    }

    // WHERE filter
    if (ast.where) {
        const filterXml = generateCondition(ast.where, '    ', aggregateAliasMap);
        if (filterXml.trimStart().startsWith('<filter')) {
            lines.push(filterXml);
        } else {
            lines.push(`    <filter type="and">`);
            lines.push(filterXml);
            lines.push(`    </filter>`);
        }
    }

    // HAVING filter
    if (ast.having) {
        const filterXml = generateCondition(ast.having, '    ', aggregateAliasMap);
        if (filterXml.trimStart().startsWith('<filter')) {
            lines.push(filterXml);
        } else {
            lines.push(`    <filter type="and">`);
            lines.push(filterXml);
            lines.push(`    </filter>`);
        }
    }

    // ORDER BY
    if (ast.orderBy) {
        // Build a set of known join aliases/tables for entityname resolution
        const joinAliasSet = new Set(ast.joins.map((j) => j.alias ?? j.table));
        for (const item of ast.orderBy) {
            const attr = xmlEscape(item.column.column);
            const tableRef = item.column.table;
            // If ordering by a column from a joined entity, emit entityname attribute
            const entitynamePart = tableRef && joinAliasSet.has(tableRef) ? ` entityname="${xmlEscape(tableRef)}"` : '';
            if (item.direction === 'DESC') {
                lines.push(`    <order attribute="${attr}"${entitynamePart} descending="true" />`);
            } else {
                lines.push(`    <order attribute="${attr}"${entitynamePart} />`);
            }
        }
    }

    lines.push(`  </entity>`);
    lines.push(`</fetch>`);

    return lines.join('\n');
}
