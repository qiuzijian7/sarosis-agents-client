/*---------------------------------------------------------------------------------------------
 *  nodeCard — React cards mounted inside the LiteGraph overlay (widgetBridge).
 *
 *  One card per graph node; pure presentational (pointer-events:none) so LiteGraph's
 *  canvas handles selection/drag/connection. Cards are driven by the node spec from
 *  `registry.getNodeSpec(type)`:
 *   - react  : Sarosis.* nodes — title + type chip + port labels + key widget values
 *   - schema : ComfyTV stages — title + schema chip (kind/workflowKind) + prompt +
 *                               run button + progress + error banner + output preview
 *   - native : ComfyUI nodes  — title + native chip + widget names/values
 *
 *  Visual language follows ComfyTV's StageCard: a dark rounded panel, an uppercase
 *  section label, a full-width run button (primary bg), a thin progress bar, an
 *  error banner, and an output preview strip. Execution state (running/progress/
 *  error/duration) comes from `CardStateStore` (see cardState.ts).
 *
 *  A `createNodeCard` helper mounts the card into an overlay container and returns
 *  an unmount function; the canvas keeps a Map<nodeId, unmount>.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { NodeSpec, PortSpec } from './registry';
import type { MediaSnapshotStore } from './mediaSnapshotStore';
import { useNodeSnapshots } from './useMediaSnapshot';
import { useNodeCardState, type CardStateStore, type NodeRunState } from './cardState';
import { buildSarosisEditorFields } from './nodeEditorForm';

export interface NodeCardMeta {
	title: string;
	kind: 'react' | 'schema' | 'native';
	kindLabel: string;
	inputs: PortSpec[];
	outputs: PortSpec[];
	/** key widget values (native: seed=…, steps=…) */
	widgetSummary?: string;
	schemaDetail?: string;
	/** ComfyTV stage kind, used to pick run-button label + icon (image/video/audio/…) */
	stageKind?: string;
	/** whether this node has a prompt editor (schema stages only) */
	hasPrompt?: boolean;
	/** current prompt text (schema stages) — bound to node.properties.prompt */
	prompt?: string;
	/** quick actions row (ComfyTV ACTIONS): label-only, click opens editor */
	actions?: string[];
	/** brand tag (ComfyTV / ComfyUI) shown at the top of the card */
	brand?: string;
	/** inline editable parameter controls (ComfyTVWidget equivalents): COMBO →
	 *  select, INT/FLOAT → number, BOOLEAN → checkbox. Excludes `prompt` (own editor). */
	controls?: Array<{ name: string; type: string; value: unknown; options?: string[]; min?: number; max?: number }>;
}

/** Types that get an inline control on the card (COMBO/INT/FLOAT/BOOLEAN). */
function toControls(spec: NodeSpec | undefined, properties: Record<string, unknown>): NodeCardMeta['controls'] {
	if (!spec?.widgets) { return undefined; }
	const list: NonNullable<NodeCardMeta['controls']> = [];
	for (const w of spec.widgets) {
		if (w.name === 'prompt') { continue; } // prompt has its own textarea
		if (w.type !== 'COMBO' && w.type !== 'INT' && w.type !== 'FLOAT' && w.type !== 'BOOLEAN') { continue; }
		const current = properties[w.name] ?? w.default;
		list.push({
			name: w.name,
			type: w.type,
			value: current,
			options: w.options,
			min: w.min,
			max: w.max,
		});
	}
	return list.length > 0 ? list : undefined;
}

/** Quick actions per ComfyTV stage kind (labels mirror ComfyTV's ACTIONS row). */
const STAGE_ACTIONS: Record<string, string[]> = {
	image: ['Edit Image', 'Panorama', 'Multi-angle', 'Relight', 'Presets'],
	'image-batch': ['Edit Image', 'Presets'],
	video: ['Edit', 'Presets'],
	audio: ['Presets'],
};

/** First non-empty string among candidates (skips undefined/null/''). */
function firstNonEmpty(...values: unknown[]): string {
	for (const v of values) {
		if (typeof v === 'string' && v.length > 0) { return v; }
	}
	return '';
}

