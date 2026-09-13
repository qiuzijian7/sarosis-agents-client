/*---------------------------------------------------------------------------------------------
 *  mediaSnapshotStore — in-memory store for media snapshots produced by Comfy nodes.
 *
 *  Keyed by `${nodeId}:${port}:${index}`. The actual bitmap payload lives in a
 *  pluggable backend (blob URL cache / IndexedDB / file storage); this store only
 *  tracks refs + a small LRU of preview refs so cards can render thumbnails.
 *  Framework-agnostic, unit-testable with an injected backend.
 *--------------------------------------------------------------------------------------------*/

import type { MediaSnapshotEntry, MediaRef } from './mediaSnapshot.js';

export interface MediaSnapshotBackend {
	save(key: string, data: Blob | string): Promise<string>;
	load(key: string): Promise<Blob | string | null>;
	remove(key: string): Promise<void>;
	/** Persist the ref metadata for a key (refresh recovery — the ref is the
	 *  source of truth; payloads are URLs/refs, not raw bitmaps). */
	saveMeta?(key: string, media: MediaRef): Promise<void>;
	removeMeta?(key: string): Promise<void>;
	listMeta?(): Promise<Array<{ key: string; media: MediaRef }>>;
}

export interface MemoryBackendEntry {
	key: string;
	data: Blob | string;
}

/** Simple in-memory backend (tests + transient runs). */
export function createMemoryBackend(): MediaSnapshotBackend & { entries: Map<string, MemoryBackendEntry> } {
	const entries = new Map<string, MemoryBackendEntry>();
	const meta = new Map<string, MediaRef>();
	return {
		entries,
		async save(key, data) {
			entries.set(key, { key, data });
			return key;
		},
		async load(key) {
			return entries.get(key)?.data ?? null;
		},
		async remove(key) {
			entries.delete(key);
			meta.delete(key);
		},
		async saveMeta(key, media) {
			meta.set(key, media);
		},
		async removeMeta(key) {
			meta.delete(key);
		},
		async listMeta() {
			return Array.from(meta, ([key, media]) => ({ key, media }));
		},
	};
}

/**
 * 别名表在 backend 里的保留 key（复用 `saveMeta`/`listMeta` 通道持久化，
 * 不新增 object store、不 bump DB version）。`media.ref` 存 JSON.stringify 的
 * `{ [nodeId]: uid }` 映射。
 */
const ALIASES_META_KEY = '__saros_aliases__';

// ── v43 meta 类型化访问器（2026-09-09）──────────────────────────────────
// 收敛 `sheetFull === '1'` 字符串约定：写入侧仍存字符串 '1'（持久化格式不变），
// 读取侧一律走这两个访问器（单点维护；String() 同时兼容历史写入的数字 1）。
/** 原生整图原图（重裁/单格替换的合法基底）。 */
export function isSheetFullMeta(meta?: Record<string, unknown>): boolean {
	return String(meta?.sheetFull) === '1';
}
/** v43: meta 标志常量——写入侧唯一真源（读取侧 isSheetFullMeta/hasSheetLikeMeta 单点判定）。 */
export const META_SHEET_FLAG = '1';
/** rows/cols 的类型化读取（调用方自行 clamp，各节点上限不同）。 */
export function sheetDimsOf(meta?: Record<string, unknown>): { rows: number; cols: number } {
	return { rows: Number(meta?.rows) || 0, cols: Number(meta?.cols) || 0 };
}
/** 合并图集（sheet='1'）或原生整图（sheetFull='1'）任一命中 = 图集类产物。 */
export function hasSheetLikeMeta(meta?: Record<string, unknown>): boolean {
	return String(meta?.sheet) === '1' || isSheetFullMeta(meta);
}

// ── meta 写侧类型化（2026-09-09，P0-2）────────────────────────────────
// 存储层 meta 全为字符串（历史格式，不改），但写侧此前是**裸 String() 约定**：
// 全仓 129 处 `key: String(x)`，漏写 String() 或 key 拼错都只在运行时暴露。
// 这里提供「值序列化 + 图集/单格构造器」，让写侧也有编译期形状约束。
// 持久化格式与读侧 isSheetFullMeta/sheetDimsOf 完全对称（仍存数字字符串）。

/** meta 值序列化：undefined/null 直接丢弃该字段（避免写入 'undefined' 脏值）。 */
export function metaValue(v: string | number | boolean | undefined | null): string | undefined {
	if (v === undefined || v === null) { return undefined; }
	return typeof v === 'string' ? v : String(v);
}

/** 构造 meta 片段：传入任意原始值，输出序列化后的 meta 补丁（自动丢弃空值）。 */
export function buildMeta(
	patch: Record<string, string | number | boolean | undefined | null>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(patch)) {
		const s = metaValue(v);
		if (s !== undefined) { out[k] = s; }
	}
	return out;
}

/**
 * 图集维度写侧（与 sheetDimsOf 读侧对称）。
 * **有限值一律写入（含 0）**——注意有消费方用 `meta.rows !== undefined` 判定
 * 「上游是否带图集语义」（nodeCard upstreamHasSheetSemantic），省略 0 会改变
 * 该判定；读侧 Number('0')||0 与 Number(undefined)||0 都是 0，故写 0 无害且更兼容。
 */
