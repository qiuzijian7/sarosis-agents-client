/**
 * Run-state display helpers for NodeCard.
 * Extracted from nodeCard.tsx for testability.
 */

import type { NodeRunState } from './cardState';

/** Icon character for a run-state badge. */
export function runStateIcon(state: NodeRunState | undefined): string {
	switch (state) {
		case 'running': return '▶';
		case 'done': return '✓';
		case 'error': return '✗';
		default: return '';
	}
}

/** Short label for a run-state badge. */
export function runStateLabel(state: NodeRunState | undefined): string {
	switch (state) {
		case 'running': return 'Running';
		case 'done': return 'Done';
		case 'error': return 'Error';
		default: return '';
	}
}
