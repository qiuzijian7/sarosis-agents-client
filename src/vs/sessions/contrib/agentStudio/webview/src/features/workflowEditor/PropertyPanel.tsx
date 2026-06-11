/*---------------------------------------------------------------------------------------------
 *  PropertyPanel — floating panel that shows properties for the selected node.
 *  Supports all 14 node types with type-specific editing forms.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useState, useEffect, useRef } from 'react';
import { useWorkflowEditorStore, nodeTypeSelectors } from './store';
import type { BranchDef, AskUserOption } from '../../types/workflowStorage';
import { useProviderStore } from '../../store/useProviderStore';
import { useAgentStore } from '../../store/useAgentStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { sendRequest } from '../../bridge/messageClient';

export const PropertyPanel: React.FC = () => {
	const selectedNodeId = useWorkflowEditorStore(s => s.selectedNodeId);
	const isOpen = useWorkflowEditorStore(s => s.isPropertyPanelOpen);
	const nodes = useWorkflowEditorStore(s => s.nodes);
	const updateNodeData = useWorkflowEditorStore(s => s.updateNodeData);
	const removeNode = useWorkflowEditorStore(s => s.removeNode);
	const setSelectedNode = useWorkflowEditorStore(s => s.setSelectedNode);

	// Load providers once when panel opens
	const providers = useProviderStore(s => s.providers);
	const loadProviders = useProviderStore(s => s.loadProviders);
	useEffect(() => {
		if (isOpen && providers.length === 0) {
			loadProviders();
		}
	}, [isOpen, providers.length, loadProviders]);

	// Load agents list for agent node dropdown
	const agents = useAgentStore(s => s.agents);
	const loadAgents = useAgentStore(s => s.loadAgents);
	useEffect(() => {
		if (isOpen && agents.length === 0) {
			loadAgents();
		}
	}, [isOpen, agents.length, loadAgents]);

	// Load skills list for skill node dropdown
	const [skills, setSkills] = useState<Array<{ id: string; name: string; description?: string; category?: string }>>([]);
	useEffect(() => {
		if (isOpen && skills.length === 0) {
			sendRequest<unknown, Array<{ id: string; name: string; description?: string; category?: string }>>('skills.list', {})
				.then(list => { if (Array.isArray(list)) { setSkills(list); } })
				.catch(() => { /* skills.list not available */ });
		}
	}, [isOpen, skills.length]);

	// Load worktree list for agent node worktree dropdown (current workspace's git worktrees)
	const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
	const [worktrees, setWorktrees] = useState<Array<{ path: string; branch: string; repoName?: string }>>([]);
	useEffect(() => {
		if (!isOpen) { return; }
		// Pass workspaceId if available; host falls back to its own active workspace when empty
		sendRequest<{ workspaceId?: string }, Array<{ path: string; branch: string; repoName?: string }>>(
			'worktree.list',
			{ workspaceId: activeWorkspaceId || undefined },
		).then(list => {
			setWorktrees(Array.isArray(list) ? list.map(wt => ({ path: wt.path, branch: wt.branch, repoName: wt.repoName })) : []);
		}).catch(() => { setWorktrees([]); });
	}, [isOpen, activeWorkspaceId]);
	// Refresh the worktree list whenever a worktree is created/removed elsewhere
	useEffect(() => {
		const handler = () => {
			sendRequest<{ workspaceId?: string }, Array<{ path: string; branch: string; repoName?: string }>>(
				'worktree.list',
				{ workspaceId: activeWorkspaceId || undefined },
			).then(list => {
				setWorktrees(Array.isArray(list) ? list.map(wt => ({ path: wt.path, branch: wt.branch, repoName: wt.repoName })) : []);
			}).catch(() => { /* ignore */ });
		};
		window.addEventListener('agentStudio:worktree-changed', handler);
		return () => window.removeEventListener('agentStudio:worktree-changed', handler);
	}, [activeWorkspaceId]);

	const selectedNode = nodes.find(n => n.id === selectedNodeId);
	const data = (selectedNode?.data || {}) as Record<string, unknown>;

	const handleChange = useCallback((field: string, value: unknown) => {
		if (selectedNodeId) {
			updateNodeData(selectedNodeId, { [field]: value });
		}
	}, [selectedNodeId, updateNodeData]);

	// Local clone of data for complex editors (branches, options)
	const [, setVersion] = useState(0);

	if (!isOpen || !selectedNode || selectedNode.type === 'start' || selectedNode.type === 'end' || selectedNode.type === 'group') {
		return null;
	}

	const isDeletable = selectedNode.type !== 'start' && selectedNode.type !== 'end';
	const nodeInfo = nodeTypeSelectors.find(n => n.type === selectedNode.type);

	return (
		<div style={panelStyle}>
			{/* Header */}
			<div style={headerStyle}>
				<div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
					<span>{nodeInfo?.icon || '📌'}</span>
					<span style={{ fontWeight: 600, fontSize: '13px' }}>
						{nodeInfo?.label || selectedNode.type}
					</span>
				</div>
				<div style={{ display: 'flex', gap: '4px' }}>
					<button onClick={() => setSelectedNode(null)}
						title="Close" style={closeBtnStyle}>✕</button>
				</div>
			</div>

			{/* Body */}
			<div style={{ padding: '12px', overflow: 'auto', flex: 1 }}>
				<Field label="Name">
					<input type="text" value={(data.label as string) || ''}
						onChange={e => handleChange('label', e.target.value)}
						style={inputStyle} placeholder="Node name" />
				</Field>

				{renderNodeTypeFields(selectedNode.type, data, handleChange, setVersion, providers, agents, skills, worktrees)}

				{isDeletable && (
					<div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--vscode-panel-border)' }}>
						<button onClick={() => { removeNode(selectedNode.id); setSelectedNode(null); }}
							style={{
								width: '100%', padding: '6px 12px',
								border: '1px solid var(--vscode-inputValidation-errorBorder)',
								borderRadius: '4px',
								backgroundColor: 'transparent',
								color: 'var(--vscode-errorForeground)',
								cursor: 'pointer', fontSize: '12px',
							}}>
							Delete Node
						</button>
					</div>
				)}
			</div>
		</div>
	);
};