export function sheetDimsMeta(rows: number, cols: number): { rows?: string; cols?: string } {
	const out: { rows?: string; cols?: string } = {};
	const r = Number(rows);
	const c = Number(cols);
	if (Number.isFinite(r)) { out.rows = String(r); }
	if (Number.isFinite(c)) { out.cols = String(c); }
	return out;
}

export class MediaSnapshotStore {
	private readonly refs = new Map<string, MediaRef>();
	/**
	 * nodeId → stageUid 别名映射。
	 *
	 * ★ 为什么需要：快照归档键是 stageUid（`put`/`renameNode` 后），但**大量
	 *   读取方仍用 nodeId 查询**（运行链路 `state.edges` 的 upstreams、双击编辑器
	 *   的 upstreams、`collectUpstreamValues` 等）。若这些 key 不解析，
	 *   `byNode(nodeId)` 查不到 uid 名下新归档 → **下游节点图像不刷新**。
	 *   别名让两种 key 都能命中同一份归档：`byNode` 先按原 key 查，查不到再用
	 *   别名。`registerAlias` 由画布层在每次 syncOverlay 注册（幂等）。
	 */
	private readonly aliases = new Map<string, string>();
	/** most-recently-used order for preview eviction */
	private readonly lru: string[] = [];
	private readonly maxPreviewRefs: number;
	private readonly persistent: boolean;
	private readonly onAsset?: (entry: MediaSnapshotEntry) => void;
	/** ★ P4：本窗口主动产生的产物（用于跨窗口广播）。远端写入不触发。 */
	private readonly onProduced?: (entry: MediaSnapshotEntry) => void;
	private readonly listeners = new Set<() => void>();
	/** opaque version bumped on every mutation (for useSyncExternalStore) */
	private version = 0;

	constructor(
		private readonly backend: MediaSnapshotBackend,
		opts?: {
			maxPreviewRefs?: number;
			persistent?: boolean;
			onAsset?: (entry: MediaSnapshotEntry) => void;
			/**
			 * ★ P4 跨窗口同步（2026-09-13）：本 webview **主动产生**的产物回调
			 * （执行/编辑/粘贴写入 `put`）。上层据此广播给同工作流的其它窗口
			 * （画布 tab ↔ 节点编辑器 tab / 独立窗口）。
			 *
			 * 为什么用回调而不是在 store 内直接调 bridge：本模块是
			 * 「framework-agnostic, unit-testable with an injected backend」——
			 * 保持零 bridge 依赖（与 `onAsset` 同一模式 ✓）。
			 *
			 * **远端写入（`putRemote`）不触发** → 无回环 ✓。
			 */
			onProduced?: (entry: MediaSnapshotEntry) => void;
		},
	) {
		this.maxPreviewRefs = opts?.maxPreviewRefs ?? 200;
		// Persistent stores (IndexedDB / host file) never evict refs — the
		// persisted refs ARE the history; dropping them would silently erase
		// already-recovered snapshots. Ref entries are tiny (URL + kind), so
		// unbounded growth is acceptable for the workflow-scoped stores.
		this.persistent = opts?.persistent ?? false;
		this.onAsset = opts?.onAsset;
		this.onProduced = opts?.onProduced;
	}

	/** Subscribe to store mutations. Returns an unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** Snapshot accessor compatible with useSyncExternalStore's getSnapshot. */
	getSnapshot(): number {
		return this.version;
	}

	// ── 工作流 Session 隔离（2026-09-11 用户需求）────────────────────────────
	//  同一工作流的不同 session（对应不同聊天会话）生成的内容必须隔离：归档 key 加
	//  `{sessionId}::` 前缀（读写全部经 _scoped 统一），因此不同 session 的同名节点
	//  互不覆盖；查询（byNode/get）优先当前 session，再回退无前缀的历史 key（旧数据
	//  兼容）。切换 session 只需 setActiveSession → notify → 卡片按新 session 重渲染。
	private _activeSessionId = 'default';

	/** 当前生效的工作流 session（快照按它隔离）。 */
	setActiveSession(sessionId: string | undefined): void {
		const next = sessionId && sessionId.trim() ? sessionId.trim() : 'default';
		if (next === this._activeSessionId) { return; }
		const prev = this._activeSessionId;
		this._activeSessionId = next;
		// ★★ 迁移「未指定会话」期间写入的产物（2026-09-12 用户需求「新建会话中的节点
		//   预览图应该是干净的，其他会话产生的资源不应该污染新会话」）：
		//   面板是**异步**取回当前 session 的 —— 若运行早于解析完成，产物会落在
		//   `default::` 下 ✗。此前靠「读取侧 default 兜底」补可见性 ⇒ **所有**会话都能
		//   看到它们（= 污染新会话 ✗✗，正是用户报的问题）。改为**在解析到真实 session
		//   时把它迁过去**：归属明确 ✓、隔离严格 ✓、且不丢数据 ✓。
		if (prev === 'default' && next !== 'default') { this.migrateDefaultScope(next); }
		this.notify();
	}

