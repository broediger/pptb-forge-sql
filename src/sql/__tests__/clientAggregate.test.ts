import { describe, it, expect } from 'vitest';
import { tokenize } from '../lexer';
import { parse } from '../parser';
import { generateFetchXml } from '../generator';
import { executeSelect, type FetchXmlQueryFn, type FetchXmlQueryResult } from '../selectExecution';
import type { SelectExecutionOptions } from '../selectExecution';
import {
    SCAN_PAGE_SIZE,
    isPlainTableCount,
    keysetCondition,
    parseTotalRecordCount,
    planClientAggregate,
} from '../clientAggregate';

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

    it('uses RetrieveTotalRecordCount for a plain COUNT(*), and scans when it fails', async () => {
        const { query, calls } = limitedQuery(() => ({ value: [{ accountid: '1' }] }));
        const snapshot = await run('SELECT COUNT(*) AS n FROM account', query, {
            totalRecordCount: async () => 123_456,
        });
        expect(snapshot.rows).toEqual([{ n: 123_456 }]);
        expect(snapshot.fetchXml).toContain('RetrieveTotalRecordCount');
        expect(calls).toHaveLength(1);

        const scanned = await run('SELECT COUNT(*) AS n FROM account', query, {
            totalRecordCount: async () => {
                throw new Error('not supported');
            },
        });
        expect(scanned.rows).toEqual([{ n: 1 }]);
    });

    it('does not use RetrieveTotalRecordCount with a filter or join', async () => {
        let used = false;
        const { query } = limitedQuery(() => ({ value: [] }));
        await run('SELECT COUNT(*) FROM account WHERE statecode = 0', query, {
            totalRecordCount: async () => ((used = true), 1),
        });
        expect(used).toBe(false);
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

    it('builds the keyset condition with NULL-aware comparisons', () => {
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
    });

    it('recognises a plain table count', () => {
        expect(isPlainTableCount(parse(tokenize('SELECT COUNT(*) FROM account')))).toBe(true);
        expect(isPlainTableCount(parse(tokenize('SELECT COUNT(*) FROM account WHERE statecode = 0')))).toBe(false);
        expect(isPlainTableCount(parse(tokenize('SELECT COUNT(name) FROM account')))).toBe(false);
    });

    it('reads a RetrieveTotalRecordCount response', () => {
        const response = { EntityRecordCountCollection: { Count: 1, Keys: ['account'], Values: [204_123] } };
        expect(parseTotalRecordCount(response, 'Account')).toBe(204_123);
        expect(parseTotalRecordCount(response, 'contact')).toBeNull();
        expect(parseTotalRecordCount({}, 'account')).toBeNull();
    });
});
