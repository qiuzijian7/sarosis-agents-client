/*---------------------------------------------------------------------------------------------
 *  NodePalette — floating overlay palette with categorized add-node buttons.
 *  Categories: System / Basic Nodes / Control Flow / Layout (mirrors cc-wf-studio).
 *
 *  v41: Changed to absolute-position overlay (floats above canvas). Collapse
 *       button (◀) on the right side of the header; parent handles slide-out.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { useWorkflowEditorStore, nodeCategories, type NodeCategory } from './store';
import { buildComfyPaletteItems, type PaletteItem, subscribeNodeRegistry, getNodeRegistryVersion } from './comfyHost/registry';

const CATEGORY_COLORS: Record<NodeCategory, string> = {
	system: '#6b7280',
	basic: '#3b82f6',
	controlFlow: '#f59e0b',
	layout: '#8b5cf6',
};

/** Dynamic Comfy groups: ComfyTV stages + ComfyUI native nodes from the registry. */
interface ComfyPaletteGroup {
	key: string;
	label: string;
	color: string;
	items: PaletteItem[];
}

function comfyGroups(): ComfyPaletteGroup[] {
	const tv = buildComfyPaletteItems('schema');
	const native = buildComfyPaletteItems('native');
	const groups: ComfyPaletteGroup[] = [];
	if (tv.length) {
		groups.push({ key: 'comfyTV', label: `ComfyTV Stages (${tv.length})`, color: '#e879f9', items: tv });
	}
	if (native.length) {
		groups.push({ key: 'comfyUI', label: `ComfyUI Native (${native.length})`, color: '#f59e0b', items: native });
	}
	return groups;
}

export const NodePalette: React.FC<{
	collapsed: boolean;
	onToggle: () => void;
	width: number; // v40: resizable width from WorkflowEditorPanel
}> = ({ collapsed, onToggle, width }) => {
	const addNode = useWorkflowEditorStore(s => s.addNode);

	// Re-render when ComfyTV/native nodes are registered (runner stages load in).
	// Without this, the palette stays frozen at its first render and the ComfyTV
	// group never appears until the whole panel remounts.
	React.useSyncExternalStore(
		subscribeNodeRegistry,
		getNodeRegistryVersion,
		getNodeRegistryVersion,
	);

	const handleAdd = (type: string) => {
		const x = 200 + Math.random() * 200;
		const y = 100 + Math.random() * 300;
		addNode(type, { x, y });
	};

	return (
		<div style={{
			width: `${width}px`,
			minWidth: '120px',
			backgroundColor: 'var(--vscode-sideBar-background)',
			display: 'flex',
			flexDirection: 'column',
			overflow: 'hidden',
			boxShadow: '2px 0 12px rgba(0,0,0,0.35)',
			height: '100%',
		}}>
			{/* Header with collapse toggle on the right */}
			<div style={{
				display: 'flex', alignItems: 'center',
				borderBottom: '1px solid var(--vscode-panel-border)',
			}}>
				<div style={{ flex: 1, display: 'flex', padding: '8px 10px' }}>
					<span style={{
						fontSize: '12px', fontWeight: 600,
						whiteSpace: 'nowrap', overflow: 'hidden',
						color: 'var(--vscode-foreground)',
					}}>
						Nodes
					</span>
				</div>
				<button
					onClick={(e) => { e.stopPropagation(); onToggle(); }}
					title="Hide Nodes panel"
					style={{
						width: '28px', alignSelf: 'stretch',
						display: 'flex', alignItems: 'center', justifyContent: 'center',
						border: 'none', borderLeft: '1px solid var(--vscode-panel-border)',
						background: 'transparent',
						color: 'var(--vscode-descriptionForeground)',
						cursor: 'pointer',
						fontSize: '11px',
					}}
					onMouseEnter={e => { (e.target as HTMLElement).style.color = 'var(--vscode-foreground)'; (e.target as HTMLElement).style.background = 'var(--vscode-toolbar-hoverBackground)'; }}
					onMouseLeave={e => { (e.target as HTMLElement).style.color = 'var(--vscode-descriptionForeground)'; (e.target as HTMLElement).style.background = 'transparent'; }}
				>
					◀
				</button>
			</div>
			{!collapsed && (
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
				{/* Dynamic Comfy groups (ComfyTV stages + ComfyUI native) */}
				{comfyGroups().map(g => (
					<div key={g.key} style={{ marginBottom: '16px' }}>
						<div style={{
							fontSize: '10px', fontWeight: 600,
							color: g.color,
							marginBottom: '6px',
							textTransform: 'uppercase',
							letterSpacing: '0.5px',
							paddingBottom: '4px',
							borderBottom: `1px solid ${g.color}22`,
						}}>
							{g.label}
						</div>
						{g.items.map(item => (
							<button
								key={item.type}
								onClick={() => handleAdd(item.type)}
								title={item.description}
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
								<span style={{ fontSize: '13px' }}>{item.icon}</span>
								<span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
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
		</div>
	);
};

export default NodePalette;
