/*---------------------------------------------------------------------------------------------
 *  scene3dHistory — Scene3D undo/redo history (ComfyTV Scene3dHistory 移植)。
 *
 *  对齐 ComfyTV src/widgets/three/scene3d/Scene3dHistory.ts：
 *    - Snapshot = { json, selectedId }（JSON 序列化快照 + 选中对象）
 *    - record(before, mergeKey)：mergeKey 相同且 < mergeWindowMs 内合并（连续拖拽合并为一步）
 *    - undo(current) / redo(current)：返回要恢复的快照
 *    - limit 默认 50
 *  纯逻辑，可单测。
 *--------------------------------------------------------------------------------------------*/

export interface Scene3dHistorySnapshot {
	json: string;
	selectedId: string | null;
}

interface HistoryEntry extends Scene3dHistorySnapshot {
	mergeKey?: string;
	time: number;
}

export interface Scene3dHistoryOptions {
	limit?: number;
	mergeWindowMs?: number;
	now?: () => number;
}

export class Scene3dHistory {
	private undos: HistoryEntry[] = [];
	private redos: HistoryEntry[] = [];
	private readonly limit: number;
	private readonly mergeWindowMs: number;
	private readonly now: () => number;

	constructor(options: Scene3dHistoryOptions = {}) {
		this.limit = options.limit ?? 50;
		this.mergeWindowMs = options.mergeWindowMs ?? 500;
		this.now = options.now ?? (() => Date.now());
	}

	record(before: Scene3dHistorySnapshot, mergeKey?: string): void {
		const time = this.now();
		const last = this.undos[this.undos.length - 1];
		if (
			last !== undefined &&
			mergeKey !== undefined &&
			last.mergeKey === mergeKey &&
			time - last.time < this.mergeWindowMs
		) {
			last.time = time;
		} else {
			this.undos.push({ json: before.json, selectedId: before.selectedId, mergeKey, time });
			if (this.undos.length > this.limit) { this.undos.shift(); }
		}
		this.redos = [];
	}

	undo(current: Scene3dHistorySnapshot): Scene3dHistorySnapshot | null {
		const entry = this.undos.pop();
		if (!entry) { return null; }
		this.redos.push({ json: current.json, selectedId: current.selectedId, time: this.now() });
		return { json: entry.json, selectedId: entry.selectedId };
	}

	redo(current: Scene3dHistorySnapshot): Scene3dHistorySnapshot | null {
		const entry = this.redos.pop();
		if (!entry) { return null; }
		this.undos.push({ json: current.json, selectedId: current.selectedId, time: this.now() });
		return { json: entry.json, selectedId: entry.selectedId };
	}

	canUndo(): boolean {
		return this.undos.length > 0;
	}

	canRedo(): boolean {
		return this.redos.length > 0;
	}

	clear(): void {
		this.undos = [];
		this.redos = [];
	}
}
