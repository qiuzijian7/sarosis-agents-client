/*---------------------------------------------------------------------------------------------
 *  AgentNode — inline editing when selected (v12)
 *  When selected, expands to show agent selector, prompt textarea, and config dropdowns.
 *  When deselected (or unselected), shows the compact read-only view.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';
import { useWorkflowEditorStore } from '../store';
import { useAgentStore } from '../../../store/useAgentStore';
import { useProviderStore } from '../../../store/useProviderStore';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';
import { sendRequest } from '../../../bridge/messageClient';

// Inline edit styles
const ieInput: React.CSSProperties = {
	width: '100%', padding: '2px 5px', fontSize: '11px',
	background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
	border: '1px solid var(--vscode-input-border)', borderRadius: '2px',
	boxSizing: 'border-box', marginTop: '2px',
};
const ieSelect: React.CSSProperties = { ...ieInput, cursor: 'pointer' };
const ieTextarea: React.CSSProperties = { ...ieInput, minHeight: '40px', resize: 'vertical' };
const ieLabel: React.CSSProperties = { fontSize: '9px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)', marginTop: '6px', display: 'block' };

export const AgentNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	const agentId = (data.agentId as string) || '';
	const config = data.agentConfig as { providerId?: string; modelId?: string } | undefined;
	const selected = props.selected;

	const updateNodeData = useWorkflowEditorStore(s => s.updateNodeData);
	const update = (k: string, v: unknown) => updateNodeData(props.id, { [k]: v });

	// Lazy-load external data
	const agents = useAgentStore(s => s.agents);
	const loadAgents = useAgentStore(s => s.loadAgents);
	const providers = useProviderStore(s => s.providers);
	const loadProviders = useProviderStore(s => s.loadProviders);
	const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
	const [worktrees, setWorktrees] = useState<{ path: string; branch: string; repoName?: string }[]>([]);

	useEffect(() => {
		if (selected && agents.length === 0) loadAgents();
		if (selected && providers.length === 0) loadProviders();
	}, [selected, agents.length, providers.length, loadAgents, loadProviders]);

	// Fetch worktrees when selected AND workspaceId is available.
	// Separated so it re-fires when activeWorkspaceId loads asynchronously.
	useEffect(() => {
		if (!selected) { return; }
		const wsId = activeWorkspaceId;
		if (!wsId) {
			// workspaceId not loaded yet — poll once after a short delay
			const timer = setTimeout(() => {
				const fallbackWsId = useWorkspaceStore.getState().activeWorkspaceId;
				if (fallbackWsId) {
					sendRequest<{ workspaceId: string }, { path: string; branch: string; repoName?: string }[]>('worktree.list', { workspaceId: fallbackWsId })
						.then(r => setWorktrees(Array.isArray(r) ? r : []))
						.catch(() => setWorktrees([]));
				}
			}, 300);
			return () => clearTimeout(timer);
		}
		sendRequest<{ workspaceId: string }, { path: string; branch: string; repoName?: string }[]>('worktree.list', { workspaceId: wsId })
			.then(r => setWorktrees(Array.isArray(r) ? r : []))
			.catch(() => setWorktrees([]));
	}, [selected, activeWorkspaceId]);

	const currentProvider = providers.find(p => p.id === config?.providerId);
	const currentModels = currentProvider?.models ?? [];

	return (
		<BaseNode {...props} color="#f97316" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>🤖</span>
				<span style={{ fontWeight: 600 }}>Agent</span>
			</div>

			{/* Label (always visible, editable when selected) */}
			{selected ? (
				<input style={ieInput} value={(data.label as string) || ''} onChange={e => update('label', e.target.value)} placeholder="Agent node name" />
			) : (
				<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '2px' }}>
					{(data.label as string) || 'Agent'}
				</div>
			)}

			{!selected && agentId && (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
					ID: {agentId.slice(0, 20)}{agentId.length > 20 ? '...' : ''}
				</div>
			)}
			{!selected && !agentId && (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
					No agent selected
				</div>
			)}
			{!selected && config?.modelId && (
				<div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)', marginTop: '2px' }}>
					{config.modelId}
				</div>
			)}

			{/* Inline editors (only when selected) */}
			{selected && (
				<>
					<span style={ieLabel}>Agent</span>
					<select style={ieSelect} value={agentId} onChange={e => {
						const found = agents.find(a => a.id === e.target.value);
						update('agentId', e.target.value);
						if (found) update('label', found.name);
					}}>
						<option value="">— Select agent —</option>
						{agents.map(a => (<option key={a.id} value={a.id}>{a.name}</option>))}
					</select>

					<span style={ieLabel}>Prompt</span>
					<textarea style={ieTextarea} value={(data.prompt as string) || ''} onChange={e => update('prompt', e.target.value)} placeholder="What should this agent do?" />

					<span style={ieLabel}>Provider</span>
					<select style={ieSelect} value={config?.providerId || ''} onChange={e => update('agentConfig', { ...config, providerId: e.target.value, modelId: '' })}>
						<option value="">— Default —</option>
						{providers.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
					</select>

					<span style={ieLabel}>Model</span>
					<select style={ieSelect} value={config?.modelId || ''} onChange={e => update('agentConfig', { ...config, modelId: e.target.value })} disabled={!config?.providerId}>
						<option value="">— Default —</option>
						{currentModels.map(m => (<option key={m.id} value={m.id}>{m.name}</option>))}
					</select>

					<span style={ieLabel}>Worktree</span>
					<select style={ieSelect} value={(data.worktreePath as string) || ''} onChange={e => update('worktreePath', e.target.value)}>
						<option value="">— None —</option>
						{worktrees.map(wt => (<option key={wt.path} value={wt.path}>{wt.repoName ? `${wt.repoName} · ` : ''}{wt.branch}</option>))}
					</select>
				</>
			)}
		</BaseNode>
	);
});
AgentNode.displayName = 'AgentNode';
