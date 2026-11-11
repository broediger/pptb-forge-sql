import { describe, it, expect } from 'vitest';
import { tokenize } from '../lexer';
import { parse } from '../parser';
import { generateFetchXml } from '../generator';
import { executeSelect, type FetchXmlQueryFn, type FetchXmlQueryResult } from '../selectExecution';
import type { SelectExecutionOptions } from '../selectExecution';
import { SCAN_PAGE_SIZE, keysetCondition, planClientAggregate } from '../clientAggregate';

const COOKIE_KEY = '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie';
const FMT = '@OData.Community.Display.V1.FormattedValue';
const LIMIT_ERROR =
    'Error invoking remote method dataverse.fetchXmlQuery: Error: Dataverse fetchXmlQuery failed: 0x8004e023: ' +
    'The maximum record limit of 50000 is exceeded. Reduce the number of aggregated or grouped records.';

/** Answers aggregate queries with the 50,000-record error and scans from `respond`. */
const limitedQuery = (respond: (fetchXml: string, scanCall: number) => FetchXmlQueryResult) => {
    const calls: string[] = [];
    let scanCalls = 0;
    const query: FetchXmlQueryFn = async (fetchXml) => {
        calls.push(fetchXml);
        if (fetchXml.includes('aggregate="true"')) throw new Error(LIMIT_ERROR);
        scanCalls += 1;
        return respond(fetchXml, scanCalls);
    };
    return { query, calls };
};

const run = (sql: string, query: FetchXmlQueryFn, options?: SelectExecutionOptions) =>
    executeSelect(parse(tokenize(sql)), query, options);

const guid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

const REPORTED_SQL =
    'SELECT COUNT(*) AS zeilen, COUNT(DISTINCT vm.evn_vollmachtid) AS vollmachten, COUNT(DISTINCT z.evn_zaehlpunktid) AS zp_records ' +
    'FROM evn_vollmacht vm INNER JOIN evn_zaehlpunkt z ON z.evn_name = vm.evn_zaehlpunktnummer ' +
    'INNER JOIN evn_crmvertrag v ON v.evn_crmvertragid = z.evn_crmvertragid ' +
    'INNER JOIN evn_evnprodukt p ON p.evn_evnproduktid = v.evn_evnproduktid ' +
    'WHERE vm.evn_vollmachtstypcode = 790530002 AND z.statuscode IN (1, 790530002) AND v.statecode = 0 ' +
    "AND p.evn_vorausszustimmunguebertr15minflag = 1 AND z.createdon >= '2026-04-01'";