	/**
	 * 把 `default::{nodeId}:port:idx` 重写为 `{sid}::…`（内存键 + 持久化 meta 同步）。
	 * 目标键已存在 → 丢弃旧条目（新 session 已有更新数据，避免 index 冲突 ✓）。
	 */
	private migrateDefaultScope(sid: string): void {
		const moved: Array<{ oldKey: string; newKey: string; media: MediaRef }> = [];
		for (const [key, media] of this.refs) {
			if (!key.startsWith('default::')) { continue; }
			const newKey = `${sid}::${key.slice('default::'.length)}`;
			if (this.refs.has(newKey)) { continue; }
			moved.push({ oldKey: key, newKey, media });
		}
		if (moved.length === 0) { return; }
		for (const { oldKey, newKey, media } of moved) {
			this.refs.delete(oldKey);
			this.refs.set(newKey, media);
			const i = this.lru.indexOf(oldKey);
			if (i >= 0) { this.lru[i] = newKey; }
			void this.backend.removeMeta?.(oldKey);
			void this.backend.saveMeta?.(newKey, media);
		}
		// eslint-disable-next-line no-console
		console.warn(`[MediaSnapshotStore] 迁移 ${moved.length} 条「未指定会话」产物 → ${sid}（运行早于 session 解析）`);
	}

	getActiveSession(): string {
		return this._activeSessionId;
	}

	/** key 作用域化：`{sessionId}::{key}`。 */
	private _scoped(key: string): string {
		return `${this._activeSessionId}::${key}`;
	}

	/** 去掉 session 前缀（非 scoped key 原样返回）。 */
	private _unscoped(prefix: string): string {
		const sep = prefix.indexOf('::');
		return sep >= 0 ? prefix.slice(sep + 2) : prefix;
	}

	private notify(): void {
		this.version++;
		for (const fn of this.listeners) { fn(); }
	}

	/**
	 * Store an entry's media ref (caller is responsible for backend.save of payload).
	 *
	 * 对齐 ComfyTV `pinnedBatchStore` 的"批次"语义：同一节点同 port 再次生成时
	 * 不要覆盖历史——每张图都保留，picker / ImageStage OUTPUT 即可一次显示所有
	 * 生成过的图像。实现：为该 (nodeId, port) 分配**单调递增的 index**（而非
	 * 直接使用调用方传入的、每次从 0 重新开始的 index），使 `byNode()` 返回的
	 * entry 天然按生成先后排序，`mergeImagePool()` 反转即可"新图在前"。
	 *
	 * 注意：调用方（stageWorkflowExecutor / comfyOutputsToSnapshots）每次 batch
	 * 传入的 entry.key/index 都从 0 重新开始，直接 set 会覆盖历史；这里忽略
	 * 传入 index，用已存在的最大 index + 1 作为真实 index，杜绝覆盖。
	 *
	 * @param skipImport 当 true 时不触发 onAsset 回调（picker/loader 等路由节点
	 *   不产生新内容，只是透传上游已有资产，不应重复导入媒体库）。默认 false。
	 */
	put(entry: MediaSnapshotEntry, skipImport?: boolean, opts?: { remote?: boolean }): void {
		// ★ session 作用域（2026-09-11）：key 加 `{sessionId}::` 前缀 → 不同 session
		//   的同名节点互不覆盖（隔离）；同一 session 内仍按 (nodeId, port) 单调递增。
		const prefix = this._scoped(`${entry.nodeId}:${entry.port}:`);
		let nextIndex = 0;
		for (const key of this.refs.keys()) {
			if (!key.startsWith(prefix)) { continue; }
			const idx = Number(key.slice(prefix.length));
			if (Number.isInteger(idx) && idx >= nextIndex) { nextIndex = idx + 1; }
		}
		const finalKey = `${prefix}${nextIndex}`;
		const finalEntry: MediaSnapshotEntry = { ...entry, key: finalKey, index: nextIndex };
		this.refs.set(finalKey, finalEntry.media);
		this.touch(finalKey);
		// Persist the ref so a refresh can recover it (refs are the history;
		// the payload is the URL/ref itself for most executors).
		void this.backend.saveMeta?.(finalKey, finalEntry.media);
		// Optional auto-collect into the host media library (generated-image
		// asset management P1). Fire-and-forget; dedup lives at the callback.
		// 路由节点（picker/loader）设 skipImport=true 避免重复导入上游已入库资产。
		if (!skipImport) { this.onAsset?.(finalEntry); }
		// ★ P4（2026-09-13）：本窗口**主动产生**的产物 → 通知上层广播给其它窗口
		//   （画布 tab ↔ 节点编辑器 tab / 独立窗口）。远端写入传 `remote:true` →
		//   不再广播 → 无回环 ✓。
		if (opts?.remote !== true) { this.onProduced?.(finalEntry); }
		this.evict();
		this.notify();
	}

