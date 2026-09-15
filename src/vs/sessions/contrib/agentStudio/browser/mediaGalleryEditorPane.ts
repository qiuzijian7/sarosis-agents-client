/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  MediaGalleryEditorPane — 完整的媒体库画廊（中间栏编辑器面板）。
 *
 *  与工作流画布里的 webview/React 版 MediaGallery.tsx 是**同一份数据、同一套语义**：
 *  查询组装、收藏/软删/恢复、缩略图解析都收在 `mediaGalleryModel.ts`（与渲染框架无关），
 *  本文件只负责把快照渲染成原生 DOM。
 *
 *  与 webview 版的差异（有意为之）：
 *   - 不做「拖拽资产到画布」（那需要画布上下文，编辑器面板里没有落点）；
 *   - 不提供分组名内联编辑（分组仍可在工作流画布里维护）；
 *   - 破坏性清理（purge / cleanOrphaned / enforceQuota）留在画布侧，这里只做浏览与常规操作。
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { MediaGalleryEditorInput } from './mediaGalleryEditorInput.js';
import { createMediaStoreProxy } from './mediaStoreProxy.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { MediaGalleryModel, MEDIA_GALLERY_DEFAULT_LIMIT, kindFromMime, defaultExtForKind, parseTagInput, type IMediaGalleryQuery, type IMediaGallerySnapshot } from './mediaGalleryModel.js';
import type { MediaAsset } from '../common/mediaStoreChannel.js';

const THUMB = 132;

const CSS_TEXT = `
.mg-container { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; color: var(--vscode-foreground); }
/* 滚动条统一由 sessions 全局样式提供（sessions/browser/media/style.css），此处不再单独定义。 */
.mg-header { display: flex; align-items: center; gap: 12px; padding: 14px 20px 10px; flex-shrink: 0; }
.mg-title { font-size: 16px; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 8px; }
.mg-sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mg-header-spacer { flex: 1; }
.mg-btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.15)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); cursor: pointer; font-size: 12px; }
.mg-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.25)); }
.mg-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.mg-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
.mg-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 0 20px 10px; flex-shrink: 0; }
.mg-input, .mg-select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 4px 8px; font-size: 12px; outline: none; }
.mg-input:focus, .mg-select:focus { border-color: var(--vscode-focusBorder); }
.mg-input { flex: 1; min-width: 160px; }
.mg-select { cursor: pointer; }
.mg-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--vscode-foreground); cursor: pointer; user-select: none; }
.mg-status { padding: 0 20px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
.mg-grid { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(${THUMB}px, 1fr)); gap: 12px; padding: 4px 20px 28px; align-content: start; }
.mg-card { position: relative; display: flex; flex-direction: column; gap: 6px; cursor: pointer; }
.mg-thumb { position: relative; width: 100%; aspect-ratio: 1 / 1; border-radius: 6px; overflow: hidden; background: var(--vscode-editorWidget-background, rgba(128,128,128,.12)); display: flex; align-items: center; justify-content: center; border: 1px solid var(--vscode-widget-border, transparent); }
.mg-card:hover .mg-thumb { border-color: var(--vscode-focusBorder); }
.mg-thumb img, .mg-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.mg-thumb .mg-icon { font-size: 34px; color: var(--vscode-descriptionForeground); }
.mg-actions { position: absolute; top: 6px; right: 6px; display: none; gap: 4px; }
.mg-card:hover .mg-actions { display: flex; }
.mg-act { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer; font-size: 13px; background: rgba(0,0,0,.55); color: #fff; }
.mg-act:hover { background: rgba(0,0,0,.8); }
.mg-act.on { color: #e8c34a; }
.mg-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mg-meta { font-size: 10px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mg-badge { position: absolute; left: 6px; top: 6px; font-size: 9px; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.mg-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.mg-tag { font-size: 10px; padding: 1px 6px; border-radius: 8px; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--vscode-badge-background, rgba(128,128,128,.2)); color: var(--vscode-badge-foreground, var(--vscode-foreground)); }
.mg-tag:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.mg-empty { grid-column: 1 / -1; padding: 40px 0; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
`;