describe('aggregate over the 50,000-record limit (reported query)', () => {
    it('translates the string-column join to a link-entity from/to pair', () => {
        const xml = generateFetchXml(parse(tokenize(REPORTED_SQL)));
        expect(xml).toContain(
            '<link-entity name="evn_zaehlpunkt" from="evn_name" to="evn_zaehlpunktnummer" link-type="inner" alias="z">',
        );
        expect(xml).toContain('<attribute name="evn_vollmachtid" aggregate="count" alias="zeilen" />');
        expect(xml).toContain(
            '<attribute name="evn_zaehlpunktid" aggregate="count" distinct="true" alias="zp_records" />',
        );
    });

    it('rethrew 0x8004e023 before (multiple aggregates with joins had no fallback)', async () => {
        // Reproduces the user's failure at the transport level: the first call is
        // the aggregate, and the fallback must run instead of surfacing the error.
        const { query, calls } = limitedQuery(() => ({ value: [] }));
        const result = await run(REPORTED_SQL, query);
        expect(calls[0]).toContain('aggregate="true"');
        expect(calls).toHaveLength(2);
        expect(result.rows).toEqual([{ zeilen: 0, vollmachten: 0, zp_records: 0 }]);
    });

    it('aggregates client-side, paging the joined scan by keyset', async () => {
        // 5,000 joined rows on page 1 (two zaehlpunkte share every second
        // vollmacht, so records repeat), then 3 more rows.
        const row = (vm: number, zp: number) => ({
            evn_vollmachtid: guid(vm),
            'z.evn_zaehlpunktid': guid(zp),
            'v.evn_crmvertragid': guid(1),
            'p.evn_evnproduktid': guid(1),
        });
        const page1 = Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => row(Math.floor(i / 2), i));
        const page2 = [row(2499, 5000), row(2500, 5001), row(2501, 5001)];
        const { query, calls } = limitedQuery((_xml, scanCall) => ({
            value: scanCall === 1 ? page1 : page2,
            // No morerecords flag and no cookie, as seen live with link-entities.
        }));
        const progress: number[] = [];
        const result = await run(REPORTED_SQL, query, { onScanProgress: (n) => progress.push(n) });

        const scan = calls[1];
        expect(scan).not.toContain('aggregate=');
        expect(scan).toContain('<fetch top="5000">');
        expect(scan).toContain('<attribute name="evn_vollmachtid" />');
        expect(scan).toContain('<attribute name="evn_zaehlpunktid" />');
        expect(scan).toContain('<attribute name="evn_crmvertragid" />');
        expect(scan).toContain('<attribute name="evn_evnproduktid" />');
        expect(scan).toContain('<order attribute="evn_vollmachtid" />');
        expect(scan).toContain('<order attribute="evn_zaehlpunktid" entityname="z" />');
        expect(scan).toContain('<order attribute="evn_evnproduktid" entityname="p" />');
        // The user's filter is kept as is.
        expect(scan).toContain('<condition attribute="createdon" entityname="z" operator="ge" value="2026-04-01" />');

        // Page 2 continues after the last key of page 1, without page numbers or cookies.
        const page2Xml = calls[2];
        expect(page2Xml).not.toMatch(/page="|paging-cookie=/);
        expect(page2Xml).toContain(`<condition attribute="evn_vollmachtid" operator="gt" value="${guid(2499)}" />`);
        expect(page2Xml).toContain(
            `<condition attribute="evn_zaehlpunktid" entityname="z" operator="gt" value="${guid(4999)}" />`,
        );
        expect(calls).toHaveLength(3);

        expect(result.rows).toEqual([{ zeilen: 5003, vollmachten: 2502, zp_records: 5002 }]);
        expect(result.columns).toEqual(['zeilen', 'vollmachten', 'zp_records']);
        expect(progress).toEqual([5000, 5003]);
        expect(result.fetchXml).toContain('0x8004e023');
        expect(result.fetchXml).toContain('keyset');
        expect(result.limitNote).toBeUndefined();
    });
});

