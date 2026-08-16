/*---------------------------------------------------------------------------------------------
 *  StoryboardEditor — multi-board storyboard editor for the ComfyTV Storyboard
 *  Editor stage (P3). Each board is a full Layer Editor document (reusing the
 *  artboard component); boards carry uid / durationMs / dialogue / notes 等
 *  ComfyTV StoryBoardData 14 字段。The cover board composite is debounce-uploaded.
 *  The `board_state` JSON is stored in the ComfyTV-contract structure.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { ComfyRunnerRegistry } from './comfyHost/comfyRunner';
import { LayerEditor } from './LayerEditor';
import {
	addBoard, boardDurationMs, boardStateToJson, moveBoard, parseBoardState, patchBoard, removeBoard,
	type StoryboardDoc,
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
	const [state, setState] = React.useState<StoryboardDoc>(() => parseBoardState(initialState, width, height));
	const [activeBoardUid, setActiveBoardUid] = React.useState<string | null>(state.boards[0]?.uid ?? null);

	const activeBoard = state.boards.find(b => b.uid === activeBoardUid) ?? state.boards[0] ?? null;
	const activeDurationMs = activeBoard ? boardDurationMs(state, activeBoard) : 2000;
	const activeDurationSec = activeDurationMs / 1000;

	const commit = React.useCallback((next: StoryboardDoc) => {
		setState(next);
		onStateChange(boardStateToJson(next));
	}, [onStateChange]);

	const patchActive = React.useCallback((patch: Partial<{ name: string; durationMs: number; dialogue: string; notes: string }>) => {
		if (!activeBoardUid) { return; }
		commit(patchBoard(state, activeBoardUid, patch));
	}, [state, activeBoardUid, commit]);

	const handleBoardDocChange = React.useCallback((docJson: string) => {
		if (!activeBoardUid) { return; }
		commit(patchBoard(state, activeBoardUid, { layerState: JSON.parse(docJson) }));
	}, [state, activeBoardUid, commit]);

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			<div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
				<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>镜头</span>
				{state.boards.map((b, i) => (
					<button
						key={b.uid}
						onClick={() => setActiveBoardUid(b.uid)}
						title={b.notes || b.uid}
						style={{
							padding: '3px 9px', borderRadius: 5, cursor: 'pointer', fontSize: 10,
							background: b.uid === activeBoardUid ? 'rgba(59,130,246,.25)' : 'rgba(255,255,255,.05)',
							color: 'var(--vscode-foreground)', border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit',
						}}
					>
						{i + 1}·{b.name ?? b.uid}
					</button>
				))}
				<button style={miniBtn} onClick={() => { const next = addBoard(state); setActiveBoardUid(next.boards[next.boards.length - 1].uid); commit(next); }}>＋镜头</button>
				{activeBoard && (
					<>
						<button style={miniBtn} onClick={() => commit(moveBoard(state, activeBoard.uid, -1))}>←</button>
						<button style={miniBtn} onClick={() => commit(moveBoard(state, activeBoard.uid, 1))}>→</button>
						<button style={miniBtn} onClick={() => { const next = removeBoard(state, activeBoard.uid); setActiveBoardUid(next.boards[next.boards.length - 1].uid); commit(next); }}>🗑</button>
					</>
				)}
			</div>

			{activeBoard && (
				<>
					<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
						<input
							value={activeBoard.name ?? ''}
							placeholder={activeBoard.uid}
							onChange={e => patchActive({ name: e.target.value })}
							style={{ ...inputStyle, width: 90 }}
						/>
						<label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
							时长 {activeDurationSec.toFixed(1)}s
							<input type="range" min={0.5} max={15} step={0.5} value={activeDurationSec}
								onChange={e => patchActive({ durationMs: Number(e.target.value) * 1000 })}
								style={{ width: 80, accentColor: '#4a9eff' }} />
						</label>
						<input
							placeholder="对白 (dialogue)"
							value={activeBoard.dialogue}
							onChange={e => patchActive({ dialogue: e.target.value })}
							style={{ ...inputStyle, flex: 1, minWidth: 120 }}
						/>
					</div>
					<input
						placeholder="镜头备注 (notes) —— 景别/动作/场景目的"
						value={activeBoard.notes}
						onChange={e => patchActive({ notes: e.target.value })}
						style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
					/>
					<LayerEditor
						key={activeBoard.uid}
						initialDoc={JSON.stringify(activeBoard.layerState ?? { width: state.width, height: state.height, layers: [] })}
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