/* ── Per-type field renderers ──────────────────────────────────────────── */

function renderNodeTypeFields(
	type: string | undefined,
	data: Record<string, unknown>,
	handleChange: (field: string, value: unknown) => void,
	setVersion: React.Dispatch<React.SetStateAction<number>>,
	providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>,
	agents: Array<{ id: string; name: string; icon: string }>,
	skills: Array<{ id: string; name: string; description?: string; category?: string }>,
	worktrees: Array<{ path: string; branch: string; repoName?: string }>,
): React.ReactNode {
	if (!type) { return null; }

	switch (type) {
		case 'prompt':
			return (
				<Field label="Prompt Template">
					<textarea
						value={(data.prompt as string) || ''}
						onChange={e => handleChange('prompt', e.target.value)}
						style={{ ...inputStyle, minHeight: '80px', resize: 'vertical', fontFamily: 'monospace' }}
						placeholder="Enter prompt text. Use {{variable}} for substitution."
					/>
				</Field>
			);

		case 'agent': {
			const config = (data.agentConfig || {}) as { providerId?: string; modelId?: string };
			const currentProvider = providers.find(p => p.id === config.providerId);
			const currentModels = currentProvider?.models ?? [];
			const selectedAgent = agents.find(a => a.id === (data.agentId as string));
			return (
				<>
					<Field label="Agent">
						<select
							value={(data.agentId as string) || ''}
							onChange={e => {
								const id = e.target.value;
								const agent = agents.find(a => a.id === id);
								handleChange('agentId', id);
								handleChange('label', agent?.name || (data.label as string));
							}}
							style={selectStyle}
						>
							<option value="">— Select agent —</option>
							{agents.map(a => (
								<option key={a.id} value={a.id}>{a.icon} {a.name}</option>
							))}
						</select>
					</Field>
					{selectedAgent && (
						<div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)', marginTop: '-8px', marginBottom: '8px' }}>
							ID: {selectedAgent.id}
						</div>
					)}
					<Field label="Provider">
						<select
							value={config.providerId || ''}
							onChange={e => {
								const newPid = e.target.value;
								handleChange('agentConfig', {
									...config,
									providerId: newPid,
									modelId: '', // reset model when provider changes
								});
							}}
							style={selectStyle}
						>
							<option value="">— Select provider —</option>
							{providers.map(p => (
								<option key={p.id} value={p.id}>{p.name}</option>
							))}
						</select>
					</Field>
					<Field label="Model">
						<select
							value={config.modelId || ''}
							onChange={e => handleChange('agentConfig', { ...config, modelId: e.target.value })}
							style={selectStyle}
							disabled={!config.providerId}
						>
							<option value="">— Select model —</option>
							{currentModels.map(m => (
								<option key={m.id} value={m.id}>{m.name}</option>
							))}
						</select>
					</Field>
					<Field label="Prompt Template">
						<textarea
							value={(data.prompt as string) || ''}
							onChange={e => handleChange('prompt', e.target.value)}
							style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }}
							placeholder="What should this agent do in this workflow step?"
						/>
					</Field>
					<Field label="Worktree">
						<select
							value={(data.worktreePath as string) || ''}
							onChange={e => handleChange('worktreePath', e.target.value)}
							style={selectStyle}
						>
							<option value="">— None —</option>
							{worktrees.map(wt => (
								<option key={wt.path} value={wt.path}>
									{wt.repoName ? `${wt.repoName} · ` : ''}{wt.branch}
									{' — '}{wt.path}
								</option>
							))}
						</select>
					</Field>
				</>
			);
		}

		case 'skill':
			return (
				<>
					<Field label="Skill Name">
						<SkillNameCombobox
							value={(data.skillName as string) || ''}
							skills={skills}
							onChange={(name) => handleChange('skillName', name)}
						/>
					</Field>
				</>
			);

		case 'tool':
			return (
				<>
					<Field label="Tool Name">
						<input type="text" value={(data.toolName as string) || ''}
							onChange={e => handleChange('toolName', e.target.value)}
							style={inputStyle} placeholder="e.g., read_file" />
					</Field>
					<ParamsEditor
						params={(data.toolParams as Record<string, string>) || {}}
						onChange={(params) => handleChange('toolParams', params)}
					/>
				</>
			);

		case 'task':
			return (
				<>
					<Field label="Executor ID">
						<input type="text" value={(data.executorId as string) || ''}
							onChange={e => handleChange('executorId', e.target.value)}
							style={inputStyle} placeholder="e.g., agent-123" />
					</Field>
					<Field label="Task ID">
						<input type="text" value={(data.taskId as string) || ''}
							onChange={e => handleChange('taskId', e.target.value)}
							style={inputStyle} placeholder="e.g., task-456" />
					</Field>
				</>
			);

		case 'ifElse':
		case 'condition':
			return (
				<>
					<Field label="Evaluation Target">
						<input type="text" value={(data.evaluationTarget as string) || (data.condition as string) || ''}
							onChange={e => {
								if (type === 'ifElse') { handleChange('evaluationTarget', e.target.value); }
								else { handleChange('condition', e.target.value); }
							}}
							style={inputStyle} placeholder="e.g., $result.status" />
					</Field>
					<BranchesEditor
						branches={(data.branches as BranchDef[]) || []}
						onChange={(branches) => { handleChange('branches', branches); setVersion(v => v + 1); }}
					/>
				</>
			);

		case 'switch':
			return (
				<>
					<Field label="Evaluation Target">
						<input type="text" value={(data.evaluationTarget as string) || ''}
							onChange={e => handleChange('evaluationTarget', e.target.value)}
							style={inputStyle} placeholder="e.g., $result.status" />
					</Field>
					<BranchesEditor
						branches={(data.branches as BranchDef[]) || []}
						onChange={(branches) => { handleChange('branches', branches); setVersion(v => v + 1); }}
					/>
				</>
			);

		case 'loop':
			return (
				<>
					<Field label="Items Source">
						<input type="text"
							value={((data.loopConfig as { items: string })?.items) || ''}
							onChange={e => handleChange('loopConfig', { ...((data.loopConfig as object) || {}), items: e.target.value })}
							style={inputStyle} placeholder="e.g., $input.tasks" />
					</Field>
					<Field label="Item Variable">
						<input type="text"
							value={((data.loopConfig as { itemVariable: string })?.itemVariable) || 'item'}
							onChange={e => handleChange('loopConfig', { ...((data.loopConfig as object) || {}), itemVariable: e.target.value })}
							style={inputStyle} />
					</Field>
					<Field label="Max Iterations">
						<input type="number"
							value={((data.loopConfig as { maxIterations?: number })?.maxIterations) || 10}
							onChange={e => handleChange('loopConfig', { ...((data.loopConfig as object) || {}), maxIterations: parseInt(e.target.value) || 0 })}
							style={inputStyle} min="1" />
					</Field>
				</>
			);

		case 'askUser':
			return (
				<>
					<Field label="Question">
						<textarea value={(data.question as string) || ''}
							onChange={e => handleChange('question', e.target.value)}
							style={{ ...inputStyle, minHeight: '48px', resize: 'vertical' }}
							placeholder="What do you want to ask?" />
					</Field>
					<div style={{ marginBottom: '8px', display: 'flex', gap: '12px' }}>
						<label style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
							<input type="checkbox" checked={!!data.multiSelect}
								onChange={e => handleChange('multiSelect', e.target.checked)} />
							{' '}Multi-select
						</label>
					</div>
					<OptionsEditor
						options={(data.options as AskUserOption[]) || []}
						onChange={(options) => { handleChange('options', options); setVersion(v => v + 1); }}
					/>
				</>
			);

		default:
			return null;
	}
}

