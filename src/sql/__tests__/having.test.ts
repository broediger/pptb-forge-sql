import { describe, it, expect } from 'vitest';
import { tokenize } from '../lexer';
import { parse } from '../parser';
import { generateFetchXml } from '../generator';
import { planHaving, applyHaving, withPage, describeHaving } from '../having';
import type { HavingPlan } from '../having';

const plan = (sql: string): HavingPlan => {
    const result = planHaving(parse(tokenize(sql)));
    if (!result) throw new Error('expected a HAVING plan');
    return result;
};

describe('planHaving', () => {
    it('returns null without HAVING', () => {
        expect(planHaving(parse(tokenize('SELECT name, COUNT(*) FROM account GROUP BY name')))).toBeNull();
    });

    it('removes HAVING and TOP from the statement sent to Dataverse', () => {
        const p = plan('SELECT TOP 5 name, COUNT(*) AS cnt FROM account GROUP BY name HAVING COUNT(*) > 1');
        expect(p.stmt.having).toBeUndefined();
        expect(p.stmt.top).toBeUndefined();
        expect(p.top).toBe(5);
        expect(p.hiddenKeys).toEqual([]);
        expect(generateFetchXml(p.stmt)).not.toContain('top=');
    });

    it('reads an aggregate that is in the SELECT list under its alias', () => {
        const p = plan('SELECT name, COUNT(*) AS cnt FROM account GROUP BY name HAVING COUNT(*) > 1');
        expect([...p.keys.values()]).toEqual(['cnt']);
    });

    it('reads an unaliased aggregate under its auto alias', () => {
        const p = plan('SELECT name, COUNT(*) FROM account GROUP BY name HAVING COUNT(*) > 1');
        expect([...p.keys.values()]).toEqual(['count_all']);
    });

    it('adds a hidden aggregate when HAVING uses one the SELECT list lacks', () => {
        const p = plan('SELECT name FROM account GROUP BY name HAVING COUNT(*) > 1');
        expect(p.hiddenKeys).toEqual(['having_1']);
        expect(p.stmt.columns).toHaveLength(2);
        expect(generateFetchXml(p.stmt)).toContain('aggregate="count" alias="having_1"');
    });

    it('treats COUNT(DISTINCT x) and COUNT(x) as different aggregates', () => {
        const p = plan('SELECT name, COUNT(x) AS c FROM account GROUP BY name HAVING COUNT(DISTINCT x) > 1');
        expect(p.hiddenKeys).toEqual(['having_1']);
    });

    it('adds a hidden grouping column referenced only in HAVING', () => {
        const p = plan("SELECT COUNT(*) AS cnt FROM account GROUP BY name HAVING name LIKE 'A%'");
        expect(p.hiddenKeys).toEqual(['having_1']);
        expect(generateFetchXml(p.stmt)).toContain('name="name" groupby="true" alias="having_1"');
    });

    it('rejects a column that is neither grouped nor aggregated', () => {
        expect(() => plan("SELECT name, COUNT(*) FROM account GROUP BY name HAVING city = 'x'")).toThrow(
            /must appear in GROUP BY/,
        );
    });

    it('rejects HAVING without GROUP BY or aggregates', () => {
        expect(() => plan("SELECT name FROM account HAVING name = 'x'")).toThrow(/requires GROUP BY/);
    });

    it('rejects subqueries in HAVING', () => {
        expect(() => plan('SELECT a FROM t GROUP BY a HAVING a IN (SELECT id FROM u)')).toThrow(
            /not supported in HAVING/,
        );
    });
});

describe('applyHaving', () => {
    const groups = [
        { name: 'A', cnt: 3, cnt_formatted: '3' },
        { name: 'B', cnt: 1, cnt_formatted: '1' },
        { name: 'C', cnt: 2, cnt_formatted: '2' },
        { cnt: 5, cnt_formatted: '5' }, // null name: Dataverse omits the key
    ];

    it('keeps groups matching an aggregate comparison', () => {
        const p = plan('SELECT name, COUNT(*) AS cnt FROM t GROUP BY name HAVING COUNT(*) > 1');
        expect(applyHaving(groups, p).map((r) => r.cnt)).toEqual([3, 2, 5]);
    });

    it('applies TOP after filtering', () => {
        const p = plan('SELECT TOP 2 name, COUNT(*) AS cnt FROM t GROUP BY name HAVING COUNT(*) > 1');
        expect(applyHaving(groups, p).map((r) => r.cnt)).toEqual([3, 2]);
    });

    it('handles AND / OR / NOT, BETWEEN and IN', () => {
        const p1 = plan("SELECT name, COUNT(*) AS cnt FROM t GROUP BY name HAVING COUNT(*) >= 2 AND NOT name = 'A'");
        expect(applyHaving(groups, p1).map((r) => r.name)).toEqual(['C']);
        const p2 = plan(
            "SELECT name, COUNT(*) AS cnt FROM t GROUP BY name HAVING name BETWEEN 'B' AND 'C' OR name IN ('a')",
        );
        expect(applyHaving(groups, p2).map((r) => r.name)).toEqual(['A', 'B', 'C']);
    });

    it('treats comparisons with a null group value as unknown, even under NOT', () => {
        const p = plan("SELECT name, COUNT(*) AS cnt FROM t GROUP BY name HAVING NOT name = 'A'");
        expect(applyHaving(groups, p).map((r) => r.name)).toEqual(['B', 'C']);
    });

    it('supports IS NULL on a grouping column', () => {
        const p = plan('SELECT name, COUNT(*) AS cnt FROM t GROUP BY name HAVING name IS NULL');
        expect(applyHaving(groups, p).map((r) => r.cnt)).toEqual([5]);
    });

    it('matches LIKE case-insensitively', () => {
        const rows = [
            { name: 'Alpha', cnt: 1 },
            { name: 'beta', cnt: 1 },
        ];
        const p = plan("SELECT name, COUNT(*) AS cnt FROM t GROUP BY name HAVING name LIKE 'a%'");
        expect(applyHaving(rows, p).map((r) => r.name)).toEqual(['Alpha']);
    });

    it('drops hidden columns and their formatted values', () => {
        const rows = [
            { name: 'A', having_1: 3, having_1_formatted: '3' },
            { name: 'B', having_1: 1 },
        ];
        const p = plan('SELECT name FROM t GROUP BY name HAVING COUNT(*) > 1');
        expect(applyHaving(rows, p)).toEqual([{ name: 'A' }]);
    });

    it('compares numeric strings numerically against numbers', () => {
        const rows = [
            { status: '10', cnt: 1 },
            { status: '9', cnt: 1 },
        ];
        const p = plan('SELECT status, COUNT(*) AS cnt FROM t GROUP BY status HAVING status > 9');
        expect(applyHaving(rows, p).map((r) => r.status)).toEqual(['10']);
    });
});

describe('withPage', () => {
    it('adds page and count to the fetch element', () => {
        expect(withPage('<fetch aggregate="true">\n  <entity name="t" />\n</fetch>', 3)).toContain(
            '<fetch aggregate="true" page="3" count="5000">',
        );
    });
});

describe('describeHaving', () => {
    it('renders the condition as SQL', () => {
        const p = plan("SELECT name FROM t GROUP BY name HAVING COUNT(*) > 1 AND name != 'x'");
        expect(describeHaving(p.having)).toBe("(COUNT(*) > 1 AND name != 'x')");
    });
});
