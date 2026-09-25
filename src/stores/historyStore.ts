import { create } from 'zustand';

export interface QueryHistoryEntry {
    id: string;
    sql: string;
    timestamp: number;
    executionTime?: number;
    rowCount?: number;
    error?: string;
    pinned?: boolean;
    statementType?: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
}

interface HistoryStore {
    entries: QueryHistoryEntry[];
    addEntry: (entry: Omit<QueryHistoryEntry, 'id'>) => void;
    removeEntry: (id: string) => void;
    togglePin: (id: string) => void;
    clearHistory: () => void;
    loadFromSettings: () => Promise<void>;
    saveToSettings: () => Promise<void>;
}

const MAX_ENTRIES = 100;

// Keep all pinned entries + fill the remaining slots up to MAX_ENTRIES with the
// newest unpinned ones (entries are ordered newest first).
function trimEntries(entries: QueryHistoryEntry[]): QueryHistoryEntry[] {
    const pinned = entries.filter((e) => e.pinned);
    const unpinned = entries.filter((e) => !e.pinned);
    const maxUnpinned = Math.max(0, MAX_ENTRIES - pinned.length);
    return [...pinned, ...unpinned.slice(0, maxUnpinned)];
}

// Stored history is loaded once per session. Saves wait for it, so a query run
// before the load completes can't overwrite the persisted history. A failed
// load isn't cached: the next save retries it, and skips writing if it still
// fails, rather than replacing the stored history with this session's entries.
let loadPromise: Promise<boolean> | null = null;

export const useHistoryStore = create<HistoryStore>((set, get) => {
    const ensureLoaded = (): Promise<boolean> => {
        loadPromise ??= (async () => {
            try {
                if (!window.toolboxAPI?.settings?.get) return false;
                const stored = await window.toolboxAPI.settings.get('queryHistory');
                if (Array.isArray(stored)) {
                    // Merge rather than replace: entries added this session
                    // (newer) stay on top of the persisted ones.
                    set((state) => {
                        const sessionIds = new Set(state.entries.map((e) => e.id));
                        const persisted = (stored as QueryHistoryEntry[]).filter((e) => !sessionIds.has(e.id));
                        return { entries: trimEntries([...state.entries, ...persisted]) };
                    });
                }
                return true;
            } catch {
                return false;
            }
        })().then((ok) => {
            if (!ok) loadPromise = null;
            return ok;
        });
        return loadPromise;
    };

    return {
        entries: [],

        addEntry: (entry) => {
            const newEntry: QueryHistoryEntry = {
                ...entry,
                id: crypto.randomUUID(),
            };

            set((state) => ({ entries: trimEntries([newEntry, ...state.entries]) }));

            get().saveToSettings();
        },

        removeEntry: (id) => {
            set((state) => ({
                entries: state.entries.filter((e) => e.id !== id),
            }));
            get().saveToSettings();
        },

        togglePin: (id) => {
            set((state) => ({
                entries: state.entries.map((e) => (e.id === id ? { ...e, pinned: !e.pinned } : e)),
            }));
            get().saveToSettings();
        },

        clearHistory: () => {
            set((state) => ({
                entries: state.entries.filter((e) => e.pinned),
            }));
            get().saveToSettings();
        },

        loadFromSettings: async () => {
            await ensureLoaded();
        },

        saveToSettings: async () => {
            if (!(await ensureLoaded())) return;
            try {
                if (!window.toolboxAPI?.settings?.set) return;
                const { entries } = get();
                await window.toolboxAPI.settings.set('queryHistory', entries);
            } catch {
                // Settings API unavailable or failed — silently ignore
            }
        },
    };
});
