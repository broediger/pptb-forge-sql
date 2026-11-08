// INSERT/UPDATE/DELETE as Web API $batch requests (#35). Each chunk of records
// is sent as one transaction (a changeset): it commits completely or not at all.
//
// PPTB's executeTransaction is used rather than executeBatch: for a
// transaction PPTB accepts the shortened response Dataverse sends when an
// operation fails, while a plain batch that stops at its first error may be
// rejected as malformed. Operations carry no extra headers, because PPTB asks
// the user to consent to every additional header.

/** Dataverse accepts at most 1000 operations per batch. */
export const MAX_BATCH_OPERATIONS = 1000;

/** Shape of `DataverseAPI.BatchRequest`, kept local so this module stays host-independent. */
export interface BatchOperation {
    method: 'POST' | 'PATCH' | 'DELETE';
    url: string;
    body?: Record<string, unknown>;
    contentId: string;
}

/** Shape of `DataverseAPI.BatchResult`. */
export interface BatchOperationResult {
    contentId?: string;
    status: number;
    statusText?: string;
    headers: Record<string, string>;
    body?: unknown;
}

export interface TransactionOutcome {
    /** Operations committed: all of them, or 0 when the transaction rolled back. */
    succeeded: number;
    /** IDs of records created by POST operations, in request order. */
    createdIds: string[];
    /** Why the transaction rolled back. */
    error?: string;
    /** Index (within the chunk) of the operation that failed, when Dataverse says which one. */
    failedIndex?: number;
}

/** Split `items` into chunks of at most `size` (clamped to 1..MAX_BATCH_OPERATIONS). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
    const n = Math.max(1, Math.min(MAX_BATCH_OPERATIONS, Math.floor(size) || 1));
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += n) chunks.push(items.slice(i, i + n));
    return chunks;
}

export function createOperations(entitySet: string, records: Record<string, unknown>[]): BatchOperation[] {
    return records.map((body, i) => ({ method: 'POST', url: entitySet, body, contentId: String(i + 1) }));
}

export function updateOperations(entitySet: string, ids: string[], values: Record<string, unknown>): BatchOperation[] {
    return ids.map((id, i) => ({
        method: 'PATCH',
        url: `${entitySet}(${id})`,
        body: values,
        contentId: String(i + 1),
    }));
}

export function deleteOperations(entitySet: string, ids: string[]): BatchOperation[] {
    return ids.map((id, i) => ({ method: 'DELETE', url: `${entitySet}(${id})`, contentId: String(i + 1) }));
}

/**
 * Interpret the results of one transaction. It succeeded only when every
 * operation returned a 2xx status; otherwise Dataverse rolled all of it back.
 */
export function summarizeTransaction(
    operations: readonly BatchOperation[],
    results: readonly BatchOperationResult[],
): TransactionOutcome {
    const failed = results.find((r) => r.status < 200 || r.status >= 300);
    if (!failed && results.length === operations.length) {
        const createdIds = operations.flatMap((op, i) => {
            if (op.method !== 'POST') return [];
            const id = createdIdOf(results[i]);
            return id ? [id] : [];
        });
        return { succeeded: operations.length, createdIds };
    }

    if (!failed) {
        return {
            succeeded: 0,
            createdIds: [],
            error: `Dataverse returned ${results.length} of ${operations.length} results; the batch was rolled back`,
        };
    }

    const index = failed.contentId ? operations.findIndex((op) => op.contentId === failed.contentId) : -1;
    return {
        succeeded: 0,
        createdIds: [],
        error: errorMessageOf(failed),
        ...(index >= 0 ? { failedIndex: index } : {}),
    };
}

/** Dataverse's error message from a failed operation, or its HTTP status. */
export function errorMessageOf(result: BatchOperationResult): string {
    const body = result.body;
    if (body && typeof body === 'object') {
        const message = (body as { error?: { message?: unknown } }).error?.message;
        if (typeof message === 'string' && message) return message;
    }
    if (typeof body === 'string' && body.trim()) return body.trim();
    return `HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`;
}

/** GUID of a created record, from the OData-EntityId header (`.../accounts(<guid>)`). */
function createdIdOf(result: BatchOperationResult): string | undefined {
    const header = Object.entries(result.headers ?? {}).find(([name]) => name.toLowerCase() === 'odata-entityid')?.[1];
    const match = header ? /\(([0-9a-f-]{36})\)\s*$/i.exec(header) : null;
    return match?.[1];
}
