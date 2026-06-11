/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Node Inline Editor (v12)
 *
 *  Replaces the floating PropertyPanel. Renders as a compact popover anchored to
 *  the right side of the selected node on the canvas. Supports all node types
 *  with type-specific compact editors.
 *
 *  Design:
 *   - Single click a node → popover appears on its right side
 *   - Click canvas or Esc → dismiss
 *   - Compact layout: max 280px wide, up to 3 fields visible; scroll if more
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useWorkflowEditorStore, nodeTypeSelectors } from './store';
import type { BranchDef, AskUserOption } from '../../types/workflowStorage';
import { useProviderStore } from '../../store/useProviderStore';
import { useAgentStore } from '../../store/useAgentStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { sendRequest } from '../../bridge/messageClient';

// ── mini-styles (compact, in-component) ──

const popoverStyle: React.CSSProperties = {
	position: 'absolute',
	zIndex: 50,
	background: 'var(--vscode-menu-background, #252526)',
	border: '1px solid var(--vscode-menu-border, #454545)',
	borderRadius: '6px',
	padding: '10px',
	minWidth: '220px',
	maxWidth: '280px',
	maxHeight: '360px',
	overflowY: 'auto',
	fontSize: '12px',
	boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
};

const fieldStyle: React.CSSProperties = { marginBottom: '8px' };
const labelStyle: React.CSSProperties = {
	fontSize: '10px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)',
	marginBottom: '2px', display: 'block',
};
const inputStyle: React.CSSProperties = {
	width: '100%', padding: '3px 6px', fontSize: '11px',
	background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
	border: '1px solid var(--vscode-input-border)', borderRadius: '2px',
	boxSizing: 'border-box',
};
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' };
const closeBtnStyle: React.CSSProperties = {
	position: 'absolute', top: '4px', right: '6px',
	background: 'none', border: 'none', color: 'var(--vscode-descriptionForeground)',
	cursor: 'pointer', fontSize: '14px',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div style={fieldStyle}>
			<span style={labelStyle}>{label}</span>
			{children}
		</div>
	);
}

// ── Options mini-editor (reused for AskUser and condition branches) ──