describe('client-side aggregates', () => {
    it('continues by keyset when a full page has no paging cookie (no morerecords either)', async () => {
        const page1 = Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => ({ accountid: guid(i) }));
        const { query, calls } = limitedQuery((_xml, scanCall) => ({
            value: scanCall === 1 ? page1 : [{ accountid: guid(5000) }, { accountid: guid(5001) }],
        }));
        const result = await run('SELECT COUNT(*) AS n FROM account WHERE statecode = 0', query);
        expect(calls).toHaveLength(3);
        expect(calls[2]).not.toMatch(/page="|paging-cookie=/);
        expect(calls[2]).toContain(`<condition attribute="accountid" operator="gt" value="${guid(4999)}" />`);
        expect(calls[2]).toContain('<condition attribute="statecode" operator="eq" value="0" />');
        expect(result.rows).toEqual([{ n: 5002 }]);
    });

    it('pages with the paging cookie when Dataverse sends one', async () => {
        const { query, calls } = limitedQuery((_xml, scanCall) =>
            scanCall === 1
                ? { value: [{ accountid: 'a' }, { accountid: 'b' }], [COOKIE_KEY]: '<cookie page="1" />' }
                : { value: [{ accountid: 'c' }] },
        );
        const result = await run('SELECT COUNT(*) FROM account', query);
        expect(calls[2]).toContain('page="2"');
        expect(calls[2]).toContain('paging-cookie=');
        expect(result.rows).toEqual([{ count_all: 3 }]);
    });

    it('computes COUNT(col), COUNT(DISTINCT), SUM, AVG, MIN and MAX with SQL null handling', async () => {
        const { query } = limitedQuery(() => ({
            value: [
                { accountid: '1', revenue: 10, name: 'Contoso', createdon: '2026-02-01T00:00:00Z' },
                { accountid: '2', revenue: 30, name: 'contoso', createdon: '2026-01-01T00:00:00Z' },
                { accountid: '3', name: 'Fabrikam', createdon: '2026-03-01T00:00:00Z' },
                { accountid: '4', revenue: 30 },
            ],
        }));
        const result = await run(
            'SELECT COUNT(*) AS c, COUNT(revenue) AS cr, COUNT(DISTINCT name) AS dn, SUM(revenue) AS s, ' +
                'AVG(revenue) AS a, MIN(revenue) AS mi, MAX(revenue) AS ma, MIN(createdon) AS first, ' +
                'SUM(DISTINCT revenue) AS sd FROM account',
            query,
        );
        expect(result.rows).toEqual([
            { c: 4, cr: 3, dn: 2, s: 70, a: 70 / 3, mi: 10, ma: 30, first: '2026-01-01T00:00:00Z', sd: 40 },
        ]);
    });

    it('returns one row of empty aggregates when nothing matches, and no rows for GROUP BY', async () => {
        const { query } = limitedQuery(() => ({ value: [] }));
        const single = await run('SELECT COUNT(*) AS c, SUM(revenue) AS s, MAX(name) AS m FROM account', query);
        expect(single.rows).toEqual([{ c: 0, s: null, m: null }]);
        const grouped = await run('SELECT statuscode, COUNT(*) AS c FROM account GROUP BY statuscode', query);
        expect(grouped.rows).toEqual([]);
    });

    it('groups joined rows, with formatted labels, ORDER BY the count and TOP', async () => {
        const row = (id: number, status: number | null, label: string | null, owner: string) => ({
            contactid: guid(id),
            'a.accountid': guid(100 + (id % 2)),
            'a.statuscode': status,
            ...(label ? { [`a.statuscode${FMT}`]: label } : {}),
            _ownerid_value: owner,
            [`_ownerid_value${FMT}`]: owner === 'u1' ? 'Ada' : 'Bob',
        });
        const { query, calls } = limitedQuery(() => ({
            value: [
                row(1, 1, 'Active', 'u1'),
                row(2, 1, 'Active', 'u1'),
                row(3, 2, 'Inactive', 'u2'),
                row(4, null, null, 'u1'),
                row(5, 1, 'Active', 'u2'),
            ],
        }));
        const result = await run(
            'SELECT TOP 2 a.statuscode, ownerid, COUNT(*) AS n FROM contact c ' +
                'LEFT JOIN account a ON a.accountid = c.parentcustomerid ' +
                'GROUP BY a.statuscode, ownerid ORDER BY n DESC, a.statuscode',
            query,
        );
        expect(calls[1]).toContain(
            '<link-entity name="account" from="accountid" to="parentcustomerid" link-type="outer" alias="a">',
        );
        expect(calls[1]).toContain('<attribute name="statuscode" />');
        expect(result.rows).toEqual([
            {
                statuscode: 1,
                statuscode_formatted: 'Active',
                statuscodename: 'Active',
                ownerid: 'u1',
                ownerid_formatted: 'Ada',
                owneridname: 'Ada',
                n: 2,
            },
            // Ties on n sort by the grouped a.statuscode, NULL first.
            { statuscode: null, ownerid: 'u1', ownerid_formatted: 'Ada', owneridname: 'Ada', n: 1 },
        ]);
        expect(result.columns).toEqual(['statuscode', 'ownerid', 'n']);
    });

    it('groups text case-insensitively and keeps NULL as its own group', async () => {
        const { query } = limitedQuery(() => ({
            value: [
                { accountid: '1', address1_city: 'Wien' },
                { accountid: '2', address1_city: 'WIEN' },
                { accountid: '3' },
            ],
        }));
        const result = await run(
            'SELECT address1_city, COUNT(*) AS n FROM account GROUP BY address1_city ORDER BY address1_city',
            query,
        );
        expect(result.rows).toEqual([
            { address1_city: null, n: 1 },
            { address1_city: 'Wien', n: 2 },
        ]);
    });

    it('applies HAVING to the client-side groups', async () => {
        const { query } = limitedQuery(() => ({
            value: [
                { accountid: '1', statuscode: 1 },
                { accountid: '2', statuscode: 1 },
                { accountid: '3', statuscode: 2 },
            ],
        }));
        const result = await run(
            'SELECT statuscode, SUM(revenue) AS s FROM account GROUP BY statuscode HAVING COUNT(*) > 1',
            query,
        );
        expect(result.rows).toEqual([{ statuscode: 1, s: null }]);
        expect(result.fetchXml).toContain('HAVING');
        expect(result.fetchXml).toContain('0x8004e023');
    });

    it('stops when cancelled and returns the partial values with a note', async () => {
        const page = (start: number) => ({
            value: Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => ({ accountid: guid(start + i) })),
        });
        let cancelled = false;
        const { query, calls } = limitedQuery((_xml, scanCall) => {
            if (scanCall === 2) cancelled = true;
            return page((scanCall - 1) * SCAN_PAGE_SIZE);
        });
        const result = await run('SELECT COUNT(*) AS n FROM account', query, { isCancelled: () => cancelled });
        expect(calls).toHaveLength(3); // aggregate + two scan pages, then the cancel is seen
        expect(result.rows).toEqual([{ n: 10_000 }]);
        expect(result.limitNote).toMatch(/Cancelled after 10,000 rows/);
        expect(result.summary).toContain('partial');
        expect(result.fetchXml).toContain('Cancelled');
    });

    it('fails with the progress so far when a later page errors (no partial result)', async () => {
        const { query } = limitedQuery((_xml, scanCall) => {
            if (scanCall === 2) throw new Error('Network error');
            return { value: Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => ({ accountid: guid(i) })) };
        });
        await expect(run('SELECT COUNT(*) FROM account WHERE statecode = 0', query)).rejects.toThrow(
            /stopped on page 2 after 5,000 rows: Network error/,
        );
    });

    it('fails past maxScanRows', async () => {
        const { query } = limitedQuery(() => ({
            value: Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => ({ accountid: guid(i) })),
            [COOKIE_KEY]: '<cookie />',
        }));
        await expect(
            run('SELECT COUNT(*) FROM account WHERE statecode = 0', query, { maxScanRows: 7000 }),
        ).rejects.toThrow(/more than 7,000 rows/);
    });

    it('keys a joined activity table by activityid when <table>id is rejected', async () => {
        const { query, calls } = limitedQuery((xml) => {
            if (xml.includes('"new_visitid"')) {
                throw new Error(
                    "0x80041103: 'new_visit' entity doesn't contain attribute with Name = 'new_visitid' and NameMapping = 'Logical'",
                );
            }
            return { value: [{ accountid: '1', 'v.activityid': 'x' }] };
        });
        const result = await run(
            'SELECT COUNT(*) AS n FROM account a JOIN new_visit v ON v.regardingobjectid = a.accountid',
            query,
        );
        expect(calls[2]).toContain('<order attribute="activityid" entityname="v" />');
        expect(result.rows).toEqual([{ n: 1 }]);
    });

    it('counts a plain COUNT(*) exactly by scanning (no record-count snapshot)', async () => {
        const { query, calls } = limitedQuery(() => ({ value: [{ accountid: '1' }, { accountid: '2' }] }));
        const result = await run('SELECT COUNT(*) AS n FROM account', query);
        expect(result.rows).toEqual([{ n: 2 }]);
        expect(calls).toHaveLength(2);
        expect(result.fetchXml).not.toContain('RetrieveTotalRecordCount');
        expect(result.fetchXml).toContain('Computed client-side');
    });
});

