import { create } from 'zustand';

export interface ForgeSettings {
    batchSize: number;           // DML batch size (default 50)
    quotedIdentifiers: boolean;  // already supported in lexer, this is just a setting display
    showFetchXml: boolean;       // auto-show FetchXML tab after execution
}

const DEFAULT_SETTINGS: ForgeSettings = {
    batchSize: 50,
    quotedIdentifiers: true,
    showFetchXml: false,
};

interface SettingsStore {
    settings: ForgeSettings;
    updateSetting: <K extends keyof ForgeSettings>(key: K, value: ForgeSettings[K]) => void;
    loadFromToolbox: () => Promise<void>;
    saveToToolbox: () => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
    settings: { ...DEFAULT_SETTINGS },

    updateSetting: <K extends keyof ForgeSettings>(key: K, value: ForgeSettings[K]) => {
        set((state) => ({
            settings: { ...state.settings, [key]: value },
        }));
        // Auto-save after every update
        get().saveToToolbox();
    },

    loadFromToolbox: async () => {
        try {
            const saved = await window.toolboxAPI.settings.get('forgeSettings') as Partial<ForgeSettings> | undefined;
            if (saved && typeof saved === 'object') {
                set({ settings: { ...DEFAULT_SETTINGS, ...saved } });
            }
        } catch {
            // toolboxAPI may not be available; keep defaults
        }
    },

    saveToToolbox: async () => {
        try {
            await window.toolboxAPI.settings.set('forgeSettings', get().settings);
        } catch {
            // toolboxAPI may not be available
        }
    },
}));
