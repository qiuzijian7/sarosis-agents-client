/*---------------------------------------------------------------------------------------------
 *  AgentNode — always-expanded editing UI (v12)
 *  Shows agent selector, prompt textarea, and config dropdowns at all times.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';
import { useWorkflowEditorStore } from '../store';
import { useAgentStore } from '../../../store/useAgentStore';
import { useProviderStore } from '../../../store/useProviderStore';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';
import { sendRequest } from '../../../bridge/messageClient';
import { extractVariables, formatVariableBadge } from '../utils/templateUtils';
import { VariableAutocomplete, buildCandidates } from '../utils/VariableAutocomplete';

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
		if (agents.length === 0) loadAgents();
		if (providers.length === 0) loadProviders();
	}, [agents.length, providers.length, loadAgents, loadProviders]);

	// Fetch worktrees when workspaceId is available.
	useEffect(() => {
		const wsId = activeWorkspaceId;
		if (!wsId) {
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
	}, [activeWorkspaceId]);

	const currentProvider = providers.find(p => p.id === config?.providerId);
	const currentModels = currentProvider?.models ?? [];

	// v13: prompt variable detection (mirrors PromptNode badge/picker UX)
	const promptText = (data.prompt as string) || '';
	const variableBadge = formatVariableBadge(promptText);
	const detectedVariables = extractVariables(promptText);

	// v14: pull workflow graph for upstream node detection
	const allNodes = useWorkflowEditorStore(s => s.nodes);
	const allEdges = useWorkflowEditorStore(s => s.edges);
	const candidates = React.useMemo(() => buildCandidates({
		nodeData: data,
		nodeId: props.id,
		nodes: allNodes as Array<{ id: string; data?: Record<string, unknown> }>,
		edges: allEdges as Array<{ source: string; target: string }>,
	}), [data, props.id, allNodes, allEdges]);
	const promptTextareaRef = React.useRef<HTMLTextAreaElement>(null);

	return (
		<BaseNode {...props} color="#f97316" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>🤖</span>
				<span style={{ fontWeight: 600 }}>Agent</span>
				{/* Variable count badge (cc-wf-studio parity) */}
				{variableBadge && (
					<span
						title={`Detected variables: ${detectedVariables.join(', ')}`}
						style={{
							marginLeft: 'auto',
							fontSize: '9px', fontWeight: 600,
							padding: '1px 5px', borderRadius: '8px',
							background: 'var(--vscode-badge-background, #4d4d4d)',
							color: 'var(--vscode-badge-foreground, #ffffff)',
						}}
					>
						{variableBadge}
					</span>
				)}
			</div>

			{/* Label (always editable) */}
			<input style={ieInput} value={(data.label as string) || ''} onChange={e => update('label', e.target.value)} placeholder="Agent node name" />

			{/* Inline editors (always visible) */}
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
			<div style={{ position: 'relative' }}>
				<textarea
					ref={promptTextareaRef}
					style={ieTextarea}
					value={promptText}
					onChange={e => update('prompt', e.target.value)}
					placeholder="Type {{ for variable autocomplete"
				/>
				<VariableAutocomplete
					targetRef={promptTextareaRef}
					text={promptText}
					onChange={next => update('prompt', next)}
					candidates={candidates}
					id={`agent-node-ac-${props.id}`}
				/>
			</div>
			{/* v13: detected variable chips */}
			{detectedVariables.length > 0 && (
				<div style={{ marginTop: '3px', display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
					{detectedVariables.map(name => (
						<span
							key={name}
							style={{
								fontSize: '9px',
								padding: '1px 5px',
								borderRadius: '2px',
								background: 'var(--vscode-textCodeBlock-background, #1e1e1e)',
								color: 'var(--vscode-charts-blue, #4fc1ff)',
								fontFamily: 'var(--vscode-editor-font-family, monospace)',
							}}
						>
							{`{{${name}}}`}
						</span>
					))}
				</div>
			)}

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
		</BaseNode>
	);
});
AgentNode.displayName = 'AgentNode';