describe('plain SELECT paging without a cookie', () => {
    it('continues a subquery scan by primary key instead of stopping at 5,000 rows', async () => {
        const contacts = Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => ({
            contactid: guid(i),
            _parentcustomerid_value: guid(9),
        }));
        const calls: string[] = [];
        const query: FetchXmlQueryFn = async (xml) => {
            calls.push(xml);
            if (xml.includes('entity name="contact"')) {
                return {
                    value:
                        calls.length === 1 ? contacts : [{ contactid: guid(5000), _parentcustomerid_value: guid(8) }],
                };
            }
            return { value: [{ name: 'Contoso' }] };
        };
        await run('SELECT name FROM account WHERE accountid IN (SELECT parentcustomerid FROM contact)', query);
        expect(calls[1]).not.toMatch(/page="|paging-cookie=/);
        expect(calls[1]).toContain(`<condition attribute="contactid" operator="gt" value="${guid(4999)}" />`);
        expect(calls[2]).toContain(`<value>${guid(8)}</value>`);
    });

    it('notes when the grid got a full page without a paging cookie', async () => {
        const query: FetchXmlQueryFn = async () => ({
            value: Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => ({ name: String(i) })),
        });
        const result = await run('SELECT name FROM account', query);
        expect(result.pagingCookie).toBeNull();
        expect(result.limitNote).toMatch(/no paging cookie/);
    });
});

