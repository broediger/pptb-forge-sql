import type { SelectStatement } from './types';
import { isColumnRef } from './types';

// Paged scans order by the primary key so paging cookies stay stable. Most
// tables key on `<table>id`; activity tables share `activityid` from
// activitypointer.

/** Standard activity tables. Custom activity tables are caught by `withActivityKey`. */
const ACTIVITY_TABLES = new Set([
    'activitypointer',
    'appointment',
    'bulkoperation',
    'campaignactivity',
    'campaignresponse',
    'email',
    'fax',
    'incidentresolution',
    'letter',
    'opportunityclose',
    'orderclose',
    'phonecall',
    'quoteclose',
    'recurringappointmentmaster',
    'serviceappointment',
    'socialactivity',
    'task',
    'untrackedemail',
]);

/** Primary key attribute of a table, for ordering paged scans. */
export function primaryKeyOf(table: string): string {
    const t = table.toLowerCase();
    return ACTIVITY_TABLES.has(t) ? 'activityid' : `${t}id`;
}

/**
 * Swap the guessed `<table>id` for `activityid` in a scan's columns and
 * order, for a custom activity table where Dataverse rejected `<table>id`.
 * Returns null when the statement doesn't use `<table>id`.
 */
export function withActivityKey(stmt: SelectStatement): SelectStatement | null {
    const guessed = `${stmt.from.table.toLowerCase()}id`;
    const isGuessed = (column: string, table?: string) => !table && column.toLowerCase() === guessed;
    if (!stmt.orderBy?.some((o) => isGuessed(o.column.column, o.column.table))) return null;
    return {
        ...stmt,
        columns: stmt.columns.map((c) =>
            isColumnRef(c) && isGuessed(c.column, c.table) ? { ...c, column: 'activityid' } : c,
        ),
        orderBy: stmt.orderBy.map((o) =>
            isGuessed(o.column.column, o.column.table) ? { ...o, column: { ...o.column, column: 'activityid' } } : o,
        ),
    };
}
