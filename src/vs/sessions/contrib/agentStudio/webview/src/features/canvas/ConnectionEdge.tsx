// @ts-nocheck
/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Connection Edge (ReactFlow custom edge)
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

const EDGE_COLORS: Record<string, string> = {
	subagent: '#3b82f6',
	collaboration: '#10b981',
	'data-flow': '#8b5cf6',
};

export function ConnectionEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	data,
	markerEnd,
}: EdgeProps): React.ReactElement {
	const connectionType = (data?.type as string) || 'subagent';
	const color = EDGE_COLORS[connectionType] || EDGE_COLORS.subagent;

	const [edgePath] = getSmoothStepPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		borderRadius: 16,
	});

	return (
		<>
			<BaseEdge
				id={id}
				path={edgePath}
				markerEnd={markerEnd}
				style={{
					stroke: color,
					strokeWidth: 2,
					opacity: 0.8,
				}}
			/>
			{/* Edge label */}
			{data?.label && (
				<text>
					<textPath
						href={`#${id}`}
						startOffset="50%"
						textAnchor="middle"
						style={{
							fontSize: '10px',
							fill: 'var(--vscode-descriptionForeground)',
						}}
					>
						{data.label as string}
					</textPath>
				</text>
			)}
		</>
	);
}
