import {
    Token,
    TokenType,
    SqlParseError,
    SelectStatement,
    InsertStatement,
    UpdateStatement,
    DeleteStatement,
    SetClause,
    Statement,
    SelectExpr,
    ColumnRef,
    AggregateExpr,
    FromClause,
    JoinClause,
    JoinType,
    WhereExpr,
    ComparisonExpr,
    ComparisonOp,
    BetweenExpr,
    InExpr,
    IsNullExpr,
    LogicalExpr,
    NotExpr,
    LiteralValue,
    OrderByItem,
} from './types';

const AGGREGATE_FUNCTIONS: TokenType[] = [TokenType.COUNT, TokenType.SUM, TokenType.AVG, TokenType.MIN, TokenType.MAX];

// ── Shared token-walking infrastructure ──

function makeWalker(tokens: Token[]) {
    let pos = 0;

    function peek(offset = 0): Token {
        const idx = pos + offset;
        return idx < tokens.length ? tokens[idx] : tokens[tokens.length - 1];
    }

    function advance(): Token {
        const t = tokens[pos];
        if (pos < tokens.length - 1) pos++;
        return t;
    }

    function check(type: TokenType): boolean {
        return peek().type === type;
    }

    function expect(type: TokenType): Token {
        if (!check(type)) {
            const t = peek();
            throw new SqlParseError(`Expected ${type} but got '${t.value || t.type}'`, t.line, t.column);
        }
        return advance();
    }

    function expectIdentifierOrKeyword(): Token {
        const t = peek();
        if (
            t.type === TokenType.IDENTIFIER ||
            t.type === TokenType.SELECT ||
            t.type === TokenType.FROM ||
            t.type === TokenType.WHERE ||
            t.type === TokenType.AND ||
            t.type === TokenType.OR ||
            t.type === TokenType.NOT ||
            t.type === TokenType.IN ||
            t.type === TokenType.LIKE ||
            t.type === TokenType.BETWEEN ||
            t.type === TokenType.IS ||
            t.type === TokenType.NULL ||
            t.type === TokenType.JOIN ||
            t.type === TokenType.INNER ||
            t.type === TokenType.LEFT ||
            t.type === TokenType.RIGHT ||
            t.type === TokenType.OUTER ||
            t.type === TokenType.ON ||
            t.type === TokenType.ORDER ||
            t.type === TokenType.BY ||
            t.type === TokenType.ASC ||
            t.type === TokenType.DESC ||
            t.type === TokenType.GROUP ||
            t.type === TokenType.HAVING ||
            t.type === TokenType.TOP ||
            t.type === TokenType.DISTINCT ||
            t.type === TokenType.AS ||
            t.type === TokenType.COUNT ||
            t.type === TokenType.SUM ||
            t.type === TokenType.AVG ||
            t.type === TokenType.MIN ||
            t.type === TokenType.MAX ||
            t.type === TokenType.TRUE ||
            t.type === TokenType.FALSE ||
            t.type === TokenType.INSERT ||
            t.type === TokenType.INTO ||
            t.type === TokenType.VALUES ||
            t.type === TokenType.UPDATE ||
            t.type === TokenType.SET ||
            t.type === TokenType.DELETE
        ) {
            return advance();
        }
        throw new SqlParseError(`Expected identifier but got '${t.value || t.type}'`, t.line, t.column);
    }

    function parseLiteral(): LiteralValue {
        const t = peek();
        if (t.type === TokenType.STRING) {
            advance();
            return t.value;
        }
        if (t.type === TokenType.NUMBER) {
            advance();
            return Number(t.value);
        }
        if (t.type === TokenType.TRUE) {
            advance();
            return true;
        }
        if (t.type === TokenType.FALSE) {
            advance();
            return false;
        }
        if (t.type === TokenType.NULL) {
            advance();
            return null;
        }
        throw new SqlParseError(`Expected literal value but got '${t.value || t.type}'`, t.line, t.column);
    }

    function parseComparisonOp(): ComparisonOp {
        const t = advance();
        switch (t.type) {
            case TokenType.EQUALS:
                return '=';
            case TokenType.NOT_EQUALS:
                return '!=';
            case TokenType.LESS_THAN:
                return '<';
            case TokenType.GREATER_THAN:
                return '>';
            case TokenType.LESS_EQUAL:
                return '<=';
            case TokenType.GREATER_EQUAL:
                return '>=';
            case TokenType.LIKE:
                return 'LIKE';
            default:
                throw new SqlParseError(
                    `Expected comparison operator but got '${t.value || t.type}'`,
                    t.line,
                    t.column,
                );
        }
    }

    function isComparisonOp(): boolean {
        const t = peek().type;
        return (
            t === TokenType.EQUALS ||
            t === TokenType.NOT_EQUALS ||
            t === TokenType.LESS_THAN ||
            t === TokenType.GREATER_THAN ||
            t === TokenType.LESS_EQUAL ||
            t === TokenType.GREATER_EQUAL ||
            t === TokenType.LIKE
        );
    }

    // Parse a possibly-dotted identifier: [table.]column
    function parseColumnRef(): ColumnRef {
        const first = expectIdentifierOrKeyword();
        if (check(TokenType.DOT)) {
            advance();
            if (check(TokenType.STAR)) {
                advance();
                return { table: first.value, column: '*' };
            }
            const second = expectIdentifierOrKeyword();
            return { table: first.value, column: second.value };
        }
        return { column: first.value };
    }

    function parseWherePrimary(): WhereExpr {
        if (check(TokenType.NOT)) {
            advance();
            const expr = parseWherePrimary();
            return { kind: 'not', expr } as NotExpr;
        }

        if (check(TokenType.LPAREN)) {
            advance();
            const expr = parseWhereOr();
            expect(TokenType.RPAREN);
            return expr;
        }

        if (AGGREGATE_FUNCTIONS.includes(peek().type)) {
            const fnToken = advance();
            const fnName = fnToken.type as 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
            expect(TokenType.LPAREN);
            let distinct = false;
            if (check(TokenType.DISTINCT)) {
                advance();
                distinct = true;
            }
            let col: ColumnRef;
            if (check(TokenType.STAR)) {
                advance();
                col = { column: '*' };
            } else {
                col = parseColumnRef();
            }
            expect(TokenType.RPAREN);
            const aggExpr: AggregateExpr = { function: fnName, column: col };
            if (distinct) aggExpr.distinct = true;
            if (!isComparisonOp()) {
                const t = peek();
                throw new SqlParseError(
                    `Expected comparison operator after aggregate but got '${t.value || t.type}'`,
                    t.line,
                    t.column,
                );
            }
            const op = parseComparisonOp();
            const t2 = peek();
            let right: LiteralValue | ColumnRef;
            if (
                t2.type === TokenType.STRING ||
                t2.type === TokenType.NUMBER ||
                t2.type === TokenType.TRUE ||
                t2.type === TokenType.FALSE ||
                t2.type === TokenType.NULL
            ) {
                right = parseLiteral();
            } else {
                right = parseColumnRef();
            }
            return { kind: 'comparison', left: aggExpr, operator: op, right } as ComparisonExpr;
        }

        const col = parseColumnRef();

        if (check(TokenType.IS)) {
            advance();
            let negated = false;
            if (check(TokenType.NOT)) {
                advance();
                negated = true;
            }
            expect(TokenType.NULL);
            return { kind: 'is_null', column: col, negated } as IsNullExpr;
        }

        if (check(TokenType.NOT) && peek(1).type === TokenType.BETWEEN) {
            advance();
            advance();
            const low = parseLiteral();
            expect(TokenType.AND);
            const high = parseLiteral();
            return { kind: 'between', column: col, low, high, negated: true } as BetweenExpr;
        }

        if (check(TokenType.BETWEEN)) {
            advance();
            const low = parseLiteral();
            expect(TokenType.AND);
            const high = parseLiteral();
            return { kind: 'between', column: col, low, high } as BetweenExpr;
        }

        if (check(TokenType.NOT) && peek(1).type === TokenType.IN) {
            advance();
            advance();
            expect(TokenType.LPAREN);
            const values: LiteralValue[] = [parseLiteral()];
            while (check(TokenType.COMMA)) {
                advance();
                values.push(parseLiteral());
            }
            expect(TokenType.RPAREN);
            return { kind: 'in', column: col, values, negated: true } as InExpr;
        }

        if (check(TokenType.IN)) {
            advance();
            expect(TokenType.LPAREN);
            const values: LiteralValue[] = [parseLiteral()];
            while (check(TokenType.COMMA)) {
                advance();
                values.push(parseLiteral());
            }
            expect(TokenType.RPAREN);
            return { kind: 'in', column: col, values } as InExpr;
        }

        if (isComparisonOp()) {
            const op = parseComparisonOp();
            const t = peek();
            let right: LiteralValue | ColumnRef;
            if (
                t.type === TokenType.STRING ||
                t.type === TokenType.NUMBER ||
                t.type === TokenType.TRUE ||
                t.type === TokenType.FALSE ||
                t.type === TokenType.NULL
            ) {
                right = parseLiteral();
            } else {
                right = parseColumnRef();
            }
            return { kind: 'comparison', left: col, operator: op, right } as ComparisonExpr;
        }

        const t = peek();
        throw new SqlParseError(
            `Expected condition operator after column but got '${t.value || t.type}'`,
            t.line,
            t.column,
        );
    }

    function parseWhereAnd(): WhereExpr {
        let left = parseWherePrimary();
        while (check(TokenType.AND)) {
            advance();
            const right = parseWherePrimary();
            left = { kind: 'and', left, right } as LogicalExpr;
        }
        return left;
    }

    function parseWhereOr(): WhereExpr {
        let left = parseWhereAnd();
        while (check(TokenType.OR)) {
            advance();
            const right = parseWhereAnd();
            left = { kind: 'or', left, right } as LogicalExpr;
        }
        return left;
    }

    return {
        peek,
        advance,
        check,
        expect,
        expectIdentifierOrKeyword,
        parseLiteral,
        parseColumnRef,
        parseWhereOr,
    };
}

