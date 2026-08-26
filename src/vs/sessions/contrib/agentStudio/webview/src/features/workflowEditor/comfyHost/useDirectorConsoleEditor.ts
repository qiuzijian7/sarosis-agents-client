/*---------------------------------------------------------------------------------------------
 * useDirectorConsoleEditor — 导演台编辑器 控制器 Hook（移植自 ComfyTV
 * composables/widgets/useStoryboardEditor.ts，Vue composable → React Hook）。
 *
 * 数据契约对齐 ComfyTV（board_state JSON 可直接被其后端消费）。doc 用 ref 可变
 * 存储 + 版本号触发重渲染（对齐 Vue ref 语义），所有 mutation 经 commit() 写回
 * onStateChange。
 *
 * LayerEditorController 抽象：本项目 LayerEditor 是受控组件，命令式操作（flip/
 * flushCapture/reload/documentIsEmpty/addImageFromUrl/cancelPendingCapture）通过
 * editor 参数注入；为 undefined 时降级 no-op（纯数据场景可用）。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import {
	parseBoardState, boardStateToJson, boardDurationMs, boardImageUrl,
	createBoard, duplicateBoardData, shotLabels, totalDurationMs, coverImageUrl,
	boardsToImagesJson, boardsFromImagesJson, boardsFromShotsJson, suggestedDurationMs,
	type StoryboardDoc, type StoryBoardData,
} from './storyboardEditor';
import type { LayerDoc } from './layerEditor';
import { fountainToBoards } from './fountain';
import { buildZip, type ZipEntry } from './zipWriter';

/** 命令式图层编辑器操作（本项目 LayerEditor 需 forwardRef 暴露；P2 落地）。 */
export interface LayerEditorController {
	flipImage(axis: 'h' | 'v'): void;
	flushCapture(): void;
	reload(): void;
	documentIsEmpty(): boolean;
	addImageFromUrl(url: string, kind: 'reference'): Promise<void>;
	cancelPendingCapture(): void;
}

export type BoardTextField = 'name' | 'dialogue' | 'action' | 'notes' | 'scenePurpose' | 'character' | 'shotSize' | 'imagePrompt' | 'motionPrompt';

export interface UseDirectorConsoleEditorOptions {
	initialState: string;
	width: number;
	height: number;
	/** board_state 变更回调（写回 widget）。 */
	onStateChange?: (json: string) => void;
	/** commit 后回调（cover 图 + images 批次 JSON）。 */
	onCommitted?: (coverUrl: string, batchJson: string) => void;
	/** 命令式图层编辑器（可选，无则降级 no-op）。 */
	editor?: LayerEditorController;
	/** 上游分镜文本（Fountain 剧本）。board_state 为空时自动解析成 boards。 */
	initialFountainText?: string;
}

export interface DirectorConsoleEditorController {
	// 状态（派生）
	doc: StoryboardDoc;
	boards: StoryBoardData[];
	labels: string[];
	currentUid: string;
	currentIndex: number;
	currentBoard: StoryBoardData;
	totalMs: number;
	// 播放
	playing: boolean;
	playIndex: number;
	playingBoard: StoryBoardData | null;
	loop: boolean;
	captions: boolean;
	// 洋葱皮 / 辅助线
	onionPrev: boolean;
	onionNext: boolean;
	onionPrevUrl: string | null;
	onionNextUrl: string | null;
	guideCenter: boolean;
	guideThirds: boolean;
	guideGrid: boolean;
	// board CRUD
	selectBoard(uid: string): void;
	addBoard(afterCurrent?: boolean): StoryBoardData;
	removeBoard(uid: string): void;
	moveBoard(uid: string, dir: -1 | 1): void;
	moveBoardTo(uid: string, toIndex: number): void;
	duplicateBoard(uid: string): StoryBoardData | null;
	// 字段
	applySuggestedDuration(uid: string): boolean;
	flipBoard(axis: 'h' | 'v'): void;
	setBoardField(uid: string, key: BoardTextField, value: string): void;
	setBoardDurationS(uid: string, seconds: number | null): void;
	toggleNewShot(uid: string): void;
	setDefaultTimingS(seconds: number): void;
	setBoardRefUrl(uid: string, url: string | null): void;
	setBoardCompositeUrl(uid: string, url: string | null): void;
	setBoardLayerState(uid: string, layerState: LayerDoc): void;
	setDocSize(width: number, height: number): void;
	// 播放控制
	play(): void;
	stopPlayback(): void;
	setLoop(v: boolean): void;
	setCaptions(v: boolean): void;
	setOnionPrev(v: boolean): void;
	setOnionNext(v: boolean): void;
	setGuideCenter(v: boolean): void;
	setGuideThirds(v: boolean): void;
	setGuideGrid(v: boolean): void;
	// 导入 / 导出
	appendBoards(incoming: StoryBoardData[]): number;
	importFromShotsJson(raw: string): number;
	importFromImagesJson(raw: string): number;
	importFountainText(text: string): number;
	importImageFiles(files: File[]): Promise<number>;
	exportBoardsZip(): Promise<Blob | null>;
	// 显式提交
	commit(): void;
}