	/**
	 * ★ P4（2026-09-13）：写入**其它窗口**产出的条目（跨窗口同步的接收端）。
	 *
	 * 与 `put` 的差别只有两点，都为了防回环/防重复：
	 *  ① `remote: true` → 不触发 `onProduced`（否则 A→B→A 无限互发 ✗）；
	 *  ② **去重**：同 (nodeId, port) 下已有**相同 ref** → 直接跳过。理由：`put` 的
	 *     index 由本地单调递增分配（忽略传入值），若不去重，同一产物在 B 端会随
	 *     A 的重复广播不断新增条目（卡片历史里出现一串相同图 ✗）。
	 *     ref 是自包含 URL（http/COS/data URL），相同 ref 即同一份内容 ✓。
	 *
	 * `skipImport=true`：远端产物在 A 窗口**已**经 `onAsset` 导入过媒体库，
	 *  B 端再导入会重复入库 ✗。
	 *
	 * @returns 是否实际写入（false = 重复条目，已跳过）
	 */
	putRemote(entry: MediaSnapshotEntry): boolean {
		const prefix = this._scoped(`${entry.nodeId}:${entry.port}:`);
		for (const [key, media] of this.refs) {
			if (key.startsWith(prefix) && media.ref === entry.media.ref) { return false; }
		}
		this.put(entry, true, { remote: true });
		return true;
	}

	/** 解析 key 到实际存储键：当前 session 优先，回退无前缀历史 key（旧数据兼容）。 */
	private _resolveKey(key: string): string {
		const scoped = this._scoped(key);
		return this.refs.has(scoped) ? scoped : key;
	}

	get(key: string): MediaRef | undefined {
		return this.refs.get(this._resolveKey(key));
	}

	/**
	 * 按 key **原地覆盖**媒体内容（不新增 index）。
	 * 用途：EmojiCellEditor 橡皮擦/涂改——直接更新整图（port 'sheet'）或
	 * 单格产物（port 'output'）的像素，保持快照序列稳定。
	 *
	 * ★ opts.importEntry（2026-09-08）：传入完整 entry 时触发媒体库导入
	 *   （onAsset，与 put 同路径）——视频直出模式（gif_enable=false）的产物
	 *   经原地替换归档，provider COS 签名 URL 约 2 小时过期，**必须落盘媒体库**
	 *   否则「生成的视频无处可寻」。EmojiCellEditor 的像素编辑不传（同资产
	 *   更新，不应重复导入）。
	 *
	 * @returns 是否成功（key 不存在 → false。**此前静默 return**，调用方无从
	 *   得知「替换没生效」，用户看到的就是「编辑后 output 没更新」。改为显式
	 *   返回 + warn，由调用方兜底提示。）
	 */
	replaceByKey(key: string, media: MediaRef, opts?: { importEntry?: MediaSnapshotEntry }): boolean {
		const resolved = this._resolveKey(key);
		if (!this.refs.has(resolved)) {
			// eslint-disable-next-line no-console
			console.warn(`[MediaSnapshotStore] replaceByKey: key not found → ${key}（快照可能在编辑期间被重排/清除）`);
			return false;
		}
		this.refs.set(resolved, media);
		void this.backend.saveMeta?.(resolved, media);
		if (opts?.importEntry) {
			this.onAsset?.({ ...opts.importEntry, key: resolved, media });
		}
		this.notify();
		return true;
	}

	has(key: string): boolean {
		return this.refs.has(this._scoped(key)) || this.refs.has(key);
	}

	/** Restore refs previously persisted by the backend (refresh recovery).
	 *  In-memory refs from the current session win — persisted entries are only
	 *  added when absent, so a concurrent run is never masked. */
	async hydrate(): Promise<void> {
		if (!this.backend.listMeta) { return; }
		const metas = await this.backend.listMeta();
		let changed = false;
		// ★★ **不做 session 推断**（2026-09-12 用户需求「新会话预览要干净」）：
		//   此前按「恢复到的 key 里最多的那个 session」推断主导作用域 —— 那会让
		//   **新建的会话**在 host 返回真实 session 之前，先按旧 session 渲染出别人的
		//   产物 ✗✗（= 污染）。作用域现在只由 `setActiveSession`（host 的权威值）
		//   决定；`default` 期间写入的产物由 `setActiveSession` 的**迁移**处理 ✓。
		for (const { key, media } of metas) {
			// ★ 别名表是保留 key，不作为普通 ref 恢复（否则会污染 refs 索引，
			//   `byNode`/`allEntries` 会把它当成一条 text 快照）。
			if (key === ALIASES_META_KEY) {
				this.restoreAliases(media);
				continue;
			}
			if (!this.refs.has(key)) {
				this.refs.set(key, media);
				this.lru.unshift(key);
				changed = true;
			}
		}
		if (changed) { this.notify(); }
	}

	/** 从持久化的 JSON 恢复别名表（hydrate 内部调用）。 */
	private restoreAliases(media: MediaRef): void {
		if (media.kind !== 'text' || !media.ref) { return; }
		try {
			const obj = JSON.parse(media.ref) as Record<string, string>;
			for (const [nodeId, uid] of Object.entries(obj)) {
				if (nodeId && uid && nodeId !== uid && !this.aliases.has(nodeId)) {
					this.aliases.set(nodeId, uid);
				}
			}
		} catch { /* 非法 JSON：忽略，交给 syncOverlay 重新注册 */ }
	}

	/** Load a stored payload (for export/download of locally-saved blobs). */
	async getPayload(key: string): Promise<Blob | string | null> {
		return this.backend.load(key);
	}

