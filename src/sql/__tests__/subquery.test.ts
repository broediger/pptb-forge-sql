import { describe, it, expect } from 'vitest';
import { tokenize } from '../lexer';
import { parse, parseStatement } from '../parser';
import { generateFetchXml } from '../generator';
import { cleanRows } from '../columnResolution';
import type { InSubqueryExpr, LiteralValue, SelectStatement } from '../types';
import {
    collectSubqueries,
    validateSubquery,
    subqueryScanStatement,
    extractSubqueryValues,
    substituteSubqueries,
    planQueries,
    sortRows,
} from '../subquery';

const parseSelect = (sql: string): SelectStatement => parse(tokenize(sql));
const strip = (xml: string) => xml.replace(/\s+/g, ' ').trim();

const USER_QUERY = `select logs.orb_jsonxmlcontent
from orb_automatelogs logs
where orb_automatename = 'ImportLead'
and orb_primaryregardingguid IN
(SELECT leadid from lead
where evn_flussrichtungcode = 790530001
)`;

const guids = (n: number) =>
    Array.from({ length: n }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);

function resolveWith(stmt: SelectStatement, lists: LiteralValue[][]): Map<InSubqueryExpr, LiteralValue[]> {
    const subs = collectSubqueries(stmt.where);
    return new Map(subs.map((s, i) => [s, lists[i]]));
}

describe('IN (SELECT ...) parsing', () => {
    it('parses the subquery as a nested SELECT', () => {
        const stmt = parseSelect(USER_QUERY);
        const subs = collectSubqueries(stmt.where);
        expect(subs).toHaveLength(1);
        expect(subs[0].column).toEqual({ column: 'orb_primaryregardingguid' });
        expect(subs[0].negated).toBeUndefined();
        expect(subs[0].subquery.from).toEqual({ table: 'lead' });
        expect(subs[0].subquery.columns).toEqual([{ column: 'leadid' }]);
        expect(subs[0].subquery.where).toEqual({
            kind: 'comparison',
            left: { column: 'evn_flussrichtungcode' },
            operator: '=',
            right: 790530001,
        });
    });

    it('parses NOT IN, parentheses inside the subquery and nested subqueries', () => {
        const stmt = parseSelect(
            'SELECT name FROM account WHERE accountid NOT IN (SELECT parentcustomerid FROM contact WHERE (statecode = 0 OR statecode = 1) AND ownerid IN (SELECT systemuserid FROM systemuser WHERE isdisabled = 0))',
        );
        const [outer] = collectSubqueries(stmt.where);
        expect(outer.negated).toBe(true);
        const [inner] = collectSubqueries(outer.subquery.where);
        expect(inner.subquery.from.table).toBe('systemuser');
    });

    it('still parses a literal IN list', () => {
        const stmt = parseSelect("SELECT name FROM account WHERE name IN ('a', 'b')");
        expect(stmt.where).toEqual({ kind: 'in', column: { column: 'name' }, values: ['a', 'b'] });
    });

    it('reports an unterminated subquery', () => {
        expect(() => parseSelect('SELECT name FROM account WHERE x IN (SELECT id FROM t')).toThrow(
            /Unterminated subquery/,
        );
    });

    it('rejects a subquery that does not select exactly one column', () => {
        const [twoCols] = collectSubqueries(parseSelect('SELECT a FROM t WHERE x IN (SELECT a, b FROM u)').where);
        expect(() => validateSubquery(twoCols.subquery)).toThrow(/exactly one column/);
        const [star] = collectSubqueries(parseSelect('SELECT a FROM t WHERE x IN (SELECT * FROM u)').where);
        expect(() => validateSubquery(star.subquery)).toThrow(/not \*/);
        const [json] = collectSubqueries(
            parseSelect("SELECT a FROM t WHERE x IN (SELECT JSON_VALUE(d, '$.id') FROM u)").where,
        );
        expect(() => validateSubquery(json.subquery)).toThrow(/JSON_VALUE is not supported/);
    });

    it('combines with JSON_VALUE in the outer SELECT (the original use case)', () => {
        const stmt =
            parseSelect(`select JSON_VALUE(logs.orb_jsonxmlcontent, '$.Lead.meteringPoints[0].greenPowerData.vatTreatment') as vatTreatment
from orb_automatelogs logs
where orb_automatename = 'ImportLead'
and orb_primaryregardingguid IN
(SELECT leadid from lead
where evn_flussrichtungcode = 790530001
)`);
        const [plan] = planQueries(stmt, resolveWith(stmt, [['g1']]));
        const xml = strip(generateFetchXml(plan));
        expect(xml).toContain('<attribute name="orb_jsonxmlcontent" />');
        expect(xml).toContain(
            '<condition attribute="orb_primaryregardingguid" operator="in"> <value>g1</value> </condition>',
        );
    });
});