/* ── Sub-editors ───────────────────────────────────────────────────────── */

function BranchesEditor({ branches, onChange }: { branches: BranchDef[]; onChange: (b: BranchDef[]) => void }) {
	const update = (idx: number, field: keyof BranchDef, value: string) => {
		const next = branches.map((b, i) => i === idx ? { ...b, [field]: value } : b);
		onChange(next);
	};
	const remove = (idx: number) => {
		if (branches.length <= 2) { return; }
		onChange(branches.filter((_, i) => i !== idx));
	};
	const add = () => {
		onChange([...branches, { id: `branch-${Date.now()}`, label: `Case ${branches.length + 1}`, condition: '' }]);
	};

	return (
		<Field label="Branches">
			{branches.map((b, i) => (
				<div key={b.id} style={{ marginBottom: '8px', padding: '6px', border: '1px solid var(--vscode-panel-border)', borderRadius: '4px' }}>
					<div style={{ display: 'flex', gap: '4px', marginBottom: '4px' }}>
						<input type="text" value={b.label}
							onChange={e => update(i, 'label', e.target.value)}
							style={{ ...inputStyle, flex: 1, fontSize: '10px' }} placeholder="Label" />
						{branches.length > 2 && (
							<button onClick={() => remove(i)} title="Remove branch"
								style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground)' }}>×</button>
						)}
					</div>
					<input type="text" value={b.condition}
						onChange={e => update(i, 'condition', e.target.value)}
						style={{ ...inputStyle, fontSize: '10px' }} placeholder="Condition (e.g., $val > 0)" />
				</div>
			))}
			<button onClick={add} style={smallAddBtnStyle}>+ Add Branch</button>
		</Field>
	);
}

