/*---------------------------------------------------------------------------------------------
 *  CanvasToolbar — floating toolbar inside the ReactFlow canvas.
 *
 *  Mirrors cc-wf-studio's CanvasToolbar.tsx: interaction mode, scroll mode,
 *  edge animation, minimap mode toggles.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { useWorkflowEditorStore } from './store';
import type { InteractionMode, ScrollMode, MinimapMode } from './store';

export const CanvasToolbar: React.FC = () => {
	const {
		interactionMode, toggleInteractionMode,
		scrollMode, toggleScrollMode,
		isEdgeAnimationEnabled, toggleEdgeAnimation,
		minimapMode, setMinimapMode,
	} = useWorkflowEditorStore();

	const modeLabel = (mode: InteractionMode) => mode === 'pan' ? 'Pan' : 'Select';
	const scrollLabel = (mode: ScrollMode) => mode === 'classic' ? 'Zoom' : 'Pan';

	const minimapModes: Array<{ value: MinimapMode; label: string }> = [
		{ value: 'hidden', label: 'Off' },
		{ value: 'auto', label: 'Auto' },
		{ value: 'always', label: 'On' },
	];

	return (
		<div style={{
			display: 'flex',
			flexDirection: 'column',
			gap: '4px',
			padding: '4px',
			backgroundColor: 'var(--vscode-editor-background)',
			border: '1px solid var(--vscode-panel-border)',
			borderRadius: '6px',
			boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
		}}>
			{/* Interaction mode */}
			<button
				onClick={toggleInteractionMode}
				title={`Interaction: ${modeLabel(interactionMode)} mode`}
				style={btnStyle}
			>
				{interactionMode === 'pan' ? '✋' : '⬚'}
			</button>

			{/* Scroll mode */}
			<button
				onClick={toggleScrollMode}
				title={`Scroll: ${scrollLabel(scrollMode)} wheel`}
				style={btnStyle}
			>
				{scrollMode === 'classic' ? '🔍' : '🖐'}
			</button>

			<div style={{ width: '100%', height: '1px', backgroundColor: 'var(--vscode-panel-border)', margin: '2px 0' }} />

			{/* Edge animation */}
			<button
				onClick={toggleEdgeAnimation}
				title={`Edge animation: ${isEdgeAnimationEnabled ? 'On' : 'Off'}`}
				style={{
					...btnStyle,
					opacity: isEdgeAnimationEnabled ? 1 : 0.5,
				}}
			>
				⚡
			</button>

			{/* Minimap mode cycle */}
			<button
				onClick={() => {
					const next: MinimapMode = minimapMode === 'hidden' ? 'auto' : minimapMode === 'auto' ? 'always' : 'hidden';
					setMinimapMode(next);
				}}
				title={`Minimap: ${minimapModes.find(m => m.value === minimapMode)?.label}`}
				style={{
					...btnStyle,
					opacity: minimapMode === 'hidden' ? 0.4 : 1,
				}}
			>
				🗺
			</button>
		</div>
	);
};

const btnStyle: React.CSSProperties = {
	width: '28px',
	height: '28px',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	border: 'none',
	borderRadius: '4px',
	backgroundColor: 'transparent',
	color: 'var(--vscode-foreground)',
	cursor: 'pointer',
	fontSize: '14px',
};
