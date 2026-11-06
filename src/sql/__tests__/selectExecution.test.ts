import { describe, it, expect } from 'vitest';
import { tokenize } from '../lexer';
import { parse } from '../parser';
import { executeSelect, fetchNextPage, injectPagingIntoFetchXml } from '../selectExecution';
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
