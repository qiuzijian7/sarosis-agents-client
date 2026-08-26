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

import type { LayerDoc } from './layerEditor';
import { defaultLayerDoc, layerDocToJson, parseLayerDoc } from './layerEditor';

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

/**
 * 纯数据创建 board（对齐 ComfyTV createBoard：newShot 默认 false，layerState
 * 默认 null——pentrado/自研 LayerEditor 在渲染时用 defaultLayerDoc 兜底）。
 * 用于 boardsFromImagesJson / boardsFromShotsJson / fountainToBoards 等纯数据
 * 导入场景。
 */
export function createBoard(partial?: Partial<StoryBoardData>): StoryBoardData {
	return {
		uid: generateBoardUid(),
		newShot: false,
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
		layerState: null,
		compositeUrl: null,
		...partial,
	};
}

/**
 * 画板内「新增镜头」用的默认数据：带 name + 初始化 layerState。
 * ★ newShot 语义对齐 ComfyTV（默认 false = 延续上一镜头标签，而非每板都是
 *   新镜头）——否则 shotLabels 的 "1A/1B" 语义失效。
 */
export function defaultBoardData(width: number, height: number, name?: string): StoryBoardData {
	return {
		...createBoard({ name: name }),
		layerState: defaultLayerDoc(width, height),
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
					newShot: b.newShot === true,
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

/* ─────────────────────────────────────────────────────────────────────────────
 * P0 移植：对齐 ComfyTV boardDoc.ts 的纯函数（totalDurationMs / shotLabels /
 * coverImageUrl / boardsToImagesJson / duplicateBoardData / boardsFromImagesJson
 * / suggestedDurationMs / boardsFromShotsJson）。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 全片总时长（每板有效时长之和）。 */
export function totalDurationMs(doc: StoryboardDoc): number {
	return doc.boards.reduce((sum, b) => sum + boardDurationMs(doc, b), 0);
}

/** 26 进制字母列（0→A, 25→Z, 26→AA...），对齐 ComfyTV shotLetters。 */
function shotLetters(n: number): string {
	let out = '';
	let v = n;
	do {
		out = String.fromCharCode(65 + (v % 26)) + out;
		v = Math.floor(v / 26) - 1;
	} while (v >= 0);
	return out;
}

/**
 * Storyboarder 式镜头标签：boards 共享 "1A" 标签直到下一个 newShot 板。
 * 首板恒为 "1A"（i===0 时 shotIndex 从 -1 递增到 0）。
 */
export function shotLabels(doc: StoryboardDoc): string[] {
	let shotIndex = -1;
	return doc.boards.map((b, i) => {
		if (i === 0 || b.newShot) { shotIndex += 1; }
		return `1${shotLetters(Math.max(0, shotIndex))}`;
	});
}

/** 封面图（首个有图像的板）。 */
export function coverImageUrl(doc: StoryboardDoc): string {
	for (const b of doc.boards) {
		const url = boardImageUrl(b);
		if (url) { return url; }
	}
	return '';
}

/** 图片批次 JSON（对齐 LayerEditor/ImagePool 约定：{images:[{index,label,image_url}]}）。 */
export function boardsToImagesJson(doc: StoryboardDoc): string {
	const labels = shotLabels(doc);
	const images: Array<{ index: number; label: string; image_url: string }> = [];
	doc.boards.forEach((b, i) => {
		const url = boardImageUrl(b);
		if (!url) { return; }
		images.push({ index: images.length + 1, label: labels[i], image_url: url });
	});
	return JSON.stringify({ images });
}

/** 深拷贝 board（新 uid），对齐 Storyboarder 的 Duplicate Board。 */
export function duplicateBoardData(board: StoryBoardData): StoryBoardData {
	return {
		...board,
		uid: generateBoardUid(),
		layerState: board.layerState ? (JSON.parse(JSON.stringify(board.layerState)) as LayerDoc) : null,
	};
}

/** 图片批次 {images:[{image_url,label}]} → 参考板（对齐 ComfyTV boardsFromImagesJson）。 */
export function boardsFromImagesJson(raw: string): StoryBoardData[] {
	let obj: unknown;
	try { obj = JSON.parse(raw || ''); } catch { return []; }
	const images = (obj as { images?: unknown })?.images;
	if (!Array.isArray(images)) { return []; }
	return (images as Array<Record<string, unknown>>)
		.filter(im => typeof im?.image_url === 'string' && im.image_url)
		.map(im => createBoard({
			newShot: true,
			refUrl: String(im.image_url),
			notes: typeof im.label === 'string' && im.label !== 'composite' ? im.label : '',
		}));
}

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/g;

/** Storyboarder 式阅读速度估算：CJK 150ms/字 + 拉丁 300ms/词，下限 1000ms。 */
export function suggestedDurationMs(board: StoryBoardData): number | null {
	const text = (board.dialogue || '').trim();
	if (!text) { return null; }
	const cjk = (text.match(CJK_RE) || []).length;
	const latinWords = text.replace(CJK_RE, ' ').split(/\s+/).filter(Boolean).length;
	return Math.max(1000, 500 + cjk * 150 + latinWords * 300);
}

/** StoryboardStage LLM shots {shots:[...]} → 新板（对齐 ComfyTV boardsFromShotsJson）。 */
export function boardsFromShotsJson(raw: string): StoryBoardData[] {
	let obj: unknown;
	try { obj = JSON.parse(raw || ''); } catch { return []; }
	const shots = (obj as { shots?: unknown })?.shots;
	if (!Array.isArray(shots)) { return []; }
	return (shots as Array<Record<string, unknown>>).map(s => {
		const durS = Number(s.duration);
		return createBoard({
			newShot: true,
			durationMs: Number.isFinite(durS) && durS > 0 ? Math.round(durS * 1000) : null,
			dialogue: String(s.dialogue ?? ''),
			action: String(s.action ?? ''),
			scenePurpose: String(s.scene_purpose ?? ''),
			character: String(s.character ?? ''),
			shotSize: String(s.shot_size ?? ''),
			imagePrompt: String(s.image_prompt ?? s.prompt ?? ''),
			motionPrompt: String(s.motion_prompt ?? ''),
			refUrl: typeof s.image_url === 'string' && s.image_url ? s.image_url : null,
		});
	});
}
