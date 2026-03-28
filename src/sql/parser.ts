import {
    Token,
    TokenType,
    SqlParseError,
    SelectStatement,
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

const AGGREGATE_FUNCTIONS: TokenType[] = [
    TokenType.COUNT,
    TokenType.SUM,
    TokenType.AVG,
    TokenType.MIN,
    TokenType.MAX,
];

export function parse(tokens: Token[]): SelectStatement {
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
            throw new SqlParseError(
                `Expected ${type} but got '${t.value || t.type}'`,
                t.line,
                t.column,
            );
        }
        return advance();
    }

    function expectIdentifierOrKeyword(): Token {
        const t = peek();
        // Allow keywords used as identifiers (table/column names like "order", "group", etc.)
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
            t.type === TokenType.FALSE
        ) {
            return advance();
        }
        throw new SqlParseError(
            `Expected identifier but got '${t.value || t.type}'`,
            t.line,
            t.column,
        );
    }

    // Parse a possibly-dotted identifier: [table.]column
    function parseColumnRef(): ColumnRef {
        const first = expectIdentifierOrKeyword();
        if (check(TokenType.DOT)) {
            advance(); // consume dot
            if (check(TokenType.STAR)) {
                advance();
                return { table: first.value, column: '*' };
            }
            const second = expectIdentifierOrKeyword();
            return { table: first.value, column: second.value };
        }
        return { column: first.value };
    }

    function parseOptionalAlias(): string | undefined {
        // AS alias or bare identifier alias (not followed by a keyword that starts a clause)
        if (check(TokenType.AS)) {
            advance();
            return expectIdentifierOrKeyword().value;
        }
        // Implicit alias: next token is a plain identifier (keywords are their own token type)
        if (peek().type === TokenType.IDENTIFIER) {
            return advance().value;
        }
        return undefined;
    }

    // Parse SELECT columns
    function parseSelectExpr(): SelectExpr {
        // Aggregate function
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

        // Bare * wildcard
        if (check(TokenType.STAR)) {
            advance();
            return { column: '*' };
        }

        // Column ref (possibly table.column or table.*)
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
        // Optional alias: bare identifier or AS alias
        let alias: string | undefined;
        if (peek().type === TokenType.AS) {
            advance();
            alias = expectIdentifierOrKeyword().value;
        } else if (peek().type === TokenType.IDENTIFIER) {
            alias = advance().value;
        }
        return alias ? { table, alias } : { table };
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
        // Negated number: handle - NUMBER
        throw new SqlParseError(
            `Expected literal value but got '${t.value || t.type}'`,
            t.line,
            t.column,
        );
    }

    // Parse a comparison operator token
    function parseComparisonOp(): ComparisonOp {
        const t = advance();
        switch (t.type) {
            case TokenType.EQUALS:        return '=';
            case TokenType.NOT_EQUALS:    return '!=';
            case TokenType.LESS_THAN:     return '<';
            case TokenType.GREATER_THAN:  return '>';
            case TokenType.LESS_EQUAL:    return '<=';
            case TokenType.GREATER_EQUAL: return '>=';
            case TokenType.LIKE:          return 'LIKE';
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

    // Primary WHERE expression: handles atoms (comparisons, IS NULL, BETWEEN, IN, parens, NOT)
    function parseWherePrimary(): WhereExpr {
        // NOT expression
        if (check(TokenType.NOT)) {
            advance();
            const expr = parseWherePrimary();
            return { kind: 'not', expr } as NotExpr;
        }

        // Parenthesized expression
        if (check(TokenType.LPAREN)) {
            advance();
            const expr = parseWhereOr();
            expect(TokenType.RPAREN);
            return expr;
        }

        // Aggregate function used as left-hand side of a comparison (e.g. in HAVING)
        if (AGGREGATE_FUNCTIONS.includes(peek().type)) {
            const fnToken = advance();
            const fnName = fnToken.type as 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
            expect(TokenType.LPAREN);
            let distinct = false;
            if (check(TokenType.DISTINCT)) { advance(); distinct = true; }
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

        // Must be a column ref followed by operator
        const col = parseColumnRef();

        // IS [NOT] NULL
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

        // [NOT] BETWEEN
        if (check(TokenType.NOT) && peek(1).type === TokenType.BETWEEN) {
            advance(); // NOT
            advance(); // BETWEEN
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

        // [NOT] IN (...)
        if (check(TokenType.NOT) && peek(1).type === TokenType.IN) {
            advance(); // NOT
            advance(); // IN
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

        // Comparison operator
        if (isComparisonOp()) {
            const op = parseComparisonOp();
            // Right-hand side: literal or column ref
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

    // AND binds tighter than OR
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

    function parseJoins(): JoinClause[] {
        const joins: JoinClause[] = [];
        while (true) {
            let joinType: JoinType | null = null;

            if (check(TokenType.INNER) && peek(1).type === TokenType.JOIN) {
                advance(); advance();
                joinType = 'INNER';
            } else if (check(TokenType.LEFT)) {
                advance();
                if (check(TokenType.OUTER)) advance(); // optional OUTER
                expect(TokenType.JOIN);
                joinType = 'LEFT';
            } else if (check(TokenType.RIGHT)) {
                advance();
                if (check(TokenType.OUTER)) advance();
                expect(TokenType.JOIN);
                joinType = 'RIGHT';
            } else if (check(TokenType.JOIN)) {
                advance();
                joinType = 'INNER'; // bare JOIN defaults to INNER
            } else {
                break;
            }

            const tableToken = expectIdentifierOrKeyword();
            const table = tableToken.value;

            // Optional alias before ON
            let alias: string | undefined;
            if (check(TokenType.AS)) {
                advance();
                alias = expectIdentifierOrKeyword().value;
            } else if (
                peek().type === TokenType.IDENTIFIER &&
                peek().type !== TokenType.ON
            ) {
                // bare alias only if it's an identifier (not ON keyword)
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
            if (items.length > 0) advance(); // consume comma
            const col = parseColumnRef();
            let direction: 'ASC' | 'DESC' = 'ASC';
            if (check(TokenType.ASC)) { advance(); direction = 'ASC'; }
            else if (check(TokenType.DESC)) { advance(); direction = 'DESC'; }
            items.push({ column: col, direction });
        } while (check(TokenType.COMMA));
        return items;
    }

    // ── Main parse ──

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

    const stmt: SelectStatement = {
        type: 'select',
        columns,
        from,
        joins,
    };
    if (distinct) stmt.distinct = true;
    if (top !== undefined) stmt.top = top;
    if (where) stmt.where = where;
    if (groupBy) stmt.groupBy = groupBy;
    if (having) stmt.having = having;
    if (orderBy) stmt.orderBy = orderBy;

    return stmt;
}
