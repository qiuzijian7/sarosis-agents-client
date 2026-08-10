/*---------------------------------------------------------------------------------------------
 *  StoryboardEditor — multi-board storyboard editor for the ComfyTV Storyboard
 *  Editor stage (P3). Each board is a full Layer Editor document (reusing the
 *  artboard component); boards carry duration + free-form metadata. The cover
 *  board composite is debounce-uploaded. The `board_state` JSON is stored in
 *  the ComfyTV-contract structure.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { ComfyRunnerRegistry } from './comfyHost/comfyRunner';
import { LayerEditor } from './LayerEditor';
import {
	addBoard, boardStateToJson, moveBoard, parseBoardState, patchBoard, removeBoard,
	type BoardState,
} from './comfyHost/storyboardEditor';
import { layerDocToJson } from './comfyHost/layerEditor';

export interface StoryboardEditorProps {
	initialState: string;
	width: number;
	height: number;
	runners: ComfyRunnerRegistry;
	preference: string;
	onStateChange: (json: string) => void;
	onRenderUploaded: (url: string | null) => void;
}

const inputStyle: React.CSSProperties = {
	background: '#111', color: '#e6e6e6', border: '1px solid rgba(255,255,255,.14)',
	borderRadius: 5, padding: '3px 6px', fontSize: 11, outline: 'none',
};

export function StoryboardEditor({ initialState, width, height, runners, preference, onStateChange, onRenderUploaded }: StoryboardEditorProps): React.JSX.Element {
	const [state, setState] = React.useState<BoardState>(() => parseBoardState(initialState, width, height));
	const [activeBoardId, setActiveBoardId] = React.useState<string | null>(state.boards[0]?.id ?? null);

	const activeBoard = state.boards.find(b => b.id === activeBoardId) ?? state.boards[0] ?? null;

	const commit = React.useCallback((next: BoardState) => {
		setState(next);
		onStateChange(boardStateToJson(next));
	}, [onStateChange]);

	const patchActive = React.useCallback((patch: Partial<{ name: string; duration: number; meta: Record<string, string> }>) => {
		if (!activeBoardId) { return; }
		commit(patchBoard(state, activeBoardId, patch));
	}, [state, activeBoardId, commit]);

	const handleBoardDocChange = React.useCallback((docJson: string) => {
		if (!activeBoardId) { return; }
		commit(patchBoard(state, activeBoardId, { doc: JSON.parse(docJson) }));
	}, [state, activeBoardId, commit]);

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			<div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
				<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>镜头</span>
				{state.boards.map((b, i) => (
					<button
						key={b.id}
						onClick={() => setActiveBoardId(b.id)}
						title={b.meta.note || b.name}
						style={{
							padding: '3px 9px', borderRadius: 5, cursor: 'pointer', fontSize: 10,
							background: b.id === activeBoardId ? 'rgba(59,130,246,.25)' : 'rgba(255,255,255,.05)',
							color: 'var(--vscode-foreground)', border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit',
						}}
					>
						{i + 1}·{b.name}
					</button>
				))}
				<button style={miniBtn} onClick={() => { const next = addBoard(state); setActiveBoardId(next.boards[next.boards.length - 1].id); commit(next); }}>＋镜头</button>
				{activeBoard && (
					<>
						<button style={miniBtn} onClick={() => commit(moveBoard(state, activeBoard.id, -1))}>←</button>
						<button style={miniBtn} onClick={() => commit(moveBoard(state, activeBoard.id, 1))}>→</button>
						<button style={miniBtn} onClick={() => { const next = removeBoard(state, activeBoard.id); setActiveBoardId(next.boards[next.boards.length - 1].id); commit(next); }}>🗑</button>
					</>
				)}
			</div>

			{activeBoard && (
				<>
					<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
						<input
							value={activeBoard.name}
							onChange={e => patchActive({ name: e.target.value })}
							style={{ ...inputStyle, width: 90 }}
						/>
						<label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
							时长 {activeBoard.duration}s
							<input type="range" min={0.5} max={15} step={0.5} value={activeBoard.duration}
								onChange={e => patchActive({ duration: Number(e.target.value) })}
								style={{ width: 80, accentColor: '#4a9eff' }} />
						</label>
						<input
							placeholder="镜头备注（景别/对白）"
							value={activeBoard.meta.note ?? ''}
							onChange={e => patchActive({ meta: { ...activeBoard.meta, note: e.target.value } })}
							style={{ ...inputStyle, flex: 1, minWidth: 140 }}
						/>
					</div>
					<LayerEditor
						key={activeBoard.id}
						initialDoc={JSON.stringify(activeBoard.doc)}
						width={state.width}
						height={state.height}
						runners={runners}
						preference={preference}
						onDocChange={handleBoardDocChange}
						onRenderUploaded={onRenderUploaded}
					/>
				</>
			)}
		</div>
	);
}

const miniBtn: React.CSSProperties = {
	width: 26, height: 22, padding: 0, borderRadius: 5, cursor: 'pointer', fontSize: 10,
	background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)',
	border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit',
};