	/**
	 * 注册 nodeId → uid 别名（幂等）。快照归档键是 uid，但大量读取方用 nodeId
	 * 查询；注册后 `byNode(nodeId)` 查不到时自动回退到 uid 名下归档。
	 *
	 * ★ 持久化：别名表随注册写入 backend（fire-and-forget），刷新后 `hydrate`
	 *   恢复 —— 消除「重启后、syncOverlay 重新注册前」`byNode(nodeId)` 短暂 miss
	 *   的时序隐患（方案 B/D′ 的 #4）。持久化失败不影响内存行为（尽力而为）。
	 */
	registerAlias(nodeId: string, uid: string): void {
		if (!nodeId || !uid || nodeId === uid) { return; }
		const prev = this.aliases.get(nodeId);
		if (prev === uid) { return; }  // 无变化，跳过重复持久化
		this.aliases.set(nodeId, uid);
		void this.persistAliases();
	}

	/** 序列化整张别名表并写入 backend（fire-and-forget，失败静默）。 */
	private persistAliases(): void {
		if (!this.backend.saveMeta) { return; }
		const obj: Record<string, string> = {};
		for (const [k, v] of this.aliases) { obj[k] = v; }
		void this.backend.saveMeta(ALIASES_META_KEY, { kind: 'text', ref: JSON.stringify(obj) });
	}

	/**
	 * 注销别名（节点已从 graph 移除时调用）。
	 *
	 * ★ 为什么必要：`nodeId` 由 `nextNodeId()` 生成，**跨会话可能复用**（序列计数器
	 *   尚未持久化）。若旧别名 `rotate-stage-1 → uid-A` 残留，新建的同名节点在
	 *   syncOverlay 重新注册 `rotate-stage-1 → uid-B` **之前**读一次
	 *   `byNode('rotate-stage-1')`，就会拿到已删节点 uid-A 的输出图（串号）。
	 *   注销是幂等且自愈的 —— 节点若只是短暂离开 graph（reconfigure 窗口），
	 *   下一帧 `registerAlias` 会原样恢复。
	 */
	unregisterAlias(nodeId: string): void {
		if (!this.aliases.delete(nodeId)) { return; }
		void this.persistAliases();
	}

	/**
	 * 按存活 nodeId 集合裁剪别名表（批量版 `unregisterAlias`）。
	 *
	 * 安全阀：`liveNodeIds` 为空时**直接返回**（工作流可能尚未加载完成／处于
	 * `graph.clear()` 的瞬时窗口，此时全量裁剪会把整张别名表清空）。
	 * 返回被删除的别名条目数。
	 */
	pruneAliases(liveNodeIds: Iterable<string>): number {
		const live = new Set(liveNodeIds);
		if (live.size === 0) { return 0; }
		const stale: string[] = [];
		for (const nodeId of this.aliases.keys()) {
			if (!live.has(nodeId)) { stale.push(nodeId); }
		}
		if (stale.length === 0) { return 0; }
		for (const nodeId of stale) { this.aliases.delete(nodeId); }
		void this.persistAliases();
		return stale.length;
	}

	/** 当前别名表的只读快照（排障 / 测试用）。 */
	aliasEntries(): Array<{ nodeId: string; uid: string }> {
		return Array.from(this.aliases, ([nodeId, uid]) => ({ nodeId, uid }));
	}

	/**
	 * 一个逻辑节点的**全部**归档键前缀（原 nodeId + 别名 uid）。
	 *
	 * ★ 这里是「合并」而非「替换」。写入侧现已统一贯穿 `snapshotKey`（= stageUid，
	 *   见 `GraphRunOptions.snapshotKeyOf` / `NodeEditorPopupProps.snapshotKey`），
	 *   但**两类归档仍会共存**：
	 *   · 历史数据 —— 旧版本按 nodeId 归档的弹窗渲染 / run 输出（`nodeId:port:i`）；
	 *   · 兜底路径 —— 未注入 uid 解析器时 `snapshotKey` 回退 nodeId。
	 *   若像旧实现那样「有别名就只查 uid」，上述归档会被整段遮蔽，
	 *   `runPosterNode` / `runRelightNode` / `runScene3DNode` /
	 *   `runStoryboardEditorNode` 的 `store.byNode(...)` 就会返回空 →
	 *   误报「请先在节点弹窗中绘制」。
	 */
	private nodeKeyPrefixes(nodeId: string): string[] {
		const alias = this.aliases.get(nodeId);
		const bases = alias && alias !== nodeId ? [nodeId, alias] : [nodeId];
		// ★★ **严格会话隔离**（2026-09-12 用户需求「新建会话中的节点预览图应该是干净的，
		//   其他会话产生的资源不应该污染新会话」）：
		//   · 当前 session 的 key（`{sid}::{nodeId}`）**必然**命中 ✓；
		//   · 无前缀的历史 key 仅在当前 session 为 `default`（= 未指定会话）时才回退 ✓
		//     —— 那是 2026-09-11 引入会话作用域**之前**的旧数据 ✓；真实会话下若也回退，
		//     新会话就会被旧会话/历史产物污染 ✗✗。
		//   ★ 此前（批次132~135）为了让「误归档在 default 下的产物」可见，加了
		//     `default::` 兜底 —— 那**正是**用户现在报的污染源 ✗；根因（运行早于
		//     session 解析）改由 `setActiveSession` 的**迁移**修复（见该函数）✓。
		return [
			...bases.map(b => this._scoped(b)),
			...(this._activeSessionId === 'default' ? bases : []),
		];
	}