function OptionsMiniEditor({ options, onChange, minItems = 2 }: {
	options: AskUserOption[];
	onChange: (o: AskUserOption[]) => void;
	minItems?: number;
}) {
	const update = (idx: number, field: string, value: string) => {
		const next = options.map((o, i) => i === idx ? { ...o, [field]: value } : o);
		onChange(next);
	};
	const remove = (idx: number) => {
		if (options.length <= minItems) { return; }
		onChange(options.filter((_, i) => i !== idx));
	};
	const add = () => onChange([...options, { label: `Option ${options.length + 1}`, description: '' }]);
	return (
		<Field label="Options">
			{options.map((opt, i) => (
				<div key={i} style={{ marginBottom: '4px', padding: '3px', border: '1px solid var(--vscode-panel-border)', borderRadius: '3px' }}>
					<div style={{ display: 'flex', gap: '2px' }}>
						<input style={{ ...inputStyle, flex: '1', fontSize: '10px' }} value={opt.label} onChange={e => update(i, 'label', e.target.value)} placeholder="Label" />
						{options.length > minItems && <button onClick={() => remove(i)} style={{ ...closeBtnStyle, position: 'static', fontSize: '12px' }}>×</button>}
					</div>
				</div>
			))}
			<button onClick={add} style={{ fontSize: '10px', padding: '1px 6px', cursor: 'pointer', background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)', border: 'none', borderRadius: '3px' }}>+ Add</button>
		</Field>
	);
}

// ── Main component ──

export const NodeInlineEditor: React.FC = () => {
	const selectedNodeId = useWorkflowEditorStore(s => s.selectedNodeId);
	const nodes = useWorkflowEditorStore(s => s.nodes);
	const updateNodeData = useWorkflowEditorStore(s => s.updateNodeData);
	const removeNode = useWorkflowEditorStore(s => s.removeNode);
	const setSelectedNode = useWorkflowEditorStore(s => s.setSelectedNode);

	const selectedNode = nodes.find(n => n.id === selectedNodeId);
	const data = (selectedNode?.data || {}) as Record<string, unknown>;

	const [, setVersion] = useState(0);
	const handleChange = useCallback((field: string, value: unknown) => {
		if (selectedNodeId) { updateNodeData(selectedNodeId, { [field]: value }); }
	}, [selectedNodeId, updateNodeData]);

	// Providers / Agents / Worktrees / Skills — loaded lazily
	const providers = useProviderStore(s => s.providers);
	const loadProviders = useProviderStore(s => s.loadProviders);
	const agents = useAgentStore(s => s.agents);
	const loadAgents = useAgentStore(s => s.loadAgents);
	const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
	const [skills, setSkills] = useState<{ id: string; name: string; description?: string }[]>([]);
	const [worktrees, setWorktrees] = useState<{ path: string; branch: string; repoName?: string }[]>([]);

	useEffect(() => {
		if (selectedNode && providers.length === 0) { loadProviders(); }
		if (selectedNode && agents.length === 0) { loadAgents(); }
		if (selectedNode && skills.length === 0) {
			sendRequest<unknown, { id: string; name: string }[]>('skills.list', {}).then(r => setSkills(Array.isArray(r) ? r : [])).catch(() => {});
		}
		if (selectedNode && activeWorkspaceId) {
			sendRequest<{ workspaceId: string }, { path: string; branch: string; repoName?: string }[]>('worktree.list', { workspaceId: activeWorkspaceId })
				.then(r => setWorktrees(Array.isArray(r) ? r : [])).catch(() => {});
		}
	}, [selectedNode, providers.length, agents.length, skills.length, activeWorkspaceId, loadProviders, loadAgents]);

	// ── Position tracking ──
	const { getNode } = useReactFlow();
	const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
	useEffect(() => {
		if (!selectedNodeId) { setPosition(null); return; }
		const rfNode = getNode(selectedNodeId);
		if (rfNode) {
			setPosition({
				x: rfNode.position.x + (rfNode.measured?.width ?? 200) + 16,
				y: rfNode.position.y,
			});
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedNodeId]);

	// Close on Escape
	useEffect(() => {
		if (!selectedNodeId) { return; }
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSelectedNode(null); } };
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [selectedNodeId, setSelectedNode]);

	if (!selectedNodeId || !selectedNode || !position) { return null; }
	if (selectedNode.type === 'start' || selectedNode.type === 'end') { return null; }

	const isDeletable = selectedNode.type !== 'start' && selectedNode.type !== 'end';
	const nodeName = data.label as string || selectedNode.type || '';

	// ── Render type-specific content ──
	const renderContent = () => {
		switch (selectedNode.type) {
			case 'agent': {
				const config = (data.agentConfig || {}) as { providerId?: string; modelId?: string };
				const currentProvider = providers.find(p => p.id === config.providerId);
				const currentModels = currentProvider?.models ?? [];
				return (
					<>
						<Field label="Agent">
							<select style={selectStyle} value={(data.agentId as string) || ''} onChange={e => {
								const found = agents.find(a => a.id === e.target.value);
								handleChange('agentId', e.target.value);
								handleChange('label', found?.name || (data.label as string));
							}}>
								<option value="">— Select —</option>
								{agents.map(a => (<option key={a.id} value={a.id}>{a.name}</option>))}
							</select>
						</Field>
						<Field label="Prompt">
							<textarea style={{ ...inputStyle, minHeight: '48px', resize: 'vertical' }}
								value={(data.prompt as string) || ''}
								onChange={e => handleChange('prompt', e.target.value)}
								placeholder="What should this agent do?" />
						</Field>
						<Field label="Provider">
							<select style={selectStyle} value={config.providerId || ''} onChange={e => {
								handleChange('agentConfig', { ...config, providerId: e.target.value, modelId: '' });
							}}>
								<option value="">— Select —</option>
								{providers.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
							</select>
						</Field>
						<Field label="Model">
							<select style={selectStyle} value={config.modelId || ''} onChange={e => handleChange('agentConfig', { ...config, modelId: e.target.value })} disabled={!config.providerId}>
								<option value="">— Select —</option>
								{currentModels.map(m => (<option key={m.id} value={m.id}>{m.name}</option>))}
							</select>
						</Field>
						<Field label="Worktree">
							<select style={selectStyle} value={(data.worktreePath as string) || ''} onChange={e => handleChange('worktreePath', e.target.value)}>
								<option value="">— None —</option>
								{worktrees.map(wt => (<option key={wt.path} value={wt.path}>{wt.repoName ? `${wt.repoName} · ` : ''}{wt.branch}</option>))}
							</select>
						</Field>
					</>
				);
			}
			case 'task': {
				return (
					<>
						<Field label="Task Name">
							<input style={inputStyle} value={(data.label as string) || ''} onChange={e => handleChange('label', e.target.value)} placeholder="Task name" />
						</Field>
						<Field label="Description">
							<textarea style={{ ...inputStyle, minHeight: '40px', resize: 'vertical' }}
								value={(data.prompt as string) || ''}
								onChange={e => handleChange('prompt', e.target.value)}
								placeholder="Task description (optional)" />
						</Field>
					</>
				);
			}
			case 'prompt': {
				return (
					<Field label="Prompt Template">
						<textarea style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }}
							value={(data.prompt as string) || ''}
							onChange={e => handleChange('prompt', e.target.value)}
							placeholder="Enter prompt template..." />
					</Field>
				);
			}
			case 'skill': {
				return (
					<>
						<Field label="Skill">
							<select style={selectStyle} value={(data.skillId as string) || ''} onChange={e => { handleChange('skillId', e.target.value); handleChange('label', e.target.value ? skills.find(s => s.id === e.target.value)?.name ?? (data.label as string) : (data.label as string)); }}>
								<option value="">— Select —</option>
								{skills.map(s => (<option key={s.id} value={s.id}>{s.name}</option>))}
							</select>
						</Field>
						<Field label="Input">
							<textarea style={{ ...inputStyle, minHeight: '40px', resize: 'vertical' }}
								value={(data.prompt as string) || ''}
								onChange={e => handleChange('prompt', e.target.value)}
								placeholder="Skill input (optional)" />
						</Field>
					</>
				);
			}
			case 'tool': {
				return (
					<>
						<Field label="Tool Name">
							<input style={inputStyle} value={(data.toolName as string) || ''} onChange={e => handleChange('toolName', e.target.value)} placeholder="e.g. read_file" />
						</Field>
						<Field label="Parameters">
							<textarea style={{ ...inputStyle, minHeight: '40px', resize: 'vertical', fontFamily: 'monospace' }}
								value={(data.params as string) || ''}
								onChange={e => handleChange('params', e.target.value)}
								placeholder='{"key": "value"}' />
						</Field>
					</>
				);
			}
			case 'askUser': {
				const options = (data.options as AskUserOption[]) || [];
				return (
					<>
						<Field label="Question">
							<textarea style={{ ...inputStyle, minHeight: '40px', resize: 'vertical' }}
								value={(data.question as string) || ''}
								onChange={e => handleChange('question', e.target.value)}
								placeholder="What do you want to ask?" />
						</Field>
						<label style={{ fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '8px' }}>
							<input type="checkbox" checked={!!data.multiSelect} onChange={e => handleChange('multiSelect', e.target.checked)} />
							Multi-select
						</label>
						<OptionsMiniEditor options={options} onChange={(o) => { handleChange('options', o); setVersion(v => v + 1); }} />
					</>
				);
			}
			case 'ifElse': {
				const branches = (data.branches as BranchDef[]) || [{ label: 'True', description: '' }, { label: 'False', description: '' }];
				return (
					<>
						<Field label="Condition">
							<input style={inputStyle} value={(data.condition as string) || ''} onChange={e => handleChange('condition', e.target.value)} placeholder="e.g. output === 'ok'" />
						</Field>
						<OptionsMiniEditor options={branches as unknown as AskUserOption[]} onChange={(o) => { handleChange('branches', o); setVersion(v => v + 1); }} minItems={2} />
					</>
				);
			}
			case 'switch': {
				const cases = (data.cases as BranchDef[]) || [{ label: 'Case 1', description: '' }, { label: 'Default', description: '' }];
				return (
					<>
						<Field label="Switch On">
							<input style={inputStyle} value={(data.switchOn as string) || ''} onChange={e => handleChange('switchOn', e.target.value)} placeholder="e.g. {{status}}" />
						</Field>
						<OptionsMiniEditor options={cases as unknown as AskUserOption[]} onChange={(o) => { handleChange('cases', o); setVersion(v => v + 1); }} minItems={2} />
					</>
				);
			}
			default:
				return (
					<Field label="Label">
						<input style={inputStyle} value={nodeName} onChange={e => handleChange('label', e.target.value)} placeholder="Node label" />
					</Field>
				);
		}
	};

	return (
		<div style={{ ...popoverStyle, left: position.x, top: position.y }} onClick={e => e.stopPropagation()}>
			<button style={closeBtnStyle} onClick={() => setSelectedNode(null)}>✕</button>
			<div style={{ fontWeight: 600, fontSize: '11px', marginBottom: '8px', color: 'var(--vscode-foreground)', textTransform: 'capitalize' }}>
				{selectedNode.type} · {nodeName}
			</div>
			{renderContent()}
			{isDeletable && (
				<button onClick={() => { removeNode(selectedNodeId); setSelectedNode(null); }}
					style={{ marginTop: '8px', fontSize: '10px', padding: '2px 8px', background: 'var(--vscode-errorForeground)', color: '#fff', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>
					Delete Node
				</button>
			)}
		</div>
	);
};
