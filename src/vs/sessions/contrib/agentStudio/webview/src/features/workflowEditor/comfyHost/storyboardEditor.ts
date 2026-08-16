/*---------------------------------------------------------------------------------------------
 *  storyboardEditor — ComfyTV Storyboard Editor support (P3 embedded editor).
 *
 *  数据契约对齐 ComfyTV widgets/storyboard/boardDoc.ts：
 *    - StoryboardDoc { version, width, height, defaultBoardTimingMs, boards }
 *    - StoryBoardData 14 字段（uid/newShot/durationMs/dialogue/action/notes/
 *      scenePurpose/character/shotSize/imagePrompt/motionPrompt/refUrl/
 *      layerState/compositeUrl）
 *  board_state JSON 可直接被 ComfyTV 后端消费。
 *
 *  本项目 layerState 用自研 LayerDoc（ComfyTV 用 pentrado document，两者均
 *  不透明、后端不解析），序列化为对象。额外保留 `name` 字段仅 UI 展示用
 *  （ComfyTV 无 name，后端忽略未知字段）。
 *--------------------------------------------------------------------------------------------*/

import type { LayerDoc } from './layerEditor.js';
import { defaultLayerDoc, layerDocToJson, parseLayerDoc } from './layerEditor.js';

export interface StoryBoardData {
	uid: string;
	name?: string;
	newShot: boolean;
	durationMs: number | null;
	dialogue: string;
	action: string;
	notes: string;
	scenePurpose: string;
	character: string;
	shotSize: string;
	imagePrompt: string;
	motionPrompt: string;
	refUrl: string | null;
	layerState: LayerDoc | null;
	compositeUrl: string | null;
}

export interface StoryboardDoc {
	version: 1;
	width: number;
	height: number;
	defaultBoardTimingMs: number;
	boards: StoryBoardData[];
}

const UID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** 5 位大写字母+数字 uid（对齐 ComfyTV generateBoardUid）。 */
export function generateBoardUid(): string {
	let s = '';
	for (let i = 0; i < 5; i++) {
		s += UID_CHARS[Math.floor(Math.random() * UID_CHARS.length)];
	}
	return s;
}

let boardSeq = 0;
function nextBoardName(): string {
	boardSeq += 1;
	return `镜头 ${boardSeq}`;
}

export function defaultBoardData(width: number, height: number, name?: string): StoryBoardData {
	return {
		uid: generateBoardUid(),
		name: name ?? nextBoardName(),
		newShot: true,
		durationMs: null,
		dialogue: '',
		action: '',
		notes: '',
		scenePurpose: '',
		character: '',
		shotSize: '',
		imagePrompt: '',
		motionPrompt: '',
		refUrl: null,
		layerState: defaultLayerDoc(width, height),
		compositeUrl: null,
	};
}

export function defaultBoardState(width = 1280, height = 720): StoryboardDoc {
	return {
		version: 1,
		width,
		height,
		defaultBoardTimingMs: 2000,
		boards: [defaultBoardData(width, height)],
	};
}

/** board 有效时长（对齐 ComfyTV boardDurationMs：durationMs ?? defaultBoardTimingMs）。 */
export function boardDurationMs(doc: StoryboardDoc, board: StoryBoardData): number {
	return board.durationMs ?? doc.defaultBoardTimingMs;
}

/** board 图像 URL（对齐 ComfyTV boardImageUrl：compositeUrl || refUrl）。 */
export function boardImageUrl(board: StoryBoardData): string | null {
	return board.compositeUrl ?? board.refUrl;
}

const str = (v: unknown, fb = ''): string => (typeof v === 'string' ? v : fb);
const nullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Parse + validate a board_state JSON; falls back to defaults. Pure. */
export function parseBoardState(value: unknown, width = 1280, height = 720): StoryboardDoc {
	if (typeof value !== 'string' || !value.trim()) { return defaultBoardState(width, height); }
	try {
		const data = JSON.parse(value);
		if (!data || typeof data !== 'object' || !Array.isArray(data.boards)) { return defaultBoardState(width, height); }
		const w = Number(data.width) || width;
		const h = Number(data.height) || height;
		const dfltMs = Number(data.defaultBoardTimingMs) || 2000;
		const boards = (data.boards as unknown[])
			.filter((b): b is Record<string, unknown> => b !== null && typeof b === 'object')
			.map((b): StoryBoardData => {
				const layerRaw = b.layerState;
				return {
					uid: str(b.uid) || generateBoardUid(),
					name: str(b.name, undefined as unknown as string) || undefined,
					newShot: b.newShot !== false,
					durationMs: typeof b.durationMs === 'number' && b.durationMs >= 100 ? b.durationMs : null,
					dialogue: str(b.dialogue),
					action: str(b.action),
					notes: str(b.notes),
					scenePurpose: str(b.scenePurpose),
					character: str(b.character),
					shotSize: str(b.shotSize),
					imagePrompt: str(b.imagePrompt),
					motionPrompt: str(b.motionPrompt),
					refUrl: nullableStr(b.refUrl),
					layerState: layerRaw ? parseLayerDoc(typeof layerRaw === 'string' ? layerRaw : JSON.stringify(layerRaw), w, h) : null,
					compositeUrl: nullableStr(b.compositeUrl),
				};
			});
		return { version: 1, width: w, height: h, defaultBoardTimingMs: dfltMs, boards: boards.length ? boards : defaultBoardState(w, h).boards };
	} catch {
		return defaultBoardState(width, height);
	}
}

export function boardStateToJson(state: StoryboardDoc): string {
	return JSON.stringify({
		version: 1,
		width: state.width,
		height: state.height,
		defaultBoardTimingMs: state.defaultBoardTimingMs,
		boards: state.boards.map(b => ({
			uid: b.uid,
			name: b.name,
			newShot: b.newShot,
			durationMs: b.durationMs,
			dialogue: b.dialogue,
			action: b.action,
			notes: b.notes,
			scenePurpose: b.scenePurpose,
			character: b.character,
			shotSize: b.shotSize,
			imagePrompt: b.imagePrompt,
			motionPrompt: b.motionPrompt,
			refUrl: b.refUrl,
			layerState: b.layerState ? JSON.parse(layerDocToJson(b.layerState)) : null,
			compositeUrl: b.compositeUrl,
		})),
	});
}

export function addBoard(state: StoryboardDoc): StoryboardDoc {
	return {
		...state,
		boards: [...state.boards, defaultBoardData(state.width, state.height)],
	};
}

export function removeBoard(state: StoryboardDoc, uid: string): StoryboardDoc {
	if (state.boards.length <= 1) { return state; }
	return { ...state, boards: state.boards.filter(b => b.uid !== uid) };
}

export function moveBoard(state: StoryboardDoc, uid: string, dir: -1 | 1): StoryboardDoc {
	const idx = state.boards.findIndex(b => b.uid === uid);
	const target = idx + dir;
	if (idx < 0 || target < 0 || target >= state.boards.length) { return state; }
	const boards = [...state.boards];
	[boards[idx], boards[target]] = [boards[target], boards[idx]];
	return { ...state, boards };
}

export function patchBoard(state: StoryboardDoc, uid: string, patch: Partial<Omit<StoryBoardData, 'uid'>>): StoryboardDoc {
	return {
		...state,
		boards: state.boards.map(b => (b.uid === uid ? { ...b, ...patch } : b)),
	};
}

export function isStoryboardEditorNode(type: string): boolean {
	return type === 'ComfyTV.StoryboardEditorStage';
}
