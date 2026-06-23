import { describe, it, expect } from 'vitest';
import { tokenize } from '../lexer';
import { parse } from '../parser';
import type { SelectStatement } from '../types';
import {
    cleanRows,
    extractColumns,
    getRequestedColumns,
    resolveRequestedColumns,
    unresolvedVirtualColumns,
    rewriteVirtualColumns,
} from '../columnResolution';

const parseSelect = (sql: string): SelectStatement => {
    const stmt = parse(tokenize(sql));
    if (stmt.type !== 'select') throw new Error('expected a SELECT statement');
    return stmt;
};

// Helper: simulate the column resolution that useQueryExecution performs after
// a query returns, including the silent-drop recovery (rewrite + re-run).
function resolveWithRecovery(
    sql: string,
    literalResponse: Record<string, unknown>[],
    rewrittenResponse: (rewritten: SelectStatement) => Record<string, unknown>[],
): { columns: string[]; rewrittenTo: string[] | null } {
    const stmt = parseSelect(sql);
    const requestedCols = getRequestedColumns(stmt);
    if (!requestedCols) throw new Error('test expects explicit columns');

    let rows = cleanRows(literalResponse);
    let allColumns = extractColumns(rows, false);
    let columns = resolveRequestedColumns(requestedCols, allColumns, rows[0] ?? {});
    let rewrittenTo: string[] | null = null;

    if (rows.length > 0) {
        const unresolved = unresolvedVirtualColumns(requestedCols, allColumns, rows[0] ?? {});
        if (unresolved.size > 0) {
            const rewritten = rewriteVirtualColumns(stmt, unresolved);
            if (rewritten !== stmt) {
                rewrittenTo = rewritten.columns.map((c) => ('function' in c ? c.function : c.column));
                rows = cleanRows(rewrittenResponse(rewritten));
                allColumns = extractColumns(rows, false);
                const retryColumns = resolveRequestedColumns(requestedCols, allColumns, rows[0] ?? {});
                if (retryColumns.length > columns.length) columns = retryColumns;
            }
        }
    }
    return { columns, rewrittenTo };
}

// A Dataverse response for `ownerid` with its OData formatted-value annotation.
const ownerRow = () => ({
    accountid: 'acc-1',
    '_ownerid_value': 'owner-guid-1',
    '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'dynamics-func-app',
    '_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'systemuser',
});

describe('column resolution — virtual lookup name recovery (issue: owneridname)', () => {
    it('recovers when Dataverse silently drops a lone owneridname column', () => {
        // Literal `SELECT owneridname FROM account`: Dataverse ignores the
        // unknown attribute and returns rows with no owner data.
        const literal = [{ accountid: 'acc-1' }, { accountid: 'acc-2' }];
        const { columns, rewrittenTo } = resolveWithRecovery(
            'SELECT owneridname FROM account',
            literal,
            // After rewrite to `ownerid`, the formatted value comes back.
            () => [ownerRow()],
        );
        expect(rewrittenTo).toEqual(['ownerid']);
        expect(columns).toEqual(['owneridname']);
    });

    it('cleanRows exposes the formatted lookup value as owneridname', () => {
        const cleaned = cleanRows([ownerRow()]);
        expect(cleaned[0].owneridname).toBe('dynamics-func-app');
        expect(cleaned[0].ownerid).toBe('owner-guid-1');
    });

    it('resolves owneridname directly when ownerid is also selected (no rewrite)', () => {
        // `SELECT accountid, ownerid, owneridname FROM account` — ownerid is
        // requested, so the formatted value is present on the first pass.
        const { columns, rewrittenTo } = resolveWithRecovery(
            'SELECT accountid, ownerid, owneridname FROM account',
            [ownerRow()],
            () => {
                throw new Error('should not re-run when columns already resolve');
            },
        );
        expect(rewrittenTo).toBeNull();
        expect(columns).toEqual(['accountid', 'ownerid', 'owneridname']);
    });

    it('recovers only the unresolved name column, leaving a real *name attribute untouched', () => {
        // `SELECT name, owneridname FROM account` — `name` resolves on the first
        // pass; only `owneridname` needs the rewrite.
        const stmt = parseSelect('SELECT name, owneridname FROM account');
        const literal = cleanRows([{ accountid: 'acc-1', name: 'Fourth Coffee' }]);
        const requested = getRequestedColumns(stmt)!;
        const unresolved = unresolvedVirtualColumns(requested, extractColumns(literal, false), literal[0]);
        expect([...unresolved]).toEqual(['owneridname']);

        const rewritten = rewriteVirtualColumns(stmt, unresolved);
        const rewrittenNames = rewritten.columns.map((c) => ('function' in c ? c.function : c.column));
        // `name` is preserved; only `owneridname` becomes `ownerid`.
        expect(rewrittenNames).toEqual(['name', 'ownerid']);
    });

    it('does not flag a fully resolved real *name attribute as virtual', () => {
        // `fullname` is a genuine attribute; when it returns data it must not be
        // treated as an unresolved virtual name.
        const rows = cleanRows([{ systemuserid: 'u-1', fullname: 'Björn Rödiger' }]);
        const unresolved = unresolvedVirtualColumns(['fullname'], extractColumns(rows, false), rows[0]);
        expect(unresolved.size).toBe(0);
    });
});
