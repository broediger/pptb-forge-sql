import { describe, it, expect } from 'vitest';
import { tokenize } from '../lexer';
import { parse } from '../parser';
import { generateFetchXml } from '../generator';
import {
    planVirtualFilter,
    assertVirtualFilterSupported,
    matchesVirtualFilter,
    finishVirtualFilter,
    emptyMissingAttributes,
    recordMissingAttribute,
    type MissingAttributes,
} from '../virtualFilter';

const parseSQL = (sql: string) => parse(tokenize(sql));
const strip = (xml: string) => xml.replace(/\s+/g, ' ');

const missingOf = (...messages: string[]): MissingAttributes => {
    const missing = emptyMissingAttributes();
    for (const m of messages) recordMissingAttribute(missing, new Error(m));
    return missing;
};
const notOn = (entity: string, attribute: string) =>
    `'${entity}' entity doesn't contain attribute with Name = '${attribute}' and NameMapping = 'Logical'. (0x80041103)`;

describe('recordMissingAttribute', () => {
    it('records the entity and attribute from the Dataverse message', () => {
        const missing = missingOf(notOn('account', 'OwnerIdName'));
        expect([...missing.names]).toEqual(['account.owneridname']);
        expect(missing.guess).toBe(false);
    });

    it('reports whether anything new was learned', () => {
        const missing = emptyMissingAttributes();
        expect(recordMissingAttribute(missing, new Error(notOn('account', 'owneridname')))).toBe(true);
        expect(recordMissingAttribute(missing, new Error(notOn('account', 'owneridname')))).toBe(false);
        expect(recordMissingAttribute(missing, new Error('something else (0x80041103)'))).toBe(true);
        expect(missing.guess).toBe(true);
        expect(recordMissingAttribute(missing, new Error('something else (0x80041103)'))).toBe(false);
    });

    it('falls back to the bare attribute name', () => {
        expect([...missingOf("Name = 'owneridname' (0x80041103)").names]).toEqual(['*.owneridname']);
    });
});

describe('planVirtualFilter', () => {
    it('returns null when no WHERE condition uses a missing attribute', () => {
        const stmt = parseSQL("SELECT owneridname FROM account WHERE name = 'x'");
        expect(planVirtualFilter(stmt, missingOf(notOn('account', 'owneridname')))).toBeNull();
        expect(planVirtualFilter(parseSQL('SELECT name FROM account'), missingOf(notOn('account', 'x')))).toBeNull();
    });

    it('moves only the affected conjuncts client-side and fetches the base column', () => {
        const stmt = parseSQL("SELECT TOP 5 name FROM account WHERE statecode = 0 AND owneridname LIKE '%Ada%'");
        const plan = planVirtualFilter(stmt, missingOf(notOn('account', 'owneridname')))!;
        const xml = strip(generateFetchXml(plan.stmt));
        expect(xml).toContain('<condition attribute="statecode" operator="eq" value="0" />');
        expect(xml).not.toContain('owneridname');
        expect(xml).toContain('<attribute name="ownerid" />');
        expect(xml).not.toContain('top=');
        expect(plan.top).toBe(5);
        expect(plan.virtualColumns).toEqual(['owneridname']);
    });

    it('moves a whole OR group that mentions a missing attribute', () => {
        const stmt = parseSQL("SELECT name FROM account WHERE owneridname = 'Ada' OR telephone1 = '1'");
        const plan = planVirtualFilter(stmt, missingOf(notOn('account', 'owneridname')))!;
        const xml = strip(generateFetchXml(plan.stmt));
        expect(xml).not.toContain('<filter');
        expect(xml).toContain('<attribute name="telephone1" />');
        expect(plan.filter.kind).toBe('or');
    });

    it('drops a selected attribute Dataverse rejected and keeps unknown names as-is', () => {
        const stmt = parseSQL(
            "SELECT c.competitoridname, c.statecodename FROM opportunityclose c WHERE c.competitoridname LIKE '%N%'",
        );
        const plan = planVirtualFilter(stmt, missingOf(notOn('opportunityclose', 'competitoridname')))!;
        const xml = strip(generateFetchXml(plan.stmt));
        expect(xml).not.toContain('competitoridname');
        expect(xml).toContain('<attribute name="competitorid" />');
        expect(xml).toContain('<attribute name="statecodename" />');
        expect(xml).toContain('<attribute name="statecode" />');
    });

    it('resolves joined columns to their link alias', () => {
        const stmt = parseSQL(
            "SELECT a.name FROM contact c JOIN account a ON a.accountid = c.parentcustomerid WHERE a.owneridname = 'Ada'",
        );
        const plan = planVirtualFilter(stmt, missingOf(notOn('account', 'owneridname')))!;
        expect(strip(generateFetchXml(plan.stmt))).toMatch(/alias="a">.*<attribute name="ownerid" \/>/);
        expect(plan.keyOf({ table: 'a', column: 'OwnerIdName' })).toBe('a.owneridname');
        expect(plan.keyOf({ table: 'c', column: 'fullname' })).toBe('fullname');
    });

    it('does not apply a missing attribute of another entity', () => {
        const stmt = parseSQL("SELECT fullname FROM contact WHERE fullname = 'x'");
        expect(planVirtualFilter(stmt, missingOf(notOn('account', 'fullname')))).toBeNull();
    });

    it('when the error named no attribute, moves every xxxname condition and also asks for the literal', () => {
        const stmt = parseSQL("SELECT name FROM account WHERE owneridname = 'Ada'");
        const plan = planVirtualFilter(stmt, missingOf('unknown attribute (0x80041103)'))!;
        const xml = strip(generateFetchXml(plan.stmt));
        expect(xml).toContain('<attribute name="ownerid" />');
        expect(xml).toContain('<attribute name="owneridname" />');
    });

    it('leaves GROUP BY with only a guessed virtual column to the other retries', () => {
        const stmt = parseSQL("SELECT name, COUNT(*) FROM account WHERE fullname LIKE 'a%' GROUP BY name");
        expect(planVirtualFilter(stmt, missingOf('unknown attribute (0x80041103)'))).toBeNull();
    });

    it('flags a column whose base was rejected too as unresolved', () => {
        const stmt = parseSQL("SELECT name FROM account WHERE fulname = 'x'");
        const missing = missingOf(notOn('account', 'fulname'));
        expect(planVirtualFilter(stmt, missing)!.unresolved).toEqual([]);
        recordMissingAttribute(missing, new Error(notOn('account', 'ful')));
        expect(planVirtualFilter(stmt, missing)!.unresolved).toEqual(['fulname']);
    });

    it('sorts client-side when ORDER BY uses a filtered display name', () => {
        const stmt = parseSQL("SELECT TOP 3 name FROM account WHERE owneridname LIKE 'A%' ORDER BY owneridname DESC");
        const plan = planVirtualFilter(stmt, missingOf(notOn('account', 'owneridname')))!;
        expect(plan.clientOrder).toEqual(stmt.orderBy);
        const xml = strip(generateFetchXml(plan.stmt));
        expect(xml).not.toContain('<order');
        expect(xml).toContain('<attribute name="ownerid" />');
    });

    it('keeps a server-side ORDER BY on real columns', () => {
        const stmt = parseSQL("SELECT name FROM account WHERE owneridname = 'Ada' ORDER BY name");
        const plan = planVirtualFilter(stmt, missingOf(notOn('account', 'owneridname')))!;
        expect(plan.clientOrder).toBeUndefined();
        expect(strip(generateFetchXml(plan.stmt))).toContain('<order attribute="name"');
    });

    it('assertVirtualFilterSupported throws only for confirmed missing columns in grouped queries', () => {
        const grouped = parseSQL("SELECT name, COUNT(*) FROM account WHERE owneridname = 'Ada' GROUP BY name");
        expect(() => assertVirtualFilterSupported(grouped, missingOf(notOn('account', 'owneridname')))).toThrow(
            /GROUP BY/,
        );
        expect(() => assertVirtualFilterSupported(grouped, missingOf('no name (0x80041103)'))).not.toThrow();
        const plain = parseSQL("SELECT name FROM account WHERE owneridname = 'Ada'");
        expect(() => assertVirtualFilterSupported(plain, missingOf(notOn('account', 'owneridname')))).not.toThrow();
    });

    it('rejects GROUP BY, DISTINCT and aggregates', () => {
        const missing = missingOf(notOn('account', 'owneridname'));
        for (const sql of [
            "SELECT COUNT(*) FROM account WHERE owneridname = 'Ada'",
            "SELECT DISTINCT name FROM account WHERE owneridname = 'Ada'",
            "SELECT name, COUNT(*) FROM account WHERE owneridname = 'Ada' GROUP BY name",
        ]) {
            expect(() => planVirtualFilter(parseSQL(sql), missing)).toThrow(/GROUP BY, DISTINCT, aggregates or HAVING/);
        }
    });
});