	/** All entries for a node (for card previews / history). */
	byNode(nodeId: string): MediaSnapshotEntry[] {
		const collect = (prefixes: string[]): MediaSnapshotEntry[] => {
			const acc: MediaSnapshotEntry[] = [];
			const seen = new Set<string>();
			// 前缀顺序 = [原 nodeId, 别名 uid]；Array#sort 稳定，故 index 相同时
			// 弹窗历史（nodeId 名下）排在 run 输出（uid 名下）之前。
			for (const prefix of prefixes) {
				for (const [key, media] of this.refs) {
					if (!key.startsWith(`${prefix}:`) || seen.has(key)) { continue; }
					seen.add(key);
					const rest = key.slice(prefix.length + 1);
					const lastColon = rest.lastIndexOf(':');
					const port = lastColon >= 0 ? rest.slice(0, lastColon) : '';
					const index = lastColon >= 0 ? Number(rest.slice(lastColon + 1)) : 0;
					// nodeId 还原为**去 session 前缀**的形态（消费方按节点 id 匹配，如
					// upstreams 查询；key 保留完整 scoped 形态供 replaceByKey 使用）。
					acc.push({ nodeId: this._unscoped(prefix), port, key, media, index });
				}
			}
			return acc;
		};
		const out = collect(this.nodeKeyPrefixes(nodeId));
		// ★ 空结果 + 别处有 → 打一行诊断（见 warnScopedMiss）：这类「产物其实在、
		//   只是 session 作用域不对」的排查此前完全无迹可循 ✗。
		if (out.length === 0) { this.warnScopedMiss(nodeId); }
		return out.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	}

	/** 「按当前 session 查不到、但别的 session 有」的诊断去重表（每个 nodeId 只报一次）。 */
	private readonly scopedMissWarned = new Set<string>();

	/**
	 * 诊断（2026-09-12）：`byNode()` 在当前 session 作用域下**查不到**任何产物，
	 * 但该节点的产物其实存在于**别的 session 前缀**下时打一行 warn。
	 *
	 * 用途：用户看到「生成过视频，重启后却显示未生成视频」时，日志能直接指出
	 * 是**会话作用域**问题（产物完好，只是当前 session 不是它归档时那个）——
	 * 见 `hydrate()` 里的作用域推断。只打一次，避免每帧刷屏。
	 */
	private warnScopedMiss(nodeId: string): void {
		if (this.scopedMissWarned.has(nodeId)) { return; }
		const alias = this.aliases.get(nodeId);
		const bases = alias && alias !== nodeId ? [nodeId, alias] : [nodeId];
		let n = 0;
		const sids = new Set<string>();
		for (const key of this.refs.keys()) {
			const base = this._unscoped(key);
			if (!bases.some(b => base.startsWith(`${b}:`))) { continue; }
			n++;
			const sep = key.indexOf('::');
			if (sep > 0) { sids.add(key.slice(0, sep)); }
		}
		if (n === 0) { return; }
		this.scopedMissWarned.add(nodeId);
		// eslint-disable-next-line no-console
		console.warn(`[MediaSnapshotStore] session 作用域未命中：节点 ${nodeId} 在当前 session「${this._activeSessionId}」下查不到产物，但其它 session（${[...sids].join(', ') || '无前缀历史'}）下有 ${n} 条 —— 预览会显示「未生成」，实际产物仍在（换回对应 session 即可见）。`);
	}

