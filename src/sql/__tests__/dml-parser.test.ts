import { describe, it, expect } from 'vitest';
import { tokenize } from '../lexer';
import { parseStatement } from '../parser';
import {
    InsertStatement,
    UpdateStatement,
    DeleteStatement,
    SqlParseError,
    ComparisonExpr,
    LogicalExpr,
    BetweenExpr,
    InExpr,
    IsNullExpr,
    NotExpr,
} from '../types';

const parseDML = (sql: string) => parseStatement(tokenize(sql));

// Helper casts for WHERE expression kinds
const asComparison = (e: unknown) => e as ComparisonExpr;
const asLogical = (e: unknown) => e as LogicalExpr;
const asBetween = (e: unknown) => e as BetweenExpr;
const asIn = (e: unknown) => e as InExpr;
const asIsNull = (e: unknown) => e as IsNullExpr;
const asNot = (e: unknown) => e as NotExpr;

// ── INSERT ────────────────────────────────────────────────────────────────────

describe('INSERT parsing', () => {
    describe('basic INSERT', () => {
        it('parses statement type as insert', () => {
            const ast = parseDML("INSERT INTO account (name, revenue) VALUES ('Contoso', 1000)") as InsertStatement;
            expect(ast.type).toBe('insert');
        });

        it('parses table name', () => {
            const ast = parseDML("INSERT INTO account (name, revenue) VALUES ('Contoso', 1000)") as InsertStatement;
            expect(ast.table).toBe('account');
        });

        it('parses column list', () => {
            const ast = parseDML("INSERT INTO account (name, revenue) VALUES ('Contoso', 1000)") as InsertStatement;
            expect(ast.columns).toEqual(['name', 'revenue']);
        });

        it('parses values row', () => {
            const ast = parseDML("INSERT INTO account (name, revenue) VALUES ('Contoso', 1000)") as InsertStatement;
            expect(ast.values).toHaveLength(1);
            expect(ast.values[0]).toEqual(['Contoso', 1000]);
        });
    });

    describe('multi-row INSERT', () => {
        it('parses two rows', () => {
            const ast = parseDML(
                "INSERT INTO contact (firstname, lastname) VALUES ('John', 'Doe'), ('Jane', 'Smith')",
            ) as InsertStatement;
            expect(ast.values).toHaveLength(2);
        });

        it('first row values are correct', () => {
            const ast = parseDML(
                "INSERT INTO contact (firstname, lastname) VALUES ('John', 'Doe'), ('Jane', 'Smith')",
            ) as InsertStatement;
            expect(ast.values[0]).toEqual(['John', 'Doe']);
        });

        it('second row values are correct', () => {
            const ast = parseDML(
                "INSERT INTO contact (firstname, lastname) VALUES ('John', 'Doe'), ('Jane', 'Smith')",
            ) as InsertStatement;
            expect(ast.values[1]).toEqual(['Jane', 'Smith']);
        });
    });

    describe('single column INSERT', () => {
        it('parses one column and one value', () => {
            const ast = parseDML("INSERT INTO account (name) VALUES ('Test')") as InsertStatement;
            expect(ast.columns).toEqual(['name']);
            expect(ast.values[0]).toEqual(['Test']);
        });
    });

    describe('NULL value', () => {
        it('parses NULL as null literal', () => {
            const ast = parseDML("INSERT INTO account (name, email) VALUES ('Test', NULL)") as InsertStatement;
            expect(ast.values[0][1]).toBeNull();
        });
    });

    describe('boolean values', () => {
        it('parses TRUE as boolean true', () => {
            const ast = parseDML("INSERT INTO account (name, active) VALUES ('Test', TRUE)") as InsertStatement;
            expect(ast.values[0][1]).toBe(true);
        });

        it('parses FALSE as boolean false', () => {
            const ast = parseDML("INSERT INTO account (name, active) VALUES ('Test', FALSE)") as InsertStatement;
            expect(ast.values[0][1]).toBe(false);
        });
    });

    describe('numeric values', () => {
        it('parses integer values', () => {
            const ast = parseDML("INSERT INTO account (name, count) VALUES ('Test', 42)") as InsertStatement;
            expect(ast.values[0][1]).toBe(42);
        });

        it('parses decimal values', () => {
            const ast = parseDML("INSERT INTO account (name, score) VALUES ('Test', 3.14)") as InsertStatement;
            expect(ast.values[0][1]).toBeCloseTo(3.14);
        });

        it('parses negative numbers', () => {
            const ast = parseDML("INSERT INTO account (name, balance) VALUES ('Test', -99)") as InsertStatement;
            expect(ast.values[0][1]).toBe(-99);
        });

        it('parses negative decimals', () => {
            const ast = parseDML("INSERT INTO account (name, temp) VALUES ('Test', -1.5)") as InsertStatement;
            expect(ast.values[0][1]).toBeCloseTo(-1.5);
        });
    });

    describe('INSERT error cases', () => {
        it('throws SqlParseError on column/value count mismatch', () => {
            expect(() => parseDML("INSERT INTO account (name) VALUES ('a', 'b')")).toThrow(SqlParseError);
        });

        it('throws SqlParseError when VALUES keyword is missing', () => {
            expect(() => parseDML("INSERT INTO account (name) ('Test')")).toThrow(SqlParseError);
        });

        it('throws SqlParseError when INTO keyword is missing', () => {
            expect(() => parseDML("INSERT account (name) VALUES ('Test')")).toThrow(SqlParseError);
        });

        it('throws SqlParseError on empty column list', () => {
            expect(() => parseDML('INSERT INTO account () VALUES ()')).toThrow(SqlParseError);
        });
    });

    describe('case insensitive keywords', () => {
        it('parses lowercase insert into ... values', () => {
            const ast = parseDML("insert into account (name) values ('Test')") as InsertStatement;
            expect(ast.type).toBe('insert');
            expect(ast.table).toBe('account');
            expect(ast.values[0][0]).toBe('Test');
        });
    });
});

