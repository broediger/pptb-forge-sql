import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueryHistoryEntry } from '../historyStore';

// Fake PPTB settings API backed by an in-memory map. `get` resolves only when
// released, so tests can control when the stored history "arrives".
function makeSettings(initial: Record<string, unknown>) {
    const data = { ...initial };
    let releaseGet: () => void = () => {};
    const getGate = new Promise<void>((resolve) => (releaseGet = resolve));
    return {
        data,
        releaseGet: () => releaseGet(),
        api: {
            get: vi.fn(async (key: string) => {
                await getGate;
                return data[key];
            }),
            set: vi.fn(async (key: string, value: unknown) => {
                data[key] = value;
            }),
        },
    };
}

const stored = (id: string, sql: string, extra: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry => ({
    id,
    sql,
    timestamp: 1,
    ...extra,
});

// The store keeps a module-level load promise, so each test needs a fresh module.
async function loadStore() {
    vi.resetModules();
    return (await import('../historyStore')).useHistoryStore;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('historyStore persistence', () => {
    let settings: ReturnType<typeof makeSettings>;

    beforeEach(() => {
        settings = makeSettings({ queryHistory: [stored('old-1', 'select 1'), stored('old-2', 'select 2')] });
        vi.stubGlobal('window', { toolboxAPI: { settings: settings.api } });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('does not overwrite persisted history when a query runs before the load finishes', async () => {
        const store = await loadStore();
        store.getState().loadFromSettings();

        // Query runs while the stored history is still being fetched
        store.getState().addEntry({ sql: 'select new', timestamp: 2 });
        await flush();
        expect(settings.api.set).not.toHaveBeenCalled();

        settings.releaseGet();
        await flush();
        await flush();

        const sqls = store.getState().entries.map((e) => e.sql);
        expect(sqls).toEqual(['select new', 'select 1', 'select 2']);
        expect((settings.data.queryHistory as QueryHistoryEntry[]).map((e) => e.sql)).toEqual(sqls);
    });

    it('does not overwrite persisted history when nothing triggered a load first', async () => {
        // Previous behaviour: the load only ran when the History tab opened
        const store = await loadStore();
        store.getState().addEntry({ sql: 'select new', timestamp: 2 });
        settings.releaseGet();
        await flush();
        await flush();

        expect((settings.data.queryHistory as QueryHistoryEntry[]).map((e) => e.sql)).toEqual([
            'select new',
            'select 1',
            'select 2',
        ]);
    });

    it('loads only once per session', async () => {
        const store = await loadStore();
        settings.releaseGet();
        await store.getState().loadFromSettings();
        await store.getState().loadFromSettings();
        expect(settings.api.get).toHaveBeenCalledTimes(1);
        expect(store.getState().entries).toHaveLength(2);
    });

    it('does not overwrite persisted history when the load fails, and retries it on the next save', async () => {
        settings.releaseGet();
        settings.api.get.mockRejectedValueOnce(new Error('host not ready'));
        const store = await loadStore();
        await store.getState().loadFromSettings();
        expect(store.getState().entries).toHaveLength(0);

        // First save retries the load, which now succeeds and merges
        store.getState().addEntry({ sql: 'select new', timestamp: 2 });
        await flush();
        await flush();

        expect(settings.api.get).toHaveBeenCalledTimes(2);
        expect((settings.data.queryHistory as QueryHistoryEntry[]).map((e) => e.sql)).toEqual([
            'select new',
            'select 1',
            'select 2',
        ]);
    });

    it('skips saving while the settings API cannot be read', async () => {
        vi.stubGlobal('window', { toolboxAPI: { settings: { set: settings.api.set } } });
        const store = await loadStore();
        store.getState().addEntry({ sql: 'select new', timestamp: 2 });
        await flush();

        expect(settings.api.set).not.toHaveBeenCalled();
        expect(store.getState().entries.map((e) => e.sql)).toEqual(['select new']);
    });

    it('keeps pinned entries and caps unpinned ones at 100 after merging', async () => {
        const many = Array.from({ length: 100 }, (_, i) => stored(`old-${i}`, `select ${i}`));
        settings.data.queryHistory = [stored('pin', 'pinned', { pinned: true }), ...many];
        const store = await loadStore();
        store.getState().addEntry({ sql: 'select new', timestamp: 2 });
        settings.releaseGet();
        await flush();
        await flush();

        const entries = store.getState().entries;
        expect(entries).toHaveLength(100);
        expect(entries[0].sql).toBe('pinned');
        expect(entries[1].sql).toBe('select new');
    });
});