function isBlankBoard(b: StoryBoardData): boolean {
	return !b.layerState && !b.compositeUrl && !b.refUrl
		&& !b.dialogue && !b.action && !b.notes && !b.scenePurpose && !b.imagePrompt;
}

function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
		reader.onerror = () => reject(reader.error ?? new Error('read failed'));
		reader.readAsDataURL(file);
	});
}

/** 初始化导演台 doc：board_state 为空 + 有上游 Fountain 文本时自动解析成 boards。 */
function initDirectorDoc(initialState: string, fountainText: string | undefined, width: number, height: number): StoryboardDoc {
	const doc = parseBoardState(initialState, width, height);
	if (!initialState.trim() && fountainText?.trim()) {
		const boards = fountainToBoards(fountainText);
		if (boards.length) { doc.boards = boards; }
	}
	return doc;
}

function didAutoImport(initialState: string, fountainText: string | undefined): boolean {
	return !initialState.trim() && !!fountainText?.trim();
}

export function useDirectorConsoleEditor(opts: UseDirectorConsoleEditorOptions): DirectorConsoleEditorController {
	const { initialState, width, height, onStateChange = () => {}, onCommitted, editor, initialFountainText } = opts;

	const docRef = React.useRef<StoryboardDoc>(initDirectorDoc(initialState, initialFountainText, width, height));
	const autoImportedRef = React.useRef(didAutoImport(initialState, initialFountainText));
	const [, setTick] = React.useState(0);
	const rerender = () => setTick(t => t + 1);

	const [currentUid, setCurrentUid] = React.useState<string>(docRef.current.boards[0]?.uid ?? '');
	const [playing, setPlaying] = React.useState(false);
	const [playIndex, setPlayIndex] = React.useState(0);
	const [loop, setLoop] = React.useState(false);
	const [captions, setCaptions] = React.useState(true);
	const [onionPrev, setOnionPrev] = React.useState(false);
	const [onionNext, setOnionNext] = React.useState(false);
	const [guideCenter, setGuideCenter] = React.useState(false);
	const [guideThirds, setGuideThirds] = React.useState(false);
	const [guideGrid, setGuideGrid] = React.useState(false);

	const playTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

	// 卸载时停止播放
	React.useEffect(() => () => {
		if (playTimerRef.current) { clearTimeout(playTimerRef.current); }
	}, []);

	// ★ 自动导入上游文本后，立即 commit 一次写回 board_state（持久化到 widget，
	//   让 runStoryboardEditorNode 能读到自动填充的 boards）。
	React.useEffect(() => {
		if (autoImportedRef.current) { commit(); }
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const doc = docRef.current;
	const boards = doc.boards;
	const labels = shotLabels(doc);
	const currentIndex = Math.max(0, boards.findIndex(b => b.uid === currentUid));
	const currentBoard = boards[currentIndex];
	const totalMs = totalDurationMs(doc);
	const playingBoard = playing ? (boards[playIndex] ?? null) : null;
	const onionPrevUrl = onionPrev && !playing ? (boards[currentIndex - 1] ? boardImageUrl(boards[currentIndex - 1]) : null) : null;
	const onionNextUrl = onionNext && !playing ? (boards[currentIndex + 1] ? boardImageUrl(boards[currentIndex + 1]) : null) : null;

	function renumberBoards(): void {
		docRef.current.boards.forEach((b, i) => {
			const expected = `镜头 ${i + 1}`;
			// 仅自动命名未命名或已是"镜头 N"模式的 board，保留用户自定义名称
			if (b.name == null || /^镜头 \d+$/.test(b.name)) {
				b.name = expected;
			}
		});
	}

	function ensureBoards(): void {
		if (docRef.current.boards.length === 0) { docRef.current.boards.push(createBoard()); }
		if (!docRef.current.boards.some(b => b.uid === currentUid)) {
			setCurrentUid(docRef.current.boards[0].uid);
		}
		renumberBoards();
	}

	function commit(): void {
		ensureBoards();
		const json = boardStateToJson(docRef.current);
		onStateChange(json);
		onCommitted?.(coverImageUrl(docRef.current), boardsToImagesJson(docRef.current));
		rerender();
	}

	function stopPlayback(): void {
		setPlaying(false);
		if (playTimerRef.current) { clearTimeout(playTimerRef.current); playTimerRef.current = null; }
	}

	function stepPlayback(): void {
		const b = docRef.current.boards[playIndex];
		if (!b) { stopPlayback(); return; }
		playTimerRef.current = setTimeout(() => {
			if (playIndex + 1 >= docRef.current.boards.length) {
				if (!loop) { stopPlayback(); return; }
				setPlayIndex(0);
				stepPlayback();
				return;
			}
			setPlayIndex(playIndex + 1);
			stepPlayback();
		}, Math.max(100, boardDurationMs(docRef.current, b)));
	}

	function play(): void {
		if (playing || docRef.current.boards.length === 0) { return; }
		editor?.flushCapture();
		setPlayIndex(currentIndex);
		setPlaying(true);
		stepPlayback();
	}

	function seedReference(): void {
		const b = docRef.current.boards[currentIndex];
		if (b?.refUrl && editor?.documentIsEmpty()) {
			void editor.addImageFromUrl(b.refUrl, 'reference');
		}
	}

	function selectBoard(uid: string): void {
		if (uid === currentUid) { return; }
		if (!docRef.current.boards.some(b => b.uid === uid)) { return; }
		stopPlayback();
		editor?.flushCapture();
		setCurrentUid(uid);
		editor?.reload();
		seedReference();
	}

	function addBoard(afterCurrent = true): StoryBoardData {
		const b = createBoard();
		const at = afterCurrent ? currentIndex + 1 : docRef.current.boards.length;
		docRef.current.boards.splice(at, 0, b);
		renumberBoards();
		commit();
		selectBoard(b.uid);
		return b;
	}

	function removeBoard(uid: string): void {
		const idx = docRef.current.boards.findIndex(b => b.uid === uid);
		if (idx < 0) { return; }
		const wasCurrent = uid === currentUid;
		if (wasCurrent) { editor?.cancelPendingCapture(); }
		docRef.current.boards.splice(idx, 1);
		renumberBoards();
		ensureBoards();
		if (wasCurrent) {
			setCurrentUid(docRef.current.boards[Math.min(idx, docRef.current.boards.length - 1)].uid);
			editor?.reload();
			seedReference();
		}
		commit();
	}

	function moveBoard(uid: string, dir: -1 | 1): void {
		const arr = docRef.current.boards;
		const i = arr.findIndex(b => b.uid === uid);
		const j = i + dir;
		if (i < 0 || j < 0 || j >= arr.length) { return; }
		[arr[i], arr[j]] = [arr[j], arr[i]];
		renumberBoards();
		commit();
	}

	function moveBoardTo(uid: string, toIndex: number): void {
		const arr = docRef.current.boards;
		const i = arr.findIndex(b => b.uid === uid);
		if (i < 0) { return; }
		const j = Math.max(0, Math.min(arr.length - 1, toIndex));
		if (i === j) { return; }
		const [b] = arr.splice(i, 1);
		arr.splice(j, 0, b);
		renumberBoards();
		commit();
	}

	function duplicateBoard(uid: string): StoryBoardData | null {
		const idx = docRef.current.boards.findIndex(b => b.uid === uid);
		if (idx < 0) { return null; }
		const copy = duplicateBoardData(docRef.current.boards[idx]);
		docRef.current.boards.splice(idx + 1, 0, copy);
		renumberBoards();
		commit();
		selectBoard(copy.uid);
		return copy;
	}

	function applySuggestedDuration(uid: string): boolean {
		const b = docRef.current.boards.find(x => x.uid === uid);
		if (!b) { return false; }
		const ms = suggestedDurationMs(b);
		if (ms == null) { return false; }
		b.durationMs = ms;
		commit();
		return true;
	}

	function flipBoard(axis: 'h' | 'v'): void {
		editor?.flipImage(axis);
	}

	function setBoardField(uid: string, key: BoardTextField, value: string): void {
		const b = docRef.current.boards.find(x => x.uid === uid);
		if (!b) { return; }
		if (key === 'name') { b.name = value || undefined; } else { (b as unknown as Record<string, unknown>)[key] = value; }
		commit();
	}

	function setBoardDurationS(uid: string, seconds: number | null): void {
		const b = docRef.current.boards.find(x => x.uid === uid);
		if (!b) { return; }
		b.durationMs = seconds != null && Number.isFinite(seconds) && seconds > 0
			? Math.max(100, Math.round(seconds * 1000))
			: null;
		commit();
	}

	function toggleNewShot(uid: string): void {
		const b = docRef.current.boards.find(x => x.uid === uid);
		if (!b) { return; }
		b.newShot = !b.newShot;
		commit();
	}

	function setDefaultTimingS(seconds: number): void {
		if (!Number.isFinite(seconds) || seconds <= 0) { return; }
		docRef.current.defaultBoardTimingMs = Math.max(100, Math.round(seconds * 1000));
		commit();
	}

	function setBoardRefUrl(uid: string, url: string | null): void {
		const b = docRef.current.boards.find(x => x.uid === uid);
		if (!b) { return; }
		b.refUrl = url;
		commit();
		if (uid === currentUid) { seedReference(); }
	}

	function setBoardCompositeUrl(uid: string, url: string | null): void {
		const b = docRef.current.boards.find(x => x.uid === uid);
		if (!b) { return; }
		b.compositeUrl = url;
		commit();
	}

	function setBoardLayerState(uid: string, layerState: LayerDoc): void {
		const b = docRef.current.boards.find(x => x.uid === uid);
		if (!b) { return; }
		b.layerState = layerState;
		commit();
	}

	function setDocSize(w: number, h: number): void {
		docRef.current.width = w;
		docRef.current.height = h;
		commit();
	}

	function appendBoards(incoming: StoryBoardData[]): number {
		if (!incoming.length) { return 0; }
		const replacing = docRef.current.boards.length === 1 && isBlankBoard(docRef.current.boards[0]);
		if (replacing) {
			editor?.cancelPendingCapture();
			docRef.current.boards = incoming;
			setCurrentUid(incoming[0].uid);
			ensureBoards();
			commit();
			editor?.reload();
			seedReference();
		} else {
			docRef.current.boards.push(...incoming);
			ensureBoards();
			commit();
			selectBoard(incoming[0].uid);
		}
		return incoming.length;
	}

	function importFromShotsJson(raw: string): number {
		return appendBoards(boardsFromShotsJson(raw));
	}

	function importFromImagesJson(raw: string): number {
		return appendBoards(boardsFromImagesJson(raw));
	}

	function importFountainText(text: string): number {
		return appendBoards(fountainToBoards(text));
	}

	async function importImageFiles(files: File[]): Promise<number> {
		const images = files.filter(f => f.type.startsWith('image/'));
		if (!images.length) { return 0; }
		const incoming: StoryBoardData[] = [];
		for (const file of images) {
			const url = await readFileAsDataUrl(file);
			incoming.push(createBoard({ newShot: true, refUrl: url, notes: file.name.replace(/\.[^.]+$/, '') }));
		}
		return appendBoards(incoming);
	}

	async function exportBoardsZip(): Promise<Blob | null> {
		const labelsNow = shotLabels(docRef.current);
		const entries: ZipEntry[] = [];
		for (let i = 0; i < docRef.current.boards.length; i++) {
			const b = docRef.current.boards[i];
			const url = boardImageUrl(b);
			if (!url) { continue; }
			const resp = await fetch(url);
			if (!resp.ok) { continue; }
			const buf = new Uint8Array(await resp.arrayBuffer());
			entries.push({ name: `board-${String(i + 1).padStart(3, '0')}-${labelsNow[i]}-${b.uid}.png`, data: buf });
		}
		if (!entries.length) { return null; }
		const bytes = buildZip(entries);
		return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' });
	}

	return {
		doc, boards, labels, currentUid, currentIndex, currentBoard, totalMs,
		playing, playIndex, playingBoard, loop, captions,
		onionPrev, onionNext, onionPrevUrl, onionNextUrl,
		guideCenter, guideThirds, guideGrid,
		selectBoard, addBoard, removeBoard, moveBoard, moveBoardTo,
		duplicateBoard, applySuggestedDuration, flipBoard,
		setBoardField, setBoardDurationS, toggleNewShot, setDefaultTimingS, setBoardRefUrl,
		setBoardCompositeUrl, setBoardLayerState, setDocSize,
		play, stopPlayback, setLoop, setCaptions,
		setOnionPrev, setOnionNext, setGuideCenter, setGuideThirds, setGuideGrid,
		appendBoards, importFromShotsJson, importFromImagesJson, importFountainText,
		importImageFiles, exportBoardsZip,
		commit,
	};
}
