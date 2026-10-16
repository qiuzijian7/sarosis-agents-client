/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 媒体库（独立工作台，2026-10-12 从「资料库」页的 media tab 提升而来）。
 *
 * 渲染逻辑**逐字搬自** `knowledgeBaseView.ts` 的 `_renderMediaPanel` / `_refreshMediaStats` /
 * `_renderMediaList` / `_mediaItemEl` / `_fillMediaThumb` / `_openMediaAsset` / `_getMediaBackend`
 * （只收掉「tab 面板 + 中间容器」那层，见 `renderBody`）。
 *
 * 数据源 = 主进程 `MediaStore`（`{rootDir}/media.db` + `{rootDir}/{yyyy}/{mm}/{id}.{ext}`），
 * 经 `createMediaStoreProxy` 的 ProxyChannel 代理读。与容器 `agentStudio.media` 对应；dsh 引擎下
 * 由 `@vssaros/dsh-media` 自托管 `/x/media/`（那一侧**直连同一个 media.db**，见该插件的说明）。
 */

import './media/kbView.css';

import { $ } from '../../../../../base/browser/dom.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import type { IMediaBackend, MediaAsset, MediaListResult } from '../../common/mediaStoreChannel.js';
import { createMediaStoreProxy } from '../mediaStoreProxy.js';
import { MediaGalleryEditorInput } from '../mediaGalleryEditorInput.js';
import { headerBtn, statCell, statsHint } from './libraryStatHelpers.js';
import { formatSizeCompact } from './knowledgeBase/kbViewUtils.js';

/** 「最近资产」列表展示的条数。 */
const MEDIA_RECENT_LIMIT = 30;

/** 媒体资产 kind → codicon 类名（非图片类资产的占位图标）。 */
function mediaKindIcon(kind: string): string {
	switch (kind) {
		case 'image': return 'codicon-file-media';
		case 'video': return 'codicon-device-camera-video';
		case 'audio': return 'codicon-unmute';
		default: return 'codicon-file-text';
	}
}

export class MediaLibraryViewPane extends ViewPane {

	/** 统计区容器（异步填充）。 */
	private _statsEl?: HTMLElement;
	/** 「最近资产」列表容器。 */
	private _listEl?: HTMLElement;
	/** 「最近资产」条数徽标。 */
	private _listCountEl?: HTMLElement;
	/** 媒体资产库后端（懒初始化，经主进程 ProxyChannel）。 */
	private _backend?: IMediaBackend;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IEditorService private readonly _editorService: IEditorService,
		@IMainProcessService private readonly _mainProcessService: IMainProcessService,
		@IOpenerService private readonly _assetOpener: IOpenerService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('kb-view');

		const header = $('div.kb-header');
		const title = $('span.kb-title');
		const text = $('span');
		text.textContent = '媒体库';
		title.replaceChildren($('span.codicon.codicon-file-media'), text);
		header.appendChild(title);
		header.appendChild($('span.kb-spacer'));
		header.appendChild(headerBtn('codicon-refresh', '刷新媒体库', (e) => { e.stopPropagation(); void this._refreshStats(); }));
		container.appendChild(header);

		const panel = $('div.kb-panel.kb-panel-media.active');
		const bar = $('div.kb-panel-bar');
		const barLabel = $('span.kb-panel-bar-label');
		barLabel.textContent = '媒体库';
		bar.replaceChildren(barLabel);
		panel.appendChild(bar);

		const content = $('div.kb-panel-content');
		panel.appendChild(content);
		container.appendChild(panel);

