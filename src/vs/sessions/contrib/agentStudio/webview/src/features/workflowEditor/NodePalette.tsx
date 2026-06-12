/*---------------------------------------------------------------------------------------------
 *  NodePalette — sidebar with categorized buttons to add nodes to the canvas.
 *  Categories: Basic Nodes / Control Flow / Layout (mirrors cc-wf-studio).
 *
 *  v19: Added tab toggle between "Nodes" palette and "Workflows" list.
 *--------------------------------------------------------------------------------------------*/

import React, { useState } from 'react';
import { useWorkflowEditorStore, nodeCategories, type NodeCategory } from './store';
import { WorkflowListPanel } from './WorkflowListPanel';

const CATEGORY_COLORS: Record<NodeCategory, string> = {
	basic: '#3b82f6',
	controlFlow: '#f59e0b',
	layout: '#8b5cf6',
};

type SidebarTab = 'nodes' | 'workflows';

export const NodePalette: React.FC<{
	collapsed: boolean;
	onToggle: () => void;
	activeWorkflowId?: string | null;
	onSelectWorkflow?: (workflowId: string) => void;
}> = ({ collapsed, onToggle, activeWorkflowId, onSelectWorkflow }) => {
	const [tab, setTab] = useState<SidebarTab>('nodes');
	const addNode = useWorkflowEditorStore(s => s.addNode);

	const handleAdd = (type: string) => {
		const x = 200 + Math.random() * 200;
		const y = 100 + Math.random() * 300;
		addNode(type, { x, y });
	};

	const handleSwitchWorkflow = (wfId: string) => {
		if (onSelectWorkflow) {
			onSelectWorkflow(wfId);
		}
	};

	return (
		<div style={{
			width: collapsed ? '32px' : '200px',
			minWidth: collapsed ? '32px' : '200px',
			borderRight: '1px solid var(--vscode-panel-border)',
			backgroundColor: 'var(--vscode-sideBar-background)',
			display: 'flex',
			flexDirection: 'column',
			overflow: 'hidden',
			transition: 'width 0.15s ease',
		}}>
			{/* Header with tab toggle */}
			<div style={{
				display: 'flex', alignItems: 'center',
				borderBottom: '1px solid var(--vscode-panel-border)',
			}}>
				<div style={{ flex: 1, display: 'flex', cursor: 'pointer' }} onClick={onToggle}>
					<div style={{ flex: 1, display: 'flex', padding: '8px 10px' }}>
						<span style={{ fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden' }}>
							{collapsed ? '＋' : tab === 'nodes' ? 'Nodes' : 'Workflows'}
						</span>
					</div>
				</div>
				{!collapsed && (
					<div style={{ display: 'flex', paddingRight: '4px' }}>
						<button
							onClick={() => setTab('nodes')}
							title="Node Palette"
							style={{
								padding: '2px 6px', fontSize: '10px', cursor: 'pointer',
								background: tab === 'nodes' ? 'var(--vscode-button-background)' : 'transparent',
								color: tab === 'nodes' ? 'var(--vscode-button-foreground)' : 'var(--vscode-descriptionForeground)',
								border: '1px solid var(--vscode-panel-border)',
								borderRadius: '3px',
							}}
						>
							＋
						</button>
						<button
							onClick={() => setTab('workflows')}
							title="Workflow List"
							style={{
								padding: '2px 6px', fontSize: '10px', cursor: 'pointer', marginLeft: '3px',
								background: tab === 'workflows' ? 'var(--vscode-button-background)' : 'transparent',
								color: tab === 'workflows' ? 'var(--vscode-button-foreground)' : 'var(--vscode-descriptionForeground)',
								border: '1px solid var(--vscode-panel-border)',
								borderRadius: '3px',
							}}
						>
							⚡
						</button>
					</div>
				)}
			</div>
			{!collapsed && tab === 'nodes' && (
				<div style={{ padding: '8px', overflow: 'auto', flex: 1 }}>
					{nodeCategories.map((cat) => (
						<div key={cat.category} style={{ marginBottom: '16px' }}>
							<div style={{
								fontSize: '10px', fontWeight: 600,
								color: CATEGORY_COLORS[cat.category],
								marginBottom: '6px',
								textTransform: 'uppercase',
								letterSpacing: '0.5px',
								paddingBottom: '4px',
								borderBottom: `1px solid ${CATEGORY_COLORS[cat.category]}22`,
							}}>
								{cat.label}
							</div>
							{cat.items.map(nt => (
								<button
									key={nt.type}
									onClick={() => handleAdd(nt.type)}
									title={nt.description}
									style={{
										display: 'flex',
										alignItems: 'center',
										gap: '6px',
										width: '100%',
										padding: '6px 8px',
										marginBottom: '3px',
										border: '1px solid var(--vscode-panel-border)',
										borderRadius: '6px',
										backgroundColor: 'var(--vscode-editor-background)',
										color: 'var(--vscode-foreground)',
										cursor: 'pointer',
										fontSize: '11px',
										textAlign: 'left',
									}}
								>
									<span style={{ fontSize: '13px' }}>{nt.icon}</span>
									<span style={{ fontWeight: 500 }}>{nt.label}</span>
								</button>
							))}
						</div>
					))}
					{/* Quick tips */}
					<div style={{
						marginTop: '12px', padding: '8px',
						backgroundColor: 'var(--vscode-textBlockQuote-background)',
						border: '1px solid var(--vscode-textBlockQuote-border)',
						borderRadius: '4px', fontSize: '10px',
						color: 'var(--vscode-descriptionForeground)', lineHeight: 1.5,
					}}>
						<b>Tips</b>
						<ul style={{ margin: '4px 0 0', paddingLeft: '14px' }}>
							<li>Click to add a node</li>
							<li>Drag nodes to rearrange</li>
							<li>Connect handles to build flow</li>
							<li>Click a node to edit properties</li>
						</ul>
					</div>
				</div>
			)}
			{!collapsed && tab === 'workflows' && (
				<div style={{ flex: 1, overflow: 'auto' }}>
					<WorkflowListPanel
						activeWorkflowId={activeWorkflowId}
						onSelectWorkflow={handleSwitchWorkflow}
					/>
				</div>
			)}
		</div>
	);
};