	/**
	 * 某节点「最新一轮」的格子快照 + 最新图集（image，格排除 sheet 类）。
	 *
	 * ★ 为什么需要：`put` 恒追加新 key（不覆盖历史），EmojiStage **多次执行**的
	 *   格子快照会全部堆在 `byNode` 里 —— 下游「转动态表情包」收集时把历史轮
	 *   也混进来（9 张旧格 + 16 张新格 → 计数膨胀），预览/拼贴与上游实际不符。
	 *
	 * 「最新一轮」格数 = 最新 sheet（meta.sheetFull/sheet='1'）的 rows×cols：
	 *   从尾部反向取 K 个非 sheet 格（每轮格子在该轮 sheet 之前归档、index 连续
	 *   递增，尾部 K 个即最新轮）。无 sheet meta 时回退全部格子（单图/无图集上游）。
	 */
	latestRoundOf(nodeId: string): {
		cells: MediaSnapshotEntry[];
		sheet?: { entry: MediaSnapshotEntry; rows: number; cols: number; margin: number };
	} {
		const all = this.byNode(nodeId);
		const isSheetEntry = (e: MediaSnapshotEntry): boolean => {
			const meta = e.media.meta as Record<string, string> | undefined;
			return e.media.kind === 'image' && hasSheetLikeMeta(meta);
		};
		const cells = all.filter(e => e.media.kind === 'image' && !isSheetEntry(e));
		// ★ sheet 选取优先级（2026-09-03 根因修复）：
		//   byNode 按 key 字典序排序（`…:image:0` < `…:output:*` < `…:sheet:0`）——
		//   **原生整图（port 'sheet'，meta.sheetFull='1'）恒排尾部**。此前「反向找
		//   第一个 sheet」会永久命中原生整图，而单格编辑/裁剪的最终产物在**合并
		//   图集**（port 'image'，meta.sheet='1'，key 排最前）→ 下游（转动态）拿到
		//   的永远是未经编辑的原生整图等分切（「单格调对了、传下去又被错误裁剪」）。
		//   现分别取两者各自最新，**merged（合并图集）优先**、full（原生整图）兜底：
		//   merged 承载编辑/裁剪结果且几何与下游切分契约（无缝等分）一致。
		let merged: { entry: MediaSnapshotEntry; rows: number; cols: number; margin: number } | undefined;
		let full: { entry: MediaSnapshotEntry; rows: number; cols: number; margin: number } | undefined;
		for (let i = all.length - 1; i >= 0; i--) {
			const e = all[i];
			if (e.media.kind !== 'image') { continue; }
			const meta = e.media.meta as Record<string, string> | undefined;
			const isMerged = String(meta?.sheet) === '1';
			const isFull = isSheetFullMeta(meta);
			if (!isMerged && !isFull) { continue; }
			const dims = sheetDimsOf(meta);
			const r = dims.rows;
			const c = dims.cols;
			const m = Number(meta?.margin);
			const shape = {
				entry: e,
				rows: Number.isFinite(r) && r >= 1 ? Math.min(6, r) : 0,
				cols: Number.isFinite(c) && c >= 1 ? Math.min(6, c) : 0,
				margin: Number.isFinite(m) && m >= 0 ? Math.min(0.2, m) : 0,
			};
			if (isMerged && !merged) { merged = shape; }
			if (isFull && !full) { full = shape; }
			if (merged && full) { break; }
		}
		const sheet = merged ?? full;
		const k = sheet && sheet.rows * sheet.cols > 0 ? Math.min(36, sheet.rows * sheet.cols) : 0;
		return { cells: k > 0 && cells.length > k ? cells.slice(cells.length - k) : cells, sheet };
	}

	/** 所有节点（跨节点）的 entry，可选按 kind 过滤。用于 picker 的「全部生成图」
	 *  视图（对齐 ComfyTV 的跨节点 batch 引用 / library 资产）。按 (nodeId, index)
	 *  排序，跨节点合并时 nodeId 作主键、index 作次键。 */
	allEntries(kind?: MediaRef['kind']): MediaSnapshotEntry[] {
		const out: MediaSnapshotEntry[] = [];
		for (const [key, media] of this.refs) {
			if (kind && media.kind !== kind) { continue; }
			const colon = key.indexOf(':');
			if (colon < 0) { continue; }
			const nodeId = key.slice(0, colon);
			const rest = key.slice(colon + 1);
			const lastColon = rest.lastIndexOf(':');
			const port = lastColon >= 0 ? rest.slice(0, lastColon) : '';
			const index = lastColon >= 0 ? Number(rest.slice(lastColon + 1)) : 0;
			out.push({ nodeId, port, key, media, index });
		}
		return out.sort((a, b) =>
			a.nodeId === b.nodeId
				? (a.index ?? 0) - (b.index ?? 0)
				: a.nodeId < b.nodeId ? -1 : 1,
		);
	}

	async remove(key: string): Promise<void> {
		this.refs.delete(key);
		const i = this.lru.indexOf(key);
		if (i >= 0) { this.lru.splice(i, 1); }
		this.notify();
		await this.backend.remove(key);
		await this.backend.removeMeta?.(key);
	}

	clear(): void {
		this.refs.clear();
		this.lru.length = 0;
		this.notify();
	}

	/** Remove all entries for a single node (picker Clear 语义：清空已选输出）。
	 *  ★ 与 `byNode` 同源：清 nodeId 名下 **和** 别名 uid 名下，否则 Clear 之后
	 *    卡片仍会显示另一半归档（“清了但没清干净”）。 */
	clearNode(nodeId: string): void {
		const prefixes = this.nodeKeyPrefixes(nodeId);
		const keys: string[] = [];
		for (const key of this.refs.keys()) {
			if (prefixes.some(p => key.startsWith(`${p}:`))) { keys.push(key); }
		}
		if (keys.length === 0) { return; }
		for (const key of keys) {
			this.refs.delete(key);
			const i = this.lru.indexOf(key);
			if (i >= 0) { this.lru.splice(i, 1); }
			void this.backend.remove(key);
			void this.backend.removeMeta?.(key);
		}
		this.notify();
	}

