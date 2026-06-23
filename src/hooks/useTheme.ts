import { useState, useEffect, useCallback } from 'react';
import { useToolboxEvents } from './useToolboxAPI';

export function useTheme(): { theme: 'light' | 'dark'; isDark: boolean } {
    const [theme, setTheme] = useState<'light' | 'dark'>('light');

    const refresh = useCallback(async () => {
        try {
            const t = await window.toolboxAPI.utils.getCurrentTheme();
            setTheme(t);
        } catch {
            setTheme('light');
        }
    }, []);

    // Read the initial theme on mount.
    useEffect(() => {
        refresh();
    }, [refresh]);

    // The host has no dedicated theme-changed event; the theme lives in the
    // toolbox settings, so re-read it whenever settings change. This keeps the
    // tool in sync when the user toggles the theme in the toolbox settings area.
    useToolboxEvents(
        useCallback(
            (event: string) => {
                if (event === 'settings:updated') {
                    refresh();
                }
            },
            [refresh],
        ),
    );

    return { theme, isDark: theme === 'dark' };
}
