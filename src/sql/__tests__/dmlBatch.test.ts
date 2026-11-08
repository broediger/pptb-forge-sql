import { describe, it, expect } from 'vitest';
import {
    chunk,
    createOperations,
    deleteOperations,
    errorMessageOf,
    hintHeaders,
    withHeaders,
    summarizeTransaction,
    updateOperations,
    MAX_BATCH_OPERATIONS,
    type BatchOperationResult,
} from '../dmlBatch';

const GUID_A = '11111111-2222-3333-4444-555555555555';
const GUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const ok = (status = 204, headers: Record<string, string> = {}): BatchOperationResult => ({ status, headers });

describe('chunk', () => {
    it('splits into chunks of the given size', () => {
        expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    it('returns no chunks for no items', () => {
        expect(chunk([], 50)).toEqual([]);
    });

    it('clamps the size to the Dataverse batch limit', () => {
        const items = Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, (_, i) => i);
        expect(chunk(items, 5000).map((c) => c.length)).toEqual([MAX_BATCH_OPERATIONS, 1]);
    });

    it('treats a size below 1 or NaN as 1', () => {
        expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
        expect(chunk([1, 2], NaN)).toEqual([[1], [2]]);
    });
});

describe('operations', () => {
    it('builds POST operations against the entity set', () => {
        expect(createOperations('accounts', [{ name: 'A' }, { name: 'B' }])).toEqual([
            { method: 'POST', url: 'accounts', body: { name: 'A' }, contentId: '1' },
            { method: 'POST', url: 'accounts', body: { name: 'B' }, contentId: '2' },
        ]);
    });

    it('builds PATCH operations with the same values for every record', () => {
        expect(updateOperations('contacts', [GUID_A, GUID_B], { firstname: 'X' })).toEqual([
            { method: 'PATCH', url: `contacts(${GUID_A})`, body: { firstname: 'X' }, contentId: '1' },
            { method: 'PATCH', url: `contacts(${GUID_B})`, body: { firstname: 'X' }, contentId: '2' },
        ]);
    });

    it('builds DELETE operations without a body', () => {
        expect(deleteOperations('tasks', [GUID_A])).toEqual([
            { method: 'DELETE', url: `tasks(${GUID_A})`, contentId: '1' },
        ]);
    });
});

describe('summarizeTransaction', () => {
    it('counts every operation when all succeed', () => {
        const ops = deleteOperations('accounts', [GUID_A, GUID_B]);
        expect(summarizeTransaction(ops, [ok(), ok()])).toEqual({ succeeded: 2, createdIds: [] });
    });

    it('reads created IDs from the OData-EntityId header, any case', () => {
        const ops = createOperations('accounts', [{ name: 'A' }, { name: 'B' }]);
        const results = [
            ok(204, { 'odata-entityid': `https://org.crm.dynamics.com/api/data/v9.2/accounts(${GUID_A})` }),
            ok(204, { 'OData-EntityId': `https://org.crm.dynamics.com/api/data/v9.2/accounts(${GUID_B})` }),
        ];
        expect(summarizeTransaction(ops, results)).toEqual({ succeeded: 2, createdIds: [GUID_A, GUID_B] });
    });

    it('skips a created record without a usable header', () => {
        const ops = createOperations('accounts', [{ name: 'A' }]);
        expect(summarizeTransaction(ops, [ok(201, {})])).toEqual({ succeeded: 1, createdIds: [] });
    });

    it('reports a rollback with the Dataverse message and the failing operation', () => {
        const ops = updateOperations('accounts', [GUID_A, GUID_B], { name: 'X' });
        const failed: BatchOperationResult = {
            contentId: '2',
            status: 400,
            statusText: 'Bad Request',
            headers: {},
            body: { error: { code: '0x80040265', message: 'Plugin rejected the update' } },
        };
        expect(summarizeTransaction(ops, [failed])).toEqual({
            succeeded: 0,
            createdIds: [],
            error: 'Plugin rejected the update',
            failedIndex: 1,
        });
    });

    it('treats a failure after successful operations as a full rollback', () => {
        const ops = deleteOperations('accounts', [GUID_A, GUID_B]);
        const outcome = summarizeTransaction(ops, [ok(), { status: 404, statusText: 'Not Found', headers: {} }]);
        expect(outcome.succeeded).toBe(0);
        expect(outcome.error).toBe('HTTP 404 Not Found');
        expect(outcome.failedIndex).toBeUndefined();
    });

    it('treats missing results as a rollback', () => {
        const ops = deleteOperations('accounts', [GUID_A, GUID_B]);
        const outcome = summarizeTransaction(ops, [ok()]);
        expect(outcome.succeeded).toBe(0);
        expect(outcome.error).toMatch(/1 of 2 results/);
    });
});

describe('errorMessageOf', () => {
    it('falls back to a string body, then the status', () => {
        expect(errorMessageOf({ status: 500, headers: {}, body: ' Server error ' })).toBe('Server error');
        expect(errorMessageOf({ status: 500, headers: {} })).toBe('HTTP 500');
    });
});

describe('hint headers (#36)', () => {
    it('maps BYPASS_CUSTOM_PLUGIN_EXECUTION to the Web API header', () => {
        expect(hintHeaders({ bypassCustomPluginExecution: true })).toEqual({
            'MSCRM.BypassCustomPluginExecution': 'true',
        });
    });

    it('needs no headers without the bypass hint', () => {
        expect(hintHeaders(undefined)).toBeUndefined();
        expect(hintHeaders({ batchSize: 10 })).toBeUndefined();
    });

    it('puts the headers on every operation', () => {
        const ops = withHeaders(deleteOperations('accounts', [GUID_A, GUID_B]), {
            'MSCRM.BypassCustomPluginExecution': 'true',
        });
        expect(ops.map((op) => op.headers)).toEqual([
            { 'MSCRM.BypassCustomPluginExecution': 'true' },
            { 'MSCRM.BypassCustomPluginExecution': 'true' },
        ]);
    });

    it('leaves operations unchanged without headers', () => {
        const ops = deleteOperations('accounts', [GUID_A]);
        expect(withHeaders(ops, undefined)).toBe(ops);
    });
});