// ── SELECT parser ──

function parseSelect(tokens: Token[]): SelectStatement {
    const w = makeWalker(tokens);
    const { peek, advance, check, expect, expectIdentifierOrKeyword, parseColumnRef, parseWhereOr } = w;

    function parseOptionalAlias(): string | undefined {
        if (check(TokenType.AS)) {
            advance();
            if (check(TokenType.STRING)) return advance().value;
            return expectIdentifierOrKeyword().value;
        }
        if (peek().type === TokenType.STRING) return advance().value;
        if (peek().type === TokenType.IDENTIFIER) return advance().value;
        return undefined;
    }

    function parseSelectExpr(): SelectExpr {
        if (AGGREGATE_FUNCTIONS.includes(peek().type)) {
            const fnToken = advance();
            const fnName = fnToken.type as 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
            expect(TokenType.LPAREN);
            let distinct = false;
            if (check(TokenType.DISTINCT)) {
                advance();
                distinct = true;
            }
            let col: ColumnRef;
            if (check(TokenType.STAR)) {
                advance();
                col = { column: '*' };
            } else {
                col = parseColumnRef();
            }
            expect(TokenType.RPAREN);
            const alias = parseOptionalAlias();
            const agg: AggregateExpr = { function: fnName, column: col, alias };
            if (distinct) agg.distinct = true;
            return agg;
        }

        if (check(TokenType.STAR)) {
            advance();
            return { column: '*' };
        }

        const col = parseColumnRef();
        const alias = parseOptionalAlias();
        if (alias) col.alias = alias;
        return col;
    }

    function parseSelectList(): SelectExpr[] {
        const exprs: SelectExpr[] = [parseSelectExpr()];
        while (check(TokenType.COMMA)) {
            advance();
            exprs.push(parseSelectExpr());
        }
        return exprs;
    }

    function parseFrom(): FromClause {
        const tableToken = expectIdentifierOrKeyword();
        const table = tableToken.value;
        let alias: string | undefined;
        if (peek().type === TokenType.AS) {
            advance();
            alias = expectIdentifierOrKeyword().value;
        } else if (peek().type === TokenType.IDENTIFIER) {
            alias = advance().value;
        }
        return alias ? { table, alias } : { table };
    }

    function parseJoins(): JoinClause[] {
        const joins: JoinClause[] = [];
        while (true) {
            let joinType: JoinType | null = null;

            if (check(TokenType.INNER) && peek(1).type === TokenType.JOIN) {
                advance();
                advance();
                joinType = 'INNER';
            } else if (check(TokenType.LEFT)) {
                advance();
                if (check(TokenType.OUTER)) advance();
                expect(TokenType.JOIN);
                joinType = 'LEFT';
            } else if (check(TokenType.RIGHT)) {
                advance();
                if (check(TokenType.OUTER)) advance();
                expect(TokenType.JOIN);
                joinType = 'RIGHT';
            } else if (check(TokenType.JOIN)) {
                advance();
                joinType = 'INNER';
            } else {
                break;
            }

            const tableToken = expectIdentifierOrKeyword();
            const table = tableToken.value;

            let alias: string | undefined;
            if (check(TokenType.AS)) {
                advance();
                alias = expectIdentifierOrKeyword().value;
            } else if (peek().type === TokenType.IDENTIFIER && peek().type !== TokenType.ON) {
                if (peek().type === TokenType.IDENTIFIER) {
                    alias = advance().value;
                }
            }

            expect(TokenType.ON);
            const on = parseWhereOr();

            const join: JoinClause = { type: joinType, table, on };
            if (alias) join.alias = alias;
            joins.push(join);
        }
        return joins;
    }

    function parseGroupBy(): ColumnRef[] {
        const cols: ColumnRef[] = [parseColumnRef()];
        while (check(TokenType.COMMA)) {
            advance();
            cols.push(parseColumnRef());
        }
        return cols;
    }

    function parseOrderBy(): OrderByItem[] {
        const items: OrderByItem[] = [];
        do {
            if (items.length > 0) advance();
            const col = parseColumnRef();
            let direction: 'ASC' | 'DESC' = 'ASC';
            if (check(TokenType.ASC)) {
                advance();
                direction = 'ASC';
            } else if (check(TokenType.DESC)) {
                advance();
                direction = 'DESC';
            }
            items.push({ column: col, direction });
        } while (check(TokenType.COMMA));
        return items;
    }

    // ── Main SELECT parse ──

    expect(TokenType.SELECT);

    let distinct = false;
    if (check(TokenType.DISTINCT)) {
        advance();
        distinct = true;
    }

    let top: number | undefined;
    if (check(TokenType.TOP)) {
        advance();
        const n = expect(TokenType.NUMBER);
        top = Number(n.value);
    }

    const columns = parseSelectList();

    expect(TokenType.FROM);
    const from = parseFrom();
    const joins = parseJoins();

    let where: WhereExpr | undefined;
    if (check(TokenType.WHERE)) {
        advance();
        where = parseWhereOr();
    }

    let groupBy: ColumnRef[] | undefined;
    if (check(TokenType.GROUP)) {
        advance();
        expect(TokenType.BY);
        groupBy = parseGroupBy();
    }

    let having: WhereExpr | undefined;
    if (check(TokenType.HAVING)) {
        advance();
        having = parseWhereOr();
    }

    let orderBy: OrderByItem[] | undefined;
    if (check(TokenType.ORDER)) {
        advance();
        expect(TokenType.BY);
        orderBy = parseOrderBy();
    }

    expect(TokenType.EOF);

    const stmt: SelectStatement = { type: 'select', columns, from, joins };
    if (distinct) stmt.distinct = true;
    if (top !== undefined) stmt.top = top;
    if (where) stmt.where = where;
    if (groupBy) stmt.groupBy = groupBy;
    if (having) stmt.having = having;
    if (orderBy) stmt.orderBy = orderBy;

    return stmt;
}