describe('matchesVirtualFilter and finishVirtualFilter', () => {
    const plan = planVirtualFilter(
        parseSQL("SELECT name FROM account WHERE owneridname LIKE 'a%' AND statecodename <> 'Inactive'"),
        missingOf(notOn('account', 'owneridname'), notOn('account', 'statecodename')),
    )!;

    it('matches case-insensitively on the display names, with SQL null semantics', () => {
        const rows = [
            { name: '1', owneridname: 'Ada', statecodename: 'Active' },
            { name: '2', owneridname: 'Bob', statecodename: 'Active' },
            { name: '3', owneridname: 'alan', statecodename: 'Inactive' },
            { name: '4', statecodename: 'Active' },
            { name: '5', owneridname: 'Anna', statecodename: 'active' },
            { name: '6', owneridname: 'Abe', statecodename: 'Active' },
        ];
        expect(rows.filter((r) => matchesVirtualFilter(r, plan)).map((r) => r.name)).toEqual(['1', '5', '6']);
    });

    it('drops the filter-only columns of joined tables from SELECT * results', () => {
        const starPlan = planVirtualFilter(
            parseSQL(
                "SELECT * FROM contact c JOIN account a ON a.accountid = c.parentcustomerid WHERE a.owneridname = 'Ada'",
            ),
            missingOf(notOn('account', 'owneridname')),
        )!;
        const rows = [{ fullname: 'X', 'a.ownerid': 'u1', 'a.ownerid_formatted': 'Ada', 'a.owneridname': 'Ada' }];
        expect(finishVirtualFilter(rows, starPlan, true)).toEqual([{ fullname: 'X' }]);
    });

    it('copies aliased display names to their alias', () => {
        const aliasPlan = planVirtualFilter(
            parseSQL("SELECT owneridname AS owner FROM account WHERE owneridname = 'Ada'"),
            missingOf(notOn('account', 'owneridname')),
        )!;
        expect(finishVirtualFilter([{ owneridname: 'Ada' }], aliasPlan, false)).toEqual([
            { owneridname: 'Ada', owner: 'Ada' },
        ]);
    });
});