describe('planClientAggregate', () => {
    it('rejects a selected column that is neither grouped nor aggregated', () => {
        expect(() => planClientAggregate(parse(tokenize('SELECT name, COUNT(*) FROM account')))).toThrow(
            /must appear in GROUP BY/,
        );
    });

    it('returns null for a query without aggregates', () => {
        expect(planClientAggregate(parse(tokenize('SELECT name FROM account')))).toBeNull();
    });

    it('builds a lexicographic keyset condition across all keys', () => {
        const keys = [
            { column: 'accountid' },
            { table: 'c', column: 'contactid' },
            { table: 'o', column: 'opportunityid' },
        ];
        const eq = (i: number, v: string) => ({ kind: 'comparison', left: keys[i], operator: '=', right: v });
        const gt = (i: number, v: string) => ({ kind: 'comparison', left: keys[i], operator: '>', right: v });
        expect(keysetCondition(keys, ['a', 'b', 'c'])).toEqual({
            kind: 'or',
            left: { kind: 'or', left: gt(0, 'a'), right: { kind: 'and', left: eq(0, 'a'), right: gt(1, 'b') } },
            right: { kind: 'and', left: eq(0, 'a'), right: { kind: 'and', left: eq(1, 'b'), right: gt(2, 'c') } },
        });
    });

    it('compares a NULL key with null / not-null', () => {
        const keys = [{ column: 'accountid' }, { table: 'c', column: 'contactid' }];
        expect(keysetCondition(keys, ['a', null])).toEqual({
            kind: 'or',
            left: { kind: 'comparison', left: keys[0], operator: '>', right: 'a' },
            right: {
                kind: 'and',
                left: { kind: 'comparison', left: keys[0], operator: '=', right: 'a' },
                right: { kind: 'is_null', column: keys[1], negated: true },
            },
        });
        const xml = generateFetchXml({
            type: 'select',
            columns: [{ column: 'accountid' }],
            from: { table: 'account' },
            joins: [],
            where: keysetCondition([keys[1], keys[0]], [null, 'a']),
        });
        expect(xml).toContain('<condition attribute="contactid" entityname="c" operator="not-null" />');
        expect(xml).toContain('<condition attribute="contactid" entityname="c" operator="null" />');
    });
});

// ── A fake Dataverse that evaluates the scan's filter ──
//
// Rows are joined (account, contact) key pairs, held in the fake server's own
// order (NULL first). Only the server orders and compares keys; the client
// never sees anything but the pages.

type KeyRow = { a: string; c: string | null };

interface FilterNode {
    type: 'and' | 'or';
    children: (FilterNode | ConditionNode)[];
}
interface ConditionNode {
    attribute: string;
    entityname?: string;
    operator: string;
    value?: string;
}

function parseFilter(xml: string): FilterNode | null {
    const start = xml.indexOf('<filter');
    if (start === -1) return null;
    const tokens = xml.slice(start).match(/<filter type="(and|or)">|<\/filter>|<condition [^>]*\/>/g) ?? [];
    const stack: FilterNode[] = [];
    let root: FilterNode | null = null;
    for (const token of tokens) {
        if (token.startsWith('<filter')) {
            const node: FilterNode = { type: token.includes('"or"') ? 'or' : 'and', children: [] };
            if (stack.length) stack[stack.length - 1].children.push(node);
            else root = node;
            stack.push(node);
        } else if (token === '</filter>') {
            stack.pop();
            if (!stack.length) break;
        } else {
            const attr = (name: string) => token.match(new RegExp(`${name}="([^"]*)"`))?.[1];
            stack[stack.length - 1].children.push({
                attribute: attr('attribute')!,
                entityname: attr('entityname'),
                operator: attr('operator')!,
                value: attr('value'),
            });
        }
    }
    return root;
}

/** The fake server's ordering of key values: NULL first, then by value. */
function serverCompare(x: string | null, y: string | null): number {
    if (x === y) return 0;
    if (x === null) return -1;
    if (y === null) return 1;
    return x < y ? -1 : 1;
}