/** Derive card display metadata from a spec + node properties. Pure, unit-testable. */
export function getNodeCardMeta(spec: NodeSpec | undefined, properties: Record<string, unknown>): NodeCardMeta {
	const title = firstNonEmpty(
		properties.title,
		properties.label,
		spec?.title,
		spec?.type,
		'Node',
	);
	const kind = spec?.kind ?? 'react';
	const kindLabel = kind === 'schema' ? 'schema→React' : kind === 'native' ? 'ComfyUI 原生' : 'React';

	let widgetSummary = spec?.widgets?.length
		? spec.widgets.slice(0, 4).map(w => {
			const v = properties[w.name];
			return v === undefined ? w.name : `${w.name}=${String(v)}`;
		}).join(' · ')
		: undefined;

	// Sarosis (react) nodes: show a compact parameter summary from the form
	// fields (e.g. agentId / skillName / questionText) so the canvas card is
	// informative without opening the editor.
	if (!widgetSummary && kind === 'react') {
		const summary = buildSarosisEditorFields(spec?.type ?? '').map(f => {
			const v = properties[f.key];
			if (v === undefined || v === null || v === '') { return undefined; }
			const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
			const short = text.length > 28 ? `${text.slice(0, 26)}…` : text;
			return `${f.label}=${short}`;
		}).filter((s): s is string => !!s);
		if (summary.length > 0) { widgetSummary = summary.slice(0, 4).join(' · '); }
	}

	const schemaDetail = spec?.comfyTV
		? `stage: ${spec.comfyTV.stageKind ?? '?'} · wf: ${spec.comfyTV.workflowKind ?? '?'}`
		: undefined;

	return {
		title,
		kind,
		kindLabel,
		inputs: spec?.inputs ?? [],
		outputs: spec?.outputs ?? [],
		widgetSummary,
		schemaDetail,
		stageKind: spec?.comfyTV?.stageKind,
		hasPrompt: kind === 'schema',
		prompt: kind === 'schema' && typeof properties.prompt === 'string' ? properties.prompt : undefined,
		actions: kind === 'schema' ? STAGE_ACTIONS[spec?.comfyTV?.stageKind ?? ''] ?? undefined : undefined,
		brand: kind === 'schema' ? 'ComfyTV' : kind === 'native' ? 'ComfyUI' : undefined,
		controls: toControls(spec, properties),
	};
}

const KIND_COLOR: Record<string, string> = {
	react: '#3b82f6',
	schema: '#e879f9',
	native: '#f59e0b',
};

const RUN_LABEL: Record<string, { label: string; icon: string }> = {
	image: { label: '生成图像', icon: '▶' },
	'image-batch': { label: '生成批图', icon: '▶' },
	video: { label: '生成视频', icon: '▶' },
	audio: { label: '生成音频', icon: '▶' },
	text: { label: '生成文本', icon: '▶' },
	'text-batch': { label: '生成文本批', icon: '▶' },
};

/** Thin ComfyTV-style progress bar (h-1.5, gradient fill + mono caption). */
function RunProgress({ progress }: { progress: number }): React.JSX.Element {
	const clamped = Math.max(0, Math.min(100, progress));
	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
			<div style={{ flex: 1, height: 5, borderRadius: 2, overflow: 'hidden', background: 'rgba(255,255,255,.10)' }}>
				<div
					style={{
						height: '100%', width: `${clamped}%`,
						borderRadius: 2,
						background: 'linear-gradient(90deg, rgba(59,130,246,.85), rgba(59,130,246,.6))',
						transition: 'width .15s ease-out',
					}}
				/>
			</div>
			<span style={{ flexShrink: 0, minWidth: 34, fontSize: 9, textAlign: 'right', fontFamily: 'Consolas, monospace', color: 'var(--vscode-descriptionForeground, #858585)' }}>
				{Math.round(clamped)}%
			</span>
		</div>
	);
}

