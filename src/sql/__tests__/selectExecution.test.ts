import { describe, it, expect } from 'vitest';
import { tokenize } from '../lexer';
import { parse } from '../parser';
import { executeSelect, fetchNextPage, injectPagingIntoFetchXml } from '../selectExecution';
import { IN_CHUNK_SIZE } from '../subquery';
import type { FetchXmlQueryFn, FetchXmlQueryResult } from '../selectExecution';

const COOKIE_KEY = '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie';

/** A fake `fetchXmlQuery` that answers each call from `respond` and records the FetchXML it got. */
const fakeQuery = (respond: (fetchXml: string, call: number) => FetchXmlQueryResult) => {
    const calls: string[] = [];
    const query: FetchXmlQueryFn = async (fetchXml) => {
        calls.push(fetchXml);
        return respond(fetchXml, calls.length);
    };
    return { query, calls };
};

const run = (sql: string, query: FetchXmlQueryFn) => executeSelect(parse(tokenize(sql)), query);

describe('executeSelect', () => {
    it('returns cleaned rows, requested columns, the FetchXML and the paging cookie', async () => {
        const { query, calls } = fakeQuery(() => ({
            value: [
                {
                    name: 'Contoso',
                    _ownerid_value: 'u1',
                    '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Ada',
                },
            ],
            [COOKIE_KEY]: '<cookie pagenumber="2" />',
        }));
        const result = await run('SELECT name, ownerid FROM account', query);
        expect(calls).toHaveLength(1);
        expect(result.fetchXml).toBe(calls[0]);
        expect(result.columns).toEqual(['name', 'ownerid']);
        expect(result.rows[0]).toMatchObject({ name: 'Contoso', ownerid: 'u1', owneridname: 'Ada' });
        expect(result.pagingCookie).toBe('<cookie pagenumber="2" />');
        expect(result.summary).toBe('1 rows returned');
    });

    it('lists requested columns that are null in every row', async () => {
        const { query } = fakeQuery(() => ({ value: [{ name: 'Contoso' }] }));
        const result = await run('SELECT name, telephone1 FROM account', query);
        expect(result.columns).toEqual(['name', 'telephone1']);
    });

    it('retries with the virtual-name rewrite when the literal attribute does not exist', async () => {
        const { query, calls } = fakeQuery((_xml, call) => {
            if (call === 1)
                throw new Error("'account' entity doesn't contain attribute with Name = 'owneridname' (0x80041103)");
            return {
                value: [{ _ownerid_value: 'u1', '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Ada' }],
            };
        });
        const result = await run('SELECT owneridname FROM account', query);
        expect(calls).toHaveLength(2);
        expect(calls[1]).toContain('<attribute name="ownerid"');
        expect(result.fetchXml).toBe(calls[1]);
        expect(result.rows[0].owneridname).toBe('Ada');
    });

    it('counts client-side when Dataverse rejects COUNT(*) over 50,000 records', async () => {
        const progress: number[] = [];
        const { query, calls } = fakeQuery((_xml, call) => {
            if (call === 1) throw new Error('AggregateQueryRecordLimit exceeded (0x8004e023)');
            if (call === 2) return { value: [{ accountid: 'a' }, { accountid: 'b' }], [COOKIE_KEY]: 'c1' };
            return { value: [{ accountid: 'c' }] };
        });
        const result = await executeSelect(parse(tokenize('SELECT COUNT(*) FROM account')), query, {
            onProgress: (n) => progress.push(n),
        });
        expect(calls).toHaveLength(3);
        expect(calls[2]).toContain('page="2"');
        expect(result.rows).toEqual([{ count_all: 3 }]);
        expect(result.columns).toEqual(['count_all']);
        expect(progress).toEqual([2, 3]);
        expect(result.pagingCookie).toBeNull();
        expect(result.fetchXml).toContain('0x8004e023');
    });

    it('reports the query FetchXML before it fails', async () => {
        const seen: string[] = [];
        const { query } = fakeQuery(() => {
            throw new Error('boom');
        });
        await expect(
            executeSelect(parse(tokenize('SELECT name FROM account')), query, { onFetchXml: (x) => seen.push(x) }),
        ).rejects.toThrow('boom');
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain('<entity name="account"');
    });

    it('errors when rows come back without any requested column', async () => {
        const { query } = fakeQuery(() => ({ value: [{ accountid: 'a' }] }));
        await expect(run('SELECT secretfield FROM account', query)).rejects.toThrow(/no readable columns/);
    });
});