describe('subquery scan and value extraction', () => {
    it('scans ordered by primary key without DISTINCT', () => {
        const [sub] = collectSubqueries(
            parseSelect('SELECT a FROM t WHERE x IN (SELECT DISTINCT parentcustomerid FROM contact)').where,
        );
        const scan = subqueryScanStatement(sub.subquery);
        expect(scan.distinct).toBe(false);
        expect(scan.orderBy).toEqual([{ column: { column: 'contactid' }, direction: 'ASC' }]);
    });

    it('leaves aggregate and TOP subqueries unchanged', () => {
        const [agg] = collectSubqueries(parseSelect('SELECT a FROM t WHERE x IN (SELECT MAX(n) FROM u)').where);
        expect(subqueryScanStatement(agg.subquery)).toBe(agg.subquery);
        const [top] = collectSubqueries(parseSelect('SELECT a FROM t WHERE x IN (SELECT TOP 5 id FROM u)').where);
        expect(subqueryScanStatement(top.subquery)).toBe(top.subquery);
    });

    it('extracts distinct non-null values, including lookup GUIDs', () => {
        const [sub] = collectSubqueries(
            parseSelect('SELECT a FROM t WHERE x IN (SELECT parentcustomerid FROM contact)').where,
        );
        const rows = cleanRows([
            { contactid: '1', _parentcustomerid_value: 'g1' },
            { contactid: '2', _parentcustomerid_value: 'g2' },
            { contactid: '3', _parentcustomerid_value: 'g1' },
            { contactid: '4' }, // null lookup omitted by Dataverse
        ]);
        expect(extractSubqueryValues(rows, sub.subquery)).toEqual(['g1', 'g2']);
    });
});

describe('substituting subquery values', () => {
    it('inlines values as a literal IN list and generates FetchXML', () => {
        const stmt = parseSelect(USER_QUERY);
        const [plan] = planQueries(stmt, resolveWith(stmt, [['g1', 'g2']]));
        const xml = strip(generateFetchXml(plan));
        expect(xml).toContain(
            '<condition attribute="orb_primaryregardingguid" operator="in"> <value>g1</value> <value>g2</value> </condition>',
        );
        expect(xml).toContain('<condition attribute="orb_automatename" operator="eq" value="ImportLead" />');
    });

    it('turns an empty IN into an always-false and an empty NOT IN into an always-true condition', () => {
        const inStmt = parseSelect('SELECT a FROM t WHERE x IN (SELECT id FROM u)');
        const notInStmt = parseSelect('SELECT a FROM t WHERE x NOT IN (SELECT id FROM u)');
        const emptyIn = substituteSubqueries(inStmt.where!, resolveWith(inStmt, [[]]));
        const emptyNotIn = substituteSubqueries(notInStmt.where!, resolveWith(notInStmt, [[]]));
        expect(emptyIn).toEqual({
            kind: 'and',
            left: { kind: 'is_null', column: { column: 'x' } },
            right: { kind: 'is_null', column: { column: 'x' }, negated: true },
        });
        expect(emptyNotIn.kind).toBe('or');
    });

    it('keeps NOT IN negated', () => {
        const stmt = parseSelect('SELECT a FROM t WHERE x NOT IN (SELECT id FROM u)');
        const [plan] = planQueries(stmt, resolveWith(stmt, [['g1']]));
        expect(strip(generateFetchXml(plan))).toContain('operator="not-in"');
    });

    it('gives a clear error for a subquery the runner does not resolve', () => {
        const update = parseStatement(tokenize('SELECT a FROM t GROUP BY a HAVING a IN (SELECT id FROM u)'));
        expect(() => generateFetchXml(update as SelectStatement)).toThrow(/only supported in the WHERE clause/);
    });
});

