/*---------------------------------------------------------------------------------------------
 *  DeletableEdge — custom ReactFlow edge with a delete button on selection.
 *
 *  Mirrors cc-wf-studio's DeletableEdge.tsx: renders an X button on selected edges
 *  using EdgeLabelRenderer (HTML layer) for smooth interaction.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import {
	BaseEdge,
	EdgeLabelRenderer,
	getBezierPath,
	type EdgeProps,
} from '@xyflow/react';

export const DeletableEdge: React.FC<EdgeProps> = ({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	selected,
	markerEnd,
	style = {},
}) => {
	const [edgePath, labelX, labelY] = getBezierPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
	});

	return (
		<>
			<BaseEdge
				id={id}
				path={edgePath}
				markerEnd={markerEnd}
				style={{
					...style,
					strokeWidth: selected ? 2.5 : 1.5,
					stroke: selected ? 'var(--vscode-focusBorder)' : style.stroke || 'var(--vscode-foreground)',
				}}
			/>
			{selected && (
				<EdgeLabelRenderer>
					<button
						style={{
							position: 'absolute',
							transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
							pointerEvents: 'all',
							width: '20px',
							height: '20px',
							borderRadius: '50%',
							border: 'none',
							backgroundColor: 'var(--vscode-inputValidation-errorBackground)',
							color: 'var(--vscode-inputValidation-errorForeground)',
							fontSize: '12px',
							fontWeight: 'bold',
							cursor: 'pointer',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							lineHeight: 1,
							zIndex: 1000,
						}}
						title="Delete connection"
						onClick={(e) => {
							e.stopPropagation();
							// Dispatch a custom event for the canvas to handle edge deletion
							window.dispatchEvent(
								new CustomEvent('workflowEditor:deleteEdge', { detail: { edgeId: id } })
							);
						}}
					>
						×
					</button>
				</EdgeLabelRenderer>
			)}
		</>
	);
};
