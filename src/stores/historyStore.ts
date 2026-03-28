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

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  entries: [],

  addEntry: (entry) => {
    const newEntry: QueryHistoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
    };

    set((state) => {
      const updated = [newEntry, ...state.entries];
      const pinned = updated.filter((e) => e.pinned);
      const unpinned = updated.filter((e) => !e.pinned);
      // Keep all pinned + fill remaining slots up to 100 with unpinned
      const maxUnpinned = Math.max(0, 100 - pinned.length);
      const trimmed = [...pinned, ...unpinned.slice(0, maxUnpinned)];
      return { entries: trimmed };
    });

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
      entries: state.entries.map((e) =>
        e.id === id ? { ...e, pinned: !e.pinned } : e
      ),
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
    try {
      if (!window.toolboxAPI?.settings?.get) return;
      const stored = await window.toolboxAPI.settings.get('queryHistory');
      if (Array.isArray(stored)) {
        set({ entries: stored as QueryHistoryEntry[] });
      }
    } catch {
      // Settings API unavailable or failed — silently ignore
    }
  },

  saveToSettings: async () => {
    try {
      if (!window.toolboxAPI?.settings?.set) return;
      const { entries } = get();
      await window.toolboxAPI.settings.set('queryHistory', entries);
    } catch {
      // Settings API unavailable or failed — silently ignore
    }
  },
}));