// ── INSERT parser ──

function parseInsert(tokens: Token[]): InsertStatement {
    const { advance, check, expect, expectIdentifierOrKeyword, parseLiteral, peek } = makeWalker(tokens);

    expect(TokenType.INSERT);
    expect(TokenType.INTO);

    const tableToken = expectIdentifierOrKeyword();
    const table = tableToken.value;

    // Column list
    expect(TokenType.LPAREN);
    const columns: string[] = [expectIdentifierOrKeyword().value];
    while (check(TokenType.COMMA)) {
        advance();
        columns.push(expectIdentifierOrKeyword().value);
    }
    expect(TokenType.RPAREN);

    expect(TokenType.VALUES);

    // One or more value rows
    const values: LiteralValue[][] = [];

    function parseValueRow(): LiteralValue[] {
        expect(TokenType.LPAREN);
        const row: LiteralValue[] = [parseLiteral()];
        while (check(TokenType.COMMA)) {
            advance();
            row.push(parseLiteral());
        }
        expect(TokenType.RPAREN);
        return row;
    }

    values.push(parseValueRow());
    while (check(TokenType.COMMA)) {
        advance();
        values.push(parseValueRow());
    }

    // Validate column count matches values count in each row
    for (let i = 0; i < values.length; i++) {
        if (values[i].length !== columns.length) {
            const t = peek();
            throw new SqlParseError(
                `Values row ${i + 1} has ${values[i].length} value(s) but ${columns.length} column(s) were specified`,
                t.line,
                t.column,
            );
        }
    }

    expect(TokenType.EOF);

    return { type: 'insert', table, columns, values };
}