/** ComfyTV-style error banner. */
function ErrorBanner({ message, cancel }: { message: string; cancel: boolean }): React.JSX.Element | null {
	if (!message) { return null; }
	const color = cancel ? '#f59e0b' : '#ef4444';
	return (
		<div
			style={{
				display: 'flex', alignItems: 'flex-start', gap: 5,
				padding: '5px 7px', borderRadius: 4, fontSize: 10, lineHeight: 1.35,
				border: `1px solid ${color}88`, background: `${color}1a`,
				color: cancel ? '#fbbf24' : '#fca5a5',
				fontFamily: 'Consolas, monospace', wordBreak: 'break-word',
			}}
		>
			<span style={{ fontSize: 12, lineHeight: 1 }}>{cancel ? '⏹' : '⚠'}</span>
			<span>{message}</span>
		</div>
	);
}

/** Thumbnail preview — grid of all image outputs, or a label row for other media. */
function SnapshotPreview({ store, nodeId }: { store: MediaSnapshotStore; nodeId: string }): React.JSX.Element | null {
	const entries = useNodeSnapshots(store, nodeId);
	if (entries.length === 0) { return null; }
	const images = entries.filter(e => e.media.kind === 'image');
	const others = entries.filter(e => e.media.kind !== 'image');
	if (images.length > 0) {
		return (
			<div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
				{images.map((e, i) => (
					<div key={i} style={{
						width: 64, height: 64, borderRadius: 4, overflow: 'hidden',
						border: '1px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.03)',
					}}>
						<img src={e.media.ref} alt="preview" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
					</div>
				))}
			</div>
		);
	}
	return (
		<div style={{
			fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)', marginTop: 3,
			fontFamily: 'Consolas, monospace', display: 'flex', flexDirection: 'column', gap: 2,
		}}>
			{others.map((e, i) => (
				<div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
					<span>{e.media.kind === 'video' ? '🎞' : e.media.kind === 'audio' ? '🔊' : '📄'}</span>
					<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.media.ref}</span>
				</div>
			))}
		</div>
	);
}

/** Uppercase section label (ComfyTV `ctv:text-2xs ctv:uppercase ctv:tracking-wide ctv:opacity-60`). */
function SectionLabel({ children, color }: { children: React.ReactNode; color?: string }): React.JSX.Element {
	return (
		<div style={{
			fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', opacity: .6,
			marginBottom: 3, color: color ?? 'var(--vscode-descriptionForeground, #858585)',
			whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
		}}>
			{children}
		</div>
	);
}

/**
 * Lightweight prompt store so inline prompt edits on a card stay in sync
 * with the editor popup (and vice-versa). Plain class + React hook, mirrors
 * CardStateStore. Values are persisted into node.properties by the canvas
 * (`wf-node-prompt` handler), so the workflow save path is unchanged.
 */
class PromptStore {
	private values = new Map<string, string>();
	private listeners = new Set<() => void>();
	get(nodeId: string): string { return this.values.get(nodeId) ?? ''; }
	set(nodeId: string, prompt: string): void {
		this.values.set(nodeId, prompt);
		this.notify();
	}
	clear(nodeId: string): void {
		this.values.delete(nodeId);
		this.notify();
	}
	clearAll(): void {
		this.values.clear();
		this.notify();
	}
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};
	private notify(): void {
		for (const l of this.listeners) { l(); }
	}
}

let promptStoreSingleton: PromptStore | null = null;
export function getPromptStore(): PromptStore {
	if (!promptStoreSingleton) { promptStoreSingleton = new PromptStore(); }
	return promptStoreSingleton;
}

export interface NodeCardProps {
	meta: NodeCardMeta;
	snapshotStore?: MediaSnapshotStore;
	cardStateStore?: CardStateStore;
	nodeId?: string;
}

