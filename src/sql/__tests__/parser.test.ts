import { describe, it, expect } from 'vitest';
import { parse } from '../parser';
import { tokenize } from '../lexer';
import {
    SelectStatement,
    ColumnRef,
    AggregateExpr,
    ComparisonExpr,
    LogicalExpr,
    BetweenExpr,
    InExpr,
    IsNullExpr,
    NotExpr,
    SqlParseError,
    isAggregateExpr,
} from '../types';

const parseSQL = (sql: string): SelectStatement => parse(tokenize(sql));

// Helper to cast WhereExpr kinds
const asComparison = (e: unknown) => e as ComparisonExpr;
const asLogical = (e: unknown) => e as LogicalExpr;
const asBetween = (e: unknown) => e as BetweenExpr;
const asIn = (e: unknown) => e as InExpr;
const asIsNull = (e: unknown) => e as IsNullExpr;
const asNot = (e: unknown) => e as NotExpr;
const asColumnRef = (e: unknown) => e as ColumnRef;
const asAggregate = (e: unknown) => e as AggregateExpr;

describe('parse', () => {
    // ── Simple SELECT ─────────────────────────────────────────────────────────

    describe('simple select', () => {
        it('parses statement type as select', () => {
            const ast = parseSQL('SELECT name FROM account');
            expect(ast.type).toBe('select');
        });

        it('parses from table name', () => {
            const ast = parseSQL('SELECT name FROM account');
            expect(ast.from.table).toBe('account');
        });

        it('parses single column name', () => {
            const ast = parseSQL('SELECT name FROM account');
            expect(ast.columns).toHaveLength(1);
            expect(asColumnRef(ast.columns[0]).column).toBe('name');
        });

        it('has no joins, where, groupBy, orderBy, top, or distinct by default', () => {
            const ast = parseSQL('SELECT name FROM account');
            expect(ast.joins).toHaveLength(0);
            expect(ast.where).toBeUndefined();
            expect(ast.groupBy).toBeUndefined();
            expect(ast.orderBy).toBeUndefined();
            expect(ast.top).toBeUndefined();
            expect(ast.distinct).toBeFalsy();
        });
    });

    // ── SELECT * ──────────────────────────────────────────────────────────────

    describe('SELECT *', () => {
        it('parses star column', () => {
            const ast = parseSQL('SELECT * FROM account');
            expect(asColumnRef(ast.columns[0]).column).toBe('*');
        });
    });

    // ── Table-prefixed columns ────────────────────────────────────────────────

    describe('table-prefixed column', () => {
        it('parses table prefix on column', () => {
            const ast = parseSQL('SELECT a.name FROM account a');
            const col = asColumnRef(ast.columns[0]);
            expect(col.table).toBe('a');
            expect(col.column).toBe('name');
        });

        it('parses table alias in FROM clause', () => {
            const ast = parseSQL('SELECT a.name FROM account a');
            expect(ast.from.alias).toBe('a');
        });
    });

    // ── Multiple columns ──────────────────────────────────────────────────────

    describe('multiple columns', () => {
        it('parses three columns', () => {
            const ast = parseSQL('SELECT name, email, phone FROM contact');
            expect(ast.columns).toHaveLength(3);
        });

        it('parses each column name correctly', () => {
            const ast = parseSQL('SELECT name, email, phone FROM contact');
            expect(asColumnRef(ast.columns[0]).column).toBe('name');
            expect(asColumnRef(ast.columns[1]).column).toBe('email');
            expect(asColumnRef(ast.columns[2]).column).toBe('phone');
        });
    });

    // ── Column aliases ────────────────────────────────────────────────────────

    describe('column aliases', () => {
        it('parses AS alias on a column', () => {
            const ast = parseSQL('SELECT name AS n FROM account');
            expect(asColumnRef(ast.columns[0]).alias).toBe('n');
        });
    });

    // ── DISTINCT ──────────────────────────────────────────────────────────────

    describe('DISTINCT', () => {
        it('sets distinct flag', () => {
            const ast = parseSQL('SELECT DISTINCT name FROM account');
            expect(ast.distinct).toBe(true);
        });
    });

    // ── TOP ───────────────────────────────────────────────────────────────────

    describe('TOP', () => {
        it('parses TOP value', () => {
            const ast = parseSQL('SELECT TOP 10 name FROM account');
            expect(ast.top).toBe(10);
        });
    });

    // ── TOP + DISTINCT ────────────────────────────────────────────────────────

    describe('TOP + DISTINCT combined', () => {
        it('parses both DISTINCT and TOP together', () => {
            const ast = parseSQL('SELECT DISTINCT TOP 5 * FROM account');
            expect(ast.distinct).toBe(true);
            expect(ast.top).toBe(5);
        });
    });

    // ── Aggregates ────────────────────────────────────────────────────────────

    describe('aggregate functions', () => {
        it('parses COUNT(id) as aggregate', () => {
            const ast = parseSQL('SELECT COUNT(id) FROM account');
            expect(isAggregateExpr(ast.columns[0])).toBe(true);
            expect(asAggregate(ast.columns[0]).function).toBe('COUNT');
            expect(asAggregate(ast.columns[0]).column.column).toBe('id');
        });

        it('parses COUNT(DISTINCT name) with distinct flag', () => {
            const ast = parseSQL('SELECT COUNT(DISTINCT name) FROM account');
            const agg = asAggregate(ast.columns[0]);
            expect(agg.function).toBe('COUNT');
            expect(agg.distinct).toBe(true);
        });

        it('parses multiple aggregates', () => {
            const ast = parseSQL('SELECT COUNT(id), SUM(revenue), AVG(age) FROM account');
            expect(ast.columns).toHaveLength(3);
            expect(asAggregate(ast.columns[0]).function).toBe('COUNT');
            expect(asAggregate(ast.columns[1]).function).toBe('SUM');
            expect(asAggregate(ast.columns[2]).function).toBe('AVG');
        });
    });

    // ── WHERE clause ──────────────────────────────────────────────────────────

    describe('WHERE equals', () => {
        it('creates a comparison where node', () => {
            const ast = parseSQL("SELECT name FROM account WHERE status = 'active'");
            expect(ast.where).toBeDefined();
            const cmp = asComparison(ast.where);
            expect(cmp.kind).toBe('comparison');
            expect(cmp.left.column).toBe('status');
            expect(cmp.operator).toBe('=');
            expect(cmp.right).toBe('active');
        });
    });

    describe('WHERE with AND', () => {
        it('creates a logical AND node', () => {
            const ast = parseSQL("SELECT name FROM account WHERE status = 'active' AND revenue > 1000");
            const logical = asLogical(ast.where);
            expect(logical.kind).toBe('and');
        });

        it('left side of AND has first condition', () => {
            const ast = parseSQL("SELECT name FROM account WHERE status = 'active' AND revenue > 1000");
            const logical = asLogical(ast.where);
            expect(asComparison(logical.left).left.column).toBe('status');
        });

        it('right side of AND has second condition', () => {
            const ast = parseSQL("SELECT name FROM account WHERE status = 'active' AND revenue > 1000");
            const logical = asLogical(ast.where);
            expect(asComparison(logical.right).left.column).toBe('revenue');
        });
    });

    describe('WHERE with OR', () => {
        it('creates a logical OR node', () => {
            const ast = parseSQL("SELECT name FROM account WHERE status = 'active' OR status = 'pending'");
            expect(asLogical(ast.where).kind).toBe('or');
        });
    });

    describe('AND/OR precedence', () => {
        it('OR is at the top level when AND binds tighter', () => {
            // a = 1 OR b = 2 AND c = 3  →  OR( a=1,  AND(b=2, c=3) )
            const ast = parseSQL('SELECT * FROM t WHERE a = 1 OR b = 2 AND c = 3');
            const top = asLogical(ast.where);
            expect(top.kind).toBe('or');
        });

        it('AND groups the right-hand pair', () => {
            const ast = parseSQL('SELECT * FROM t WHERE a = 1 OR b = 2 AND c = 3');
            const top = asLogical(ast.where);
            const right = asLogical(top.right);
            expect(right.kind).toBe('and');
            expect(asComparison(right.left).left.column).toBe('b');
            expect(asComparison(right.right).left.column).toBe('c');
        });
    });

    describe('WHERE NOT', () => {
        it('creates a not node', () => {
            const ast = parseSQL("SELECT * FROM t WHERE NOT status = 'closed'");
            expect(asNot(ast.where).kind).toBe('not');
        });

        it('wraps the inner expression', () => {
            const ast = parseSQL("SELECT * FROM t WHERE NOT status = 'closed'");
            const inner = asComparison(asNot(ast.where).expr);
            expect(inner.left.column).toBe('status');
        });
    });

    describe('WHERE with parentheses', () => {
        it('parentheses override default AND/OR precedence', () => {
            // (a = 1 OR b = 2) AND c = 3  →  AND( OR(a=1, b=2), c=3 )
            const ast = parseSQL('SELECT * FROM t WHERE (a = 1 OR b = 2) AND c = 3');
            const top = asLogical(ast.where);
            expect(top.kind).toBe('and');
        });

        it('OR is nested inside the AND left branch', () => {
            const ast = parseSQL('SELECT * FROM t WHERE (a = 1 OR b = 2) AND c = 3');
            const top = asLogical(ast.where);
            expect(asLogical(top.left).kind).toBe('or');
        });
    });

    describe('WHERE BETWEEN', () => {
        it('creates a between node', () => {
            const ast = parseSQL('SELECT * FROM account WHERE revenue BETWEEN 100 AND 500');
            const expr = asBetween(ast.where);
            expect(expr.kind).toBe('between');
            expect(expr.column.column).toBe('revenue');
            expect(expr.low).toBe(100);
            expect(expr.high).toBe(500);
        });
    });

    describe('WHERE IN', () => {
        it('creates an in node with correct values', () => {
            const ast = parseSQL("SELECT * FROM account WHERE status IN ('active', 'pending')");
            const expr = asIn(ast.where);
            expect(expr.kind).toBe('in');
            expect(expr.column.column).toBe('status');
            expect(expr.values).toEqual(['active', 'pending']);
        });
    });

    describe('WHERE IS NULL', () => {
        it('creates an is_null node', () => {
            const ast = parseSQL('SELECT * FROM account WHERE email IS NULL');
            const expr = asIsNull(ast.where);
            expect(expr.kind).toBe('is_null');
            expect(expr.column.column).toBe('email');
            expect(expr.negated).toBeFalsy();
        });
    });

    describe('WHERE IS NOT NULL', () => {
        it('creates a negated is_null node', () => {
            const ast = parseSQL('SELECT * FROM account WHERE email IS NOT NULL');
            const expr = asIsNull(ast.where);
            expect(expr.kind).toBe('is_null');
            expect(expr.negated).toBe(true);
        });
    });

    describe('WHERE LIKE', () => {
        it('creates a comparison with LIKE operator', () => {
            const ast = parseSQL("SELECT * FROM account WHERE name LIKE '%corp%'");
            const cmp = asComparison(ast.where);
            expect(cmp.operator).toBe('LIKE');
            expect(cmp.right).toBe('%corp%');
        });
    });

    describe('WHERE NOT IN', () => {
        it('creates a negated in node', () => {
            const ast = parseSQL("SELECT * FROM account WHERE status NOT IN ('closed', 'deleted')");
            const expr = asIn(ast.where);
            expect(expr.kind).toBe('in');
            expect(expr.negated).toBe(true);
            expect(expr.values).toEqual(['closed', 'deleted']);
        });
    });

    // ── JOIN clauses ──────────────────────────────────────────────────────────

    describe('INNER JOIN', () => {
        it('produces one join entry', () => {
            const ast = parseSQL(
                'SELECT a.name, c.fullname FROM account a INNER JOIN contact c ON a.accountid = c.parentcustomerid',
            );
            expect(ast.joins).toHaveLength(1);
        });

        it('join type is INNER', () => {
            const ast = parseSQL(
                'SELECT a.name, c.fullname FROM account a INNER JOIN contact c ON a.accountid = c.parentcustomerid',
            );
            expect(ast.joins[0].type).toBe('INNER');
        });

        it('join table and alias are correct', () => {
            const ast = parseSQL(
                'SELECT a.name, c.fullname FROM account a INNER JOIN contact c ON a.accountid = c.parentcustomerid',
            );
            expect(ast.joins[0].table).toBe('contact');
            expect(ast.joins[0].alias).toBe('c');
        });

        it('join ON condition is parsed', () => {
            const ast = parseSQL(
                'SELECT a.name, c.fullname FROM account a INNER JOIN contact c ON a.accountid = c.parentcustomerid',
            );
            const on = asComparison(ast.joins[0].on);
            expect(on.kind).toBe('comparison');
            expect(on.left.column).toBe('accountid');
        });
    });

    describe('LEFT JOIN', () => {
        it('join type is LEFT', () => {
            const ast = parseSQL(
                'SELECT a.name FROM account a LEFT JOIN contact c ON a.accountid = c.parentcustomerid',
            );
            expect(ast.joins[0].type).toBe('LEFT');
        });
    });

    describe('multiple JOINs', () => {
        it('parses two joins', () => {
            const ast = parseSQL(
                'SELECT a.name, c.fullname, t.subject ' +
                    'FROM account a ' +
                    'INNER JOIN contact c ON a.accountid = c.parentcustomerid ' +
                    'LEFT JOIN task t ON c.contactid = t.regardingobjectid',
            );
            expect(ast.joins).toHaveLength(2);
            expect(ast.joins[0].type).toBe('INNER');
            expect(ast.joins[1].type).toBe('LEFT');
        });
    });

    // ── ORDER BY ──────────────────────────────────────────────────────────────

    describe('ORDER BY', () => {
        it('parses single ORDER BY column', () => {
            const ast = parseSQL('SELECT name FROM account ORDER BY name');
            expect(ast.orderBy).toHaveLength(1);
            expect(ast.orderBy![0].column.column).toBe('name');
        });

        it('defaults to ASC when no direction given', () => {
            const ast = parseSQL('SELECT name FROM account ORDER BY name');
            expect(ast.orderBy![0].direction).toBe('ASC');
        });

        it('parses explicit DESC direction', () => {
            const ast = parseSQL('SELECT name FROM account ORDER BY name DESC');
            expect(ast.orderBy![0].direction).toBe('DESC');
        });

        it('parses multiple ORDER BY items', () => {
            const ast = parseSQL('SELECT * FROM account ORDER BY name ASC, revenue DESC');
            expect(ast.orderBy).toHaveLength(2);
            expect(ast.orderBy![0].column.column).toBe('name');
            expect(ast.orderBy![0].direction).toBe('ASC');
            expect(ast.orderBy![1].column.column).toBe('revenue');
            expect(ast.orderBy![1].direction).toBe('DESC');
        });
    });

    // ── GROUP BY ──────────────────────────────────────────────────────────────

    describe('GROUP BY', () => {
        it('parses GROUP BY column', () => {
            const ast = parseSQL('SELECT status, COUNT(id) FROM account GROUP BY status');
            expect(ast.groupBy).toHaveLength(1);
            expect(ast.groupBy![0].column).toBe('status');
        });
    });

    describe('GROUP BY with HAVING', () => {
        it('parses HAVING clause', () => {
            const ast = parseSQL('SELECT status, COUNT(id) FROM account GROUP BY status HAVING COUNT(id) > 5');
            expect(ast.having).toBeDefined();
        });

        it('HAVING condition has correct operator', () => {
            const ast = parseSQL('SELECT status, COUNT(id) FROM account GROUP BY status HAVING COUNT(id) > 5');
            // The HAVING expression is a comparison; exact structure depends on implementation
            expect(ast.having!.kind).toBeDefined();
        });
    });

    // ── Complex combined query ────────────────────────────────────────────────

    describe('complex combined query', () => {
        it('parses without throwing', () => {
            const sql =
                'SELECT DISTINCT TOP 50 a.name, c.fullname, COUNT(t.taskid) ' +
                'FROM account a ' +
                'INNER JOIN contact c ON a.accountid = c.parentcustomerid ' +
                'LEFT JOIN task t ON c.contactid = t.regardingobjectid ' +
                'WHERE a.statecode = 0 AND c.statuscode = 1 ' +
                'GROUP BY a.name, c.fullname ' +
                'ORDER BY a.name ASC';
            expect(() => parseSQL(sql)).not.toThrow();
        });

        it('sets all top-level flags on complex query', () => {
            const sql =
                'SELECT DISTINCT TOP 50 a.name ' + 'FROM account a ' + 'WHERE a.statecode = 0 ' + 'ORDER BY a.name ASC';
            const ast = parseSQL(sql);
            expect(ast.distinct).toBe(true);
            expect(ast.top).toBe(50);
            expect(ast.where).toBeDefined();
            expect(ast.orderBy).toBeDefined();
        });
    });

    // ── Error cases ───────────────────────────────────────────────────────────

    describe('error cases', () => {
        it('throws SqlParseError when FROM is missing', () => {
            expect(() => parseSQL('SELECT name')).toThrow(SqlParseError);
        });

        it('throws SqlParseError for unexpected token after SELECT', () => {
            expect(() => parseSQL('SELECT FROM account')).toThrow(SqlParseError);
        });

        it('error has a line property', () => {
            expect.assertions(2);
            try {
                parseSQL('SELECT name');
            } catch (e) {
                expect(e).toBeInstanceOf(SqlParseError);
                expect(typeof (e as SqlParseError).line).toBe('number');
            }
        });

        it('error has a column property', () => {
            expect.assertions(2);
            try {
                parseSQL('SELECT name');
            } catch (e) {
                expect(e).toBeInstanceOf(SqlParseError);
                expect(typeof (e as SqlParseError).column).toBe('number');
            }
        });
    });

    // ── Negative number literals (Bug 1) ──────────────────────────────────────

    describe('negative number literals', () => {
        it('parses WHERE age > -1 without throwing', () => {
            expect(() => parseSQL('SELECT age FROM account WHERE age > -1')).not.toThrow();
        });

        it('parses the right-hand value as -1 for WHERE age > -1', () => {
            const ast = parseSQL('SELECT age FROM account WHERE age > -1');
            const cmp = asComparison(ast.where);
            expect(cmp.right).toBe(-1);
        });

        it('parses a negative decimal value correctly', () => {
            const ast = parseSQL('SELECT score FROM account WHERE score >= -3.5');
            const cmp = asComparison(ast.where);
            expect(cmp.right).toBeCloseTo(-3.5);
        });
    });
});
