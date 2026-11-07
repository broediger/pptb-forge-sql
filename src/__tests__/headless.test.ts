import { describe, it, expect } from 'vitest';
import { runHeadlessQuery, resolveMaxRows } from '../headless';
import type { FetchXmlQueryFn } from '../sql/selectExecution';

const respondWith = (value: Record<string, unknown>[], pagingCookie?: string) => {
    const calls: string[] = [];
    const query: FetchXmlQueryFn = async (fetchXml) => {
        calls.push(fetchXml);
        return { value, '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie': pagingCookie };
    };
    return { query, calls };
};

describe('runHeadlessQuery', () => {
    it('returns rows projected onto the result columns, with nulls filled in', async () => {
        const { query } = respondWith([
            {
                name: 'Contoso',
                _ownerid_value: 'u1',
                '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Ada',
            },
            { name: 'Fabrikam' },
        ]);
        const result = await runHeadlessQuery({ sql: 'SELECT name, owneridname, telephone1 FROM account' }, query);
        expect(result.status).toBe('success');
        expect(result.columns).toEqual(['name', 'owneridname', 'telephone1']);
        expect(result.rows).toEqual([
            { name: 'Contoso', owneridname: 'Ada', telephone1: null },
            { name: 'Fabrikam', owneridname: null, telephone1: null },
        ]);
        expect(result.moreRecords).toBe(false);
        expect(result.fetchXml).toContain('<entity name="account"');
    });

    it('truncates to maxRows and flags moreRecords', async () => {
        const { query } = respondWith([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
        const result = await runHeadlessQuery({ sql: 'SELECT name FROM account', maxRows: 2 }, query);
        expect(result.rowCount).toBe(2);
        expect(result.moreRecords).toBe(true);
        expect(result.summary).toContain('returning the first 2');
    });

    it('flags moreRecords when Dataverse has another page', async () => {
        const { query } = respondWith([{ name: 'a' }], '<cookie />');
        const result = await runHeadlessQuery({ sql: 'SELECT name FROM account' }, query);
        expect(result.moreRecords).toBe(true);
    });

    it.each([
        "INSERT INTO account (name) VALUES ('x')",
        "UPDATE account SET name = 'x' WHERE name = 'y'",
        "DELETE FROM account WHERE name = 'x'",
    ])('rejects DML without calling Dataverse: %s', async (sql) => {
        const { query, calls } = respondWith([]);
        const result = await runHeadlessQuery({ sql }, query);
        expect(result.status).toBe('error');
        expect(result.error).toMatch(/Only SELECT statements/);
        expect(calls).toHaveLength(0);
    });

    it('reports a missing sql parameter', async () => {
        const { query } = respondWith([]);
        expect(await runHeadlessQuery({}, query)).toEqual({
            status: 'error',
            error: 'Missing required parameter: sql.',
        });
    });

    it('reports parse errors with their position', async () => {
        const { query } = respondWith([]);
        const result = await runHeadlessQuery({ sql: 'SELEC name FROM account' }, query);
        expect(result.status).toBe('error');
        expect(result.error).toMatch(/^SQL parse error at line 1, column 1/);
    });

    it('returns Dataverse errors with the FetchXML that failed', async () => {
        const query: FetchXmlQueryFn = async () => {
            throw new Error('Principal user is missing prvReadAccount privilege');
        };
        const result = await runHeadlessQuery({ sql: 'SELECT name FROM account' }, query);
        expect(result.status).toBe('error');
        expect(result.error).toContain('prvReadAccount');
        expect(result.fetchXml).toContain('<entity name="account"');
    });
});

describe('resolveMaxRows', () => {
    it.each([
        [undefined, 500],
        ['10', 500],
        [0, 500],
        [-3, 500],
        [Number.NaN, 500],
        [25.7, 25],
        [100_000, 5000],
    ])('%s → %s', (input, expected) => {
        expect(resolveMaxRows(input)).toBe(expected);
    });
});

describe('runHeadlessQuery with a client-side filter', () => {
    it('stops at maxRows and flags moreRecords', async () => {
        const calls: string[] = [];
        const query: FetchXmlQueryFn = async (fetchXml) => {
            calls.push(fetchXml);
            if (fetchXml.includes('owneridname')) {
                throw new Error(
                    "'account' entity doesn't contain attribute with Name = 'owneridname' and NameMapping = 'Logical'. (0x80041103)",
                );
            }
            const row = (name: string) => ({
                name,
                _ownerid_value: 'u',
                '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Ada',
            });
            return {
                value: [row('a'), row('b'), row('c')],
                '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie': '<cookie pagenumber="2" />',
            };
        };
        const result = await runHeadlessQuery(
            { sql: "SELECT name FROM account WHERE owneridname = 'Ada'", maxRows: 2 },
            query,
        );
        expect(calls).toHaveLength(2);
        expect(result.rows).toEqual([{ name: 'a' }, { name: 'b' }]);
        expect(result.moreRecords).toBe(true);
        expect(result.summary).toMatch(/^Showing the first 2 matches/);
    });
});
