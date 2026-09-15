/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  mediaGalleryModel.ts — 媒体库画廊的**数据层**（与渲染框架无关）。
 *
 *  背景：媒体库有两套 UI —— 工作流画布里的 webview/React 版（MediaGallery.tsx）与
 *  本仓原生的 MediaGalleryEditorPane。两者渲染代码无法共享（React vs 原生 DOM），
 *  但**查询与操作的语义必须一致**，否则同一批资产在两个入口会表现不同。
 *  本文件把这套语义收成一份实现：筛选条件组装、破坏性操作的返回值归一化、
 *  data URL / 本地路径解析、导入。
 *
 *  ★ 契约真源仍是 `common/mediaStoreChannel.ts`（IMediaBackend）；本文件只做「组合 + 归一化」，
 *    不新增任何后端能力。
 *--------------------------------------------------------------------------------------------*/

import type {
	IMediaBackend, MediaAsset, MediaListFilter, MediaStats,
} from '../common/mediaStoreChannel.js';

/** 画廊筛选条件（与 webview MediaGallery 的 state 一一对应）。 */
export interface IMediaGalleryQuery {
	/** 模糊匹配文件名 / 引用 / 元数据。 */
	query?: string;
	/** 'image' | 'video' | 'audio' | 'text'；空 = 全部。 */
	kind?: string;
	/** 仅收藏。 */
	favorite?: boolean;
	/** 分组（board）。 */
	board?: string;
	/** 精确匹配某个标签。 */
	tag?: string;
	/** 回收站视图（含已软删）。 */
	includeDeleted?: boolean;
	/** 限定某个工作流的产出；空 = 全局媒体库。 */
	workflowId?: string;
	limit?: number;
	offset?: number;
}

/** 画廊默认分页大小（对齐 webview MediaGallery 的 limit: 200）。 */
export const MEDIA_GALLERY_DEFAULT_LIMIT = 200;

/** 一次查询的完整快照（列表 + 总数 + 统计 + 分组候选）。 */
export interface IMediaGallerySnapshot {
	readonly items: MediaAsset[];
	readonly total: number;
	readonly stats: MediaStats;
	/** 当前结果集中出现过的分组名（用于分组下拉；空串分组不计入）。 */
	readonly boards: string[];
	/** 媒体库里已使用过的**全部**标签（按使用频次降序，用于标签筛选下拉）。 */
	readonly tags: string[];
}

/**
 * 把 UI 筛选条件转成后端 filter。
 * 关键：**空值必须剔除** —— 传 `undefined` 过 IPC 会被序列化成 null，
 * 后端按「字段存在即过滤」判断时会把 `query: null` 当成空串查询。
 */
export function toMediaListFilter(q: IMediaGalleryQuery): MediaListFilter {
	const filter: MediaListFilter = {};
	if (q.query) { filter.query = q.query; }
	if (q.kind) { filter.kind = q.kind; }
	if (q.favorite) { filter.favorite = true; }
	if (q.board) { filter.board = q.board; }
	if (q.tag) { filter.tag = q.tag; }
	if (q.includeDeleted) { filter.includeDeleted = true; }
	if (q.workflowId) { filter.workflowId = q.workflowId; }
	filter.limit = q.limit ?? MEDIA_GALLERY_DEFAULT_LIMIT;
	if (q.offset) { filter.offset = q.offset; }
	return filter;
}

/** 媒体库数据层：把 IMediaBackend 的多次调用组合成 UI 需要的一次查询 / 一次操作。 */
export class MediaGalleryModel {

	constructor(private readonly backend: IMediaBackend) { }

	/** 一次拉齐列表 + 统计 + 标签候选（UI 首屏 / 刷新）。 */
	async load(q: IMediaGalleryQuery): Promise<IMediaGallerySnapshot> {
		const filter = toMediaListFilter(q);
		const [list, stats, tags] = await Promise.all([
			this.backend.list(filter),
			this.backend.stats(),
			// 标签候选必须来自**全库**而非当前结果集 —— 否则筛选后候选会塌缩
			this.backend.listTags().catch(() => [] as string[]),
		]);
		const boards = new Set<string>();
		for (const a of list.items) { if (a.board) { boards.add(a.board); } }
		return {
			items: list.items,
			total: list.total,
			stats,
			boards: Array.from(boards).sort(),
			tags,
		};
	}

	/** 覆写资产标签；返回归一化后的标签集合。 */
	async setTags(asset: MediaAsset, tags: readonly string[]): Promise<string[]> {
		const normalized = normalizeTags(tags);
		await this.backend.setTags(asset.id, normalized);
		return normalized;
	}

	// ─── 本地化（URL 引用 → 落盘）──────────────────────────────────────

	/**
	 * 该资产是否「可本地化」：仅 URL 引用（http/https）且尚未落盘。
	 * 落盘后 filePath 有值 ⇒ 不再需要本地化（幂等判据，UI 用它决定是否显示按钮）。
	 */
	static canLocalize(asset: MediaAsset): boolean {
		return !asset.filePath && /^https?:\/\//i.test(asset.ref);
	}