// ── UPDATE ────────────────────────────────────────────────────────────────────

describe('UPDATE parsing', () => {
    describe('basic UPDATE', () => {
        it('parses statement type as update', () => {
            const ast = parseDML("UPDATE account SET name = 'NewName' WHERE accountid = 'xxx'") as UpdateStatement;
            expect(ast.type).toBe('update');
        });

        it('parses table name', () => {
            const ast = parseDML("UPDATE account SET name = 'NewName' WHERE accountid = 'xxx'") as UpdateStatement;
            expect(ast.table).toBe('account');
        });

        it('parses single SET clause column', () => {
            const ast = parseDML("UPDATE account SET name = 'NewName' WHERE accountid = 'xxx'") as UpdateStatement;
            expect(ast.set).toHaveLength(1);
            expect(ast.set[0].column).toBe('name');
        });

        it('parses single SET clause value', () => {
            const ast = parseDML("UPDATE account SET name = 'NewName' WHERE accountid = 'xxx'") as UpdateStatement;
            expect(ast.set[0].value).toBe('NewName');
        });

        it('parses WHERE clause as a comparison', () => {
            const ast = parseDML("UPDATE account SET name = 'NewName' WHERE accountid = 'xxx'") as UpdateStatement;
            const cmp = asComparison(ast.where);
            expect(cmp.kind).toBe('comparison');
            expect(cmp.left.column).toBe('accountid');
            expect(cmp.operator).toBe('=');
            expect(cmp.right).toBe('xxx');
        });
    });

    describe('multiple SET clauses', () => {
        it('parses two SET entries', () => {
            const ast = parseDML(
                "UPDATE account SET name = 'New', revenue = 5000 WHERE status = 'active'",
            ) as UpdateStatement;
            expect(ast.set).toHaveLength(2);
        });

        it('first SET entry is correct', () => {
            const ast = parseDML(
                "UPDATE account SET name = 'New', revenue = 5000 WHERE status = 'active'",
            ) as UpdateStatement;
            expect(ast.set[0].column).toBe('name');
            expect(ast.set[0].value).toBe('New');
        });

        it('second SET entry is correct', () => {
            const ast = parseDML(
                "UPDATE account SET name = 'New', revenue = 5000 WHERE status = 'active'",
            ) as UpdateStatement;
            expect(ast.set[1].column).toBe('revenue');
            expect(ast.set[1].value).toBe(5000);
        });
    });

    describe('SET with NULL', () => {
        it('parses SET column = NULL as null literal', () => {
            const ast = parseDML("UPDATE contact SET email = NULL WHERE contactid = 'xxx'") as UpdateStatement;
            expect(ast.set[0].value).toBeNull();
        });
    });

    describe('SET with number', () => {
        it('parses SET column = 0 as number', () => {
            const ast = parseDML("UPDATE account SET revenue = 0 WHERE accountid = 'xxx'") as UpdateStatement;
            expect(ast.set[0].value).toBe(0);
        });
    });

    describe('SET with boolean', () => {
        it('parses SET column = FALSE as boolean false', () => {
            const ast = parseDML("UPDATE account SET active = FALSE WHERE accountid = 'xxx'") as UpdateStatement;
            expect(ast.set[0].value).toBe(false);
        });

        it('parses SET column = TRUE as boolean true', () => {
            const ast = parseDML("UPDATE account SET active = TRUE WHERE accountid = 'xxx'") as UpdateStatement;
            expect(ast.set[0].value).toBe(true);
        });
    });

    describe('SET with negative number', () => {
        it('parses SET column = -10 as -10', () => {
            const ast = parseDML("UPDATE account SET score = -10 WHERE accountid = 'xxx'") as UpdateStatement;
            expect(ast.set[0].value).toBe(-10);
        });
    });

    describe('complex WHERE in UPDATE', () => {
        it('parses WHERE with AND and IS NOT NULL', () => {
            const ast = parseDML(
                "UPDATE account SET status = 'closed' WHERE revenue < 100 AND createdon IS NOT NULL",
            ) as UpdateStatement;
            const logical = asLogical(ast.where);
            expect(logical.kind).toBe('and');
            const left = asComparison(logical.left);
            expect(left.left.column).toBe('revenue');
            expect(left.operator).toBe('<');
            expect(left.right).toBe(100);
            const right = asIsNull(logical.right);
            expect(right.kind).toBe('is_null');
            expect(right.column.column).toBe('createdon');
            expect(right.negated).toBe(true);
        });
    });

    describe('WHERE with IN in UPDATE', () => {
        it('parses WHERE column IN list', () => {
            const ast = parseDML(
                "UPDATE account SET status = 'review' WHERE category IN ('A', 'B')",
            ) as UpdateStatement;
            const expr = asIn(ast.where);
            expect(expr.kind).toBe('in');
            expect(expr.column.column).toBe('category');
            expect(expr.values).toEqual(['A', 'B']);
        });
    });

    describe('UPDATE error cases', () => {
        it('throws SqlParseError when WHERE is missing', () => {
            expect(() => parseDML("UPDATE account SET name = 'x'")).toThrow(SqlParseError);
        });

        it('error message contains WHERE when WHERE is missing', () => {
            expect.assertions(2);
            try {
                parseDML("UPDATE account SET name = 'x'");
            } catch (e) {
                expect(e).toBeInstanceOf(SqlParseError);
                expect((e as SqlParseError).message).toMatch(/WHERE/i);
            }
        });

        it('throws SqlParseError when SET keyword is missing', () => {
            expect(() => parseDML("UPDATE account name = 'x' WHERE id = '1'")).toThrow(SqlParseError);
        });
    });

    describe('case insensitive keywords', () => {
        it('parses lowercase update ... set ... where', () => {
            const ast = parseDML("update account set name = 'x' where id = '1'") as UpdateStatement;
            expect(ast.type).toBe('update');
            expect(ast.table).toBe('account');
            expect(ast.set[0].column).toBe('name');
            expect(ast.set[0].value).toBe('x');
        });
    });
});