export function NodeCard({ meta, snapshotStore, cardStateStore, nodeId }: NodeCardProps): React.JSX.Element {
	const kindColor = KIND_COLOR[meta.kind] ?? '#888';
	const run = useNodeCardState(cardStateStore, nodeId);
	const runLabel = RUN_LABEL[meta.stageKind ?? ''] ?? { label: '运行', icon: '▶' };
	const showRun = meta.kind === 'schema';
	const duration = run.durationMs != null && run.durationMs > 0
		? run.durationMs < 60000 ? `${(run.durationMs / 1000).toFixed(1)}s` : `${Math.floor(run.durationMs / 60000)}m ${Math.round((run.durationMs % 60000) / 1000)}s`
		: '';
	const showOutput = run.runState === 'success' || run.runState === 'error';

	// Inline prompt editor (schema stages). Value is kept in a tiny store so the
	// editor popup and the canvas card stay in sync; every edit is also bridged
	// back to node.properties.prompt (canvas → store → workflow save).
	const promptStore = getPromptStore();
	// Seed the store from meta.prompt on first mount (idempotent — only set
	// when the store has no entry yet, so later meta.prompt changes from a
	// fresh load still apply).
	React.useEffect(() => {
		if (nodeId && promptStore.get(nodeId) === '' && meta.prompt) {
			promptStore.set(nodeId, meta.prompt);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [nodeId, meta.prompt]);
	const promptValue = nodeId
		? useSyncExternalStore(promptStore.subscribe, () => promptStore.get(nodeId), () => meta.prompt ?? '')
		: (meta.prompt ?? '');
	const commitPrompt = React.useCallback((next: string) => {
		if (nodeId) {
			promptStore.set(nodeId, next);
			window.dispatchEvent(new CustomEvent('wf-node-prompt', { detail: { nodeId, prompt: next } }));
		}
	}, [nodeId, promptStore]);

	// Inline parameter controls (workflow/resolution/…). Local state mirrors
	// meta.controls so the card stays responsive; edits bridge back to
	// node.properties via `wf-node-control`.
	const [controlDrafts, setControlDrafts] = React.useState<Record<string, unknown>>(() => {
		const init: Record<string, unknown> = {};
		for (const c of meta.controls ?? []) { init[c.name] = c.value; }
		return init;
	});
	const commitControl = React.useCallback((name: string, value: unknown) => {
		setControlDrafts(d => ({ ...d, [name]: value }));
		if (nodeId) {
			window.dispatchEvent(new CustomEvent('wf-node-control', { detail: { nodeId, name, value } }));
		}
	}, [nodeId]);

	return (
		<div
			className="wf-comfy-card"
			style={{
				position: 'relative',
				width: '100%',
				height: '100%',
				boxSizing: 'border-box',
				pointerEvents: 'none',
				userSelect: 'none',
				overflow: 'hidden',
				borderRadius: 8,
				border: `1.5px solid ${kindColor}55`,
				// Opaque card background so overlapping cards fully occlude
				// the card behind them (semi-transparent .94 let the lower
				// card bleed through, which looked like "z-order" chaos).
				background: 'linear-gradient(180deg, rgb(38,38,46), rgb(24,24,28))',
				color: 'var(--vscode-foreground, #ccc)',
				fontFamily: 'inherit',
				boxShadow: '0 4px 18px rgba(0,0,0,.45)',
				fontSize: 11,
				padding: '6px 8px',
				display: 'flex',
				flexDirection: 'column',
				gap: 3,
			}}
		>
			{/* Schema stages hide the canvas title bar (NO_TITLE class), so the
			    card renders the node's title itself — the whole node is then one
			    DOM layer and overlapping nodes stack correctly. Native ComfyUI
			    nodes still let LiteGraph draw the title bar. */}
			{meta.kind === 'schema' && (
				<div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
					<span style={{ fontSize: 11, fontWeight: 600, color: 'var(--vscode-foreground, #e8e8e8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
						{meta.title}
					</span>
				</div>
			)}
			{meta.brand && (
				<div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
					<span style={{ fontSize: 8, letterSpacing: 1.5, textTransform: 'uppercase', opacity: .45, color: 'var(--vscode-descriptionForeground, #858585)' }}>
						{meta.brand}
					</span>
					{meta.schemaDetail && (
						<span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)', fontFamily: 'Consolas, monospace' }}>
							{meta.schemaDetail}
						</span>
					)}
				</div>
			)}
			{!meta.brand && meta.schemaDetail && (
				<div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)', fontFamily: 'Consolas, monospace' }}>
					{meta.schemaDetail}
				</div>
			)}
			{meta.widgetSummary && (
				<div style={{ fontSize: 9, color: '#9cdcfe', fontFamily: 'Consolas, monospace' }}>
					{meta.widgetSummary}
				</div>
			)}

			{/* Inline parameter controls (ComfyTVWidget equivalents). 2-column
				 grid to keep the card height small even with 6+ widgets. */}
			{showRun && meta.controls && meta.controls.length > 0 && (
				<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
					{meta.controls.map(c => {
						const val = controlDrafts[c.name] ?? c.value;
						if (c.type === 'COMBO') {
							// Combos with options get a full row, otherwise they
							// would crowd the grid label.
							const wide = !c.options || c.options.length === 0;
							return (
								<label key={c.name} style={{ gridColumn: wide ? '1 / -1' : 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, minWidth: 0 }}>
									<span style={{ color: 'var(--vscode-descriptionForeground, #858585)', width: 38, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
									<select
										value={String(val ?? '')}
										onChange={e => commitControl(c.name, e.target.value)}
										style={{
											pointerEvents: 'auto', flex: 1, padding: '1px 3px', borderRadius: 3, minWidth: 0,
											background: 'var(--vscode-input-background, rgba(255,255,255,.06))',
											color: 'var(--vscode-foreground, #e8e8e8)',
											border: '1px solid var(--vscode-input-border, rgba(255,255,255,.14))',
											fontSize: 9, fontFamily: 'inherit',
										}}
									>
										{(c.options && c.options.length > 0)
											? c.options.map(o => <option key={String(o)} value={String(o)}>{String(o)}</option>)
											: <option value={String(val ?? '')}>{String(val ?? '')}</option>}
									</select>
								</label>
							);
						}
						if (c.type === 'INT' || c.type === 'FLOAT') {
							return (
								<label key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, minWidth: 0 }}>
									<span style={{ color: 'var(--vscode-descriptionForeground, #858585)', width: 38, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
									<input
										type="number"
										value={String(val ?? '')}
										min={c.min}
										max={c.max}
										onChange={e => commitControl(c.name, c.type === 'INT' ? Math.round(Number(e.target.value)) : Number(e.target.value))}
										style={{
											pointerEvents: 'auto', flex: 1, padding: '1px 3px', borderRadius: 3, minWidth: 0,
											background: 'var(--vscode-input-background, rgba(255,255,255,.06))',
											color: 'var(--vscode-foreground, #e8e8e8)',
											border: '1px solid var(--vscode-input-border, rgba(255,255,255,.14))',
											fontSize: 9, fontFamily: 'inherit',
										}}
									/>
								</label>
							);
						}
						if (c.type === 'BOOLEAN') {
							return (
								<label key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, minWidth: 0 }}>
									<input
										type="checkbox"
										checked={!!val}
										onChange={e => commitControl(c.name, e.target.checked)}
										style={{ pointerEvents: 'auto' }}
									/>
									<span style={{ color: 'var(--vscode-descriptionForeground, #858585)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
								</label>
							);
						}
						return null;
					})}
				</div>
			)}

			{/* Inline prompt editor (ComfyTV MainPromptInput equivalent) */}
			{showRun && meta.hasPrompt && (
				<textarea
					value={promptValue}
					onChange={e => commitPrompt(e.target.value)}
					placeholder="提示词…"
					rows={1}
					spellCheck={false}
					style={{
						pointerEvents: 'auto', resize: 'none', boxSizing: 'border-box',
						width: '100%', padding: '3px 5px', borderRadius: 3,
						background: 'var(--vscode-input-background, rgba(255,255,255,.06))',
						color: 'var(--vscode-foreground, #e8e8e8)', border: '1px solid var(--vscode-input-border, rgba(255,255,255,.14))',
						fontSize: 10, lineHeight: 1.4, fontFamily: 'inherit', minHeight: 28, maxHeight: 80,
						overflowY: 'auto',
					}}
				/>
			)}

			{/* ComfyTV stage: run button + progress + error + output */}
			{showRun && (
				<>
					<button
						type="button"
						disabled={run.runState === 'running'}
						title="运行此节点（双击也可打开编辑器）"
						onClick={() => {
							if (nodeId) {
								// Bridge back to the canvas: opens the editor popup
								// (which owns the actual runner call).
								window.dispatchEvent(new CustomEvent('wf-node-run', { detail: { nodeId } }));
							}
						}}
						style={{
							display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
							marginTop: 4, padding: '6px 10px', borderRadius: 6,
							border: 'none', cursor: run.runState === 'running' ? 'default' : 'pointer',
							pointerEvents: 'auto',
							background: run.runState === 'error'
								? '#dc2626'
								: run.runState === 'running' ? '#b91c1c'
								: 'linear-gradient(180deg, #3b82f6, #2563eb)',
							color: '#fff', fontWeight: 600, fontSize: 11,
							width: '100%', boxSizing: 'border-box',
							fontFamily: 'inherit',
						}}
					>
						<span>{run.runState === 'running' ? '⏹' : run.runState === 'success' ? '↻' : runLabel.icon}</span>
						<span>
							{run.runState === 'running' ? '取消'
								: run.runState === 'success' ? '重新运行'
								: run.runState === 'error' ? '重试'
								: runLabel.label}
						</span>
					</button>
					{run.runState === 'running' && <RunProgress progress={run.progress} />}
					{run.runState === 'error' && <ErrorBanner message={run.errorMsg ?? '执行失败'} cancel={false} />}
					{showOutput && (
						<>
							<div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
								<SectionLabel>Output</SectionLabel>
								<span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)', fontFamily: 'Consolas, monospace' }}>
									{duration}
								</span>
							</div>
							{snapshotStore && nodeId && <SnapshotPreview store={snapshotStore} nodeId={nodeId} />}
						</>
					)}
					{meta.actions && meta.actions.length > 0 && (
						<>
							<div style={{ marginTop: 3 }}><SectionLabel>Actions</SectionLabel></div>
							<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
								{meta.actions.map(a => (
									<button
										key={a}
										type="button"
										title="打开编辑器"
										onClick={() => {
											if (nodeId) {
												window.dispatchEvent(new CustomEvent('wf-node-run', { detail: { nodeId } }));
											}
										}}
										style={{
											pointerEvents: 'auto', cursor: 'pointer',
											padding: '2px 7px', borderRadius: 4,
											border: '1px solid var(--vscode-panel-border, rgba(255,255,255,.14))',
											background: 'transparent', color: 'var(--vscode-foreground, #e8e8e8)',
											fontSize: 9, fontFamily: 'inherit',
										}}
									>
										{a}
									</button>
								))}
							</div>
						</>
					)}
				</>
			)}
		</div>
	);
}

/** Mount a card into an overlay container; returns an unmount function. */
export function createNodeCard(
	container: HTMLElement,
	meta: NodeCardMeta,
	options?: { snapshotStore?: MediaSnapshotStore; cardStateStore?: CardStateStore; nodeId?: string },
): () => void {
	let root: Root | null = null;
	container.innerHTML = '';
	// createRoot on a fresh element avoids "already been rendered" warnings on re-mount.
	const host = document.createElement('div');
	host.style.cssText = 'width:100%;height:100%;';
	container.appendChild(host);
	try {
		root = createRoot(host);
		root.render(
			<NodeCard
				meta={meta}
				snapshotStore={options?.snapshotStore}
				cardStateStore={options?.cardStateStore}
				nodeId={options?.nodeId}
			/>,
		);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn('[nodeCard] mount failed, falling back to raw text:', err);
		container.textContent = meta.title;
	}
	return () => {
		if (root) {
			root.unmount();
			root = null;
		}
		host.remove();
	};
}

/** Re-export run-state helpers so tests can build/assert states. */
export type { NodeRunState };
