// ── Token types produced by the lexer ──

export enum TokenType {
    // Keywords
    SELECT = 'SELECT',
    FROM = 'FROM',
    WHERE = 'WHERE',
    AND = 'AND',
    OR = 'OR',
    NOT = 'NOT',
    IN = 'IN',
    LIKE = 'LIKE',
    BETWEEN = 'BETWEEN',
    IS = 'IS',
    NULL = 'NULL',
    JOIN = 'JOIN',
    INNER = 'INNER',
    LEFT = 'LEFT',
    RIGHT = 'RIGHT',
    OUTER = 'OUTER',
    ON = 'ON',
    ORDER = 'ORDER',
    BY = 'BY',
    ASC = 'ASC',
    DESC = 'DESC',
    GROUP = 'GROUP',
    HAVING = 'HAVING',
    TOP = 'TOP',
    DISTINCT = 'DISTINCT',
    AS = 'AS',
    COUNT = 'COUNT',
    SUM = 'SUM',
    AVG = 'AVG',
    MIN = 'MIN',
    MAX = 'MAX',
    TRUE = 'TRUE',
    FALSE = 'FALSE',

    // DML keywords
    INSERT = 'INSERT',
    INTO = 'INTO',
    VALUES = 'VALUES',
    UPDATE = 'UPDATE',
    SET = 'SET',
    DELETE = 'DELETE',

    // Literals & identifiers
    IDENTIFIER = 'IDENTIFIER',
    NUMBER = 'NUMBER',
    STRING = 'STRING',

    // Operators
    EQUALS = 'EQUALS', // =
    NOT_EQUALS = 'NOT_EQUALS', // != or <>
    LESS_THAN = 'LESS_THAN', // <
    GREATER_THAN = 'GREATER_THAN', // >
    LESS_EQUAL = 'LESS_EQUAL', // <=
    GREATER_EQUAL = 'GREATER_EQUAL', // >=

    // Punctuation
    COMMA = 'COMMA',
    DOT = 'DOT',
    STAR = 'STAR',
    LPAREN = 'LPAREN',
    RPAREN = 'RPAREN',

    // Special
    EOF = 'EOF',
}

export interface Token {
    type: TokenType;
    value: string;
    line: number;
    column: number;
}

// ── AST node types ──

export interface ColumnRef {
    table?: string; // e.g. "a" in a.name
    column: string; // e.g. "name" or "*"
    alias?: string;
}

export interface AggregateExpr {
    function: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
    column: ColumnRef;
    distinct?: boolean;
    alias?: string;
}

export type SelectExpr = ColumnRef | AggregateExpr;

export function isAggregateExpr(expr: SelectExpr): expr is AggregateExpr {
    return 'function' in expr;
}

export interface FromClause {
    table: string;
    alias?: string;
}

export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'OUTER';

export interface JoinClause {
    type: JoinType;
    table: string;
    alias?: string;
    on: WhereExpr;
}

// ── WHERE expression tree ──

export type ComparisonOp = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'LIKE';

export interface ComparisonExpr {
    kind: 'comparison';
    left: ColumnRef | AggregateExpr;
    operator: ComparisonOp;
    right: LiteralValue | ColumnRef;
}

export interface BetweenExpr {
    kind: 'between';
    column: ColumnRef;
    low: LiteralValue;
    high: LiteralValue;
    negated?: boolean;
}

export interface InExpr {
    kind: 'in';
    column: ColumnRef;
    values: LiteralValue[];
    negated?: boolean;
}

export interface IsNullExpr {
    kind: 'is_null';
    column: ColumnRef;
    negated?: boolean;
}

export interface LogicalExpr {
    kind: 'and' | 'or';
    left: WhereExpr;
    right: WhereExpr;
}

export interface NotExpr {
    kind: 'not';
    expr: WhereExpr;
}

export type WhereExpr = ComparisonExpr | BetweenExpr | InExpr | IsNullExpr | LogicalExpr | NotExpr;

export type LiteralValue = string | number | boolean | null;

export interface OrderByItem {
    column: ColumnRef;
    direction: 'ASC' | 'DESC';
}

// ── Top-level SELECT statement ──

export interface SelectStatement {
    type: 'select';
    distinct?: boolean;
    top?: number;
    columns: SelectExpr[];
    from: FromClause;
    joins: JoinClause[];
    where?: WhereExpr;
    groupBy?: ColumnRef[];
    having?: WhereExpr;
    orderBy?: OrderByItem[];
}

// ── DML statements ──

export interface InsertStatement {
    type: 'insert';
    table: string;
    columns: string[];
    values: LiteralValue[][]; // multiple rows for multi-row insert
}

export interface SetClause {
    column: string;
    value: LiteralValue;
}

export interface UpdateStatement {
    type: 'update';
    table: string;
    set: SetClause[];
    where: WhereExpr; // required — parser rejects UPDATE without WHERE
}

export interface DeleteStatement {
    type: 'delete';
    table: string;
    where: WhereExpr; // required — parser rejects DELETE without WHERE
}

export type Statement = SelectStatement | InsertStatement | UpdateStatement | DeleteStatement;

// ── Parse error ──

export class SqlParseError extends Error {
    constructor(
        message: string,
        public line: number,
        public column: number,
    ) {
        super(`${message} (line ${line}, column ${column})`);
        this.name = 'SqlParseError';
    }
}