describe('fetchNextPage', () => {
    it('injects the unwrapped paging cookie and page number', async () => {
        const { query, calls } = fakeQuery(() => ({ value: [{ name: 'Fabrikam' }] }));
        const pptbCookie = `<cookie pagenumber="2" pagingcookie="${encodeURIComponent(encodeURIComponent('<cookie page="1"></cookie>'))}" />`;
        const page = await fetchNextPage(query, '<fetch><entity name="account" /></fetch>', pptbCookie, 2, []);
        expect(calls[0]).toBe(injectPagingIntoFetchXml('<fetch><entity name="account" /></fetch>', pptbCookie, 2));
        expect(calls[0]).toContain('paging-cookie="&lt;cookie page=&quot;1&quot;&gt;&lt;/cookie&gt;"');
        expect(page.rows).toEqual([{ name: 'Fabrikam' }]);
        expect(page.pagingCookie).toBeNull();
    });
});

describe('executeSelect: WHERE on virtual name columns (#25)', () => {
    const notOn = (entity: string, attribute: string) =>
        new Error(
            `'${entity}' entity doesn't contain attribute with Name = '${attribute}' and NameMapping = 'Logical'. (0x80041103)`,
        );
    const FMT = '@OData.Community.Display.V1.FormattedValue';

    it('runs the query from the issue: filters client-side and orders activity tables by activityid', async () => {
        const sql = `select c.activityid, c.competitoridname, c.statecodename, a.owneridname, o.statecodename
            from opportunityclose c
            inner join dbo.opportunity as o on o.opportunityid = c.opportunityid
            inner join dbo.account as a on a.accountid = o.accountid
            where c.competitoridname like '%Nihon%'`;
        const { query, calls } = fakeQuery((xml) => {
            if (xml.includes('competitoridname')) throw notOn('opportunityclose', 'competitoridname');
            if (xml.includes('"opportunitycloseid"')) throw notOn('opportunityclose', 'opportunitycloseid');
            const row = (id: string, competitor: string) => ({
                activityid: id,
                _competitorid_value: `comp-${id}`,
                [`_competitorid_value${FMT}`]: competitor,
                statecode: 1,
                [`statecode${FMT}`]: 'Completed',
                'a.ownerid': 'u1',
                [`a.ownerid${FMT}`]: 'Ada',
                'o.statecode': 2,
                [`o.statecode${FMT}`]: 'Lost',
            });
            return { value: [row('1', 'Nihon Kohden'), row('2', 'Contoso'), row('3', 'NIHON Inc')] };
        });
        const result = await run(sql, query);

        expect(calls).toHaveLength(2);
        expect(calls[1]).not.toContain('competitoridname');
        expect(calls[1]).toContain('<order attribute="activityid"');
        expect(calls[1]).toContain('<attribute name="competitorid" />');
        expect(result.rows.map((r) => r.activityid)).toEqual(['1', '3']);
        expect(result.columns).toEqual([
            'activityid',
            'competitoridname',
            'statecodename',
            'a.owneridname',
            'o.statecodename',
        ]);
        expect(result.rows[0]).toMatchObject({
            competitoridname: 'Nihon Kohden',
            statecodename: 'Completed',
            'a.owneridname': 'Ada',
            'o.statecodename': 'Lost',
        });
        expect(result.pagingCookie).toBeNull();
        expect(result.fetchXml).toMatch(/^<!-- WHERE c\.competitoridname LIKE '%Nihon%' is evaluated client-side/);
        expect(result.fetchXml).toContain('3 row(s) read, 2 matched');
        expect(result.summary).toBe("2 of 3 rows matched the client-side filter on 'c.competitoridname'");
    });

    it('reads further pages until TOP rows matched', async () => {
        const { query, calls } = fakeQuery((xml) => {
            if (xml.includes('owneridname')) throw notOn('account', 'owneridname');
            const owner = (name: string) => ({ _ownerid_value: 'u', [`_ownerid_value${FMT}`]: name });
            if (!xml.includes('paging-cookie'))
                return { value: [{ name: 'a', ...owner('Bob') }], [COOKIE_KEY]: '<cookie pagenumber="2" />' };
            return {
                value: [
                    { name: 'b', ...owner('Ada') },
                    { name: 'c', ...owner('Ada') },
                ],
            };
        });
        const result = await run("SELECT TOP 1 name FROM account WHERE owneridname = 'ada'", query);
        expect(calls).toHaveLength(3);
        expect(calls[1]).not.toContain('top=');
        expect(result.rows.map((r) => r.name)).toEqual(['b']);
    });

    it('stops reading once TOP rows matched', async () => {
        const { query, calls } = fakeQuery((xml) => {
            if (xml.includes('owneridname')) throw notOn('account', 'owneridname');
            return {
                value: [{ name: 'a', _ownerid_value: 'u', [`_ownerid_value${FMT}`]: 'Ada' }],
                [COOKIE_KEY]: '<cookie pagenumber="2" />',
            };
        });
        const result = await run("SELECT TOP 1 name FROM account WHERE owneridname = 'Ada'", query);
        expect(calls).toHaveLength(2);
        expect(result.rows).toHaveLength(1);
        expect(result.fetchXml).toContain('(stopped at TOP)');
    });

    it('reports the FetchXML actually sent, including the paging order', async () => {
        const seen: string[] = [];
        const { query } = fakeQuery((xml) => {
            if (xml.includes('owneridname')) throw notOn('email', 'owneridname');
            if (xml.includes('"emailid"')) throw notOn('email', 'emailid');
            return { value: [] };
        });
        await executeSelect(parse(tokenize("SELECT subject FROM email WHERE owneridname = 'Ada'")), query, {
            onFetchXml: (x) => seen.push(x),
        });
        expect(seen.at(-1)).toContain('<order attribute="activityid"');
    });

    it('orders a custom activity table by activityid after Dataverse rejects <table>id', async () => {
        const { query, calls } = fakeQuery((xml) => {
            if (xml.includes('owneridname')) throw notOn('new_visit', 'owneridname');
            if (xml.includes('"new_visitid"')) throw notOn('new_visit', 'new_visitid');
            return { value: [] };
        });
        await run("SELECT subject FROM new_visit WHERE owneridname = 'Ada'", query);
        expect(calls).toHaveLength(3);
        expect(calls[2]).toContain('<order attribute="activityid"');
    });

    it('counts activity tables over 50,000 records by activityid', async () => {
        const { query, calls } = fakeQuery((_xml, call) => {
            if (call === 1) throw new Error('AggregateQueryRecordLimit exceeded (0x8004e023)');
            return { value: [{ activityid: 'a' }] };
        });
        const result = await run('SELECT COUNT(*) FROM email', query);
        expect(calls[1]).toContain('<order attribute="activityid"');
        expect(result.rows).toEqual([{ count_all: 1 }]);
    });

    it('orders a subquery scan on an activity table by activityid', async () => {
        const { query, calls } = fakeQuery((xml) => {
            if (xml.includes('"emailid"')) throw notOn('email', 'emailid');
            if (xml.includes('entity name="email"')) return { value: [{ _regardingobjectid_value: 'a1' }] };
            return { value: [{ name: 'Contoso' }] };
        });
        const result = await run(
            "SELECT name FROM account WHERE accountid IN (SELECT regardingobjectid FROM email WHERE subject LIKE '%x%')",
            query,
        );
        expect(calls[0]).toContain('<order attribute="activityid"');
        expect(result.rows).toEqual([{ name: 'Contoso' }]);
    });

    it('sorts client-side on a filtered display name, then applies TOP', async () => {
        const { query, calls } = fakeQuery((xml) => {
            if (xml.includes('owneridname')) throw notOn('account', 'owneridname');
            const row = (name: string, owner: string) => ({
                name,
                _ownerid_value: 'u',
                [`_ownerid_value${FMT}`]: owner,
            });
            return { value: [row('1', 'Anna'), row('2', 'Bob'), row('3', 'Ada'), row('4', 'Abe')] };
        });
        const result = await run(
            "SELECT TOP 2 name, owneridname FROM account WHERE owneridname LIKE 'A%' ORDER BY owneridname",
            query,
        );
        expect(calls).toHaveLength(2);
        expect(calls[1]).not.toMatch(/<order attribute="owner/);
        expect(result.rows.map((r) => r.owneridname)).toEqual(['Abe', 'Ada']);
        expect(result.fetchXml).toContain('ORDER BY is sorted client-side');
    });

    it('stops at the row limit and says more rows match', async () => {
        const { query, calls } = fakeQuery((xml) => {
            if (xml.includes('owneridname')) throw notOn('account', 'owneridname');
            const rows = [1, 2, 3].map((n) => ({
                name: String(n),
                _ownerid_value: 'u',
                [`_ownerid_value${FMT}`]: 'Ada',
            }));
            return { value: rows, [COOKIE_KEY]: '<cookie pagenumber="2" />' };
        });
        const result = await executeSelect(
            parse(tokenize("SELECT name FROM account WHERE owneridname = 'Ada'")),
            query,
            {
                rowLimit: 2,
            },
        );
        expect(calls).toHaveLength(2);
        expect(result.rows).toHaveLength(2);
        expect(result.pagingCookie).toBeNull();
        expect(result.limitNote).toMatch(/^Showing the first 2 matches/);
        expect(result.fetchXml).toContain('(stopped at the row limit)');
    });

    it('does not claim more rows when exactly the limit matched', async () => {
        const { query, calls } = fakeQuery((xml) => {
            if (xml.includes('owneridname')) throw notOn('account', 'owneridname');
            const owner = (name: string) => ({ _ownerid_value: 'u', [`_ownerid_value${FMT}`]: name });
            if (!xml.includes('paging-cookie')) {
                return {
                    value: [
                        { name: '1', ...owner('Ada') },
                        { name: '2', ...owner('Ada') },
                    ],
                    [COOKIE_KEY]: '<cookie pagenumber="2" />',
                };
            }
            return { value: [{ name: '3', ...owner('Bob') }] };
        });
        const result = await executeSelect(
            parse(tokenize("SELECT name FROM account WHERE owneridname = 'Ada'")),
            query,
            {
                rowLimit: 2,
            },
        );
        expect(calls).toHaveLength(3);
        expect(result.rows).toHaveLength(2);
        expect(result.limitNote).toBeUndefined();
    });

    it('adds the primary key as a paging tiebreaker after ORDER BY', async () => {
        const { query, calls } = fakeQuery((xml) => {
            if (xml.includes('owneridname')) throw notOn('account', 'owneridname');
            return { value: [] };
        });
        await run("SELECT name FROM account WHERE owneridname = 'Ada' ORDER BY createdon DESC", query);
        expect(calls[1]).toMatch(/<order attribute="createdon" descending="true" \/>\s*<order attribute="accountid"/);
    });

    it('does not add a limit note when every match fits', async () => {
        const { query } = fakeQuery((xml) => {
            if (xml.includes('owneridname')) throw notOn('account', 'owneridname');
            return { value: [{ name: '1', _ownerid_value: 'u', [`_ownerid_value${FMT}`]: 'Ada' }] };
        });
        const result = await executeSelect(
            parse(tokenize("SELECT name FROM account WHERE owneridname = 'Ada'")),
            query,
            {
                rowLimit: 1,
            },
        );
        expect(result.limitNote).toBeUndefined();
    });

    it('explains matched rows without readable columns', async () => {
        const { query } = fakeQuery((xml) => {
            if (xml.includes('owneridname')) throw notOn('contact', 'owneridname');
            return { value: [{ contactid: 'c', _ownerid_value: 'u', [`_ownerid_value${FMT}`]: 'Ada' }] };
        });
        await expect(run("SELECT secretfield FROM contact WHERE owneridname = 'Ada'", query)).rejects.toThrow(
            /no readable columns/,
        );
    });

    it('learns rejected attributes once across the parts of a split query', async () => {
        const ids = Array.from({ length: IN_CHUNK_SIZE + 1 }, (_, i) => `c${i}`);
        const { query, calls } = fakeQuery((xml) => {
            if (xml.includes('owneridname')) throw notOn('account', 'owneridname');
            if (xml.includes('entity name="contact"')) return { value: ids.map((id) => ({ contactid: id })) };
            return { value: [] };
        });
        await run(
            "SELECT name FROM account WHERE owneridname = 'Ada' AND primarycontactid IN (SELECT contactid FROM contact)",
            query,
        );
        const failed = calls.filter((xml) => xml.includes('owneridname'));
        expect(failed).toHaveLength(1);
    });

    it('copies an aliased display name to its alias', async () => {
        const { query } = fakeQuery((xml) => {
            if (xml.includes('owneridname')) throw notOn('account', 'owneridname');
            return { value: [{ _ownerid_value: 'u', [`_ownerid_value${FMT}`]: 'Ada' }] };
        });
        const result = await run("SELECT owneridname AS owner FROM account WHERE owneridname = 'Ada'", query);
        expect(result.columns).toEqual(['owner']);
        expect(result.rows[0].owner).toBe('Ada');
    });

    it('reports a mistyped column instead of returning no rows', async () => {
        const { query, calls } = fakeQuery((xml) => {
            if (xml.includes('"fulname"')) throw notOn('account', 'fulname');
            if (xml.includes('"ful"')) throw notOn('account', 'ful');
            return { value: [{ name: 'a' }] };
        });
        await expect(run("SELECT name FROM account WHERE fulname = 'x'", query)).rejects.toThrow(/'fulname'/);
        expect(calls).toHaveLength(2);
    });

    it('filters a subquery on a virtual name column', async () => {
        const { query, calls } = fakeQuery((xml) => {
            if (xml.includes('owneridname')) throw notOn('contact', 'owneridname');
            if (xml.includes('entity name="contact"')) {
                const contact = (parent: string, owner: string) => ({
                    _parentcustomerid_value: parent,
                    _ownerid_value: 'u',
                    [`_ownerid_value${FMT}`]: owner,
                });
                return { value: [contact('a1', 'Bob'), contact('a2', 'Ada')] };
            }
            return { value: [{ name: 'Contoso' }] };
        });
        const result = await run(
            "SELECT name FROM account WHERE accountid IN (SELECT parentcustomerid FROM contact WHERE owneridname = 'Bob')",
            query,
        );
        expect(calls.at(-1)).toContain('<value>a1</value>');
        expect(calls.at(-1)).not.toContain('a2');
        expect(result.rows).toEqual([{ name: 'Contoso' }]);
    });

    it('explains why HAVING with a virtual name condition cannot run', async () => {
        const { query } = fakeQuery(() => {
            throw notOn('account', 'owneridname');
        });
        await expect(
            run(
                "SELECT name, COUNT(*) FROM account WHERE owneridname = 'Ada' GROUP BY name HAVING COUNT(*) > 1",
                query,
            ),
        ).rejects.toThrow(/GROUP BY, DISTINCT, aggregates or HAVING/);
    });

    it('falls back to the SELECT rewrite when an unnamed error meets GROUP BY', async () => {
        const { query, calls } = fakeQuery((_xml, call) => {
            if (call === 1) throw new Error('Attribute not found (0x80041103)');
            return {
                value: [{ ownerid: 'u', 'ownerid@OData.Community.Display.V1.FormattedValue': 'Ada', count_all: 2 }],
            };
        });
        await run("SELECT owneridname, COUNT(*) FROM account WHERE fullname LIKE 'a%' GROUP BY owneridname", query);
        expect(calls).toHaveLength(2);
        expect(calls[1]).toContain('<condition attribute="fullname" operator="like"');
    });

    it('keeps learning attributes to avoid until the query runs', async () => {
        const { query, calls } = fakeQuery((xml) => {
            if (xml.includes('"owneridname"')) throw notOn('account', 'owneridname');
            if (xml.includes('"fullname"')) throw notOn('account', 'fullname');
            if (xml.includes('"full"')) throw notOn('account', 'full');
            return { value: [] };
        });
        const result = await run("SELECT fullname FROM account WHERE owneridname = 'Ada'", query);
        expect(result.rows).toEqual([]);
        expect(calls.at(-1)).not.toMatch(/"(fullname|full|owneridname)"/);
    });

    it('surfaces the error when a missing attribute is not a display name', async () => {
        const { query, calls } = fakeQuery(() => {
            throw notOn('account', 'nosuchcolumn');
        });
        await expect(run("SELECT name FROM account WHERE nosuchcolumn = 'x'", query)).rejects.toThrow(/nosuchcolumn/);
        expect(calls).toHaveLength(1);
    });

    it('stops when Dataverse keeps rejecting the same attribute', async () => {
        const { query, calls } = fakeQuery(() => {
            throw notOn('account', 'owneridname');
        });
        await expect(run("SELECT name FROM account WHERE owneridname = 'Ada'", query)).rejects.toThrow(/owneridname/);
        expect(calls).toHaveLength(2);
    });
});
