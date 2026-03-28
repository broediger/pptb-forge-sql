import { useCallback, useEffect, useRef, useState } from 'react';

export type LogEntry = {
    timestamp: Date;
    message: string;
    type: 'info' | 'success' | 'warning' | 'error';
};

export function useConnection() {
    const [connection, setConnection] = useState<ToolBoxAPI.DataverseConnection | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const refreshConnection = useCallback(async () => {
        try {
            const conn = await window.toolboxAPI.connections.getActiveConnection();
            setConnection(conn);
        } catch (error) {
            console.error('Error refreshing connection:', error);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        refreshConnection();
    }, [refreshConnection]);

    return { connection, isLoading, refreshConnection };
}

export function useToolboxEvents(onEvent: (event: string, data: any) => void) {
    // Keep a ref to the latest callback so the handler registered once on mount
    // always calls the current version without needing to re-register.
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;

    useEffect(() => {
        // Register the listener exactly once. We intentionally use an empty
        // dependency array so React StrictMode's double-invocation of effects
        // doesn't duplicate event handlers.
        // Note: cleanup would require events.off() which the API doesn't support yet.
        const handler = (_event: any, payload: ToolBoxAPI.ToolBoxEventPayload) => {
            onEventRef.current(payload.event, payload.data);
        };

        window.toolboxAPI.events.on(handler);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
}

export function useEventLog() {
    const [logs, setLogs] = useState<LogEntry[]>([]);

    // Use useCallback without dependencies since we're using the functional update form of setState
    // This ensures the functions are stable across renders and won't cause infinite loops
    const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
        setLogs((prev) => [
            {
                timestamp: new Date(),
                message,
                type,
            },
            ...prev.slice(0, 49), // Keep last 50 entries
        ]);
        console.log(`[${type.toUpperCase()}] ${message}`);
    }, []); // Empty deps is safe because we use functional setState

    const clearLogs = useCallback(() => {
        setLogs([]);
    }, []); // Empty deps is safe because we use functional setState

    return { logs, addLog, clearLogs };
}