function OptionsEditor({ options, onChange }: { options: AskUserOption[]; onChange: (o: AskUserOption[]) => void }) {
	const update = (idx: number, field: keyof AskUserOption, value: string) => {
		const next = options.map((o, i) => i === idx ? { ...o, [field]: value } : o);
		onChange(next);
	};
	const remove = (idx: number) => {
		if (options.length <= 2) { return; }
		onChange(options.filter((_, i) => i !== idx));
	};
	const add = () => {
		onChange([...options, { label: `Option ${options.length + 1}`, description: '' }]);
	};

	return (
		<Field label="Options">
			{options.map((opt, i) => (
				<div key={i} style={{ marginBottom: '8px', padding: '6px', border: '1px solid var(--vscode-panel-border)', borderRadius: '4px' }}>
					<div style={{ display: 'flex', gap: '4px', marginBottom: '4px' }}>
						<input type="text" value={opt.label}
							onChange={e => update(i, 'label', e.target.value)}
							style={{ ...inputStyle, flex: 1, fontSize: '10px' }} placeholder="Option label" />
						{options.length > 2 && (
							<button onClick={() => remove(i)} title="Remove option"
								style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground)' }}>×</button>
						)}
					</div>
					<input type="text" value={opt.description || ''}
						onChange={e => update(i, 'description', e.target.value)}
						style={{ ...inputStyle, fontSize: '10px' }} placeholder="Description (optional)" />
				</div>
			))}
			<button onClick={add} style={smallAddBtnStyle}>+ Add Option</button>
		</Field>
	);
}

function ParamsEditor({ params, onChange }: { params: Record<string, string>; onChange: (p: Record<string, string>) => void }) {
	const entries = Object.entries(params);
	const update = (oldKey: string, newKey: string, value: string) => {
		const next: Record<string, string> = {};
		for (const [k, v] of entries) {
			if (k === oldKey) { next[newKey || oldKey] = value; }
			else { next[k] = v; }
		}
		if (!oldKey && newKey) { next[newKey] = value; }
		onChange(next);
	};
	const remove = (key: string) => {
		const next = { ...params };
		delete next[key];
		onChange(next);
	};
	const newEntries = [...entries, ['', ''] as [string, string]]; // Add a blank row

	return (
		<Field label="Parameters">
			{newEntries.map(([k, v], i) => (
				<div key={i} style={{ display: 'flex', gap: '4px', marginBottom: '4px' }}>
					<input type="text" value={k}
						onChange={e => update(k, e.target.value, v)}
						style={{ ...inputStyle, flex: 1, fontSize: '10px' }} placeholder="Key" />
					<input type="text" value={v}
						onChange={e => update(k, k, e.target.value)}
						style={{ ...inputStyle, flex: 1, fontSize: '10px' }} placeholder="Value" />
					{k && (
						<button onClick={() => remove(k)} title="Remove"
							style={{ ...iconBtnStyle, color: 'var(--vscode-errorForeground)' }}>×</button>
					)}
				</div>
			))}
		</Field>
	);
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
	<div style={{ marginBottom: '12px' }}>
		<label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)', marginBottom: '4px', textTransform: 'uppercase' }}>
			{label}
		</label>
		{children}
	</div>
);

