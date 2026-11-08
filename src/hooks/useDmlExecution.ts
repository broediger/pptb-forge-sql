import { useState, useCallback, useRef } from 'react';
import { tokenize, parseStatement, generateFetchXml } from '../sql';
import {
    InsertStatement,
    UpdateStatement,
    DeleteStatement,
    SqlParseError,
    SelectStatement,
    WhereExpr,
} from '../sql/types';
import { useSettingsStore } from '../stores/settingsStore';
import { primaryKeyOf } from '../sql/primaryKey';
import {
    chunk,
    createOperations,
    deleteOperations,
    summarizeTransaction,
    updateOperations,
    MAX_BATCH_OPERATIONS,
    type BatchOperation,
    type TransactionOutcome,
} from '../sql/dmlBatch';

// ── Public types ──

export interface DmlResult {
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    affectedCount: number;
    createdIds?: string[];
    executionTime: number;
}

export interface DmlConfirmation {
    operation: 'UPDATE' | 'DELETE';
    table: string;
    affectedCount: number;
    sampleRecords?: Record<string, unknown>[];
    typeToConfirm?: boolean;
    sql: string;
    /** Records per transaction; 0 when the host can't run transactions. */
    batchSize: number;
    /** Whether the user may run all records as a single transaction. */
    canRunAsOneTransaction: boolean;
}

export interface DmlConfirmOptions {
    /** Run every record in one transaction instead of one per batch. */
    singleTransaction?: boolean;
}

export interface DmlProgress {
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    total: number;
    completed: number;
    cancelled: boolean;
}

// ── Internal pending state stored in a ref so confirmExecution can access it ──

interface PendingDml {
    stmt: UpdateStatement | DeleteStatement;
    recordIds: string[];
    sampleRecords?: Record<string, unknown>[];
}

// One INSERT/UPDATE/DELETE run, described per record index so it can be sent
// as batch transactions or, on hosts without them, one call per record.
interface WriteJob {
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    table: string;
    count: number;
    /** Batch operations for records [from, to). */
    operations: (entitySet: string, from: number, to: number) => BatchOperation[];
    /** Write one record with the per-record API; returns the created ID for INSERT. */
    single: (index: number) => Promise<string | undefined>;
    /** ID of an existing record, for error messages (UPDATE/DELETE). */
    idAt?: (index: number) => string;
}

const PAST_TENSE = { INSERT: 'created', UPDATE: 'updated', DELETE: 'deleted' } as const;
const COMPLETE_TITLE = { INSERT: 'Insert Complete', UPDATE: 'Update Complete', DELETE: 'Delete Complete' } as const;

// ── Helper: build a synthetic FetchXML that selects the primary key only ──

function buildResolveFetchXml(table: string, where: WhereExpr): string {
    const syntheticSelect: SelectStatement = {
        type: 'select',
        columns: [{ column: primaryKeyOf(table) }],
        from: { table },
        joins: [],
        where,
    };
    return generateFetchXml(syntheticSelect);
}

// ── Helper: check dataverseAPI is available ──

function assertDataverseAPI(): void {
    if (typeof window === 'undefined' || !window.dataverseAPI) {
        throw new Error('Dataverse API not available. Load this tool in Power Platform ToolBox.');
    }
}

// PPTB 1.2.7 added $batch transactions; older hosts fall back to one call per record.
function supportsTransactions(): boolean {
    return typeof window.dataverseAPI?.executeTransaction === 'function';
}

// Batch URLs need the entity set name. Metadata knows it for every table;
// PPTB's getEntitySetName only pluralizes the logical name.
async function entitySetNameOf(table: string): Promise<string> {
    try {
        const metadata = await window.dataverseAPI.getEntityMetadata(table, true, ['EntitySetName']);
        if (typeof metadata?.EntitySetName === 'string' && metadata.EntitySetName) return metadata.EntitySetName;
    } catch {
        // fall back below
    }
    return window.dataverseAPI.getEntitySetName(table);
}

function currentBatchSize(): number {
    return useSettingsStore.getState().settings.batchSize;
}

function transactionInfo(count: number, batchSize: number): Pick<DmlConfirmation, 'batchSize' | 'canRunAsOneTransaction'> {
    if (!supportsTransactions()) return { batchSize: 0, canRunAsOneTransaction: false };
    return { batchSize, canRunAsOneTransaction: count > batchSize && count <= MAX_BATCH_OPERATIONS };
}