// ── UPDATE parser ──

function parseUpdate(tokens: Token[]): UpdateStatement {
    const { advance, check, expect, expectIdentifierOrKeyword, parseLiteral, parseWhereOr, peek } = makeWalker(tokens);

    expect(TokenType.UPDATE);

    const tableToken = expectIdentifierOrKeyword();
    const table = tableToken.value;

    expect(TokenType.SET);

    // One or more col = val pairs
    const set: SetClause[] = [];

    function parseSetClause(): SetClause {
        const column = expectIdentifierOrKeyword().value;
        expect(TokenType.EQUALS);
        const value = parseLiteral();
        return { column, value };
    }

    set.push(parseSetClause());
    while (check(TokenType.COMMA)) {
        advance();
        set.push(parseSetClause());
    }

    // WHERE is required
    if (!check(TokenType.WHERE)) {
        const t = peek();
        throw new SqlParseError(
            'UPDATE without WHERE clause is not allowed. Use WHERE to specify which records to update.',
            t.line,
            t.column,
        );
    }
    advance(); // consume WHERE
    const where = parseWhereOr();

    expect(TokenType.EOF);

    return { type: 'update', table, set, where };
}

// ── DELETE parser ──

function parseDelete(tokens: Token[]): DeleteStatement {
    const { advance, check, expect, expectIdentifierOrKeyword, parseWhereOr, peek } = makeWalker(tokens);

    expect(TokenType.DELETE);
    expect(TokenType.FROM);

    const tableToken = expectIdentifierOrKeyword();
    const table = tableToken.value;

    // WHERE is required
    if (!check(TokenType.WHERE)) {
        const t = peek();
        throw new SqlParseError(
            'DELETE without WHERE clause is not allowed. Use WHERE to specify which records to delete.',
            t.line,
            t.column,
        );
    }
    advance(); // consume WHERE
    const where = parseWhereOr();

    expect(TokenType.EOF);

    return { type: 'delete', table, where };
}

// ── Public API ──

export function parseStatement(tokens: Token[]): Statement {
    const first = tokens[0];
    if (!first) {
        throw new SqlParseError('Expected SELECT, INSERT, UPDATE, or DELETE', 1, 1);
    }
    switch (first.type) {
        case TokenType.SELECT:
            return parseSelect(tokens);
        case TokenType.INSERT:
            return parseInsert(tokens);
        case TokenType.UPDATE:
            return parseUpdate(tokens);
        case TokenType.DELETE:
            return parseDelete(tokens);
        default:
            throw new SqlParseError(`Expected SELECT, INSERT, UPDATE, or DELETE`, first.line, first.column);
    }
}

export function parse(tokens: Token[]): SelectStatement {
    const stmt = parseStatement(tokens);
    if (stmt.type !== 'select') {
        const first = tokens[0];
        throw new SqlParseError(
            `Expected SELECT statement but got ${stmt.type.toUpperCase()}`,
            first?.line ?? 1,
            first?.column ?? 1,
        );
    }
    return stmt;
}