const inputStyle: React.CSSProperties = {
	width: '100%', padding: '6px 8px',
	border: '1px solid var(--vscode-input-border)', borderRadius: '4px',
	backgroundColor: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
	fontSize: '12px', fontFamily: 'var(--vscode-font-family)', boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = {
	...inputStyle,
	cursor: 'pointer',
	appearance: 'auto' as any,
};

const panelStyle: React.CSSProperties = {
	position: 'absolute', top: 5, right: 5, bottom: 5,
	width: '280px',
	backgroundColor: 'var(--vscode-sideBar-background)',
	border: '1px solid var(--vscode-panel-border)', borderRadius: '8px',
	zIndex: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden',
	boxShadow: '0 4px 12px var(--vscode-widget-shadow)',
};

const headerStyle: React.CSSProperties = {
	display: 'flex', alignItems: 'center', justifyContent: 'space-between',
	padding: '10px 12px', borderBottom: '1px solid var(--vscode-panel-border)',
};

const closeBtnStyle: React.CSSProperties = {
	background: 'none', border: 'none',
	color: 'var(--vscode-descriptionForeground)',
	cursor: 'pointer', fontSize: '14px', padding: '2px 6px',
};

const iconBtnStyle: React.CSSProperties = {
	background: 'none', border: 'none', cursor: 'pointer',
	fontSize: '14px', padding: '2px 4px',
};

const smallAddBtnStyle: React.CSSProperties = {
	padding: '4px 10px', fontSize: '10px',
	border: '1px solid var(--vscode-button-border)',
	borderRadius: '4px', backgroundColor: 'var(--vscode-button-background)',
	color: 'var(--vscode-button-foreground)', cursor: 'pointer',
	marginTop: '4px',
};

/** Searchable combobox for selecting a skill by name, with real-time filtering. */
const SkillNameCombobox: React.FC<{
	value: string;
	skills: Array<{ id: string; name: string; description?: string; category?: string }>;
	onChange: (name: string) => void;
}> = ({ value, skills, onChange }) => {
	const [open, setOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);

	// Close dropdown on outside click
	useEffect(() => {
		if (!open) { return; }
		const handler = (e: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
				inputRef.current && !inputRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [open]);

	const filtered = skills.filter(s =>
		!value || s.name.toLowerCase().includes(value.toLowerCase()) ||
		(s.description && s.description.toLowerCase().includes(value.toLowerCase()))
	);

	const comboboxInputStyle: React.CSSProperties = {
		width: '100%', padding: '6px 8px',
		background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)', borderRadius: 3,
		fontSize: '12px', outline: 'none', boxSizing: 'border-box',
	};

	return (
		<div style={{ position: 'relative' }}>
			<input type="text" ref={inputRef}
				value={value}
				onChange={e => { onChange(e.target.value); setOpen(true); }}
				onFocus={() => setOpen(true)}
				style={comboboxInputStyle}
				placeholder="Search or type skill name..."
				autoComplete="off" />
			{open && filtered.length > 0 && (
				<div ref={dropdownRef} style={{
					position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1000,
					maxHeight: 180, overflowY: 'auto',
					background: 'var(--vscode-dropdown-background)',
					border: '1px solid var(--vscode-dropdown-border)',
					borderRadius: 3, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
				}}>
					{filtered.map(skill => (
						<div key={skill.id}
							onMouseDown={e => { e.preventDefault(); onChange(skill.name); setOpen(false); }}
							style={{
								padding: '6px 10px', cursor: 'pointer', fontSize: '12px',
								color: 'var(--vscode-dropdown-foreground)',
								borderBottom: '1px solid var(--vscode-dropdown-border)',
							}}
							onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
							onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
						>
							<div style={{ fontWeight: 500 }}>{skill.name}</div>
							{skill.description && (
								<div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)', marginTop: 1 }}>
									{skill.description}
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
};