export class MediaGalleryEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.mediaGallery';

	private _container: HTMLElement | null = null;
	private _gridEl: HTMLElement | null = null;
	private _statusEl: HTMLElement | null = null;
	private _boardSelect: HTMLSelectElement | null = null;
	private _tagSelect: HTMLSelectElement | null = null;
	private _searchInput: HTMLInputElement | null = null;
	private _fileInput: HTMLInputElement | null = null;

	private _model: MediaGalleryModel | null = null;
	private _query: IMediaGalleryQuery = { limit: MEDIA_GALLERY_DEFAULT_LIMIT };
	/** 防竞态：每次 load 自增，回填前校验是否最新。 */
	private _loadToken = 0;
	/** 资产 id → 可渲染 URL（懒解析并缓存）。 */
	private readonly _urlCache = new Map<string, string | null>();
	private _searchTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IOpenerService private readonly openerService: IOpenerService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@ILogService private readonly logService: ILogService,
	) {
		super(MediaGalleryEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		const container = append(parent, $('.mg-container'));
		this._container = container;

		const style = document.createElement('style');
		style.textContent = CSS_TEXT;
		container.appendChild(style);

		this._model = new MediaGalleryModel(createMediaStoreProxy(this.mainProcessService));
		this._render();
	}

	override async setInput(input: MediaGalleryEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!this._container) { return; }
		await this._load();
	}

	override focus(): void {
		super.focus();
		this._searchInput?.focus();
	}

	override layout(dimension: { width: number; height: number }): void {
		// 网格由 CSS grid(auto-fill) 自适应，无需按尺寸重算布局。
		void dimension;
	}

	override dispose(): void {
		if (this._searchTimer !== undefined) { clearTimeout(this._searchTimer); }
		super.dispose();
	}

	// ═══════════════════════════════════════════════════════════
	//  骨架
	// ═══════════════════════════════════════════════════════════

	private _render(): void {
		const container = this._container;
		if (!container || !this._model) { return; }
		clearNode(container);
		const style = document.createElement('style');
		style.textContent = CSS_TEXT;
		container.appendChild(style);

		// ── header ──
		const header = append(container, $('.mg-header'));
		const titleWrap = append(header, $('div'));
		const h1 = append(titleWrap, $('h1.mg-title'));
		append(h1, $('span.codicon.codicon-file-media'));
		append(h1, $('span')).textContent = '媒体库';
		const sub = append(titleWrap, $('.mg-sub'));
		sub.textContent = '工作流产出与上传的图片 / 视频 / 音频 / 文本资产';

		append(header, $('.mg-header-spacer'));
		const importBtn = append(header, $('.mg-btn.primary'));
		append(importBtn, $('span.codicon.codicon-cloud-upload'));
		append(importBtn, $('span')).textContent = '导入';
		importBtn.onclick = () => this._fileInput?.click();
		const localizeAllBtn = append(header, $('.mg-btn'));
		append(localizeAllBtn, $('span.codicon.codicon-cloud-download'));
		append(localizeAllBtn, $('span')).textContent = '本地化全部';
		localizeAllBtn.title = '把所有「仅 URL 引用」的资产下载并落盘（此后不再依赖远端服务与 CSP）';
		localizeAllBtn.onclick = () => void this._localizeAll();
		const refreshBtn = append(header, $('.mg-btn'));
		append(refreshBtn, $('span.codicon.codicon-refresh'));
		append(refreshBtn, $('span')).textContent = '刷新';
		refreshBtn.onclick = () => void this._load();

		// 隐藏的 file input（多选导入）
		const fileInput = document.createElement('input');
		fileInput.type = 'file';
		fileInput.multiple = true;
		fileInput.accept = 'image/*,video/*,audio/*,text/*';
		fileInput.style.display = 'none';
		fileInput.onchange = () => { void this._importPicked(fileInput.files); fileInput.value = ''; };
		container.appendChild(fileInput);
		this._fileInput = fileInput;

		// ── toolbar ──
		const toolbar = append(container, $('.mg-toolbar'));
		const search = document.createElement('input');
		search.className = 'mg-input';
		search.placeholder = '搜索文件名 / 引用…';
		search.oninput = () => {
			if (this._searchTimer !== undefined) { clearTimeout(this._searchTimer); }
			this._searchTimer = setTimeout(() => {
				this._query.query = search.value.trim() || undefined;
				void this._load();
			}, 250);
		};
		toolbar.appendChild(search);
		this._searchInput = search;

		const kindSelect = document.createElement('select');
		kindSelect.className = 'mg-select';
		for (const [v, label] of [['', '全部类型'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['text', '文本']] as Array<[string, string]>) {
			const opt = document.createElement('option');
			opt.value = v; opt.textContent = label;
			kindSelect.appendChild(opt);
		}
		kindSelect.onchange = () => { this._query.kind = kindSelect.value || undefined; void this._load(); };
		toolbar.appendChild(kindSelect);

		const boardSelect = document.createElement('select');
		boardSelect.className = 'mg-select';
		boardSelect.onchange = () => { this._query.board = boardSelect.value || undefined; void this._load(); };
		toolbar.appendChild(boardSelect);
		this._boardSelect = boardSelect;

		const tagSelect = document.createElement('select');
		tagSelect.className = 'mg-select';
		tagSelect.title = '按标签筛选';
		tagSelect.onchange = () => { this._query.tag = tagSelect.value || undefined; void this._load(); };
		toolbar.appendChild(tagSelect);
		this._tagSelect = tagSelect;

		const favLabel = append(toolbar, $('label.mg-check'));
		const favCheck = document.createElement('input');
		favCheck.type = 'checkbox';
		favCheck.onchange = () => { this._query.favorite = favCheck.checked || undefined; void this._load(); };
		favLabel.appendChild(favCheck);
		append(favLabel, $('span')).textContent = '仅收藏';

		const delLabel = append(toolbar, $('label.mg-check'));
		const delCheck = document.createElement('input');
		delCheck.type = 'checkbox';
		delCheck.onchange = () => { this._query.includeDeleted = delCheck.checked || undefined; void this._load(); };
		delLabel.appendChild(delCheck);
		append(delLabel, $('span')).textContent = '回收站';

		// ── status + grid ──
		this._statusEl = append(container, $('.mg-status'));
		this._gridEl = append(container, $('.mg-grid'));

		// 根目录展示
		void this._model.getRootDir().then(dir => {
			sub.textContent = dir ? `根目录：${dir}` : '工作流产出与上传的媒体资产';
		}).catch(() => { /* 忽略 */ });
	}

	// ═══════════════════════════════════════════════════════════
	//  数据
	// ═══════════════════════════════════════════════════════════

	private async _load(): Promise<void> {
		const model = this._model;
		const grid = this._gridEl;
		if (!model || !grid) { return; }
		const token = ++this._loadToken;
		try {
			const snap = await model.load(this._query);
			if (token !== this._loadToken || this._gridEl !== grid) { return; }
			this._renderSnapshot(snap);
		} catch (err) {
			this.logService.warn('[MediaGallery] load failed', err);
			if (token === this._loadToken && this._gridEl === grid) {
				clearNode(grid);
				append(grid, $('.mg-empty')).textContent = '读取媒体库失败（媒体存储未就绪？）';
			}
		}
	}

	private _renderSnapshot(snap: IMediaGallerySnapshot): void {
		const grid = this._gridEl;
		if (!grid) { return; }

		if (this._statusEl) {
			const size = formatBytes(snap.stats.dirSizeBytes);
			// 待本地化数量：CSP 已不放行 http: ⇒ 未落盘的 URL 引用资产需要用户点一次本地化才能显示
			const pending = snap.items.filter(a => MediaGalleryModel.canLocalize(a)).length;
			const pendingText = pending > 0 ? ` · 待本地化 ${pending}` : '';
			this._statusEl.textContent = `${snap.total} 项 · 目录占用 ${size} · 回收站 ${snap.stats.deletedCount}${pendingText}`;
		}

		// 分组下拉：保留当前选中项，重建候选
		const boardSelect = this._boardSelect;
		if (boardSelect) {
			const current = this._query.board ?? '';
			clearNode(boardSelect);
			const all = document.createElement('option');
			all.value = ''; all.textContent = '全部分组';
			boardSelect.appendChild(all);
			for (const b of snap.boards) {
				const opt = document.createElement('option');
				opt.value = b; opt.textContent = b;
				boardSelect.appendChild(opt);
			}
			boardSelect.value = snap.boards.includes(current) ? current : '';
		}

		// 标签下拉：候选来自**全库**（snap.tags），不受当前筛选影响
		const tagSelect = this._tagSelect;
		if (tagSelect) {
			const current = this._query.tag ?? '';
			clearNode(tagSelect);
			const all = document.createElement('option');
			all.value = ''; all.textContent = '全部标签';
			tagSelect.appendChild(all);
			for (const t of snap.tags) {
				const opt = document.createElement('option');
				opt.value = t; opt.textContent = t;
				tagSelect.appendChild(opt);
			}
			tagSelect.value = snap.tags.includes(current) ? current : '';
		}

		clearNode(grid);
		if (snap.items.length === 0) {
			append(grid, $('.mg-empty')).textContent = this._query.includeDeleted
				? '回收站为空'
				: '暂无媒体资产（工作流产出图片或点击「导入」后会出现在这里）';
			return;
		}
		for (const asset of snap.items) {
			grid.appendChild(this._cardEl(asset));
		}
	}

	// ═══════════════════════════════════════════════════════════
	//  卡片
	// ═══════════════════════════════════════════════════════════

	private _cardEl(asset: MediaAsset): HTMLElement {
		const card = $('.mg-card');
		card.title = asset.fileName ?? asset.ref;

		const thumb = append(card, $('.mg-thumb'));
		this._fillThumb(thumb, asset);

		if (asset.favorite) {
			const badge = append(thumb, $('.mg-badge'));
			badge.textContent = '★';
		}

		// 悬停操作：收藏 / 移入回收站 / 恢复
		const actions = append(card, $('.mg-actions'));
		const fav = append(actions, $('.mg-act.codicon.codicon-star-full'));
		if (asset.favorite) { fav.classList.add('on'); }
		fav.title = asset.favorite ? '取消收藏' : '收藏';
		fav.onclick = (e) => { e.stopPropagation(); void this._toggleFavorite(asset, fav); };

		const tagBtn = append(actions, $('.mg-act.codicon.codicon-tag'));
		tagBtn.title = '编辑标签';
		tagBtn.onclick = (e) => { e.stopPropagation(); void this._editTags(asset); };

		// 仅「URL 引用且未落盘」的资产需要本地化
		if (MediaGalleryModel.canLocalize(asset)) {
			const dl = append(actions, $('.mg-act.codicon.codicon-cloud-download'));
			dl.title = '本地化（下载并落盘）';
			dl.onclick = (e) => { e.stopPropagation(); void this._localizeOne(asset); };
		}

		if (asset.isDeleted) {
			const restore = append(actions, $('.mg-act.codicon.codicon-history'));
			restore.title = '从回收站恢复';
			restore.onclick = (e) => { e.stopPropagation(); void this._restore(asset); };
		} else {
			const del = append(actions, $('.mg-act.codicon.codicon-trash'));
			del.title = '移入回收站';
			del.onclick = (e) => { e.stopPropagation(); void this._remove(asset); };
		}

		const name = append(card, $('.mg-name'));
		name.textContent = assetFileName(asset);
		const meta = append(card, $('.mg-meta'));
		const size = asset.sizeBytes ? formatBytes(asset.sizeBytes) : '';
		const when = asset.createdAt ? new Date(asset.createdAt).toLocaleDateString() : '';
		meta.textContent = [asset.kind, size, when].filter(Boolean).join(' · ');

		// 标签 chips：点击即按该标签筛选（最常用的入口，不必绕到工具条下拉）
		if (asset.tags && asset.tags.length > 0) {
			const tagRow = append(card, $('.mg-tags'));
			for (const t of asset.tags) {
				const chip = append(tagRow, $('span.mg-tag'));
				chip.textContent = t;
				chip.title = `按标签筛选：${t}`;
				chip.onclick = (e) => {
					e.stopPropagation();
					this._query.tag = t;
					if (this._tagSelect) { this._tagSelect.value = t; }
					void this._load();
				};
			}
		}

		card.onclick = () => void this._openAsset(asset);
		return card;
	}

	/** 缩略图：图片/视频懒解析可渲染 URL；音频/文本用图标占位。 */
	private _fillThumb(host: HTMLElement, asset: MediaAsset): void {
		const model = this._model;
		if (!model) { return; }

		if (asset.kind !== 'image' && asset.kind !== 'video') {
			append(host, $('span.mg-icon.codicon.' + kindIcon(asset.kind)));
			return;
		}
		const cached = this._urlCache.get(asset.id);
		if (cached !== undefined) {
			this._mountThumb(host, asset, cached);
			return;
		}
		void model.resolveUrl(asset).then(url => {
			this._urlCache.set(asset.id, url);
			if (host.isConnected) { this._mountThumb(host, asset, url); }
		}).catch(() => { /* 缩略图失败不阻断 */ });
	}

	private _mountThumb(host: HTMLElement, asset: MediaAsset, url: string | null): void {
		if (!url) {
			append(host, $('span.mg-icon.codicon.' + kindIcon(asset.kind)));
			return;
		}
		if (asset.kind === 'video') {
			// <img> 不会解码视频首帧 ⇒ 用 <video preload="metadata"> 让浏览器解出封面帧
			const video = document.createElement('video');
			video.src = url;
			video.muted = true;
			video.playsInline = true;
			video.preload = 'metadata';
			host.appendChild(video);
			return;
		}
		const img = document.createElement('img');
		img.src = url;
		img.alt = '';
		img.loading = 'lazy';
		host.appendChild(img);
	}

	// ═══════════════════════════════════════════════════════════
	//  操作
	// ═══════════════════════════════════════════════════════════

	private async _toggleFavorite(asset: MediaAsset, btn: HTMLElement): Promise<void> {
		try {
			const next = await this._model!.toggleFavorite(asset);
			btn.classList.toggle('on', next);
			btn.title = next ? '取消收藏' : '收藏';
		} catch (err) {
			this.notificationService.error(`收藏失败：${err}`);
		}
	}

	/** 编辑标签：逗号/空格分隔输入，清空即移除全部标签。 */
	private async _editTags(asset: MediaAsset): Promise<void> {
		let result;
		try {
			result = await this.dialogService.input({
				message: '标签（用逗号分隔，留空则清空）',
				detail: assetFileName(asset),
				inputs: [{
					value: (asset.tags ?? []).join(', '),
					placeholder: '例如：角色, 场景, 待筛选',
				}],
			});
		} catch (err) {
			this.logService.warn('[MediaGallery] tag dialog failed', err);
			return;
		}
		if (!result.confirmed) { return; }
		try {
			await this._model!.setTags(asset, parseTagInput(result.values?.[0] ?? ''));
			await this._load();
		} catch (err) {
			this.notificationService.error(`保存标签失败：${err}`);
		}
	}

	/** 本地化单个资产（下载并落盘），完成后刷新列表。 */
	private async _localizeOne(asset: MediaAsset): Promise<void> {
		try {
			await this._model!.localize(asset);
			await this._load();
		} catch (err) {
			this.notificationService.error(`本地化失败：${err}`);
		}
	}

	/**
	 * 批量本地化。
	 * ★ 目标取自**全库**（默认查询）而非当前筛选结果 —— 本地化的目的是让资产彻底不依赖远端，
	 *   若只看当前筛选，用户切来切去会漏掉一批。
	 */
	private async _localizeAll(): Promise<void> {
		const model = this._model;
		if (!model) { return; }
		let items: MediaAsset[];
		try {
			items = (await model.load({ limit: MEDIA_GALLERY_DEFAULT_LIMIT })).items;
		} catch (err) {
			this.notificationService.error(`读取资产列表失败：${err}`);
			return;
		}
		const pending = items.filter(a => MediaGalleryModel.canLocalize(a));
		if (pending.length === 0) {
			this.notificationService.info('没有需要本地化的资产（都已落盘）');
			return;
		}
		const r = await model.localizeAll(pending);
		if (r.failed.length > 0) {
			this.notificationService.warn(`本地化完成：成功 ${r.ok} / 失败 ${r.failed.length}（首个失败：${r.failed[0].error}）`);
		} else {
			this.notificationService.info(`已本地化 ${r.ok} 个资产`);
		}
		await this._load();
	}

	private async _remove(asset: MediaAsset): Promise<void> {
		try {
			await this._model!.remove(asset);
			await this._load();
		} catch (err) {
			this.notificationService.error(`移入回收站失败：${err}`);
		}
	}

	private async _restore(asset: MediaAsset): Promise<void> {
		try {
			await this._model!.restore(asset);
			await this._load();
		} catch (err) {
			this.notificationService.error(`恢复失败：${err}`);
		}
	}

	/** 打开资产：优先本地落盘文件（系统默认程序），否则打开原始引用地址。 */
	private async _openAsset(asset: MediaAsset): Promise<void> {
		try {
			const path = await this._model!.resolvePath(asset);
			if (path) {
				await this.openerService.open(URI.file(path), { openExternal: true });
				return;
			}
			if (asset.ref) {
				await this.openerService.open(URI.parse(asset.ref), { openExternal: true });
			}
		} catch (err) {
			this.logService.warn('[MediaGallery] open asset failed', err);
		}
	}

	/** 导入本地文件（多选）：读成 base64 落盘，逐条上报结果。 */
	private async _importPicked(files: FileList | null): Promise<void> {
		const model = this._model;
		if (!model || !files || files.length === 0) { return; }
		let ok = 0;
		const failed: string[] = [];
		for (const file of Array.from(files)) {
			try {
				const base64 = await readFileAsBase64(file);
				const kind = kindFromMime(file.type || '');
				const ext = (file.name.split('.').pop() || defaultExtForKind(kind)).toLowerCase().replace(/[^a-z0-9]/g, '');
				await model.importBase64({ base64, kind, ext: ext || defaultExtForKind(kind), mime: file.type || undefined });
				ok++;
			} catch (err) {
				failed.push(file.name);
				this.logService.warn(`[MediaGallery] import failed: ${file.name}`, err);
			}
		}
		if (failed.length) {
			this.notificationService.warn(`已导入 ${ok} 个，失败 ${failed.length} 个：${failed.slice(0, 3).join('、')}`);
		} else {
			this.notificationService.info(`已导入 ${ok} 个媒体资产`);
		}
		await this._load();
	}
}

