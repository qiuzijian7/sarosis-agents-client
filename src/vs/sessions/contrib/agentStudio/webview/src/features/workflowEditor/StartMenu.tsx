/*---------------------------------------------------------------------------------------------
 *  StartMenu — empty canvas state overlay with quick-start options.
 *
 *  Shows when the workflow has only Start + End nodes (no user-created nodes).
 *  Mirrors cc-wf-studio's StartMenu.tsx.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { useWorkflowEditorStore } from './store';

interface StartMenuProps {
	onAddFirstNode: (type: string) => void;
}

export const StartMenu: React.FC<StartMenuProps> = ({ onAddFirstNode }) => {
	const nodes = useWorkflowEditorStore(s => s.nodes);
	const workflowName = useWorkflowEditorStore(s => s.workflowName);

	// Only show when there are exactly 2 nodes (Start + End) and no user nodes
	const hasUserNodes = nodes.some(n => n.type !== 'start' && n.type !== 'end');
	if (hasUserNodes) { return null; }

	return (
		<div style={{
			position: 'absolute',
			inset: 0,
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			zIndex: 5,
			pointerEvents: 'none',
		}}>
			<div style={{
				backgroundColor: 'var(--vscode-editor-background)',
				border: '1px solid var(--vscode-panel-border)',
				borderRadius: '12px',
				padding: '32px 40px',
				textAlign: 'center',
				pointerEvents: 'all',
				boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
				maxWidth: '420px',
			}}>
				<h2 style={{
					margin: '0 0 8px',
					fontSize: '18px',
					fontWeight: 700,
					color: 'var(--vscode-foreground)',
				}}>
					{workflowName || 'New Workflow'}
				</h2>
				<p style={{
					margin: '0 0 24px',
					fontSize: '13px',
					color: 'var(--vscode-descriptionForeground)',
					lineHeight: 1.5,
				}}>
					Drag nodes from the palette or click below to get started.
				</p>

				<div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
					<QuickButton icon="📋" label="Task" onClick={() => onAddFirstNode('task')} />
					<QuickButton icon="🔀" label="Condition" onClick={() => onAddFirstNode('condition')} />
					<QuickButton icon="⇉" label="Parallel" onClick={() => onAddFirstNode('parallel')} />
					<QuickButton icon="🔄" label="Loop" onClick={() => onAddFirstNode('loop')} />
				</div>

				<p style={{
					margin: '16px 0 0',
					fontSize: '11px',
					color: 'var(--vscode-descriptionForeground)',
				}}>
					Tips: Ctrl+Z to undo · Ctrl+Shift+Z to redo · Delete to remove · Ctrl+S to save
				</p>
			</div>
		</div>
	);
};

const QuickButton: React.FC<{ icon: string; label: string; onClick: () => void }> = ({ icon, label, onClick }) => (
	<button
		onClick={onClick}
		style={{
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'center',
			gap: '6px',
			padding: '14px 18px',
			border: '1px solid var(--vscode-panel-border)',
			borderRadius: '8px',
			backgroundColor: 'var(--vscode-input-background)',
			color: 'var(--vscode-foreground)',
			cursor: 'pointer',
			fontSize: '12px',
			fontWeight: 500,
			transition: 'border-color 0.15s',
		}}
		onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--vscode-focusBorder)'; }}
		onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--vscode-panel-border)'; }}
	>
		<span style={{ fontSize: '20px' }}>{icon}</span>
		<span>{label}</span>
	</button>
);
