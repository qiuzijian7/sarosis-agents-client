/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Agent Color Utility
 *  Assigns consistent, visually distinct colors to agent instances.
 *  The same agent ID always gets the same color within a session.
 *--------------------------------------------------------------------------------------------*/

/**
 * Palette of 12 visually distinct colors chosen for:
 * - Good contrast on dark backgrounds
 * - Distinguishability from common status colors (green/red/gray)
 * - Color-blind friendliness (varied hue + saturation)
 */
const AGENT_PALETTE = [
	{ primary: '#3b82f6', light: 'rgba(59,130,246,0.15)',  name: 'blue'     },  // 0
	{ primary: '#8b5cf6', light: 'rgba(139,92,246,0.15)',  name: 'violet'   },  // 1
	{ primary: '#ec4899', light: 'rgba(236,72,153,0.15)',  name: 'pink'     },  // 2
	{ primary: '#f97316', light: 'rgba(249,115,22,0.15)',  name: 'orange'   },  // 3
	{ primary: '#14b8a6', light: 'rgba(20,184,166,0.15)',  name: 'teal'     },  // 4
	{ primary: '#eab308', light: 'rgba(234,179,8,0.15)',   name: 'yellow'   },  // 5
	{ primary: '#06b6d4', light: 'rgba(6,182,212,0.15)',   name: 'cyan'     },  // 6
	{ primary: '#a855f7', light: 'rgba(168,85,247,0.15)',  name: 'purple'   },  // 7
	{ primary: '#f43f5e', light: 'rgba(244,63,94,0.15)',   name: 'rose'     },  // 8
	{ primary: '#84cc16', light: 'rgba(132,204,22,0.15)',  name: 'lime'     },  // 9
	{ primary: '#6366f1', light: 'rgba(99,102,241,0.15)',  name: 'indigo'   },  // 10
	{ primary: '#d946ef', light: 'rgba(217,70,239,0.15)',  name: 'fuchsia'  },  // 11
];

export interface AgentColorScheme {
	/** Primary color (saturated, for borders & accents) */
	primary: string;
	/** Light/transparent version (for backgrounds & highlights) */
	light: string;
	/** Color name identifier */
	name: string;
}

// Cache: agentId → color index (stable within session)
const colorCache = new Map<string, number>();
let nextColorIndex = 0;

/**
 * Deterministic hash from string to number (djb2 algorithm).
 * Used to assign colors consistently when cache is empty (e.g. after reload).
 */
function hashString(str: string): number {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) + hash) + str.charCodeAt(i);
		hash = hash & hash; // Convert to 32-bit integer
	}
	return Math.abs(hash);
}

/**
 * Get the color scheme for a given agent ID.
 * First attempt: deterministic hash-based assignment (stable across reloads).
 * If collision occurs, falls back to sequential assignment.
 */
export function getAgentColor(agentId: string): AgentColorScheme {
	let index = colorCache.get(agentId);
	if (index !== undefined) {
		return AGENT_PALETTE[index];
	}

	// Deterministic: hash the ID to pick a color
	index = hashString(agentId) % AGENT_PALETTE.length;

	// If this slot is already taken by a different agent, find next free
	const usedIndices = new Set(colorCache.values());
	if (usedIndices.has(index)) {
		// Check if the existing mapping is for this exact agentId (shouldn't be, since cache miss)
		// Find the next unused slot
		for (let offset = 0; offset < AGENT_PALETTE.length; offset++) {
			const candidate = (index + offset) % AGENT_PALETTE.length;
			if (!usedIndices.has(candidate)) {
				index = candidate;
				break;
			}
		}
		// If all slots are used (12+ agents), wrap around with hash offset
		if (usedIndices.has(index)) {
			index = hashString(agentId) % AGENT_PALETTE.length;
		}
	}

	colorCache.set(agentId, index);
	return AGENT_PALETTE[index];
}

/**
 * Get CSS custom properties string for an agent color.
 * Returns an object with `--agent-color` and `--agent-color-light` values.
 */
export function getAgentColorCSSProps(agentId: string): Record<string, string> {
	const color = getAgentColor(agentId);
	return {
		'--agent-color': color.primary,
		'--agent-color-light': color.light,
	};
}

/**
 * Pre-register colors for a list of agent IDs (preserving insertion order).
 * Call this when loading agents to ensure consistent color assignment.
 */
export function registerAgentColors(agentIds: string[]): void {
	for (const id of agentIds) {
		if (!colorCache.has(id)) {
			getAgentColor(id);
		}
	}
}

/**
 * Clear the color cache (e.g. on workspace switch).
 */
export function resetAgentColors(): void {
	colorCache.clear();
	nextColorIndex = 0;
}
