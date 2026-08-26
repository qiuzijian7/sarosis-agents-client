/*---------------------------------------------------------------------------------------------
 *  MultiPanelStoryboardEditor — 多宫格故事板编辑器（网格宫格）。
 *
 *  与 导演台编辑器（线性时间线分镜）不同：这里是一个 gridCount 宫格网格
 *  （2×1 / 2×2 / 3×2 / 3×3），每格独立填角色/动作/对白/图像提示，底部实时
 *  预览拼出的 qwen 多宫格 prompt。生成不在编辑器内发生 —— 点节点「运行」时由
 *  workflowRun.runMultiPanelStoryboardNode 读 panels_state 单图直出整张多宫格。
 *
 *  纯数据编辑器：不依赖 runners（无需直接出图），只把 panels_state JSON 写回 widget。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import {
	parsePanelsState,
	panelsStateToJson,
	createDefaultPanelsState,
	buildMultiPanelPrompt,
	gridLayoutForCount,
	GRID_COUNT_OPTIONS,
	type MultiPanelState,
} from './comfyHost/multiPanelStoryboard';

export interface MultiPanelStoryboardEditorProps {
	initialState: string;
	onStateChange: (json: string) => void;
}

const inputStyle: React.CSSProperties = {
	background: '#111', color: '#e6e6e6', border: '1px solid rgba(255,255,255,.14)',
	borderRadius: 5, padding: '4px 6px', fontSize: 11, outline: 'none', width: '100%',
	boxSizing: 'border-box', fontFamily: 'inherit',
};

const labelStyle: React.CSSProperties = { fontSize: 10, color: 'var(--vscode-descriptionForeground)' };

const fieldRow: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 6 };

const cellStyle: React.CSSProperties = {
	background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.12)',
	borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 2,
};

const cellHeaderStyle: React.CSSProperties = {
	fontSize: 11, fontWeight: 600, color: 'var(--vscode-foreground)',
	display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2,
};

const chip: React.CSSProperties = {
	padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
	background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)',
	border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit',
};
const chipOn: React.CSSProperties = { ...chip, background: 'rgba(59,130,246,.3)', borderColor: 'rgba(59,130,246,.6)' };

export function MultiPanelStoryboardEditor({ initialState, onStateChange }: MultiPanelStoryboardEditorProps): React.JSX.Element {
	const [state, setState] = React.useState<MultiPanelState>(() => parsePanelsState(initialState));

	const commit = React.useCallback((next: MultiPanelState) => {
		setState(next);
		onStateChange(panelsStateToJson(next));
	}, [onStateChange]);

	const changeGridCount = (count: number) => {
		if (count === state.gridCount) { return; }
		// 切宫格数：保留已有内容，多退少补。
		const prev = state.panels;
		const panels = Array.from({ length: count }, (_, i) => {
			const p = prev[i];
			return p ?? { index: i, character: '', action: '', dialogue: '', imagePrompt: '' };
		}).map((p, i) => ({ ...p, index: i }));
		commit({ gridCount: count, panels });
	};

	const setPanelField = (index: number, field: 'character' | 'action' | 'dialogue' | 'imagePrompt', value: string) => {
		const panels = state.panels.map(p => p.index === index ? { ...p, [field]: value } : p);
		commit({ ...state, panels });
	};

	const layout = gridLayoutForCount(state.gridCount);
	const promptPreview = buildMultiPanelPrompt(state);

	const fields: Array<{ key: 'character' | 'action' | 'dialogue' | 'imagePrompt'; label: string; placeholder: string; multiline?: boolean }> = [
		{ key: 'character', label: '角色', placeholder: '出场角色（跨格一致可只填首格）' },
		{ key: 'action', label: '动作', placeholder: '画面动作描述' },
		{ key: 'dialogue', label: '对白', placeholder: '台词' },
		{ key: 'imagePrompt', label: '图像提示', placeholder: '留空则用「动作+对白」拼接' },
	];

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 2px 12px' }}>
			{/* 宫格数选择 */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
				<span style={labelStyle}>宫格数</span>
				{GRID_COUNT_OPTIONS.map(n => (
					<button
						key={n}
						type="button"
						style={n === state.gridCount ? chipOn : chip}
						onClick={() => changeGridCount(n)}
					>
						{n} 宫格
					</button>
				))}
			</div>

			{/* 宫格网格 */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
					gridTemplateRows: `repeat(${layout.rows}, auto)`,
					gap: 8,
				}}
			>
				{state.panels.map(p => (
					<div key={p.index} style={cellStyle}>
						<div style={cellHeaderStyle}>
							<span>第 {p.index + 1} 格</span>
						</div>
						{fields.map(f => (
							<div key={f.key} style={fieldRow}>
								<span style={labelStyle}>{f.label}</span>
								<input
									style={inputStyle}
									value={p[f.key]}
									placeholder={f.placeholder}
									onChange={e => setPanelField(p.index, f.key, e.target.value)}
								/>
							</div>
						))}
					</div>
				))}
			</div>

			{/* 拼出的 prompt 预览 */}
			<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
				<span style={labelStyle}>生成提示词预览（运行节点时单图直出整张多宫格）</span>
				<pre style={{
					background: 'rgba(0,0,0,.3)', border: '1px solid rgba(255,255,255,.1)',
					borderRadius: 6, padding: 8, margin: 0, fontSize: 10, color: '#c9d1d9',
					whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflowY: 'auto',
				}}>
					{state.gridCount}宫格漫画，等宽白色边框，不要文字。{'\n\n'}
					{promptPreview}
					{'\n\n'}一致性要求：所有宫格为同一角色、同一服装、同一光线，统一画面风格。
				</pre>
			</div>
		</div>
	);
}
