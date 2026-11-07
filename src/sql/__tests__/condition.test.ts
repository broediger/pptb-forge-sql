import { describe, it, expect } from 'vitest';
import { evaluateCondition, columnText } from '../condition';
import type { WhereExpr } from '../types';

describe('evaluateCondition', () => {
    const subquery = {
        kind: 'in_subquery',
        column: { column: 'ownerid' },
        subquery: {},
    } as unknown as WhereExpr;

    it('names the clause when a subquery reaches client-side evaluation', () => {
        expect(() => evaluateCondition(subquery, () => null, 'HAVING')).toThrow(/not supported in HAVING/);
        expect(() => evaluateCondition(subquery, () => null)).toThrow(/not supported in client-side conditions/);
    });

    it('passes the clause into nested conditions', () => {
        const nested: WhereExpr = { kind: 'not', expr: subquery };
        expect(() => evaluateCondition(nested, () => null, 'WHERE')).toThrow(/not supported in WHERE/);
    });
});

describe('columnText', () => {
    it('writes a column as table.column or column', () => {
        expect(columnText({ table: 'a', column: 'name' })).toBe('a.name');
        expect(columnText({ column: 'name' })).toBe('name');
    });
});

describe('evaluateCondition semantics', () => {
    const value = (row: Record<string, unknown>) => (o: { column: unknown }) =>
        row[(o as { column: string }).column] ?? null;
    const cmp = (column: string, operator: string, right: unknown): WhereExpr =>
        ({ kind: 'comparison', left: { column }, operator, right }) as unknown as WhereExpr;

    it('compares two-option booleans with 1/0 the way SQL does', () => {
        const yes = value({ donotemail: true });
        const no = value({ donotemail: false });
        expect(evaluateCondition(cmp('donotemail', '=', 1), yes)).toBe(true);
        expect(evaluateCondition(cmp('donotemail', '=', 1), no)).toBe(false);
        expect(evaluateCondition(cmp('donotemail', '=', 0), no)).toBe(true);
        expect(evaluateCondition(cmp('donotemail', '=', '1'), yes)).toBe(true);
        expect(evaluateCondition(cmp('donotemail', '=', 'TRUE'), yes)).toBe(true);
    });

    it('supports T-SQL LIKE character classes', () => {
        const like = (pattern: string, text: string) =>
            evaluateCondition(cmp('label', 'LIKE', pattern), value({ label: text }));
        expect(like('[AI]%', 'Active')).toBe(true);
        expect(like('[AI]%', 'Inactive')).toBe(true);
        expect(like('[AI]%', 'Draft')).toBe(false);
        expect(like('[^A]%', 'Active')).toBe(false);
        expect(like('[^A]%', 'Draft')).toBe(true);
        expect(like('[a-c]x', 'bx')).toBe(true);
        expect(like('[a-c]x', 'dx')).toBe(false);
        expect(like('50[%]', '50%')).toBe(true);
        expect(like('50[%]', '501')).toBe(false);
        expect(like('a[b', 'a[b')).toBe(true);
        expect(like('[.]x', 'ax')).toBe(false);
    });
});