/** 媒体 kind → codicon 类名。 */
function kindIcon(kind: string): string {
	switch (kind) {
		case 'image': return 'codicon-file-media';
		case 'video': return 'codicon-device-camera-video';
		case 'audio': return 'codicon-unmute';
		default: return 'codicon-file-text';
	}
}

/** 资产展示名：fileName → ComfyUI filename= 参数 → URL 尾部文件名 → id + 兜底扩展名。 */
function assetFileName(a: MediaAsset): string {
	if (a.fileName) { return a.fileName; }
	const q = /[?&]filename=([^&#]+)/.exec(a.ref);
	if (q) { return decodeURIComponent(q[1]); }
	const m = /[^/?#]+\.[A-Za-z0-9]{2,5}(?:[?#]|$)/.exec(a.ref);
	if (m) { return m[0].replace(/[?#].*$/, ''); }
	return `${a.id}.${defaultExtForKind(a.kind)}`;
}

/** 人类可读字节数（B/KB/MB/GB）。 */
function formatBytes(n: number | undefined): string {
	if (!n) { return '0 B'; }
	const units = ['B', 'KB', 'MB', 'GB'];
	let v = n, i = 0;
	while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
	return `${v.toFixed(v >= 100 ? 0 : 1).replace(/\.0$/, '')} ${units[i]}`;
}

/** FileReader → base64（去掉 data URL 前缀，只留载荷）。 */
function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const s = String(reader.result ?? '');
			const comma = s.indexOf(',');
			resolve(comma >= 0 ? s.slice(comma + 1) : s);
		};
		reader.onerror = () => reject(reader.error ?? new Error('read failed'));
		reader.readAsDataURL(file);
	});
}