describe('planQueries splitting', () => {
    it('returns a single query when every list fits', () => {
        const stmt = parseSelect(USER_QUERY);
        expect(planQueries(stmt, resolveWith(stmt, [guids(250)]), 250)).toHaveLength(1);
    });

    it('splits a long IN list into chunks, keeping the rest of the WHERE', () => {
        const stmt = parseSelect(USER_QUERY);
        const plans = planQueries(stmt, resolveWith(stmt, [guids(600)]), 250);
        expect(plans).toHaveLength(3);
        const counts = plans.map((p) => (generateFetchXml(p).match(/<value>/g) ?? []).length);
        expect(counts).toEqual([250, 250, 100]);
        for (const p of plans) expect(generateFetchXml(p)).toContain('value="ImportLead"');
    });

    it('rejects a long NOT IN, a long IN under OR, and two long lists', () => {
        const notIn = parseSelect('SELECT a FROM t WHERE x NOT IN (SELECT id FROM u)');
        expect(() => planQueries(notIn, resolveWith(notIn, [guids(300)]), 250)).toThrow(/not NOT IN, OR/);

        const orIn = parseSelect("SELECT a FROM t WHERE y = 'z' OR x IN (SELECT id FROM u)");
        expect(() => planQueries(orIn, resolveWith(orIn, [guids(300)]), 250)).toThrow(/not NOT IN, OR/);

        const two = parseSelect('SELECT a FROM t WHERE x IN (SELECT id FROM u) AND y IN (SELECT id FROM v)');
        expect(() => planQueries(two, resolveWith(two, [guids(300), guids(300)]), 250)).toThrow(/Only one subquery/);
    });

    it('rejects splitting an aggregate query', () => {
        const stmt = parseSelect('SELECT COUNT(*) FROM t WHERE x IN (SELECT id FROM u)');
        expect(() => planQueries(stmt, resolveWith(stmt, [guids(300)]), 250)).toThrow(/aggregates or GROUP BY/);
    });

    it('allows a short NOT IN next to a long IN', () => {
        const stmt = parseSelect('SELECT a FROM t WHERE x IN (SELECT id FROM u) AND y NOT IN (SELECT id FROM v)');
        const plans = planQueries(stmt, resolveWith(stmt, [guids(300), ['g1']]), 250);
        expect(plans).toHaveLength(2);
        for (const p of plans) expect(generateFetchXml(p)).toContain('operator="not-in"');
    });
});

describe('sortRows', () => {
    it('sorts merged rows by ORDER BY with NULLs first', () => {
        const rows = [
            { name: 'b', n: 2 },
            { name: 'a', n: null },
            { name: 'c', n: 1 },
        ];
        expect(sortRows(rows, [{ column: { column: 'n' }, direction: 'ASC' }]).map((r) => r.name)).toEqual([
            'a',
            'c',
            'b',
        ]);
        expect(sortRows(rows, [{ column: { column: 'name' }, direction: 'DESC' }]).map((r) => r.name)).toEqual([
            'c',
            'b',
            'a',
        ]);
    });
});
