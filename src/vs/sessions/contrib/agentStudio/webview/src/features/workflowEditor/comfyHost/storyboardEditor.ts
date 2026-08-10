/*---------------------------------------------------------------------------------------------
 *  storyboardEditor — ComfyTV Storyboard Editor support (P3 embedded editor).
 *
 *  The stage holds a hidden `board_state` JSON document (boards / timing /
 *  metadata / per-board layers) plus width/height (1280×720) and uploads a
 *  cover composite (`captured_image`) + per-board batch (`captured_images`).
 *  We reuse the Layer Editor document model for each board and keep the JSON
 *  structure aligned with the ComfyTV contract.
 *--------------------------------------------------------------------------------------------*/

import type { LayerDoc } from './layerEditor.js';
import { defaultLayerDoc, layerDocToJson, parseLayerDoc } from './layerEditor.js';

export interface BoardDoc {
	id: string;
	name: string;
	/** board duration in seconds */
	duration: number;
	/** free-form shot metadata (beat / dialogue / camera) */
	meta: Record<string, string>;
	doc: LayerDoc;
}

export interface BoardState {
	width: number;
	height: number;
	boards: BoardDoc[];
}

let boardSeq = 0;
function newBoardId(): string {
	boardSeq += 1;
	return `board_${boardSeq}`;
}

export function defaultBoardState(width = 1280, height = 720): BoardState {
	return {
		width,
		height,
		boards: [{
			id: newBoardId(),
			name: '镜头 1',
			duration: 3,
			meta: { note: '' },
			doc: defaultLayerDoc(width, height),
		}],
	};
}

/** Parse + validate a board_state JSON; falls back to defaults. Pure. */
export function parseBoardState(value: unknown, width = 1280, height = 720): BoardState {
	if (typeof value !== 'string' || !value.trim()) { return defaultBoardState(width, height); }
	try {
		const data = JSON.parse(value);
		if (!data || typeof data !== 'object' || !Array.isArray(data.boards)) { return defaultBoardState(width, height); }
		const w = Number(data.width) || width;
		const h = Number(data.height) || height;
		const boards = data.boards
			.filter((b: unknown) => b && typeof b === 'object')
			.map((b: Record<string, unknown>): BoardDoc => ({
				id: typeof b.id === 'string' ? b.id : newBoardId(),
				name: typeof b.name === 'string' ? b.name : '镜头',
				duration: Math.max(0.1, Number(b.duration) || 3),
				meta: b.meta && typeof b.meta === 'object' ? b.meta as Record<string, string> : {},
				doc: parseLayerDoc(typeof b.doc === 'string' ? b.doc : JSON.stringify(b.doc ?? {}), w, h),
			}));
		return { width: w, height: h, boards: boards.length ? boards : defaultBoardState(w, h).boards };
	} catch {
		return defaultBoardState(width, height);
	}
}

export function boardStateToJson(state: BoardState): string {
	return JSON.stringify({
		width: state.width,
		height: state.height,
		boards: state.boards.map(b => ({
			id: b.id,
			name: b.name,
			duration: b.duration,
			meta: b.meta,
			doc: JSON.parse(layerDocToJson(b.doc)),
		})),
	});
}

export function addBoard(state: BoardState): BoardState {
	return {
		...state,
		boards: [...state.boards, {
			id: newBoardId(),
			name: `镜头 ${state.boards.length + 1}`,
			duration: 3,
			meta: {},
			doc: defaultLayerDoc(state.width, state.height),
		}],
	};
}

export function removeBoard(state: BoardState, boardId: string): BoardState {
	if (state.boards.length <= 1) { return state; }
	return { ...state, boards: state.boards.filter(b => b.id !== boardId) };
}

export function moveBoard(state: BoardState, boardId: string, dir: -1 | 1): BoardState {
	const idx = state.boards.findIndex(b => b.id === boardId);
	const target = idx + dir;
	if (idx < 0 || target < 0 || target >= state.boards.length) { return state; }
	const boards = [...state.boards];
	[boards[idx], boards[target]] = [boards[target], boards[idx]];
	return { ...state, boards };
}

export function patchBoard(state: BoardState, boardId: string, patch: Partial<Omit<BoardDoc, 'id'>>): BoardState {
	return {
		...state,
		boards: state.boards.map(b => (b.id === boardId ? { ...b, ...patch } : b)),
	};
}

export function isStoryboardEditorNode(type: string): boolean {
	return type === 'ComfyTV.StoryboardEditorStage';
}