		this._renderPanel(content);
	}

	// ─── 渲染（搬自 knowledgeBaseView 的 _renderMediaPanel 等）────────────────

	private _renderPanel(host: HTMLElement): void {
		host.replaceChildren();

		// 入口置顶：打开完整媒体库画廊（中间栏 EditorPane，与工作流画布同一份数据）
		const entry = $('div.kb-entry');
		entry.onclick = () => this._openGalleryEditor();
		const entryIcon = $('span.kb-entry-icon.codicon.codicon-file-media');
		const entryText = $('div.kb-entry-text');
		const entryTitle = $('div.kb-entry-title');
		entryTitle.textContent = '查看完整媒体库';
		const entryMeta = $('div.kb-entry-meta');
		entryMeta.textContent = '打开 MediaGalleryEditorPane';
		entryText.replaceChildren(entryTitle, entryMeta);
		const entryArrow = $('span.kb-entry-arrow.codicon.codicon-arrow-right');
		entry.replaceChildren(entryIcon, entryText, entryArrow);
		host.appendChild(entry);

		// 统计骨架（异步回填）
		const stats = $('div.kb-stats');
		this._statsEl = stats;
		stats.appendChild(statsHint('正在读取媒体库…'));
		host.appendChild(stats);

		// 最近资产列表
		const listSection = $('div.kb-side-section');
		const listHead = $('div.kb-side-section-head');
		const listLabel = $('span');
		listLabel.textContent = '最近资产';
		this._listCountEl = $('span.kb-count');
		this._listCountEl.textContent = '—';
		listHead.replaceChildren(listLabel, $('span.kb-spacer'), this._listCountEl);
		listSection.appendChild(listHead);
		this._listEl = $('div.kb-media-list');
		listSection.appendChild(this._listEl);
		host.appendChild(listSection);

		void this._refreshStats();
	}

	/** 读取媒体库统计 + 最近资产（工作流产出的图片/视频/音频/文本）。 */
	private async _refreshStats(): Promise<void> {
		const statsEl = this._statsEl;
		if (!statsEl) { return; }
		try {
			const backend = this._getBackend();
			const kinds = ['image', 'video', 'audio', 'text'] as const;
			const [stats, recent, kindTotals] = await Promise.all([
				backend.stats(),
				backend.list({ limit: MEDIA_RECENT_LIMIT }),
				// 分类计数：用 limit:1 只取 total，避免把全量资产拉过 IPC
				Promise.all(kinds.map(async k => {
					try { return (await backend.list({ kind: k, limit: 1 })).total; } catch { return 0; }
				})),
			]);
			if (this._statsEl !== statsEl) { return; }

			const hero = $('div.kb-stat-hero');
			const heroNum = $('span.kb-stat-hero-num');
			heroNum.textContent = String(stats.assetCount);
			const heroLabel = $('span.kb-stat-hero-label');
			heroLabel.textContent = `个资产 · ${formatSizeCompact(stats.totalBytes)}`;
			hero.replaceChildren(heroNum, heroLabel);

			const grid = $('div.kb-stat-grid');
			kinds.forEach((k, i) => grid.appendChild(statCell(k, kindTotals[i])));
			grid.appendChild(statCell('回收站', stats.deletedCount));

			const meta = $('div.kb-stat-meta');
			meta.textContent = `媒体目录占用：${formatSizeCompact(stats.dirSizeBytes)}`;

			statsEl.replaceChildren(hero, grid, meta);
			this._renderList(recent);
		} catch (err) {
			this._logService.warn('[MediaLibrary] media stats failed', err);
			if (this._statsEl === statsEl) {
				statsEl.replaceChildren(statsHint('读取媒体库失败（媒体存储未就绪？）'));
			}
		}
	}

	/** 渲染「最近资产」列表。 */
	private _renderList(result: MediaListResult): void {
		const host = this._listEl;
		if (!host) { return; }
		host.replaceChildren();
		if (this._listCountEl) { this._listCountEl.textContent = String(result.total); }
		if (result.items.length === 0) {
			host.appendChild(statsHint('暂无媒体资产（工作流产出图片后会出现在这里）'));
			return;
		}
		for (const asset of result.items) {
			host.appendChild(this._itemEl(asset));
		}
	}

	/** 单条媒体资产（缩略图 + 名称 + 元信息；点击打开）。 */
	private _itemEl(asset: MediaAsset): HTMLElement {
		const row = $('div.kb-media-item');
		const label = asset.fileName ?? asset.ref;
		row.title = label;

		const thumb = $('div.kb-media-thumb');
		if (asset.kind === 'image') {
			if (asset.ref.startsWith('data:') || /^https:/i.test(asset.ref)) {
				// data: / https: 可直接用（CSP 已放行）；http: 不放行 ⇒ 必须先本地化
				const img = document.createElement('img');
				img.src = asset.ref;
				img.alt = '';
				img.loading = 'lazy';
				thumb.appendChild(img);
			} else {
				// 渲染进程读不到本地文件 ⇒ 走主进程 getAsDataUrl（懒加载，失败不影响列表）
				void this._fillThumb(thumb, asset.id);
			}
		} else {
			thumb.appendChild($('span.codicon.' + mediaKindIcon(asset.kind)));
		}

		const text = $('div.kb-media-text');
		const name = $('div.kb-media-name');
		name.textContent = label;
		const meta = $('div.kb-media-meta');
		const size = asset.sizeBytes ? ` · ${formatSizeCompact(asset.sizeBytes)}` : '';
		const when = asset.createdAt ? ` · ${new Date(asset.createdAt).toLocaleString()}` : '';
		const tags = asset.tags?.length ? ` · ${asset.tags.map(t => `#${t}`).join(' ')}` : '';
		meta.textContent = `${asset.kind}${size}${when}${tags}`;
		text.replaceChildren(name, meta);

		const open = $('span.kb-media-open.codicon.codicon-link-external');
		open.title = '打开';
		open.onclick = (e) => { e.stopPropagation(); void this._openAsset(asset); };

		row.replaceChildren(thumb, text, open);
		row.onclick = () => void this._openAsset(asset);
		return row;
	}

	/** 异步填充缩略图（data URL；未落盘资产退化为图标占位）。 */
	private async _fillThumb(host: HTMLElement, id: string): Promise<void> {
		try {
			const url = await this._getBackend().getAsDataUrl(id);
			if (!host.isConnected) { return; }
			if (!url) {
				// 纯 URL 引用（未落盘）拿不到 data URL ⇒ 用图标占位，避免留白
				host.replaceChildren($('span.codicon.codicon-file-media'));
				return;
			}
			const img = document.createElement('img');
			img.src = url;
			img.alt = '';
			host.replaceChildren(img);
		} catch { /* 缩略图失败不阻断列表 */ }
	}

	/** 打开媒体资产：优先本地落盘文件，否则退回原始引用地址。 */
	private async _openAsset(asset: MediaAsset): Promise<void> {
		try {
			const path = await this._getBackend().getFilePath(asset.id);
			if (path) {
				await this._assetOpener.open(URI.file(path), { openExternal: true });
				return;
			}
			if (asset.ref) {
				await this._assetOpener.open(URI.parse(asset.ref), { openExternal: true });
			}
		} catch (err) {
			this._logService.warn('[MediaLibrary] open media asset failed', err);
		}
	}

	/** 懒初始化媒体资产库后端（经主进程 ProxyChannel）。 */
	private _getBackend(): IMediaBackend {
		if (!this._backend) {
			this._backend = createMediaStoreProxy(this._mainProcessService);
		}
		return this._backend;
	}

	/** 打开完整的媒体库画廊面板（MediaGalleryEditorPane）。 */
	private _openGalleryEditor(): void {
		try {
			const input = MediaGalleryEditorInput.getOrCreate();
			void this._editorService.openEditor(input, { pinned: true });
		} catch (err) {
			this._logService.error(`[MediaLibrary] failed to open MediaGalleryEditorPane: ${err}`);
		}
	}
}
