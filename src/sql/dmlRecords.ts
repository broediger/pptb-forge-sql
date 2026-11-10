// Records an UPDATE or DELETE changes (#40). Dataverse returns at most 5,000
// records per page, so the lookup pages through all of them with the paging
// cookie, ordered by the primary key.

import { generateFetchXml } from './generator';
import { primaryKeyOf } from './primaryKey';
import { injectPagingIntoFetchXml, type FetchXmlQueryFn } from './selectExecution';
import type { SelectStatement, WhereExpr } from './types';

const PAGING_COOKIE_KEY = '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie';

/** Default for the most records one UPDATE or DELETE may change (setting `maxDmlRecords`). */
export const DEFAULT_MAX_DML_RECORDS = 100_000;
/** Highest value the setting accepts. */
export const MAX_DML_RECORDS_LIMIT = 1_000_000;

/** The setting's value as a usable limit: whole, between 1 and MAX_DML_RECORDS_LIMIT. */
export function clampMaxDmlRecords(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return DEFAULT_MAX_DML_RECORDS;
    return Math.max(1, Math.min(MAX_DML_RECORDS_LIMIT, Math.floor(n)));
}

/** Records kept for the confirmation dialog's preview. */
const SAMPLE_SIZE = 5;

export interface DmlRecordsOptions {
    /** Defaults to DEFAULT_MAX_DML_RECORDS. */
    maxRecords?: number;
    /** Records found so far, after each page. */
    onProgress?: (found: number) => void;
    /** Checked before each page; the lookup stops when it returns true. */
    isCancelled?: () => boolean;
}

export interface DmlRecords {
    ids: string[];
    /** The first records, for the preview. */
    sampleRows: Record<string, unknown>[];
    cancelled: boolean;
}

/** FetchXML that selects the primary key of every matching record, ordered by it for paging. */
export function dmlRecordsFetchXml(table: string, where: WhereExpr): string {
    const primaryKey = primaryKeyOf(table);
    const select: SelectStatement = {
        type: 'select',
        columns: [{ column: primaryKey }],
        from: { table },
        joins: [],
        where,
        orderBy: [{ column: { column: primaryKey }, direction: 'ASC' }],
    };
    return generateFetchXml(select);
}

/** IDs of every record matching `where`, read page by page. */
export async function resolveDmlRecords(
    query: FetchXmlQueryFn,
    table: string,
    where: WhereExpr,
    options: DmlRecordsOptions = {},
): Promise<DmlRecords> {
    const maxRecords = options.maxRecords ?? DEFAULT_MAX_DML_RECORDS;
    const primaryKey = primaryKeyOf(table);
    const fetchXml = dmlRecordsFetchXml(table, where);
    const ids = new Set<string>();
    const sampleRows: Record<string, unknown>[] = [];
    let pagingCookie: string | null = null;

    for (let page = 1; ; page++) {
        if (options.isCancelled?.()) return { ids: [...ids], sampleRows, cancelled: true };
        const result = await query(page === 1 ? fetchXml : injectPagingIntoFetchXml(fetchXml, pagingCookie!, page));
        const rows = result.value ?? [];
        for (const row of rows) {
            const id = row[primaryKey];
            if (typeof id !== 'string' || !id || ids.has(id)) continue;
            ids.add(id);
            if (sampleRows.length < SAMPLE_SIZE) sampleRows.push(row);
        }
        if (ids.size > maxRecords) {
            throw new Error(
                `The statement matches more than ${maxRecords.toLocaleString('en-US')} records in '${table}'. ` +
                    'Narrow the WHERE clause and run it in parts, or raise "Max records per statement" in the settings.',
            );
        }
        options.onProgress?.(ids.size);
        pagingCookie = result[PAGING_COOKIE_KEY] ?? null;
        if (!pagingCookie || rows.length === 0) break;
    }
    return { ids: [...ids], sampleRows, cancelled: false };
}