function matches(node: FilterNode | ConditionNode, row: KeyRow): boolean {
    if ('children' in node) {
        return node.type === 'and'
            ? node.children.every((c) => matches(c, row))
            : node.children.some((c) => matches(c, row));
    }
    const value = node.entityname === 'c' ? row.c : node.attribute === 'accountid' ? row.a : undefined;
    if (value === undefined) return true; // not a key condition
    switch (node.operator) {
        case 'null':
            return value === null;
        case 'not-null':
            return value !== null;
        case 'eq':
            return value !== null && serverCompare(value, node.value!) === 0;
        case 'gt':
            return value !== null && serverCompare(value, node.value!) > 0;
        default:
            throw new Error(`fake: unexpected operator ${node.operator}`);
    }
}

/** Serves `data` (in server order) to the scan, recording which rows went out. */
function fakeServer(data: KeyRow[], misbehave?: (page: KeyRow[], call: number) => KeyRow[]) {
    const sorted = [...data].sort((x, y) => serverCompare(x.a, y.a) || serverCompare(x.c, y.c));
    const served: KeyRow[] = [];
    const calls: string[] = [];
    const query: FetchXmlQueryFn = async (xml) => {
        calls.push(xml);
        if (xml.includes('aggregate="true"')) throw new Error(LIMIT_ERROR);
        expect(xml).toContain('<order attribute="accountid" />');
        expect(xml).toContain('<order attribute="contactid" entityname="c" />');
        const filter = parseFilter(xml);
        const top = Number(xml.match(/top="(\d+)"/)?.[1] ?? SCAN_PAGE_SIZE);
        let page = sorted.filter((row) => !filter || matches(filter, row)).slice(0, top);
        if (misbehave) page = misbehave(page, calls.length);
        served.push(...page);
        return {
            value: page.map((row) => ({ accountid: row.a, ...(row.c === null ? {} : { 'c.contactid': row.c }) })),
        };
    };
    return { query, calls, served };
}

const JOIN_SQL =
    'SELECT COUNT(*) AS n, COUNT(c.contactid) AS contacts, COUNT(DISTINCT a.accountid) AS accounts ' +
    'FROM account a LEFT JOIN contact c ON c.parentcustomerid = a.accountid';

const id = (prefix: string, n: number) => `${prefix}${String(n).padStart(6, '0')}`;
const tupleCounts = (rows: KeyRow[]) => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(`${r.a}|${r.c}`, (counts.get(`${r.a}|${r.c}`) ?? 0) + 1);
    return counts;
};
/** Every row of `data` was served exactly once: nothing skipped, nothing repeated. */
const expectServedOnce = (data: KeyRow[], served: KeyRow[]) => {
    const counts = tupleCounts(served);
    expect(counts.size).toBe(data.length);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    for (const r of data) expect(counts.has(`${r.a}|${r.c}`)).toBe(true);
};

