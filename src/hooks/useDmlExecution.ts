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

// ── Helper: build a synthetic FetchXML that selects the primary key only ──

function buildResolveFetchXml(table: string, where: WhereExpr): string {
    const syntheticSelect: SelectStatement = {
        type: 'select',
        columns: [{ column: table + 'id' }],
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
        const pkField = table + 'id';
        const ids = [...new Set(rows.map((r) => r[pkField] as string).filter(Boolean))];
        return { ids, rows };
    }

    // ── INSERT ──

    async function executeInsert(stmt: InsertStatement, sql: string): Promise<void> {
        assertDataverseAPI();
        const { table, columns, values } = stmt;
        const total = values.length;
        const createdIds: string[] = [];
        const showProgress = total > 10;

        if (showProgress) {
            setProgress({ operation: 'INSERT', total, completed: 0, cancelled: false });
        }

        const start = performance.now();

        for (let i = 0; i < values.length; i++) {
            if (cancelledRef.current) {
                setProgress((p) => (p ? { ...p, cancelled: true } : p));
                break;
            }

            const record: Record<string, unknown> = {};
            for (let c = 0; c < columns.length; c++) {
                record[columns[c]] = values[i][c] ?? null;
            }

            const created = await window.dataverseAPI.create(table, record);
            if (created?.id) createdIds.push(created.id);

            if (showProgress) {
                setProgress({ operation: 'INSERT', total, completed: i + 1, cancelled: false });
            }
        }

        const end = performance.now();
        const executionTime = Math.round(end - start);
        const wasCancelled = cancelledRef.current;

        setProgress(null);
        setIsExecuting(false);

        const affectedCount = createdIds.length;
        setDmlResult({ operation: 'INSERT', affectedCount, createdIds, executionTime });

        if (wasCancelled) {
            try {
                window.toolboxAPI.utils.showNotification({
                    title: 'Operation Cancelled',
                    body: `${affectedCount} of ${total} records processed before cancellation`,
                    type: 'warning',
                });
            } catch {
                // toolboxAPI may not be available
            }
        } else {
            try {
                window.toolboxAPI.utils.showNotification({
                    title: 'Insert Complete',
                    body: `${affectedCount} record${affectedCount !== 1 ? 's' : ''} created in ${executionTime}ms`,
                    type: 'success',
                });
            } catch {
                // toolboxAPI may not be available
            }
        }

        addToHistory(sql, executionTime, affectedCount);
    }

    // ── UPDATE ──

    async function executeUpdate(stmt: UpdateStatement, sql: string): Promise<void> {
        assertDataverseAPI();

        // Build set values object
        const setValues: Record<string, unknown> = {};
        for (const clause of stmt.set) {
            setValues[clause.column] = clause.value;
        }

        // Resolve matching records
        const { ids } = await resolveRecords(stmt.table, stmt.where);
        const count = ids.length;

        if (count === 0) {
            setIsExecuting(false);
            setDmlResult({ operation: 'UPDATE', affectedCount: 0, executionTime: 0 });
            return;
        }

        // Require confirmation above a threshold derived from batchSize
        const batchSize = useSettingsStore.getState().settings.batchSize;
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
            });
            setIsExecuting(false);
            return;
        }

        // Proceed directly for <= 10 records
        await runUpdateBatch(stmt.table, ids, setValues, sql);
    }

    async function runUpdateBatch(
        table: string,
        ids: string[],
        setValues: Record<string, unknown>,
        sql: string,
    ): Promise<void> {
        const total = ids.length;
        setIsExecuting(true);
        setProgress({ operation: 'UPDATE', total, completed: 0, cancelled: false });

        const start = performance.now();
        let completedCount = 0;

        for (let i = 0; i < ids.length; i++) {
            if (cancelledRef.current) {
                setProgress((p) => (p ? { ...p, cancelled: true } : p));
                break;
            }
            await window.dataverseAPI.update(table, ids[i], setValues);
            completedCount = i + 1;
            setProgress({ operation: 'UPDATE', total, completed: completedCount, cancelled: false });
        }

        const end = performance.now();
        const executionTime = Math.round(end - start);
        const wasCancelled = cancelledRef.current;

        setProgress(null);
        setIsExecuting(false);
        setConfirmationNeeded(null);
        setDmlResult({ operation: 'UPDATE', affectedCount: completedCount, executionTime });

        if (wasCancelled) {
            try {
                window.toolboxAPI.utils.showNotification({
                    title: 'Operation Cancelled',
                    body: `${completedCount} of ${total} records processed before cancellation`,
                    type: 'warning',
                });
            } catch {
                // toolboxAPI may not be available
            }
        } else {
            try {
                window.toolboxAPI.utils.showNotification({
                    title: 'Update Complete',
                    body: `${completedCount} record${completedCount !== 1 ? 's' : ''} updated in ${executionTime}ms`,
                    type: 'success',
                });
            } catch {
                // toolboxAPI may not be available
            }
        }

        addToHistory(sql, executionTime, completedCount);
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
        const deleteBatchSize = useSettingsStore.getState().settings.batchSize;
        setConfirmationNeeded({
            operation: 'DELETE',
            table: stmt.table,
            affectedCount: count,
            sampleRecords,
            typeToConfirm: count > deleteBatchSize,
            sql,
        });
        setIsExecuting(false);
    }

    async function runDeleteBatch(table: string, ids: string[], sql: string): Promise<void> {
        const total = ids.length;
        setIsExecuting(true);
        setProgress({ operation: 'DELETE', total, completed: 0, cancelled: false });

        const start = performance.now();
        let completedCount = 0;

        for (let i = 0; i < ids.length; i++) {
            if (cancelledRef.current) {
                setProgress((p) => (p ? { ...p, cancelled: true } : p));
                break;
            }
            await window.dataverseAPI.delete(table, ids[i]);
            completedCount = i + 1;
            setProgress({ operation: 'DELETE', total, completed: completedCount, cancelled: false });
        }

        const end = performance.now();
        const executionTime = Math.round(end - start);
        const wasCancelled = cancelledRef.current;

        setProgress(null);
        setIsExecuting(false);
        setConfirmationNeeded(null);
        setDmlResult({ operation: 'DELETE', affectedCount: completedCount, executionTime });

        if (wasCancelled) {
            try {
                window.toolboxAPI.utils.showNotification({
                    title: 'Operation Cancelled',
                    body: `${completedCount} of ${total} records processed before cancellation`,
                    type: 'warning',
                });
            } catch {
                // toolboxAPI may not be available
            }
        } else {
            try {
                window.toolboxAPI.utils.showNotification({
                    title: 'Delete Complete',
                    body: `${completedCount} record${completedCount !== 1 ? 's' : ''} deleted in ${executionTime}ms`,
                    type: 'success',
                });
            } catch {
                // toolboxAPI may not be available
            }
        }

        addToHistory(sql, executionTime, completedCount);
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

    const confirmExecution = useCallback(async (): Promise<void> => {
        const pending = pendingRef.current;
        const sql = pendingSqlRef.current;
        if (!pending) return;

        cancelledRef.current = false;

        try {
            if (pending.stmt.type === 'update') {
                const updateStmt = pending.stmt as UpdateStatement;
                const setValues: Record<string, unknown> = {};
                for (const clause of updateStmt.set) {
                    setValues[clause.column] = clause.value;
                }
                await runUpdateBatch(updateStmt.table, pending.recordIds, setValues, sql);
            } else if (pending.stmt.type === 'delete') {
                const deleteStmt = pending.stmt as DeleteStatement;
                await runDeleteBatch(deleteStmt.table, pending.recordIds, sql);
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