function describeRolledBackChunk(
    job: WriteJob,
    outcome: TransactionOutcome,
    from: number,
    to: number,
    chunkIndex: number,
    chunkCount: number,
): string {
    const which = chunkCount > 1 ? `Batch ${chunkIndex + 1} of ${chunkCount} (records ${from + 1}-${to})` : 'The transaction';
    const record =
        outcome.failedIndex !== undefined
            ? ` at record ${from + outcome.failedIndex + 1}${job.idAt ? ` ${job.idAt(from + outcome.failedIndex)}` : ''}`
            : '';
    return `${which} failed${record} and was rolled back: ${outcome.error}`;
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function notify(title: string, body: string, type: 'success' | 'warning' | 'error'): void {
    try {
        window.toolboxAPI.utils.showNotification({ title, body, type });
    } catch {
        // toolboxAPI may not be available
    }
}

function updateJob(stmt: UpdateStatement, ids: string[]): WriteJob {
    const values: Record<string, unknown> = {};
    for (const clause of stmt.set) {
        values[clause.column] = clause.value;
    }
    return {
        operation: 'UPDATE',
        table: stmt.table,
        count: ids.length,
        operations: (entitySet, from, to) => updateOperations(entitySet, ids.slice(from, to), values),
        single: async (i) => {
            await window.dataverseAPI.update(stmt.table, ids[i], values);
            return undefined;
        },
        idAt: (i) => ids[i],
    };
}

function deleteJob(stmt: DeleteStatement, ids: string[]): WriteJob {
    return {
        operation: 'DELETE',
        table: stmt.table,
        count: ids.length,
        operations: (entitySet, from, to) => deleteOperations(entitySet, ids.slice(from, to)),
        single: async (i) => {
            await window.dataverseAPI.delete(stmt.table, ids[i]);
            return undefined;
        },
        idAt: (i) => ids[i],
    };
}

// ── Hook ──

export function useDmlExecution() {
    const [dmlResult, setDmlResult] = useState<DmlResult | null>(null);
    const [dmlError, setDmlError] = useState<string | null>(null);
    const [isExecuting, setIsExecuting] = useState(false);
    const [confirmationNeeded, setConfirmationNeeded] = useState<DmlConfirmation | null>(null);
    const [progress, setProgress] = useState<DmlProgress | null>(null);

    // Cancellation flag
    const cancelledRef = useRef<boolean>(false);

    // Pending DML stored between "show confirmation" and "confirmExecution"
    const pendingRef = useRef<PendingDml | null>(null);
    // Keep the last sql for the confirmation object
    const pendingSqlRef = useRef<string>('');

    // ── Reset state for a fresh run ──

    function resetState() {
        setDmlResult(null);
        setDmlError(null);
        setConfirmationNeeded(null);
        setProgress(null);
        cancelledRef.current = false;
        pendingRef.current = null;
    }

    // ── Resolve matching record IDs via FetchXML ──

    async function resolveRecords(
        table: string,
        where: WhereExpr,
    ): Promise<{ ids: string[]; rows: Record<string, unknown>[] }> {
        assertDataverseAPI();
        const fetchXml = buildResolveFetchXml(table, where);
        const result = await window.dataverseAPI.fetchXmlQuery(fetchXml);
        const rows: Record<string, unknown>[] = result.value ?? [];
        const pkField = primaryKeyOf(table);
        const ids = [...new Set(rows.map((r) => r[pkField] as string).filter(Boolean))];
        return { ids, rows };
    }

    // ── Write records: one transaction per chunk, or per record on older hosts ──

    async function runWrites(job: WriteJob, chunkSize: number, sql: string): Promise<void> {
        const { operation, table, count } = job;
        const showProgress = operation !== 'INSERT' || count > 10;
        setIsExecuting(true);
        if (showProgress) setProgress({ operation, total: count, completed: 0, cancelled: false });

        const start = performance.now();
        let completed = 0;
        const createdIds: string[] = [];
        let failure: string | null = null;

        if (supportsTransactions()) {
            const entitySet = await entitySetNameOf(table);
            const chunks = chunk(Array.from({ length: count }, (_, i) => i), chunkSize);
            for (let c = 0; c < chunks.length; c++) {
                if (cancelledRef.current) break;
                const first = chunks[c][0];
                const end = first + chunks[c].length;
                const ops = job.operations(entitySet, first, end);
                let results: Awaited<ReturnType<typeof window.dataverseAPI.executeTransaction>>;
                try {
                    results = await window.dataverseAPI.executeTransaction(ops);
                } catch (err) {
                    // The request itself failed, so whether this batch committed is unknown.
                    const which = chunks.length > 1 ? `Batch ${c + 1} of ${chunks.length} (records ${first + 1}-${end})` : 'The transaction';
                    failure = `${which} failed: ${errorText(err)}`;
                    break;
                }
                const outcome = summarizeTransaction(ops, results);
                if (outcome.error) {
                    failure = describeRolledBackChunk(job, outcome, first, end, c, chunks.length);
                    break;
                }
                completed += outcome.succeeded;
                createdIds.push(...outcome.createdIds);
                if (showProgress) setProgress({ operation, total: count, completed, cancelled: false });
            }
        } else {
            for (let i = 0; i < count; i++) {
                if (cancelledRef.current) break;
                try {
                    const id = await job.single(i);
                    if (id) createdIds.push(id);
                } catch (err) {
                    failure = `${errorText(err)} (record ${i + 1}${job.idAt ? ` ${job.idAt(i)}` : ''})`;
                    break;
                }
                completed = i + 1;
                if (showProgress) setProgress({ operation, total: count, completed, cancelled: false });
            }
        }

        const executionTime = Math.round(performance.now() - start);
        const wasCancelled = cancelledRef.current;
        const verb = PAST_TENSE[operation];

        setProgress(null);
        setIsExecuting(false);
        setConfirmationNeeded(null);

        if (failure) {
            const message = `${failure}. ${completed} of ${count} record${count !== 1 ? 's were' : ' was'} ${verb} before the error.`;
            setDmlError(message);
            notify('DML Error', message, 'error');
            return;
        }

        setDmlResult({
            operation,
            affectedCount: completed,
            ...(operation === 'INSERT' ? { createdIds } : {}),
            executionTime,
        });

        if (wasCancelled) {
            notify('Operation Cancelled', `${completed} of ${count} records processed before cancellation`, 'warning');
        } else {
            notify(
                COMPLETE_TITLE[operation],
                `${completed} record${completed !== 1 ? 's' : ''} ${verb} in ${executionTime}ms`,
                'success',
            );
        }

        addToHistory(sql, executionTime, completed);
    }

    // ── INSERT ──

    async function executeInsert(stmt: InsertStatement, sql: string): Promise<void> {
        assertDataverseAPI();
        const { table, columns, values } = stmt;
        const records = values.map((row) => {
            const record: Record<string, unknown> = {};
            for (let c = 0; c < columns.length; c++) {
                record[columns[c]] = row[c] ?? null;
            }
            return record;
        });

        await runWrites(
            {
                operation: 'INSERT',
                table,
                count: records.length,
                operations: (entitySet, from, to) => createOperations(entitySet, records.slice(from, to)),
                single: async (i) => (await window.dataverseAPI.create(table, records[i]))?.id || undefined,
            },
            currentBatchSize(),
            sql,
        );
    }

    // ── UPDATE ──

    async function executeUpdate(stmt: UpdateStatement, sql: string): Promise<void> {
        assertDataverseAPI();

        // Resolve matching records
        const { ids } = await resolveRecords(stmt.table, stmt.where);
        const count = ids.length;

        if (count === 0) {
            setIsExecuting(false);
            setDmlResult({ operation: 'UPDATE', affectedCount: 0, executionTime: 0 });
            return;
        }

        // Require confirmation above a threshold derived from batchSize
        const batchSize = currentBatchSize();
        const updateConfirmThreshold = Math.max(10, Math.floor(batchSize / 5));
        const updateTypeConfirmThreshold = batchSize * 2;

        if (count > updateConfirmThreshold) {
            pendingRef.current = { stmt, recordIds: ids };
            pendingSqlRef.current = sql;
            setConfirmationNeeded({
                operation: 'UPDATE',
                table: stmt.table,
                affectedCount: count,
                typeToConfirm: count > updateTypeConfirmThreshold,
                sql,
                ...transactionInfo(count, batchSize),
            });
            setIsExecuting(false);
            return;
        }

        // Proceed directly below the confirmation threshold
        await runWrites(updateJob(stmt, ids), batchSize, sql);
    }

    // ── DELETE ──

    async function executeDelete(stmt: DeleteStatement, sql: string): Promise<void> {
        assertDataverseAPI();

        const { ids, rows } = await resolveRecords(stmt.table, stmt.where);
        const count = ids.length;

        if (count === 0) {
            setIsExecuting(false);
            setDmlResult({ operation: 'DELETE', affectedCount: 0, executionTime: 0 });
            return;
        }

        const sampleRecords = rows.slice(0, 5);
        pendingRef.current = { stmt, recordIds: ids, sampleRecords };
        pendingSqlRef.current = sql;

        // DELETE always requires confirmation
        const deleteBatchSize = currentBatchSize();
        setConfirmationNeeded({
            operation: 'DELETE',
            table: stmt.table,
            affectedCount: count,
            sampleRecords,
            typeToConfirm: count > deleteBatchSize,
            sql,
            ...transactionInfo(count, deleteBatchSize),
        });
        setIsExecuting(false);
    }

    // ── History helper (best-effort) ──

    function addToHistory(_sql: string, _executionTime: number, _affectedCount: number): void {
        // History integration can be wired in App.tsx via the returned dmlResult
    }

    // ── Public: execute(sql) ──

    const execute = useCallback(async (sql: string): Promise<void> => {
        resetState();
        setIsExecuting(true);

        try {
            const tokens = tokenize(sql);
            const stmt = parseStatement(tokens);

            if (stmt.type === 'select') {
                throw new Error('Use the query editor to run SELECT statements');
            }

            if (stmt.type === 'insert') {
                await executeInsert(stmt as InsertStatement, sql);
            } else if (stmt.type === 'update') {
                await executeUpdate(stmt as UpdateStatement, sql);
            } else if (stmt.type === 'delete') {
                await executeDelete(stmt as DeleteStatement, sql);
            }
        } catch (err) {
            setIsExecuting(false);
            setProgress(null);

            let errorMessage: string;
            if (err instanceof SqlParseError) {
                errorMessage = `SQL parse error at line ${err.line}, column ${err.column}: ${err.message.replace(/ \(line \d+, column \d+\)$/, '')}`;
            } else if (err instanceof Error) {
                errorMessage = err.message;
            } else {
                errorMessage = String(err);
            }

            setDmlError(errorMessage);

            try {
                window.toolboxAPI.utils.showNotification({
                    title: 'DML Error',
                    body: errorMessage,
                    type: 'error',
                });
            } catch {
                // toolboxAPI may not be available
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Public: confirmExecution() ──

    const confirmExecution = useCallback(async (options: DmlConfirmOptions = {}): Promise<void> => {
        const pending = pendingRef.current;
        const sql = pendingSqlRef.current;
        if (!pending) return;

        cancelledRef.current = false;
        // Close the dialog so the progress shows, and so a second click can't start the run again.
        pendingRef.current = null;
        setConfirmationNeeded(null);

        const ids = pending.recordIds;
        const chunkSize = options.singleTransaction ? Math.min(ids.length, MAX_BATCH_OPERATIONS) : currentBatchSize();

        try {
            if (pending.stmt.type === 'update') {
                await runWrites(updateJob(pending.stmt as UpdateStatement, ids), chunkSize, sql);
            } else if (pending.stmt.type === 'delete') {
                await runWrites(deleteJob(pending.stmt as DeleteStatement, ids), chunkSize, sql);
            }
        } catch (err) {
            setIsExecuting(false);
            setProgress(null);
            setConfirmationNeeded(null);

            let errorMessage: string;
            if (err instanceof Error) {
                errorMessage = err.message;
            } else {
                errorMessage = String(err);
            }

            setDmlError(errorMessage);

            try {
                window.toolboxAPI.utils.showNotification({
                    title: 'DML Error',
                    body: errorMessage,
                    type: 'error',
                });
            } catch {
                // toolboxAPI may not be available
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Public: cancelExecution() ──

    const cancelExecution = useCallback((): void => {
        cancelledRef.current = true;
        setConfirmationNeeded(null);
        pendingRef.current = null;
        setIsExecuting(false);
        setProgress(null);
    }, []);

    const clearResult = useCallback(() => {
        setDmlResult(null);
        setDmlError(null);
    }, []);

    return {
        dmlResult,
        dmlError,
        isExecuting,
        confirmationNeeded,
        progress,
        execute,
        confirmExecution,
        cancelExecution,
        clearResult,
    };
}