describe('keyset paging over joins (fake Dataverse)', () => {
    it('pages through one record whose linked rows fill more than two pages', async () => {
        const data: KeyRow[] = [
            ...Array.from({ length: 12_000 }, (_, i) => ({ a: id('a', 1), c: id('c', i) })),
            { a: id('a', 2), c: null }, // outer join without a match
            ...Array.from({ length: 3 }, (_, i) => ({ a: id('a', 3), c: id('d', i) })),
        ];
        const { query, calls, served } = fakeServer(data);
        const result = await run(JOIN_SQL, query);
        expect(result.rows).toEqual([{ n: 12_004, contacts: 12_003, accounts: 3 }]);
        expect(calls).toHaveLength(1 + 3);
        expectServedOnce(data, served);
        // Page 2 continues inside account a000001.
        expect(calls[2]).toContain(`<condition attribute="accountid" operator="eq" value="${id('a', 1)}" />`);
        expect(calls[2]).toContain(
            `<condition attribute="contactid" entityname="c" operator="gt" value="${id('c', 4999)}" />`,
        );
    });

    it('handles fan-out across a page boundary and a page ending on a NULL linked key', async () => {
        const data: KeyRow[] = [
            // 4,997 single rows, then account a004998 with 6 contacts on rows 4,998–5,003.
            ...Array.from({ length: 4997 }, (_, i) => ({ a: id('a', i + 1), c: id('c', i + 1) })),
            ...Array.from({ length: 6 }, (_, i) => ({ a: id('a', 4998), c: id('x', i) })),
            // Rows 5,004–9,999, then row 10,000 is an account without contacts.
            ...Array.from({ length: 4996 }, (_, i) => ({ a: id('b', i + 1), c: id('y', i) })),
            { a: id('b', 99_999), c: null },
            // After the NULL key: more rows that must not be skipped or repeated.
            ...Array.from({ length: 4 }, (_, i) => ({ a: id('e', 1), c: id('z', i) })),
        ];
        const { query, calls, served } = fakeServer(data);
        const result = await run(JOIN_SQL, query);
        expect(result.rows).toEqual([{ n: 10_004, contacts: 10_003, accounts: 4997 + 1 + 4996 + 1 + 1 }]);
        expectServedOnce(data, served);
        // Page 3 starts after (b099999, NULL): same account with a non-null contact, or a later account.
        expect(calls[3]).toContain(`<condition attribute="contactid" entityname="c" operator="not-null" />`);
        expect(calls[3]).toContain(`<condition attribute="accountid" operator="gt" value="${id('b', 99_999)}" />`);
        expect(calls).toHaveLength(1 + 3);
    });

    it('drops a row the server repeats across the page boundary, by its full key tuple', async () => {
        const data: KeyRow[] = Array.from({ length: 5003 }, (_, i) => ({
            a: id('a', Math.floor(i / 3)),
            c: id('c', i),
        }));
        let previousLast: KeyRow | null = null;
        const { query, served } = fakeServer(data, (page) => {
            const out = previousLast ? [previousLast, ...page.slice(0, SCAN_PAGE_SIZE - 1)] : page;
            previousLast = page[page.length - 1];
            return out;
        });
        const result = await run(JOIN_SQL, query);
        expect(tupleCounts(served).get(`${data[4999].a}|${data[4999].c}`)).toBe(2);
        expect(result.rows).toEqual([{ n: 5003, contacts: 5003, accounts: 1668 }]);
        expect(result.fetchXml).toContain('1 repeated row(s) dropped');
    });

    it('fails instead of looping when the server returns the same page again', async () => {
        const data: KeyRow[] = Array.from({ length: 6000 }, (_, i) => ({ a: id('a', i), c: id('c', i) }));
        let first: KeyRow[] | null = null;
        const { query, calls } = fakeServer(data, (page) => (first ??= page));
        await expect(run(JOIN_SQL, query)).rejects.toThrow(/doesn't advance/);
        expect(calls.length).toBe(3);
    });
});

describe('review fixes', () => {
    it('refuses MIN/MAX over GUIDs instead of comparing them as text', async () => {
        const { query } = limitedQuery(() => ({
            value: [
                { contactid: '1', _parentcustomerid_value: '10000000-0000-0000-0000-000000000002' },
                { contactid: '2', _parentcustomerid_value: '20000000-0000-0000-0000-000000000001' },
            ],
        }));
        await expect(run('SELECT MIN(parentcustomerid) AS m FROM contact', query)).rejects.toThrow(
            /uniqueidentifier column can't be computed client-side/,
        );
    });

    it('refuses a client-side ORDER BY over grouped GUIDs', async () => {
        const { query } = limitedQuery(() => ({
            value: [{ contactid: '1', _parentcustomerid_value: '10000000-0000-0000-0000-000000000002' }],
        }));
        await expect(
            run(
                'SELECT parentcustomerid, COUNT(*) AS n FROM contact GROUP BY parentcustomerid ORDER BY parentcustomerid',
                query,
            ),
        ).rejects.toThrow(/ORDER BY parentcustomerid/);
    });

    it('fills every SELECT reference of a grouped column', async () => {
        const { query } = limitedQuery(() => ({
            value: [
                { accountid: '1', name: 'Contoso' },
                { accountid: '2', name: 'Contoso' },
            ],
        }));
        const result = await run('SELECT name, name AS label, COUNT(*) AS n FROM account GROUP BY name', query);
        expect(result.rows).toEqual([{ name: 'Contoso', label: 'Contoso', n: 2 }]);
        expect(result.columns).toEqual(['name', 'label', 'n']);
    });

    it('fills a grouped column HAVING adds under a hidden alias', async () => {
        const { query } = limitedQuery(() => ({
            value: [
                { accountid: '1', name: 'Contoso', statecode: 0 },
                { accountid: '2', name: 'Fabrikam', statecode: 0 },
                { accountid: '3', name: 'Fabrikam', statecode: 1 },
            ],
        }));
        const result = await run(
            "SELECT statecode, COUNT(*) AS n FROM account GROUP BY statecode, name HAVING name LIKE 'F%' ORDER BY statecode",
            query,
        );
        expect(result.rows).toEqual([
            { statecode: 0, n: 1 },
            { statecode: 1, n: 1 },
        ]);
    });

    it('sorts by a grouped column that is only in ORDER BY, then applies TOP', async () => {
        const { query } = limitedQuery(() => ({
            value: [
                { contactid: '1', statecode: 2 },
                { contactid: '2', statecode: 0 },
                { contactid: '3', statecode: 2 },
                { contactid: '4', statecode: 1 },
            ],
        }));
        const result = await run(
            'SELECT TOP 2 COUNT(*) AS c FROM contact GROUP BY statecode ORDER BY statecode DESC',
            query,
        );
        expect(result.rows).toEqual([{ c: 2 }, { c: 1 }]);
        expect(result.columns).toEqual(['c']);
    });

    it('averages over the numeric values only', async () => {
        const { query } = limitedQuery(() => ({
            value: [
                { accountid: '1', x: 10 },
                { accountid: '2', x: 'n/a' },
                { accountid: '3', x: 20 },
            ],
        }));
        const result = await run('SELECT AVG(x) AS a, SUM(x) AS s, COUNT(x) AS c FROM account', query);
        expect(result.rows).toEqual([{ a: 15, s: 30, c: 3 }]);
    });

    it('counts DISTINCT case-insensitively per group', async () => {
        const { query } = limitedQuery(() => ({
            value: [
                { accountid: '1', statecode: 0, name: 'A' },
                { accountid: '2', statecode: 0, name: 'a' },
                { accountid: '3', statecode: 0, name: 'B' },
                { accountid: '4', statecode: 1, name: 'B' },
            ],
        }));
        const result = await run(
            'SELECT statecode, COUNT(DISTINCT name) AS d FROM account GROUP BY statecode ORDER BY statecode',
            query,
        );
        expect(result.rows).toEqual([
            { statecode: 0, d: 2 },
            { statecode: 1, d: 1 },
        ]);
    });

    it('does not note a missing paging cookie on a native aggregate with 5,000 groups', async () => {
        const query: FetchXmlQueryFn = async () => ({
            value: Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => ({ name: String(i), n: 1 })),
        });
        const result = await run('SELECT name, COUNT(*) AS n FROM account GROUP BY name', query);
        expect(result.limitNote).toBeUndefined();
    });

    it('re-reads a client-filtered scan with ORDER BY by primary key, then sorts client-side', async () => {
        const notOn = (attr: string) =>
            new Error(
                `0x80041103: 'account' entity doesn't contain attribute with Name = '${attr}' and NameMapping = 'Logical'`,
            );
        const row = (i: number) => ({
            accountid: guid(i),
            name: `n${String(10_000 - i).padStart(5, '0')}`,
            _ownerid_value: 'u',
            // Only the last row of page 1 and the rows after it match the filter.
            [`_ownerid_value${FMT}`]: i >= 4999 ? 'Ada' : 'Bob',
        });
        const calls: string[] = [];
        const query: FetchXmlQueryFn = async (xml) => {
            calls.push(xml);
            if (xml.includes('owneridname')) throw notOn('owneridname');
            if (calls.length === 2) return { value: Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => row(i)) };
            if (!xml.includes('operator="gt"'))
                return { value: Array.from({ length: SCAN_PAGE_SIZE }, (_, i) => row(i)) };
            return { value: [row(5000), row(5001)] };
        };
        const result = await executeSelect(
            parse(tokenize("SELECT name, owneridname FROM account WHERE owneridname = 'Ada' ORDER BY name")),
            query,
            { rowLimit: 3 },
        );
        // Page 1 in user order, then a re-read ordered by the key alone, continued by keyset.
        expect(calls[1]).toContain('<order attribute="name" />');
        expect(calls[2]).not.toContain('<order attribute="name" />');
        expect(calls[2]).toContain('<order attribute="accountid" />');
        expect(calls[3]).toContain(`<condition attribute="accountid" operator="gt" value="${guid(4999)}" />`);
        expect(result.rows.map((r) => r.name)).toEqual(['n04999', 'n05000', 'n05001']);
    });
});
