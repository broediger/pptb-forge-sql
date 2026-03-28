import { useState, useEffect } from 'react';

export function useTheme(): { theme: 'light' | 'dark'; isDark: boolean } {
    const [theme, setTheme] = useState<'light' | 'dark'>('light');

    useEffect(() => {
        (async () => {
            try {
                const t = await window.toolboxAPI.utils.getCurrentTheme();
                setTheme(t);
            } catch {
                setTheme('light');
            }
        })();
    }, []);

    return { theme, isDark: theme === 'dark' };
}
