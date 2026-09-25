import { create } from 'zustand';
import type { CsvDelimiter } from '../utils/export';

export interface ForgeSettings {
    batchSize: number; // DML batch size (default 50)
    quotedIdentifiers: boolean; // already supported in lexer, this is just a setting display
    showFetchXml: boolean; // auto-show FetchXML tab after execution
    csvDelimiter: CsvDelimiter; // last delimiter chosen in the CSV export menu
}

const DEFAULT_SETTINGS: ForgeSettings = {
    batchSize: 50,
    quotedIdentifiers: true,
    showFetchXml: false,
    csvDelimiter: ',',
};

interface SettingsStore {
    settings: ForgeSettings;
    updateSetting: <K extends keyof ForgeSettings>(key: K, value: ForgeSettings[K]) => void;
    loadFromToolbox: () => Promise<void>;
    saveToToolbox: () => Promise<void>;
}

// Saved settings are loaded once per session. Saves wait for the load so they
// can't overwrite the stored settings with defaults, and settings changed while
// the load is in flight win over the stored values. A failed load isn't cached:
// the next save retries it, and skips writing if it still fails.
let loadPromise: Promise<boolean> | null = null;
let loaded = false;
const changedBeforeLoad = new Set<keyof ForgeSettings>();

export const useSettingsStore = create<SettingsStore>((set, get) => {
    const ensureLoaded = (): Promise<boolean> => {
        loadPromise ??= (async () => {
            try {
                if (!window.toolboxAPI?.settings?.get) return false;
                const saved = (await window.toolboxAPI.settings.get('forgeSettings')) as
                    | Partial<ForgeSettings>
                    | undefined;
                set((state) => {
                    const changed = Object.fromEntries(
                        [...changedBeforeLoad].map((key) => [key, state.settings[key]]),
                    ) as Partial<ForgeSettings>;
                    const stored = saved && typeof saved === 'object' ? saved : {};
                    return { settings: { ...DEFAULT_SETTINGS, ...stored, ...changed } };
                });
                loaded = true;
                changedBeforeLoad.clear();
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
        settings: { ...DEFAULT_SETTINGS },

        updateSetting: <K extends keyof ForgeSettings>(key: K, value: ForgeSettings[K]) => {
            if (!loaded) changedBeforeLoad.add(key);
            set((state) => ({
                settings: { ...state.settings, [key]: value },
            }));
            // Auto-save after every update
            get().saveToToolbox();
        },

        loadFromToolbox: async () => {
            await ensureLoaded();
        },

        saveToToolbox: async () => {
            if (!(await ensureLoaded())) return;
            try {
                await window.toolboxAPI.settings.set('forgeSettings', get().settings);
            } catch {
                // toolboxAPI may not be available
            }
        },
    };
});
