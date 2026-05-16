/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Theme Store (Zustand)
 *  Manages the current theme and applies it to the DOM via data-theme attribute.
 *  Listens for 'agentStudio:theme-changed' CustomEvents dispatched by index.tsx.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';

export type AgentStudioTheme = 'dark' | 'light' | 'slate' | 'solarized' | 'monokai' | 'nord' | 'oled';

const VALID_THEMES: ReadonlySet<string> = new Set<AgentStudioTheme>([
	'dark', 'light', 'slate', 'solarized', 'monokai', 'nord', 'oled',
]);

interface ThemeState {
	/** Current active theme name */
	theme: AgentStudioTheme;
	/** Apply a new theme — updates both the store and the DOM */
	setTheme: (theme: AgentStudioTheme) => void;
}

/** Apply theme to the document root element */
function applyThemeToDOM(theme: AgentStudioTheme): void {
	const html = document.documentElement;
	// Always set the attribute so that html[data-theme] selectors match for every theme,
	// including "dark".  Previously dark removed the attribute, which prevented the
	// --as-* CSS overrides from taking effect.
	html.setAttribute('data-theme', theme);
}

export const useThemeStore = create<ThemeState>((set) => ({
	theme: 'dark',
	setTheme: (theme: AgentStudioTheme) => {
		if (!VALID_THEMES.has(theme)) {
			console.warn(`[ThemeStore] Invalid theme "${theme}", ignoring.`);
			return;
		}
		applyThemeToDOM(theme);
		set({ theme });
	},
}));

// ─── Global Event Listener ─────────────────────────────────────────────────
// This runs once at module load time. The Host sends 'theme.changed' events
// via postMessage → index.tsx dispatches CustomEvent → we pick it up here.

function handleThemeChanged(e: Event): void {
	const detail = (e as CustomEvent).detail;
	const newTheme = detail?.theme as string;
	if (newTheme && VALID_THEMES.has(newTheme)) {
		useThemeStore.getState().setTheme(newTheme as AgentStudioTheme);
	} else {
		console.warn(`[ThemeStore] Received theme.changed with invalid theme:`, detail);
	}
}

window.addEventListener('agentStudio:theme-changed', handleThemeChanged);