	/**
	 * 删除孤儿快照：归档键前缀既不是任何存活 nodeId、也不是任何存活 stageUid。
	 *
	 * 用途：节点删除后其 uid 名下的快照会永久留在 IndexedDB（`persistent: true`
	 * 的 store 永不淘汰 —— "persisted refs ARE the history"），久用只增不减。
	 * 调用方（画布层）在**确认图已完整加载**后传入全部存活键（nodeId + uid）回收。
	 *
	 * 安全阀：`liveKeys` 为空 → 直接返回 0。`graph.clear()` 的瞬时窗口或工作流
	 * 尚未加载完成时 `graph.nodes` 为空，照常裁剪会把全部历史输出图删光（不可逆）。
	 * 返回删除的条目数。
	 */
	pruneOrphans(liveKeys: Iterable<string>): number {
		const live = new Set<string>();
		for (const k of liveKeys) { if (k) { live.add(k); } }
		if (live.size === 0) { return 0; }
		const doomed: string[] = [];
		for (const key of this.refs.keys()) {
			// ★ session 作用域（2026-09-11 用户需求）：先剥离 `{sid}::` 前缀再比对
			//   存活键 —— 否则 scoped key 的首个 ':' 落在 session 段里（`wfs_A:`），
			//   前缀解析成 sessionId → 不在 liveKeys → 被误判孤儿删除（不可逆）。
			const base = this._unscoped(key);
			const colon = base.indexOf(':');
			// 不含 ':' 的保留键（别名表等）与畸形键一律保守保留。
			if (colon <= 0) { continue; }
			if (!live.has(base.slice(0, colon))) { doomed.push(key); }
		}
		if (doomed.length === 0) { return 0; }
		for (const key of doomed) {
			this.refs.delete(key);
			const i = this.lru.indexOf(key);
			if (i >= 0) { this.lru.splice(i, 1); }
			void this.backend.remove(key);
			void this.backend.removeMeta?.(key);
		}
		this.notify();
		return doomed.length;
	}

	/**
	 * 把 `oldNodeId` 名下的所有条目迁移到 `newNodeId`（键前缀重写）。
	 *
	 * 用途：引入 stage uid 后，历史工作流的快照仍按旧 `nodeId` 归档。加载时做一次
	 * `nodeId → uid` 迁移，否则用户升级后所有历史输出图会「消失」（其实是查不到）。
	 * 等价 ComfyTV 的 `adoptOutputs`。
	 *
	 * 注意只重写 refs 索引与 meta，**不搬动 backend 里的 payload** —— payload 的 key
	 * 就是 `media.ref`，保持不变即可继续加载；只有索引键需要换。返回迁移条目数。
	 */
	renameNode(oldNodeId: string, newNodeId: string): number {
		if (oldNodeId === newNodeId) { return 0; }
		const moved: Array<{ oldKey: string; newKey: string; entry: MediaRef }> = [];
		for (const [key, media] of this.refs) {
			if (!key.startsWith(`${oldNodeId}:`)) { continue; }
			const rest = key.slice(oldNodeId.length + 1);
			const newKey = `${newNodeId}:${rest}`;
			// 目标键已存在说明 uid 名下已有更新的数据，旧的直接丢弃。
			if (this.refs.has(newKey)) { continue; }
			moved.push({ oldKey: key, newKey, entry: media });
		}
		if (moved.length === 0) { return 0; }
		for (const { oldKey, newKey, entry } of moved) {
			this.refs.delete(oldKey);
			this.refs.set(newKey, entry);
			const i = this.lru.indexOf(oldKey);
			if (i >= 0) { this.lru[i] = newKey; }
			// meta 需要按新键重存（payload 的 ref 不变，仍指向原 backend key）。
			void this.backend.removeMeta?.(oldKey);
			void this.backend.saveMeta?.(newKey, entry);
		}
		this.notify();
		return moved.length;
	}

	/**
	 * Persist a payload through the backend and record the ref.
	 *
	 * ★ 语义与 `put` 不同，**不能**走 put 的「单调递增 index 重写」：
	 *   - `put` 面向执行器：每次 batch 的 entry.index 从 0 重来，必须用 MAX+1
	 *     重写成真实 index 才能不覆盖历史；
	 *   - `savePayload` 面向「本地保存的 blob」（local editor renders），调用方
	 *     **显式指定 index**，key = `${nodeId}:${port}:${index}` 由调用方决定。
	 *   若复用 put，backend 的 payload 存成 `n9:image:2`，而 ref 索引键被重写成
	 *   `n9:image:0` —— 两者不一致，hydrate 后 `get('n9:image:2')` 查不到，
	 *   返回的 key 也指向一个不存在的 ref。故这里**直接按指定 key 落盘**。
	 */
	async savePayload(nodeId: string, port: string, index: number, data: Blob | string, kind?: MediaRef['kind']): Promise<string> {
		const key = `${nodeId}:${port}:${index}`;
		await this.backend.save(key, data);
		const media: MediaRef = {
			kind: kind ?? (typeof data === 'string' ? 'text' : 'image'),
			ref: key,
		};
		this.refs.set(key, media);
		this.touch(key);
		void this.backend.saveMeta?.(key, media);
		this.onAsset?.({ nodeId, port, key, media, index });
		this.evict();
		this.notify();
		return key;
	}

	private touch(key: string): void {
		const i = this.lru.indexOf(key);
		if (i >= 0) { this.lru.splice(i, 1); }
		this.lru.unshift(key);
	}

	private evict(): void {
		if (this.persistent) { return; }
		while (this.lru.length > this.maxPreviewRefs) {
			const old = this.lru.pop();
			if (old !== undefined) {
				this.refs.delete(old);
				void this.backend.remove(old);
				void this.backend.removeMeta?.(old);
			}
		}
	}
}


