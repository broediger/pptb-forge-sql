import { describe, it, expect } from 'vitest';
import { generateFetchXml } from '../generator';
import { tokenize } from '../lexer';
import { parse } from '../parser';

const toFetchXml = (sql: string): string => generateFetchXml(parse(tokenize(sql)));

// Normalise whitespace to make substring assertions whitespace-independent
const strip = (xml: string) => xml.replace(/\s+/g, ' ').trim();

describe('generateFetchXml', () => {

    // ── Simple SELECT ─────────────────────────────────────────────────────────

    describe('simple select', () => {
        it('wraps output in <fetch> element', () => {
            const xml = toFetchXml('SELECT name FROM account');
            expect(strip(xml)).toContain('<fetch');
            expect(strip(xml)).toContain('</fetch>');
        });

        it('wraps output in <entity> element with correct name', () => {
            const xml = toFetchXml('SELECT name FROM account');
            expect(strip(xml)).toContain('entity name="account"');
        });

        it('emits <attribute> for named column', () => {
            const xml = toFetchXml('SELECT name FROM account');
            expect(strip(xml)).toContain('attribute name="name"');
        });

        it('produces the expected minimal FetchXML structure', () => {
            const xml = toFetchXml('SELECT name FROM account');
            const s = strip(xml);
            // Must contain fetch > entity > attribute in that order
            expect(s.indexOf('<fetch')).toBeLessThan(s.indexOf('entity name="account"'));
            expect(s.indexOf('entity name="account"')).toBeLessThan(s.indexOf('attribute name="name"'));
        });
    });

    // ── SELECT * ──────────────────────────────────────────────────────────────

    describe('SELECT *', () => {
        it('emits <all-attributes /> instead of individual attributes', () => {
            const xml = toFetchXml('SELECT * FROM account');
            expect(strip(xml)).toContain('all-attributes');
        });

        it('does not emit a named <attribute> element', () => {
            const xml = toFetchXml('SELECT * FROM account');
            expect(strip(xml)).not.toContain('<attribute name=');
        });
    });

    // ── TOP ───────────────────────────────────────────────────────────────────

    describe('TOP', () => {
        it('adds top attribute to <fetch>', () => {
            const xml = toFetchXml('SELECT TOP 10 name FROM account');
            expect(strip(xml)).toContain('top="10"');
        });
    });

    // ── DISTINCT ──────────────────────────────────────────────────────────────

    describe('DISTINCT', () => {
        it('adds distinct="true" to <fetch>', () => {
            const xml = toFetchXml('SELECT DISTINCT name FROM account');
            expect(strip(xml)).toContain('distinct="true"');
        });
    });

    // ── WHERE conditions ──────────────────────────────────────────────────────

    describe('WHERE equals', () => {
        it('emits a <filter> element', () => {
            const xml = toFetchXml("SELECT name FROM account WHERE status = 'active'");
            expect(strip(xml)).toContain('<filter');
        });

        it('emits a <condition> element', () => {
            const xml = toFetchXml("SELECT name FROM account WHERE status = 'active'");
            expect(strip(xml)).toContain('<condition');
        });

        it('uses operator="eq"', () => {
            const xml = toFetchXml("SELECT name FROM account WHERE status = 'active'");
            expect(strip(xml)).toContain('operator="eq"');
        });

        it('sets the attribute name', () => {
            const xml = toFetchXml("SELECT name FROM account WHERE status = 'active'");
            expect(strip(xml)).toContain('attribute="status"');
        });

        it('sets the value', () => {
            const xml = toFetchXml("SELECT name FROM account WHERE status = 'active'");
            expect(strip(xml)).toContain('value="active"');
        });
    });

    describe('WHERE not equals', () => {
        it('uses operator="neq"', () => {
            const xml = toFetchXml("SELECT name FROM account WHERE status != 'active'");
            expect(strip(xml)).toContain('operator="neq"');
        });
    });

    describe('WHERE less than', () => {
        it('uses operator="lt"', () => {
            const xml = toFetchXml('SELECT name FROM account WHERE revenue < 1000');
            expect(strip(xml)).toContain('operator="lt"');
        });
    });

    describe('WHERE greater than', () => {
        it('uses operator="gt"', () => {
            const xml = toFetchXml('SELECT name FROM account WHERE revenue > 1000');
            expect(strip(xml)).toContain('operator="gt"');
        });
    });

    describe('WHERE LIKE', () => {
        it('uses operator="like"', () => {
            const xml = toFetchXml("SELECT * FROM account WHERE name LIKE '%corp%'");
            expect(strip(xml)).toContain('operator="like"');
        });
    });

    describe('WHERE IS NULL', () => {
        it('uses operator="null"', () => {
            const xml = toFetchXml('SELECT * FROM account WHERE email IS NULL');
            expect(strip(xml)).toContain('operator="null"');
        });

        it('does not include a value attribute', () => {
            const xml = toFetchXml('SELECT * FROM account WHERE email IS NULL');
            // The condition element for IS NULL should not have value="..."
            const conditionMatch = strip(xml).match(/condition[^>]*operator="null"[^>]*/);
            expect(conditionMatch).not.toBeNull();
            expect(conditionMatch![0]).not.toContain('value=');
        });
    });

    describe('WHERE IS NOT NULL', () => {
        it('uses operator="not-null"', () => {
            const xml = toFetchXml('SELECT * FROM account WHERE email IS NOT NULL');
            expect(strip(xml)).toContain('operator="not-null"');
        });
    });

    // ── Logical conditions ────────────────────────────────────────────────────

    describe('WHERE AND', () => {
        it('emits filter type="and"', () => {
            const xml = toFetchXml(
                "SELECT name FROM account WHERE status = 'active' AND revenue > 1000"
            );
            expect(strip(xml)).toContain('type="and"');
        });

        it('contains two condition elements', () => {
            const xml = toFetchXml(
                "SELECT name FROM account WHERE status = 'active' AND revenue > 1000"
            );
            const matches = strip(xml).match(/<condition/g) ?? [];
            expect(matches.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('WHERE OR', () => {
        it('emits filter type="or"', () => {
            const xml = toFetchXml(
                "SELECT name FROM account WHERE status = 'active' OR status = 'pending'"
            );
            expect(strip(xml)).toContain('type="or"');
        });
    });

    // ── IN / BETWEEN ──────────────────────────────────────────────────────────

    describe('WHERE IN', () => {
        it('uses operator="in"', () => {
            const xml = toFetchXml("SELECT * FROM account WHERE status IN ('active', 'pending')");
            expect(strip(xml)).toContain('operator="in"');
        });

        it('emits multiple <value> elements for each IN item', () => {
            const xml = toFetchXml("SELECT * FROM account WHERE status IN ('active', 'pending')");
            const matches = strip(xml).match(/<value/g) ?? [];
            expect(matches.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('WHERE BETWEEN', () => {
        it('uses operator="between"', () => {
            const xml = toFetchXml('SELECT * FROM account WHERE revenue BETWEEN 100 AND 500');
            expect(strip(xml)).toContain('operator="between"');
        });

        it('emits two <value> elements', () => {
            const xml = toFetchXml('SELECT * FROM account WHERE revenue BETWEEN 100 AND 500');
            const matches = strip(xml).match(/<value/g) ?? [];
            expect(matches.length).toBeGreaterThanOrEqual(2);
        });
    });

    // ── JOINs ─────────────────────────────────────────────────────────────────

    describe('INNER JOIN', () => {
        it('emits a <link-entity> element', () => {
            const xml = toFetchXml(
                'SELECT a.name, c.fullname FROM account a INNER JOIN contact c ON a.accountid = c.parentcustomerid'
            );
            expect(strip(xml)).toContain('link-entity');
        });

        it('sets link-type="inner"', () => {
            const xml = toFetchXml(
                'SELECT a.name, c.fullname FROM account a INNER JOIN contact c ON a.accountid = c.parentcustomerid'
            );
            expect(strip(xml)).toContain('link-type="inner"');
        });

        it('sets from to the link-entity attribute (parentcustomerid)', () => {
            const xml = toFetchXml(
                'SELECT a.name, c.fullname FROM account a INNER JOIN contact c ON a.accountid = c.parentcustomerid'
            );
            expect(strip(xml)).toContain('from="parentcustomerid"');
        });

        it('sets to to the parent entity attribute (accountid)', () => {
            const xml = toFetchXml(
                'SELECT a.name, c.fullname FROM account a INNER JOIN contact c ON a.accountid = c.parentcustomerid'
            );
            expect(strip(xml)).toContain('to="accountid"');
        });
    });

    describe('LEFT JOIN', () => {
        it('sets link-type="outer"', () => {
            const xml = toFetchXml(
                'SELECT a.name FROM account a LEFT JOIN contact c ON a.accountid = c.parentcustomerid'
            );
            expect(strip(xml)).toContain('link-type="outer"');
        });
    });

    // ── ORDER BY ──────────────────────────────────────────────────────────────

    describe('ORDER BY', () => {
        it('emits an <order> element', () => {
            const xml = toFetchXml('SELECT name FROM account ORDER BY name');
            expect(strip(xml)).toContain('<order');
        });

        it('sets the attribute name on <order>', () => {
            const xml = toFetchXml('SELECT name FROM account ORDER BY name');
            expect(strip(xml)).toContain('attribute="name"');
        });

        it('emits descending="true" for DESC direction', () => {
            const xml = toFetchXml('SELECT name FROM account ORDER BY name DESC');
            expect(strip(xml)).toContain('descending="true"');
        });

        it('omits descending attribute entirely for ASC direction', () => {
            const xml = toFetchXml('SELECT name FROM account ORDER BY name ASC');
            expect(strip(xml)).not.toContain('descending=');
        });
    });

    // ── Aggregates ────────────────────────────────────────────────────────────

    describe('aggregates', () => {
        it('emits aggregate="count" on the attribute', () => {
            const xml = toFetchXml('SELECT COUNT(id) FROM account');
            expect(strip(xml)).toContain('aggregate="count"');
        });

        it('emits aggregate="sum" on the attribute', () => {
            const xml = toFetchXml('SELECT SUM(revenue) FROM account GROUP BY status');
            expect(strip(xml)).toContain('aggregate="sum"');
        });

        it('emits aggregate="avg" on the attribute', () => {
            const xml = toFetchXml('SELECT AVG(age) FROM account GROUP BY status');
            expect(strip(xml)).toContain('aggregate="avg"');
        });
    });

    // ── GROUP BY ──────────────────────────────────────────────────────────────

    describe('GROUP BY', () => {
        it('adds aggregate="true" to <fetch> element', () => {
            const xml = toFetchXml('SELECT status, COUNT(id) FROM account GROUP BY status');
            expect(strip(xml)).toContain('aggregate="true"');
        });

        it('sets groupby="true" on grouped attributes', () => {
            const xml = toFetchXml('SELECT status, COUNT(id) FROM account GROUP BY status');
            expect(strip(xml)).toContain('groupby="true"');
        });
    });

    // ── XML escaping ──────────────────────────────────────────────────────────

    describe('XML escaping', () => {
        it('escapes & in string values', () => {
            const xml = toFetchXml("SELECT name FROM account WHERE name = 'A&B'");
            expect(strip(xml)).toContain('&amp;');
            expect(strip(xml)).not.toMatch(/value="[^"]*&[^a][^"]*"/);
        });

        it('escapes < in string values', () => {
            const xml = toFetchXml("SELECT name FROM account WHERE name = 'A<B'");
            expect(strip(xml)).toContain('&lt;');
        });

        it('escapes > in string values', () => {
            const xml = toFetchXml("SELECT name FROM account WHERE name = 'A>B'");
            expect(strip(xml)).toContain('&gt;');
        });

        it('escapes " in string values', () => {
            const xml = toFetchXml('SELECT name FROM account WHERE name = \'A"B\'');
            expect(strip(xml)).toContain('&quot;');
        });

        it("escapes ' in string values", () => {
            const xml = toFetchXml("SELECT name FROM account WHERE name = 'it''s'");
            // The apostrophe inside the value must be escaped in the XML output
            expect(strip(xml)).toMatch(/&apos;|&#39;/);
        });
    });

    // ── NOT negation pushdown ────────────────────────────────────────────────

    describe('NOT negation', () => {
        it('negates = to neq', () => {
            const xml = toFetchXml("SELECT * FROM t WHERE NOT status = 'active'");
            expect(strip(xml)).toContain('operator="neq"');
        });

        it('negates > to le', () => {
            const xml = toFetchXml('SELECT * FROM t WHERE NOT revenue > 100');
            expect(strip(xml)).toContain('operator="le"');
        });

        it('negates LIKE to not-like', () => {
            const xml = toFetchXml("SELECT * FROM t WHERE NOT name LIKE '%x%'");
            expect(strip(xml)).toContain('operator="not-like"');
        });

        it('applies De Morgan to NOT (a AND b) → OR(NOT a, NOT b)', () => {
            const xml = toFetchXml("SELECT * FROM t WHERE NOT (a = 1 AND b = 2)");
            const s = strip(xml);
            expect(s).toContain('type="or"');
            expect(s).toContain('operator="neq"');
        });

        it('double NOT cancels out', () => {
            const xml = toFetchXml("SELECT * FROM t WHERE NOT NOT status = 'active'");
            expect(strip(xml)).toContain('operator="eq"');
        });
    });

    // ── RIGHT JOIN error ──────────────────────────────────────────────────────

    describe('RIGHT JOIN', () => {
        it('throws an error because FetchXML does not support RIGHT JOIN', () => {
            expect(() => toFetchXml(
                'SELECT a.name FROM account a RIGHT JOIN contact c ON a.accountid = c.parentcustomerid'
            )).toThrow(/RIGHT JOIN/);
        });
    });

    // ── Table-qualified WHERE (entityname attribute) ──────────────────────────

    describe('table-qualified WHERE', () => {
        it('emits entityname for conditions on joined table columns', () => {
            const xml = toFetchXml(
                "SELECT a.name FROM account a INNER JOIN contact c ON a.accountid = c.parentcustomerid WHERE c.status = 'active'"
            );
            expect(strip(xml)).toContain('entityname="c"');
        });
    });

    // ── HAVING with aggregates ────────────────────────────────────────────────

    describe('HAVING aggregate conditions', () => {
        it('references aggregate by alias in HAVING condition', () => {
            const xml = toFetchXml(
                'SELECT status, COUNT(id) FROM account GROUP BY status HAVING COUNT(id) > 5'
            );
            const s = strip(xml);
            expect(s).toContain('aggregate="true"');
            expect(s).toContain('aggregate="count"');
            // The HAVING condition should reference the auto-alias, not "count(id)"
            expect(s).not.toContain('attribute="count(id)"');
            expect(s).toContain('attribute="count_id"');
        });
    });

    // ── Column-to-column error ────────────────────────────────────────────────

    describe('column-to-column comparison', () => {
        it('throws when WHERE compares two columns', () => {
            expect(() => toFetchXml(
                'SELECT * FROM account WHERE name = othername'
            )).toThrow(/not supported/);
        });
    });

    // ── Complex end-to-end query ──────────────────────────────────────────────

    describe('complex end-to-end query', () => {
        it('generates valid-looking FetchXML for a multi-clause query', () => {
            const sql =
                "SELECT DISTINCT TOP 25 a.name, c.fullname " +
                "FROM account a " +
                "INNER JOIN contact c ON a.accountid = c.parentcustomerid " +
                "WHERE a.statecode = 0 " +
                "ORDER BY a.name ASC";
            const xml = toFetchXml(sql);
            const s = strip(xml);

            expect(s).toContain('top="25"');
            expect(s).toContain('distinct="true"');
            expect(s).toContain('entity name="account"');
            expect(s).toContain('link-entity');
            expect(s).toContain('link-type="inner"');
            expect(s).toContain('<filter');
            expect(s).toContain('<order');
            expect(s).toContain('</fetch>');
        });
    });

    // ── Bug fixes ─────────────────────────────────────────────────────────────

    describe('negative number literals (Bug 1)', () => {
        it('does not throw for WHERE age > -1', () => {
            expect(() => toFetchXml('SELECT age FROM account WHERE age > -1')).not.toThrow();
        });

        it('emits value="-1" for WHERE age > -1', () => {
            const xml = toFetchXml('SELECT age FROM account WHERE age > -1');
            expect(strip(xml)).toContain('value="-1"');
        });

        it('does not throw for WHERE score >= -3.5', () => {
            expect(() => toFetchXml('SELECT score FROM account WHERE score >= -3.5')).not.toThrow();
        });
    });

    describe('COUNT(*) FetchXML output (Bug 3)', () => {
        it('does not emit name="*" for COUNT(*)', () => {
            const xml = toFetchXml('SELECT COUNT(*) FROM account');
            expect(strip(xml)).not.toContain('name="*"');
        });

        it('emits aggregate="count" for COUNT(*)', () => {
            const xml = toFetchXml('SELECT COUNT(*) FROM account');
            expect(strip(xml)).toContain('aggregate="count"');
        });

        it('uses entity name + id convention for COUNT(*) on account', () => {
            const xml = toFetchXml('SELECT COUNT(*) FROM account');
            expect(strip(xml)).toContain('name="accountid"');
        });
    });

    describe('col = NULL produces null operator (Bug 4)', () => {
        it('emits operator="null" for WHERE status = NULL', () => {
            const xml = toFetchXml('SELECT name FROM account WHERE status = NULL');
            expect(strip(xml)).toContain('operator="null"');
        });

        it('does not emit value attribute for WHERE status = NULL', () => {
            const xml = toFetchXml('SELECT name FROM account WHERE status = NULL');
            const condMatch = strip(xml).match(/condition[^>]*operator="null"[^>]*/);
            expect(condMatch).not.toBeNull();
            expect(condMatch![0]).not.toContain('value=');
        });

        it('emits operator="not-null" for WHERE status != NULL', () => {
            const xml = toFetchXml('SELECT name FROM account WHERE status != NULL');
            expect(strip(xml)).toContain('operator="not-null"');
        });
    });

    describe('aggregate="true" without GROUP BY (Bug 2)', () => {
        it('adds aggregate="true" to <fetch> when COUNT is used without GROUP BY', () => {
            const xml = toFetchXml('SELECT COUNT(id) FROM account');
            expect(strip(xml)).toContain('aggregate="true"');
        });

        it('does not add aggregate="true" for plain SELECT without aggregates', () => {
            const xml = toFetchXml('SELECT status FROM account GROUP BY status');
            expect(strip(xml)).not.toContain('aggregate="true"');
        });
    });

    describe('DISTINCT + aggregate conflict (Bug 5)', () => {
        it('omits distinct="true" when aggregate functions are present', () => {
            const xml = toFetchXml('SELECT DISTINCT COUNT(id) FROM account');
            expect(strip(xml)).not.toContain('distinct="true"');
        });

        it('still emits aggregate="true" when DISTINCT COUNT is used', () => {
            const xml = toFetchXml('SELECT DISTINCT COUNT(id) FROM account');
            expect(strip(xml)).toContain('aggregate="true"');
        });
    });

    describe('ORDER BY on joined entity columns (Bug 6)', () => {
        it('emits entityname attribute on <order> for joined column', () => {
            const xml = toFetchXml(
                'SELECT a.name, c.fullname FROM account a ' +
                'INNER JOIN contact c ON a.accountid = c.parentcustomerid ' +
                'ORDER BY c.fullname'
            );
            expect(strip(xml)).toContain('entityname="c"');
        });

        it('emits attribute="fullname" on the <order> element', () => {
            const xml = toFetchXml(
                'SELECT a.name, c.fullname FROM account a ' +
                'INNER JOIN contact c ON a.accountid = c.parentcustomerid ' +
                'ORDER BY c.fullname'
            );
            const s = strip(xml);
            expect(s).toMatch(/order attribute="fullname"[^/]*entityname="c"/);
        });

        it('does not emit entityname on <order> for main entity column', () => {
            const xml = toFetchXml(
                'SELECT a.name FROM account a ' +
                'INNER JOIN contact c ON a.accountid = c.parentcustomerid ' +
                'ORDER BY a.name'
            );
            const s = strip(xml);
            // order for main entity should not have entityname
            const orderMatch = s.match(/order attribute="name"[^/]*/);
            expect(orderMatch).not.toBeNull();
            expect(orderMatch![0]).not.toContain('entityname=');
        });
    });

    describe('SELECT c.* on JOIN emits <all-attributes /> (Bug 7)', () => {
        it('emits <all-attributes /> inside <link-entity> for wildcard join column', () => {
            const xml = toFetchXml(
                'SELECT a.name, c.* FROM account a ' +
                'INNER JOIN contact c ON a.accountid = c.parentcustomerid'
            );
            expect(strip(xml)).toContain('all-attributes');
        });

        it('does not self-close <link-entity> when join has wildcard', () => {
            const xml = toFetchXml(
                'SELECT a.name, c.* FROM account a ' +
                'INNER JOIN contact c ON a.accountid = c.parentcustomerid'
            );
            expect(strip(xml)).toContain('</link-entity>');
        });

        it('emits <all-attributes /> between open and close link-entity tags', () => {
            const xml = toFetchXml(
                'SELECT a.name, c.* FROM account a ' +
                'INNER JOIN contact c ON a.accountid = c.parentcustomerid'
            );
            const s = strip(xml);
            const linkOpen = s.indexOf('<link-entity');
            const allAttr = s.indexOf('all-attributes');
            const linkClose = s.indexOf('</link-entity>');
            expect(linkOpen).toBeLessThan(allAttr);
            expect(allAttr).toBeLessThan(linkClose);
        });
    });

});
