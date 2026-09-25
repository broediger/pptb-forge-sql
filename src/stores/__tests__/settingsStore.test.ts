import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fake PPTB settings API backed by an in-memory map. `get` resolves only when
// released, so tests can control when the saved settings "arrive".
function makeSettings(initial: Record<string, unknown>) {
    const data = { ...initial };
    let releaseGet: () => void = () => {};
    const getGate = new Promise<void>((resolve) => (releaseGet = resolve));
    return {
        data,
        releaseGet: () => releaseGet(),
        api: {
            // Reads the value when called, like a real IPC round trip
            get: vi.fn(async (key: string) => {
                const value = data[key];
                await getGate;
                return value;
            }),
            set: vi.fn(async (key: string, value: unknown) => {
                data[key] = value;
            }),
        },
    };
}

// The store keeps module-level load state, so each test needs a fresh module.
async function loadStore() {
    vi.resetModules();
    return (await import('../settingsStore')).useSettingsStore;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('settingsStore persistence', () => {
    let settings: ReturnType<typeof makeSettings>;

    beforeEach(() => {
        settings = makeSettings({
            forgeSettings: { batchSize: 200, quotedIdentifiers: true, showFetchXml: true, csvDelimiter: ',' },
        });
        vi.stubGlobal('window', { toolboxAPI: { settings: settings.api } });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('does not overwrite saved settings with defaults when a setting changes before the load finishes', async () => {
        const store = await loadStore();
        store.getState().loadFromToolbox();

        store.getState().updateSetting('csvDelimiter', ';');
        await flush();
        expect(settings.api.set).not.toHaveBeenCalled();

        settings.releaseGet();
        await flush();
        await flush();

        const expected = { batchSize: 200, quotedIdentifiers: true, showFetchXml: true, csvDelimiter: ';' };
        expect(store.getState().settings).toEqual(expected);
        expect(settings.data.forgeSettings).toEqual(expected);
    });

    it('keeps a change made during the load instead of reverting it to the saved value', async () => {
        settings.data.forgeSettings = { csvDelimiter: ';' };
        const store = await loadStore();
        store.getState().loadFromToolbox();
        store.getState().updateSetting('csvDelimiter', ',');
        settings.releaseGet();
        await flush();
        await flush();

        expect(store.getState().settings.csvDelimiter).toBe(',');
        expect((settings.data.forgeSettings as { csvDelimiter: string }).csvDelimiter).toBe(',');
    });

    it('retries a failed load on the next save and skips saving if it still fails', async () => {
        settings.releaseGet();
        settings.api.get.mockRejectedValueOnce(new Error('host not ready'));
        settings.api.get.mockRejectedValueOnce(new Error('still not ready'));
        const store = await loadStore();
        await store.getState().loadFromToolbox();

        store.getState().updateSetting('showFetchXml', false);
        await flush();
        expect(settings.api.set).not.toHaveBeenCalled();

        // Next change: load succeeds, saved values merge under both changes
        store.getState().updateSetting('csvDelimiter', ';');
        await flush();
        await flush();
        expect(settings.api.get).toHaveBeenCalledTimes(3);
        expect(settings.data.forgeSettings).toEqual({
            batchSize: 200,
            quotedIdentifiers: true,
            showFetchXml: false,
            csvDelimiter: ';',
        });
    });

    it('loads only once per session', async () => {
        const store = await loadStore();
        settings.releaseGet();
        await store.getState().loadFromToolbox();
        await store.getState().loadFromToolbox();
        expect(settings.api.get).toHaveBeenCalledTimes(1);
        expect(store.getState().settings.batchSize).toBe(200);
    });
});