	/**
	 * 本地化单个资产（重试下载并落盘）；返回落盘后的最新记录。
	 * ⚠ 导入时**已经自动尝试过一次**本地化，这里补的是「当时下载失败、以纯引用残留」的资产。
	 */
	async localize(asset: MediaAsset): Promise<MediaAsset> {
		return this.backend.localize(asset.id);
	}

	/**
	 * 批量本地化。带并发上限（默认 4）—— 一次性并发几十个请求会把远端服务打挂，
	 * 也会让 IPC 与磁盘写入互相挤占。单个失败不影响其余，逐条收集错误。
	 */
	async localizeAll(
		assets: readonly MediaAsset[],
		concurrency = 4,
	): Promise<{ total: number; ok: number; failed: Array<{ id: string; error: string }> }> {
		const targets = assets.filter(a => MediaGalleryModel.canLocalize(a));
		const failed: Array<{ id: string; error: string }> = [];
		let ok = 0;
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < targets.length) {
				const asset = targets[cursor++];
				try {
					await this.backend.localize(asset.id);
					ok++;
				} catch (err) {
					failed.push({ id: asset.id, error: String((err as Error)?.message ?? err) });
				}
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targets.length)) }, () => worker()));
		return { total: targets.length, ok, failed };
	}

	/** 切换收藏；返回切换后的值。 */
	async toggleFavorite(asset: MediaAsset): Promise<boolean> {
		const next = !asset.favorite;
		await this.backend.setFavorite(asset.id, next);
		return next;
	}

	/** 移入回收站（软删）。 */
	async remove(asset: MediaAsset): Promise<void> {
		await this.backend.remove(asset.id);
	}

	/** 从回收站恢复。 */
	async restore(asset: MediaAsset): Promise<void> {
		await this.backend.restore(asset.id);
	}

	/** 设置分组（空串 = 清除分组）。 */
	async setBoard(asset: MediaAsset, board: string): Promise<void> {
		await this.backend.setBoard(asset.id, board.trim() || null);
	}

	/** 导入一份 base64 载荷（本地镜像落盘）。 */
	async importBase64(opts: {
		base64: string; kind: string; ext: string; mime?: string; workflowId?: string;
	}): Promise<MediaAsset> {
		return this.backend.importAsset({
			base64: opts.base64,
			kind: opts.kind,
			ext: opts.ext,
			mime: opts.mime,
			workflowId: opts.workflowId,
			provider: 'upload',
		});
	}

	/**
	 * 解析资产的**可渲染 URL**（供 `<img>` / `<video>` 直接用）。
	 *
	 * ★ 受 `sessions.html` 的 CSP 约束，返回值必须是 `data:` / `blob:` / `https:` 之一：
	 *   - `data:` / `https:` 引用直接透传（省一次 IPC）；
	 *   - **`http:` 不直用** —— CSP 已收紧（不放行 http:），直用会被拦并在控制台报违规；
	 *     这类资产必须先用 `localize()` / `localizeAll()` 落盘，之后走本地 data URL；
	 *   - 未落盘资产 `getAsDataUrl` 返回 null ⇒ 调用方退化为图标占位。
	 */
	async resolveUrl(asset: MediaAsset): Promise<string | null> {
		if (asset.ref.startsWith('data:')) { return asset.ref; }
		if (/^https:/i.test(asset.ref)) { return asset.ref; }
		return this.backend.getAsDataUrl(asset.id);
	}

	/** 解析资产的本地绝对路径（URL 引用 / 文件缺失 → null）。 */
	async resolvePath(asset: MediaAsset): Promise<string | null> {
		return this.backend.getFilePath(asset.id);
	}

	/** 媒体库根目录。 */
	async getRootDir(): Promise<string> {
		return this.backend.getRootDir();
	}

	/** 分类计数（只取 total，避免把全量资产拉过 IPC）。 */
	async countByKind(kind: string): Promise<number> {
		try { return (await this.backend.list({ kind, limit: 1 })).total; } catch { return 0; }
	}
}

/** 媒体资产 kind → 扩展名兜底（导入时无法从文件名推断时使用）。 */
export function defaultExtForKind(kind: string): string {
	switch (kind) {
		case 'image': return 'png';
		case 'video': return 'mp4';
		case 'audio': return 'mp3';
		default: return 'txt';
	}
}

/** 从 MIME 推断资产 kind。 */
export function kindFromMime(mime: string): string {
	if (mime.startsWith('video/')) { return 'video'; }
	if (mime.startsWith('audio/')) { return 'audio'; }
	if (mime.startsWith('text/')) { return 'text'; }
	return 'image';
}

/**
 * 标签归一化：去空白、去重、丢弃空串。
 * 与主进程侧 `serializeTags` 保持同一套规则 —— 两边不一致会让「输入什么就得什么」失效。
 */
export function normalizeTags(tags: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of tags) {
		const t = raw.trim();
		if (!t || seen.has(t)) { continue; }
		seen.add(t);
		out.push(t);
	}
	return out;
}

/** 把「逗号 / 中文逗号 / 分号 / 空白」分隔的输入解析成标签数组。 */
export function parseTagInput(text: string): string[] {
	return normalizeTags(text.split(/[,，;；\s]+/));
}
