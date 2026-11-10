import { describe, it, expect } from 'vitest';
import {
    clampMaxDmlRecords,
    dmlRecordsFetchXml,
    resolveDmlRecords,
    DEFAULT_MAX_DML_RECORDS,
    MAX_DML_RECORDS_LIMIT,
} from '../dmlRecords';
import type { FetchXmlQueryFn, FetchXmlQueryResult } from '../selectExecution';
import { tokenize } from '../lexer';
import { parse } from '../parser';

const COOKIE_KEY = '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie';
const cookie = (page: number) =>
    `<cookie pagenumber="${page}" pagingcookie="${encodeURIComponent(encodeURIComponent(`<cookie page="${page - 1}"></cookie>`))}" istracking="False" />`;

const where = parse(tokenize('SELECT name FROM account WHERE statecode = 1')).where!;

/** Pages of `size` account IDs; `total` records in all. */
function pagedAccounts(total: number, size: number) {
    const calls: string[] = [];
    const query: FetchXmlQueryFn = async (fetchXml) => {
        calls.push(fetchXml);
        const page = Number(/\bpage="(\d+)"/.exec(fetchXml)?.[1] ?? 1);
        const from = (page - 1) * size;
        const to = Math.min(from + size, total);
        const result: FetchXmlQueryResult = {
            value: Array.from({ length: to - from }, (_, i) => ({ accountid: `id-${from + i}` })),
        };
        if (to < total) result[COOKIE_KEY] = cookie(page + 1);
        return result;
    };
    return { query, calls };
}

describe('dmlRecordsFetchXml', () => {
    it('selects and orders by the primary key', () => {
        const xml = dmlRecordsFetchXml('account', where);
        expect(xml).toContain('<attribute name="accountid"');
        expect(xml).toMatch(/<order attribute="accountid"/);
    });

    it('uses activityid for activity tables', () => {
        expect(dmlRecordsFetchXml('email', where)).toMatch(/<order attribute="activityid"/);
    });
});

describe('resolveDmlRecords', () => {
    it('reads every page', async () => {
        const { query, calls } = pagedAccounts(12, 5);
        const result = await resolveDmlRecords(query, 'account', where);
        expect(calls).toHaveLength(3);
        expect(calls[1]).toContain('page="2"');
        expect(calls[2]).toContain('page="3"');
        expect(calls[1]).toContain('paging-cookie="&lt;cookie page=&quot;1&quot;&gt;&lt;/cookie&gt;"');
        expect(result.ids).toHaveLength(12);
        expect(result.ids[11]).toBe('id-11');
        expect(result.cancelled).toBe(false);
    });

    it('stops after one page without a paging cookie', async () => {
        const { query, calls } = pagedAccounts(3, 5);
        const result = await resolveDmlRecords(query, 'account', where);
        expect(calls).toHaveLength(1);
        expect(result.ids).toEqual(['id-0', 'id-1', 'id-2']);
    });

    it('keeps the first five records as a sample and drops duplicates', async () => {
        const query: FetchXmlQueryFn = async () => ({
            value: ['a', 'b', 'a', 'c', 'd', 'e', 'f', '', null].map((id) => ({ accountid: id })),
        });
        const result = await resolveDmlRecords(query, 'account', where);
        expect(result.ids).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        expect(result.sampleRows.map((r) => r.accountid)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('reports the records found after each page', async () => {
        const { query } = pagedAccounts(12, 5);
        const found: number[] = [];
        await resolveDmlRecords(query, 'account', where, { onProgress: (n) => found.push(n) });
        expect(found).toEqual([5, 10, 12]);
    });

    it('stops when cancelled', async () => {
        const { query, calls } = pagedAccounts(12, 5);
        let pages = 0;
        const result = await resolveDmlRecords(query, 'account', where, {
            onProgress: () => (pages += 1),
            isCancelled: () => pages >= 1,
        });
        expect(calls).toHaveLength(1);
        expect(result.cancelled).toBe(true);
    });

    it('rejects more records than the limit', async () => {
        const { query, calls } = pagedAccounts(12, 5);
        await expect(resolveDmlRecords(query, 'account', where, { maxRecords: 8 })).rejects.toThrow(
            "The statement matches more than 8 records in 'account'",
        );
        expect(calls).toHaveLength(2);
    });

    it('accepts exactly the limit', async () => {
        const { query } = pagedAccounts(10, 5);
        const result = await resolveDmlRecords(query, 'account', where, { maxRecords: 10 });
        expect(result.ids).toHaveLength(10);
    });
});

describe('clampMaxDmlRecords', () => {
    it('keeps whole numbers in range', () => {
        expect(clampMaxDmlRecords(250_000)).toBe(250_000);
        expect(clampMaxDmlRecords(1234.9)).toBe(1234);
    });

    it('clamps to 1 and the upper limit', () => {
        expect(clampMaxDmlRecords(0)).toBe(1);
        expect(clampMaxDmlRecords(-5)).toBe(1);
        expect(clampMaxDmlRecords(5_000_000)).toBe(MAX_DML_RECORDS_LIMIT);
    });

    it('falls back to the default for a stored value that is not a number', () => {
        expect(clampMaxDmlRecords(undefined)).toBe(DEFAULT_MAX_DML_RECORDS);
        expect(clampMaxDmlRecords('lots')).toBe(DEFAULT_MAX_DML_RECORDS);
        expect(clampMaxDmlRecords('50000')).toBe(50_000);
    });
});
