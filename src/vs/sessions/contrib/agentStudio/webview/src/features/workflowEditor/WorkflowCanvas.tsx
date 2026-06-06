/*---------------------------------------------------------------------------------------------
 *  WorkflowCanvas — ReactFlow canvas with node types, background, and controls.
 *--------------------------------------------------------------------------------------------*/

import React, { useMemo, useCallback } from 'react';
import {
	ReactFlow,
	Background,
	Controls,
	MiniMap,
	type NodeTypes,
	type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { StartNode } from './nodes/StartNode';
import { EndNode } from './nodes/EndNode';
import { TaskNode } from './nodes/TaskNode';
import { ConditionNode } from './nodes/ConditionNode';
import { ParallelNode } from './nodes/ParallelNode';
import { LoopNode } from './nodes/LoopNode';
import { useWorkflowEditorStore } from './store';

const nodeTypes: NodeTypes = {
	start: StartNode,
	end: EndNode,
	task: TaskNode,
	condition: ConditionNode,
	parallel: ParallelNode,
	loop: LoopNode,
};

const nodeColor = (node: Node): string => {
	switch (node.type) {
		case 'start': return '#22c55e';
		case 'end': return '#ef4444';
		case 'task': return '#3b82f6';
		case 'condition': return '#f59e0b';
		case 'parallel': return '#8b5cf6';
		case 'loop': return '#06b6d4';
		default: return '#888780';
	}
};

export const WorkflowCanvas: React.FC = () => {
	const {
		nodes, edges,
		onNodesChange, onEdgesChange, onConnect,
		setSelectedNode,
	} = useWorkflowEditorStore();

	const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
		setSelectedNode(node.id);
	}, [setSelectedNode]);

	const onPaneClick = useCallback(() => {
		setSelectedNode(null);
	}, [setSelectedNode]);

	return (
		<div style={{ position: 'absolute', inset: 0 }}>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={onConnect}
				onNodeClick={onNodeClick}
				onPaneClick={onPaneClick}
				nodeTypes={nodeTypes}
				fitView
				snapToGrid
				snapGrid={[15, 15]}
				deleteKeyCode={['Backspace', 'Delete']}
				multiSelectionKeyCode="Control"
			>
				<Background gap={15} size={1} color="var(--vscode-panel-border)" />
				<Controls />
				<MiniMap
					nodeColor={nodeColor}
					maskColor="var(--vscode-widget-shadow)"
					style={{ backgroundColor: 'var(--vscode-editor-background)' }}
				/>
			</ReactFlow>
		</div>
	);
};
