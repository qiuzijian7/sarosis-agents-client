/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Theme Store (Zustand)
 *  Now delegates to VS Code's native theme system.
 *  The --vscode-* CSS variables are automatically updated by VS Code when the theme changes,
 *  so our --as-* aliases in themes.css follow suit without any DOM attribute manipulation.
 *
 *  This store is kept for backward compatibility but is intentionally minimal.
 *  The 'agentStudio:theme-changed' event is still dispatched for any components that listen.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';

export type AgentStudioTheme = string;

interface ThemeState {
	/** Current active theme identifier (VS Code theme settingsId) */
	theme: string;
	/** Notify the store that the theme has changed (called from index.tsx on host events) */
	setTheme: (theme: string) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
	theme: '',
	setTheme: (theme: string) => {
		// VS Code handles the actual theme application via --vscode-* CSS variables.
		// We just track the current theme name in the store for reference.
		set({ theme });
	},
}));

// ─── Global Event Listener ─────────────────────────────────────────────────
// This runs once at module load time. The Host sends 'theme.changed' events
// via postMessage → index.tsx dispatches CustomEvent → we pick it up here.

function handleThemeChanged(e: Event): void {
	const detail = (e as CustomEvent).detail;
	const newTheme = detail?.theme as string;
	if (newTheme) {
		useThemeStore.getState().setTheme(newTheme);
	}
}

window.addEventListener('agentStudio:theme-changed', handleThemeChanged);
