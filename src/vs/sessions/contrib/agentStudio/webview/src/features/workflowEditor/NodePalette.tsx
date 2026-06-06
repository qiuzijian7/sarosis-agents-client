/*---------------------------------------------------------------------------------------------
 *  NodePalette — sidebar with buttons to add nodes to the canvas.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { nodeTypeSelectors, useWorkflowEditorStore } from './store';

export const NodePalette: React.FC<{ collapsed: boolean; onToggle: () => void }> = ({ collapsed, onToggle }) => {
	const addNode = useWorkflowEditorStore(s => s.addNode);

	const handleAdd = (type: string) => {
		const x = 200 + Math.random() * 200;
		const y = 100 + Math.random() * 300;
		addNode(type, { x, y });
	};

	return (
		<div style={{
			width: collapsed ? '32px' : '180px',
			minWidth: collapsed ? '32px' : '180px',
			borderRight: '1px solid var(--vscode-panel-border)',
			backgroundColor: 'var(--vscode-sideBar-background)',
			display: 'flex',
			flexDirection: 'column',
			overflow: 'hidden',
			transition: 'width 0.15s ease',
		}}>
			<div style={{
				display: 'flex',
				alignItems: 'center',
				padding: '8px 10px',
				borderBottom: '1px solid var(--vscode-panel-border)',
				cursor: 'pointer',
			}} onClick={onToggle}>
				<span style={{ fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden' }}>
					{collapsed ? '＋' : 'Nodes'}
				</span>
			</div>
			{!collapsed && (
				<div style={{ padding: '8px', overflow: 'auto', flex: 1 }}>
					<div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)', marginBottom: '6px', textTransform: 'uppercase' }}>
						Add Step
					</div>
					{nodeTypeSelectors.map(nt => (
						<button
							key={nt.type}
							onClick={() => handleAdd(nt.type)}
							title={nt.description}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: '6px',
								width: '100%',
								padding: '8px 10px',
								marginBottom: '4px',
								border: '1px solid var(--vscode-panel-border)',
								borderRadius: '6px',
								backgroundColor: 'var(--vscode-editor-background)',
								color: 'var(--vscode-foreground)',
								cursor: 'pointer',
								fontSize: '12px',
								textAlign: 'left',
							}}
						>
							<span>{nt.icon}</span>
							<span style={{ fontWeight: 500 }}>{nt.label}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
};
