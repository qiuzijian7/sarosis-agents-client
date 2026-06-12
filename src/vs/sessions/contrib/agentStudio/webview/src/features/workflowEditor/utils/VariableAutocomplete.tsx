/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Variable Autocomplete for prompt inputs
 *  Reference: cc-wf-studio has a simple "Insert variable" dropdown; this component
 *  upgrades that to a full IDE-style IntelliSense popup that appears when the user
 *  types `{{` inside a textarea. Supports keyboard navigation (↑↓ Enter Esc Tab).
 *
 *  Detection rule (regex):
 *    /\{\{(\w*)$/    → caret sits right after an unclosed `{{` block
 *  Insertion:
 *    Replaces the `{{<typed-prefix>` fragment with `{{<chosenName>}` and leaves
 *    the caret right after the inserted `}}`.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';

/** A variable available in the current completion context. */
export interface IVariableCandidate {
	name: string;
	/** Source category shown next to the name in the popup. */
	source: 'context' | 'workflow' | 'node' | 'static';
	/** Short description for the popup footer (optional). */
	description?: string;
	/** Free-form metadata for callers (e.g. the upstream node's label). */
	tag?: string;
}

interface VariableAutocompleteProps {
	/** Ref to the underlying <textarea> or <input> we are reading caret info from. */
	targetRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
	/** Current text value (controlled). */
	text: string;
	/** Called with the new text after a variable is inserted. */
	onChange: (next: string) => void;
	/** All variables that can be offered in the popup. */
	candidates: IVariableCandidate[];
	/** Optional: stable id used for ARIA wiring. */
	id?: string;
}

interface IPopupState {
	open: boolean;
	/** Caret offset inside the textarea (0-based character index). */
	caret: number;
	/** Char index of the `{{` that started the current block. */
	blockStart: number;
	/** Text typed between `{{` and the caret (the search prefix). */
	prefix: string;
	/** Anchor position relative to the textarea element. */
	anchor: { left: number; top: number };
	/** Index of the highlighted candidate in the filtered list. */
	highlight: number;
}

const INITIAL: IPopupState = {
	open: false,
	caret: 0,
	blockStart: 0,
	prefix: '',
	anchor: { left: 0, top: 0 },
	highlight: 0,
};

/**
 * Look backwards from `caret` and return the start index of the unclosed
 * `{{` (or -1 when there is no such block). Stops at the previous `}}`
 * or at the start of the string, whichever comes first.
 */
function findOpenBlockStart(text: string, caret: number): number {
	// Window of text behind the caret that could plausibly contain the `{{`.
	const tail = text.slice(Math.max(0, caret - 200), caret);
	// Find the last `}}` *after* the last `{{` — i.e. is there a `{{` that
	// is still unclosed at the caret?
	const lastClose = tail.lastIndexOf('}}');
	const lastOpen = tail.lastIndexOf('{{');
	if (lastOpen < 0) { return -1; }
	if (lastClose > lastOpen) { return -1; } // already closed further down
	return Math.max(0, caret - 200) + lastOpen;
}

export const VariableAutocomplete: React.FC<VariableAutocompleteProps> = ({
	targetRef,
	text,
	onChange,
	candidates,
	id,
}) => {
	const [state, setState] = useState<IPopupState>(INITIAL);
	const popupRef = useRef<HTMLDivElement>(null);
	// Keep the latest candidates in a ref so the keydown handler (attached
	// to the textarea) does not need to re-bind on every change.
	const candidatesRef = useRef(candidates);
	candidatesRef.current = candidates;

	// Filtered candidate list (recomputed when the prefix changes).
	const filtered = useMemo<IVariableCandidate[]>(() => {
		if (!state.open) { return []; }
		const lower = state.prefix.toLowerCase();
		if (!lower) { return candidates; }
		return candidates.filter(c => c.name.toLowerCase().includes(lower));
	}, [state.open, state.prefix, candidates]);

	// Reset highlight when the filtered list changes shape.
	useEffect(() => {
		if (state.highlight >= filtered.length) {
			setState(s => ({ ...s, highlight: Math.max(0, filtered.length - 1) }));
		}
	}, [filtered.length, state.highlight]);

	const close = useCallback(() => {
		setState(s => (s.open ? INITIAL : s));
	}, []);

	const detect = useCallback(() => {
		const ta = targetRef.current;
		if (!ta) { return; }
		const caret = ta.selectionStart ?? 0;
		const start = findOpenBlockStart(text, caret);
		if (start < 0) { close(); return; }
		const prefix = text.slice(start + 2, caret);

		// Reject prefixes containing whitespace (autocomplete should only fire
		// for the `{{abc` style — once the user types a space, they're done).
		if (/\s/.test(prefix)) { close(); return; }

		// Anchor the popup just below the caret, measured from the textarea.
		const coords = measureCaret(ta, start + 2); // show popover after `{{`
		setState({
			open: true,
			caret,
			blockStart: start,
			prefix,
			anchor: coords,
			highlight: 0,
		});
	}, [targetRef, text, close]);

	// Bind caret-tracking listeners. We deliberately use `input` (covers IME
	// composition in modern browsers) and `keyup`/`click` (covers arrow keys
	// that don't change the text but move the caret).
	useEffect(() => {
		const ta = targetRef.current;
		if (!ta) { return; }
		const handler = () => detect();
		ta.addEventListener('input', handler);
		ta.addEventListener('keyup', handler);
		ta.addEventListener('click', handler);
		ta.addEventListener('select', handler);
		return () => {
			ta.removeEventListener('input', handler);
			ta.removeEventListener('keyup', handler);
			ta.removeEventListener('click', handler);
			ta.removeEventListener('select', handler);
		};
	}, [targetRef, detect]);

	// Click outside closes the popup.
	useEffect(() => {
		if (!state.open) { return; }
		const onDoc = (e: MouseEvent) => {
			const ta = targetRef.current;
			if (ta && ta.contains(e.target as Node)) { return; }
			if (popupRef.current && popupRef.current.contains(e.target as Node)) { return; }
			close();
		};
		document.addEventListener('mousedown', onDoc);
		return () => document.removeEventListener('mousedown', onDoc);
	}, [state.open, close, targetRef]);

	const insertCandidate = useCallback((idx: number) => {
		const cand = filtered[idx];
		if (!cand) { return; }
		const ta = targetRef.current;
		if (!ta) { return; }
		// Replace the `{{<prefix>` fragment with the full `{{name}}` token.
		const before = text.slice(0, state.blockStart);
		const after = text.slice(state.caret);
		const token = `{{${cand.name}}}`;
		const next = before + token + after;
		onChange(next);
		// Restore caret right after the inserted token on the next tick.
		const newCaret = state.blockStart + token.length;
		setTimeout(() => {
			ta.focus();
			ta.setSelectionRange(newCaret, newCaret);
		}, 0);
		close();
	}, [filtered, state.blockStart, state.caret, text, onChange, targetRef, close]);

	// Keyboard navigation: ↑↓, Enter/Tab insert, Esc closes.
	const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (!state.open) { return; }
		if (filtered.length === 0 && e.key !== 'Escape') { return; }
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setState(s => ({ ...s, highlight: (s.highlight + 1) % Math.max(1, filtered.length) }));
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setState(s => ({ ...s, highlight: (s.highlight - 1 + filtered.length) % Math.max(1, filtered.length) }));
		} else if (e.key === 'Enter' || e.key === 'Tab') {
			e.preventDefault();
			insertCandidate(state.highlight);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			close();
		}
	}, [state.open, state.highlight, filtered.length, insertCandidate, close]);

	// Re-render the textarea with our onKeyDown wrapper.
	// We achieve this by attaching a native listener to the DOM ref.
	useEffect(() => {
		const ta = targetRef.current;
		if (!ta) { return; }
		const nativeHandler = (ev: KeyboardEvent) => {
			const fakeEvent = {
				key: ev.key,
				preventDefault: () => ev.preventDefault(),
			} as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
			onKeyDown(fakeEvent);
		};
		ta.addEventListener('keydown', nativeHandler as any);
		return () => ta.removeEventListener('keydown', nativeHandler as any);
	}, [targetRef, onKeyDown]);

	if (!state.open || filtered.length === 0) { return null; }

	return (
		<div
			id={id}
			ref={popupRef}
			style={{
				position: 'absolute',
				left: state.anchor.left,
				top: state.anchor.top,
				zIndex: 9999,
				minWidth: 240,
				maxWidth: 360,
				maxHeight: 220,
				overflowY: 'auto',
				background: 'var(--vscode-menu-background, #252526)',
				border: '1px solid var(--vscode-menu-border, #454545)',
				borderRadius: 4,
				padding: '4px 0',
				boxShadow: '0 6px 16px rgba(0,0,0,0.45)',
				fontSize: 11,
				color: 'var(--vscode-menu-foreground, #cccccc)',
			}}
		>
			{filtered.map((c, i) => {
				const isHighlighted = i === state.highlight;
				return (
					<div
						key={c.name}
						onMouseDown={(e) => { e.preventDefault(); insertCandidate(i); }}
						onMouseEnter={() => setState(s => ({ ...s, highlight: i }))}
						style={{
							display: 'flex', alignItems: 'center', gap: 8,
							padding: '4px 10px',
							cursor: 'pointer',
							background: isHighlighted
								? 'var(--vscode-menu-selectionBackground, #094771)'
								: 'transparent',
						}}
					>
						<span style={{ color: 'var(--vscode-charts-blue, #4fc1ff)', fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>
							{`{{${c.name}}}`}
						</span>
						<span style={{ color: 'var(--vscode-descriptionForeground, #999)', fontSize: 10, marginLeft: 'auto', flexShrink: 0 }}>
							{sourceLabel(c.source, c.tag)}
						</span>
					</div>
				);
			})}
		</div>
	);
};

/* ── helpers ──────────────────────────────────────────────────────────── */

function sourceLabel(source: IVariableCandidate['source'], tag?: string): string {
	if (tag) { return tag; }
	switch (source) {
		case 'context': return 'context';
		case 'workflow': return 'workflow';
		case 'node': return 'node';
		case 'static': return 'static';
	}
}

/**
 * Measure the screen position of the character at `charIndex` inside the
 * target element (input or textarea), relative to the element (so the
 * popup can be absolutely positioned). Falls back to the bounding rect
 * when measurement fails.
 */
function measureCaret(
	el: HTMLTextAreaElement | HTMLInputElement,
	charIndex: number,
): { left: number; top: number } {
	const rect = el.getBoundingClientRect();

	// v15: for <input> elements, the popup sits directly below the input —
	// the user only types a single line so caret-accurate placement adds no
	// value, and the mirror-div technique below only works for textarea.
	if (el.tagName !== 'TEXTAREA') {
		return { left: 0, top: rect.height + 2 };
	}

	const ta = el as HTMLTextAreaElement;
	try {
		// mirror the textarea into a hidden div so we can measure
		// the caret position via Range. This is the standard trick
		// for textarea caret coordinates.
		const div = document.createElement('div');
		const style = getComputedStyle(ta);
		const copyProps: Array<keyof CSSStyleDeclaration> = [
			'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
			'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
			'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
			'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
			'fontSizeAdjust', 'lineHeight', 'fontFamily',
			'textAlign', 'textTransform', 'textIndent', 'textDecoration',
			'letterSpacing', 'wordSpacing',
		];
		for (const p of copyProps) {
			// @ts-expect-error - dynamic CSS property copy
			div.style[p] = style[p];
		}
		div.style.position = 'absolute';
		div.style.visibility = 'hidden';
		div.style.whiteSpace = 'pre-wrap';
		div.style.wordWrap = 'break-word';
		div.style.left = '-9999px';
		div.style.top = '0';

		const text = ta.value.slice(0, charIndex);
		div.textContent = text;

		const span = document.createElement('span');
		span.textContent = ta.value.slice(charIndex) || '.';
		div.appendChild(span);

		document.body.appendChild(div);
		const spanRect = span.getBoundingClientRect();
		const divRect = div.getBoundingClientRect();
		document.body.removeChild(div);

		return {
			left: (spanRect.left - divRect.left) + ta.scrollLeft,
			top: (spanRect.top - divRect.top) + ta.scrollTop,
		};
	} catch {
		return { left: 0, top: rect.height };
	}
}

/**
 * Helper: build the full candidate list for a given node. Includes:
 *   - per-node static values (data.variables)
 *   - upstream node outputs (key: <nodeId>.output or $prev)
 *
 * v16: removed the 3 built-in candidates (`taskTitle`, `taskDescription`,
 * `workflowName`) — the autocomplete popup now only shows variables the
 * user can actually author (their own `data.variables` plus upstream node
 * outputs). The host still injects the 3 built-ins at runtime so hand-typed
 * references like `{{taskDescription}}` keep working, but they no longer
 * appear in the picker.
 *
 * `nodeId` is optional — if omitted, upstream outputs are skipped.
 */
export function buildCandidates(args: {
	nodeData?: Record<string, unknown>;
	nodeId?: string;
	nodes?: Array<{ id: string; data?: Record<string, unknown> }>;
	edges?: Array<{ source: string; target: string }>;
}): IVariableCandidate[] {
	const out: IVariableCandidate[] = [];
	const { nodeData, nodeId, nodes, edges } = args;

	// 1. Per-node static values (cc-wf-studio parity)
	const vars = (nodeData?.variables as Record<string, string> | undefined) ?? {};
	for (const k of Object.keys(vars)) {
		out.push({ name: k, source: 'static', description: 'Per-node static value' });
	}

	// 2. Upstream node outputs (key: <nodeId>.output + $prev)
	if (nodeId && nodes && edges) {
		const upstreamIds = edges.filter(e => e.target === nodeId).map(e => e.source);
		for (const id of upstreamIds) {
			const upNode = nodes.find(n => n.id === id);
			const label = (upNode?.data?.label as string | undefined) || id;
			out.push({
				name: `${id}.output`,
				source: 'node',
				description: `Output of "${label}"`,
				tag: label,
			});
		}
		if (upstreamIds.length > 0) {
			out.push({ name: '$prev', source: 'node', description: 'Most recent upstream output' });
			out.push({ name: '$prev.output', source: 'node', description: 'Most recent upstream output' });
		}
	}

	return out;
}