// ── DELETE ────────────────────────────────────────────────────────────────────

describe('DELETE parsing', () => {
    describe('basic DELETE', () => {
        it('parses statement type as delete', () => {
            const ast = parseDML("DELETE FROM account WHERE accountid = 'xxx'") as DeleteStatement;
            expect(ast.type).toBe('delete');
        });

        it('parses table name', () => {
            const ast = parseDML("DELETE FROM account WHERE accountid = 'xxx'") as DeleteStatement;
            expect(ast.table).toBe('account');
        });

        it('parses WHERE clause as a comparison', () => {
            const ast = parseDML("DELETE FROM account WHERE accountid = 'xxx'") as DeleteStatement;
            const cmp = asComparison(ast.where);
            expect(cmp.kind).toBe('comparison');
            expect(cmp.left.column).toBe('accountid');
            expect(cmp.operator).toBe('=');
            expect(cmp.right).toBe('xxx');
        });
    });

    describe('complex WHERE in DELETE', () => {
        it('parses WHERE with AND and IS NULL', () => {
            const ast = parseDML("DELETE FROM contact WHERE status = 'inactive' AND email IS NULL") as DeleteStatement;
            const logical = asLogical(ast.where);
            expect(logical.kind).toBe('and');
            const left = asComparison(logical.left);
            expect(left.left.column).toBe('status');
            expect(left.right).toBe('inactive');
            const right = asIsNull(logical.right);
            expect(right.kind).toBe('is_null');
            expect(right.column.column).toBe('email');
            expect(right.negated).toBeFalsy();
        });
    });

    describe('WHERE with OR in DELETE', () => {
        it('parses OR condition', () => {
            const ast = parseDML("DELETE FROM account WHERE status = 'closed' OR revenue = 0") as DeleteStatement;
            const logical = asLogical(ast.where);
            expect(logical.kind).toBe('or');
            expect(asComparison(logical.left).left.column).toBe('status');
            expect(asComparison(logical.right).left.column).toBe('revenue');
        });
    });

    describe('WHERE with IN in DELETE', () => {
        it('parses IN clause with multiple values', () => {
            const ast = parseDML("DELETE FROM account WHERE status IN ('deleted', 'archived')") as DeleteStatement;
            const expr = asIn(ast.where);
            expect(expr.kind).toBe('in');
            expect(expr.column.column).toBe('status');
            expect(expr.values).toEqual(['deleted', 'archived']);
        });
    });

    describe('WHERE with LIKE in DELETE', () => {
        it('parses LIKE pattern comparison', () => {
            const ast = parseDML("DELETE FROM account WHERE name LIKE '%test%'") as DeleteStatement;
            const cmp = asComparison(ast.where);
            expect(cmp.kind).toBe('comparison');
            expect(cmp.operator).toBe('LIKE');
            expect(cmp.left.column).toBe('name');
            expect(cmp.right).toBe('%test%');
        });
    });

    describe('WHERE with NOT in DELETE', () => {
        it('parses NOT expression', () => {
            const ast = parseDML('DELETE FROM account WHERE NOT active = TRUE') as DeleteStatement;
            const not = asNot(ast.where);
            expect(not.kind).toBe('not');
            const inner = asComparison(not.expr);
            expect(inner.left.column).toBe('active');
            expect(inner.right).toBe(true);
        });
    });

    describe('WHERE with BETWEEN in DELETE', () => {
        it('parses BETWEEN range', () => {
            const ast = parseDML(
                "DELETE FROM account WHERE createdon BETWEEN '2020-01-01' AND '2020-12-31'",
            ) as DeleteStatement;
            const expr = asBetween(ast.where);
            expect(expr.kind).toBe('between');
            expect(expr.column.column).toBe('createdon');
            expect(expr.low).toBe('2020-01-01');
            expect(expr.high).toBe('2020-12-31');
        });
    });

    describe('DELETE error cases', () => {
        it('throws SqlParseError when WHERE is missing', () => {
            expect(() => parseDML('DELETE FROM account')).toThrow(SqlParseError);
        });

        it('error message contains WHERE when WHERE is missing', () => {
            expect.assertions(2);
            try {
                parseDML('DELETE FROM account');
            } catch (e) {
                expect(e).toBeInstanceOf(SqlParseError);
                expect((e as SqlParseError).message).toMatch(/WHERE/i);
            }
        });

        it('throws SqlParseError when FROM keyword is missing', () => {
            expect(() => parseDML("DELETE account WHERE accountid = 'xxx'")).toThrow(SqlParseError);
        });
    });

    describe('case insensitive keywords', () => {
        it('parses lowercase delete from ... where', () => {
            const ast = parseDML("delete from account where id = '1'") as DeleteStatement;
            expect(ast.type).toBe('delete');
            expect(ast.table).toBe('account');
        });
    });
});

// ── Backwards compatibility ───────────────────────────────────────────────────

describe('parseStatement with SELECT', () => {
    it('parses SELECT and returns type select', () => {
        const ast = parseDML('SELECT name FROM account');
        expect(ast.type).toBe('select');
    });

    it('parses FROM table correctly', () => {
        const ast = parseDML('SELECT name FROM account') as { type: string; from: { table: string } };
        expect(ast.from.table).toBe('account');
    });
});

// ── Statement type routing errors ─────────────────────────────────────────────

describe('statement type routing', () => {
    it('throws SqlParseError for unknown leading keyword', () => {
        // DROP is not a keyword — it tokenizes as an IDENTIFIER, not a recognised statement start
        expect(() => parseDML('DROP TABLE account')).toThrow(SqlParseError);
    });

    it('error message mentions the expected statement types', () => {
        expect.assertions(2);
        try {
            parseDML('DROP TABLE account');
        } catch (e) {
            expect(e).toBeInstanceOf(SqlParseError);
            expect((e as SqlParseError).message).toMatch(/SELECT|INSERT|UPDATE|DELETE/);
        }
    });
});
