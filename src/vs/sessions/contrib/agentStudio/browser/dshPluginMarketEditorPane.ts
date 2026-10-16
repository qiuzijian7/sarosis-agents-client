/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/dshPluginMarketEditorPane.css';

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { localize } from '../../../../nls.js';
import { $, Dimension, append, clearNode } from '../../../../base/browser/dom.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { DshPluginMarketEditorInput } from './dshPluginMarketEditorInput.js';
import { IDshInstallResult, getDshPluginCenterHost } from './dshPluginCenterHost.js';
import { IDshMarketEntry, dshMarketInstallSpec, fetchDshMarketCatalog } from './dshMarketCatalog.js';
import { IDshPluginRecommendation, dshPluginRecommendations } from '../common/dshPluginRecommendations.js';
import { dshInstallTransport } from '../common/dshPluginTransport.js';

/** 一次渲染多少张社区卡：全量 4500+ 条渲成 DOM 会卡（搜索只在**已读入内存**的目录里过滤，不再请求）。 */
const COMMUNITY_CARD_LIMIT = 60;

type MarketSource = 'all' | 'official' | 'community';

/**
 * **dsh 插件商城**页（编辑区，2026-10-14）。
 *
 * 与侧栏「插件中心」的分工：侧栏窄（380px）⇒ 放"策展推荐 + 手输 spec + 已装清单"；本页宽 ⇒ 放**浏览型**
 * 体验（搜索 4500+ 条社区目录、按来源筛、卡片带 ★/下载量）。**两侧共用同一套真源**：
 * 目录 `browser/dshMarketCatalog.ts`、推荐 `common/dshPluginRecommendations.ts`、
 * 安装通道 `common/dshPluginTransport.ts`、Host 能力 `IDshPluginCenterHost` —— 不在本页另写判据 ✓。
 */
export class DshPluginMarketEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.dshPluginMarket';

	private _container: HTMLElement | undefined;
	private _status: HTMLElement | undefined;
	private _searchInput: HTMLInputElement | undefined;
	private _chips: HTMLElement | undefined;
	private _message: HTMLElement | undefined;
	private _content: HTMLElement | undefined;

	// 数据
	private _entries: readonly IDshMarketEntry[] | undefined;
	private _entriesError: string | undefined;
	private _installed = new Set<string>();
	private _hostText = '';
	private _loading = false;
	private _initialized = false;
	private _skeletonBuilt = false;

	// 交互状态
	private _query = '';
	private _source: MarketSource = 'all';
	private _busySpec: string | undefined;
	/**
	 * 安装结果/进度一句话（**不写进状态行**：状态行要一直显示 Host 状态）。用字段而不是直接写 DOM，
	 * 是为了 `_render()` 重绘时不丢。
	 */
	private _activeMessage: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(DshPluginMarketEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = append(parent, $('div.dsh-market-editor'));
		this._status = append(this._container, $('div.dsh-market-status'));
		const bar = append(this._container, $('div.dsh-market-toolbar'));
		this._searchInput = append(bar, $('input.dsh-market-search')) as HTMLInputElement;
		this._searchInput.type = 'text';
		this._searchInput.placeholder = localize('dshMarketSearch', "搜索插件（名称 / 作者 / npm 名 / 描述）…");
		this._chips = append(bar, $('div.dsh-market-chips'));
		this._message = append(this._container, $('div.dsh-market-message'));
		this._content = append(this._container, $('div.dsh-market-content'));
		this._skeletonBuilt = true;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof DshPluginMarketEditorInput) || !this._skeletonBuilt) {
			return;
		}
		if (this._initialized) {
			return;
		}
		this._initialized = true;

		this._searchInput!.oninput = () => {
			this._query = this._searchInput!.value;
			this._render();
		};

		const host = getDshPluginCenterHost();
		if (host) {
			// Host 侧清单变化（装完 / 启停 / 重启）⇒ 重取"已安装"标记
			this._register(host.onDidChange(() => void this._load()));
		}
		await this._load();
	}

	override layout(dimension: Dimension): void {
		if (this._container && dimension) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	// ── 数据 ─────────────────────────────────────────────────────────────────────

	private async _load(): Promise<void> {
		if (this._loading) {
			return;
		}
		this._loading = true;
		const host = getDshPluginCenterHost();
		this._hostText = host
			? host.statusText()
			: localize('dshMarketNoHost', "插件中心未启用（Host 组件未加载）⇒ 只能浏览，不能安装");
		try {
			const [entries, bundles] = await Promise.all([
				this._entries
					? Promise.resolve(this._entries)
					: fetchDshMarketCatalog().catch((e: unknown) => {
						this._entriesError = e instanceof Error ? e.message : String(e);
						return undefined;
					}),
				host ? host.loadBundles().catch(() => undefined) : Promise.resolve(undefined),
			]);
			if (entries) {
				this._entries = entries;
				this._entriesError = undefined;
			}
			if (bundles) {
				this._installed = new Set(bundles.bundles.filter(b => b.installed).map(b => b.name));
				if (bundles.error) {
					this._hostText = `${this._hostText} · ${bundles.error}`;
				}
			}
		} finally {
			this._loading = false;
			this._render();
		}
	}

	// ── 渲染 ─────────────────────────────────────────────────────────────────────

	private _render(): void {
		if (!this._status || !this._chips || !this._content || !this._message) {
			return;
		}
		clearNode(this._status);
		append(this._status, $('span.dsh-market-title')).textContent = localize('dshMarketTitle', "dsh 插件商城");
		append(this._status, $('span.dsh-market-host')).textContent = this._hostText;
		const refresh = append(this._status, $('button.dsh-market-btn.dsh-market-refresh')) as HTMLButtonElement;
		refresh.textContent = localize('dshMarketRefresh', "刷新");
		refresh.title = localize('dshMarketRefreshHint', "重新读社区目录与 profile 的已装清单");
		refresh.onclick = () => {
			this._entries = undefined;
			this._entriesError = undefined;
			void this._load();
		};

		this._message.textContent = this._busySpec
			? localize('dshMarketBusy', "正在处理 {0} …", this._busySpec)
			: (this._activeMessage ?? '');
		this._message.classList.toggle('is-hidden', !this._busySpec && !this._activeMessage);

		// 来源 chips（分类 = 过滤器：本页不做"页签"）
		clearNode(this._chips);
		const reco = this._recommendations();
		const options: { key: MarketSource; label: string; count?: number }[] = [
			{ key: 'all', label: localize('dshMarketSourceAll', "全部") },
			{ key: 'official', label: localize('dshMarketSourceOfficial', "官方推荐"), count: reco.length },
			{ key: 'community', label: localize('dshMarketSourceCommunity', "社区目录"), count: this._entries?.length },
		];
		for (const opt of options) {
			const chip = append(this._chips, $('button.dsh-market-chip')) as HTMLButtonElement;
			chip.classList.toggle('is-on', this._source === opt.key);
			chip.textContent = opt.count === undefined ? opt.label : `${opt.label} ${opt.count}`;
			chip.onclick = () => {
				this._source = opt.key;
				this._render();
			};
		}

		clearNode(this._content);

		if (this._source === 'all' || this._source === 'official') {
			this._renderSection(localize('dshMarketRecoSection', "官方推荐（随 dsh 版本钉住的组合包）"), reco.map(item => this._recoCard(item)));
		}
		if (this._source === 'all' || this._source === 'community') {
			this._renderCommunity();
		}
	}

	private _renderSection(title: string, cards: readonly HTMLElement[]): void {
		if (!cards.length) {
			return;
		}
		const section = append(this._content!, $('div.dsh-market-section'));
		append(section, $('div.dsh-market-section-title')).textContent = title;
		const grid = append(section, $('div.dsh-market-grid'));
		for (const card of cards) {
			grid.appendChild(card);
		}
	}

	private _renderCommunity(): void {
		if (this._entriesError) {
			const box = append(this._content!, $('div.dsh-market-empty'));
			box.textContent = localize('dshMarketError', "读不到社区目录：{0}", this._entriesError);
			const retry = append(box, $('button.dsh-market-btn')) as HTMLButtonElement;
			retry.textContent = localize('dshMarketRetry', "重试");
			retry.onclick = () => {
				this._entries = undefined;
				this._entriesError = undefined;
				void this._load();
			};
			return;
		}
		if (!this._entries) {
			append(this._content!, $('div.dsh-market-empty')).textContent = localize('dshMarketLoading', "正在读取社区目录…");
			return;
		}
		const matching = this._filterEntries(this._entries);
		const top = [...matching].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0)).slice(0, COMMUNITY_CARD_LIMIT);
		if (!top.length) {
			append(this._content!, $('div.dsh-market-empty')).textContent = localize('dshMarketNoMatch', "社区目录里没有匹配的插件。");
			return;
		}
		this._renderSection(
			localize('dshMarketCommunitySection', "社区目录（dsh-market · 共 {0} 条，匹配 {1}，按 star 取前 {2}）", this._entries.length, matching.length, COMMUNITY_CARD_LIMIT),
			top.map(entry => this._communityCard(entry)),
		);
	}

	private _recommendations(): readonly IDshPluginRecommendation[] {
		try {
			return dshPluginRecommendations();
		} catch {
			return [];
		}
	}

	private _filterEntries(entries: readonly IDshMarketEntry[]): readonly IDshMarketEntry[] {
		const q = this._query.trim().toLowerCase();
		if (!q) {
			return entries;
		}
		return entries.filter(e =>
			e.name.toLowerCase().includes(q)
			|| e.owner.toLowerCase().includes(q)
			|| (e.npm ?? '').toLowerCase().includes(q)
			|| e.description.toLowerCase().includes(q));
	}

	// ── 卡片 ─────────────────────────────────────────────────────────────────────

	private _cardHead(card: HTMLElement, name: string, version?: string, badge?: string): HTMLElement {
		const head = append(card, $('div.dsh-market-card-head'));
		append(head, $('span.dsh-market-name')).textContent = name;
		if (version) {
			append(head, $('span.dsh-market-version')).textContent = version.startsWith('v') ? version : `v${version}`;
		}
		if (badge) {
			append(head, $('span.dsh-market-badge')).textContent = badge;
		}
		return head;
	}

	private _installButton(card: HTMLElement, spec: string, installedName?: string): void {
		const row = append(card, $('div.dsh-market-card-actions'));
		const btn = append(row, $('button.dsh-market-btn.dsh-market-install')) as HTMLButtonElement;
		const already = !!installedName && this._installed.has(installedName);
		const busy = this._busySpec === spec;
		btn.textContent = busy
			? localize('dshMarketInstalling', "处理中…")
			: already
				? localize('dshMarketInstalledTag', "已安装")
				: localize('dshMarketInstall', "安装");
		btn.disabled = !!this._busySpec || already;
		if (already) {
			btn.title = localize('dshMarketInstalledHint', "profile 里已经有这个组合包（卸载/启停到侧栏「插件中心」的 dsh 组合包页签）。");
		} else {
			btn.title = localize('dshMarketInstallHint', "先预检（读一次这个 spec 指向什么），确认是组合包后才写进 profile。");
			btn.onclick = () => void this._install(spec);
		}
		append(row, $('span.dsh-market-spec')).textContent = spec;
	}

	private _recoCard(item: IDshPluginRecommendation): HTMLElement {
		const card = $('div.dsh-market-card');   // 建出来即可，挂载由 `_renderSection` 统一做
		this._cardHead(card, item.label, undefined, localize('dshMarketBadgeOfficial', "官方"));
		append(card, $('div.dsh-market-note-line')).textContent = item.note;
		append(card, $('div.dsh-market-spec-line')).textContent = item.spec;
		this._installButton(card, item.spec);
		return card;
	}

	private _communityCard(entry: IDshMarketEntry): HTMLElement {
		const card = $('div.dsh-market-card');
		this._cardHead(card, entry.name, entry.version, entry.npm ? localize('dshMarketBadgeNpm', "npm") : localize('dshMarketBadgeGit', "git"));
		const meta = append(card, $('div.dsh-market-meta-line'));
		const bits = [entry.owner, entry.stars !== undefined ? `★ ${entry.stars}` : undefined, entry.downloads !== undefined ? `⬇ ${entry.downloads}` : undefined].filter(Boolean);
		meta.textContent = bits.join(' · ');
		append(card, $('div.dsh-market-note-line')).textContent = entry.description;
		this._installButton(card, dshMarketInstallSpec(entry), entry.npm ?? undefined);
		return card;
	}

	// ── 安装（与侧栏共用通道判据）───────────────────────────────────────────────

	private async _install(spec: string): Promise<void> {
		const host = getDshPluginCenterHost();
		if (!host) {
			this._activeMessage = localize('dshMarketNeedHost', "安装需要 Host：插件中心未启用或 Host 未运行（先用侧栏的「重启 Host」）。");
			this._render();
			return;
		}
		if (this._busySpec) {
			return;
		}
		this._busySpec = spec;
		this._activeMessage = localize('dshMarketInspecting', "正在预检 {0} …", spec);
		this._render();
		try {
			const inspect = await host.inspectBundle(spec);
			if (inspect.status !== 'accepted' || inspect.bundle === false) {
				this._activeMessage = localize('dshMarketRefused', "不能安装（{0}）：{1}", inspect.problem ?? 'unknown', inspect.reason ?? '');
				return;
			}
			// ★ 与侧栏「添加插件」**同一个选路纯函数**（`common/dshPluginTransport.ts`）：
			//   本页若自己写一遍"是不是 path / 有没有名字"，两条路的判据就会漂（历史事故见该模块头注释）。
			const transport = dshInstallTransport(inspect, false);
			this._activeMessage = transport === 'local'
				? localize('dshMarketInstallingLocal', "正在把本地目录装进 profile：{0} …", spec)
				: transport === 'spec'
					? localize('dshMarketInstallingSpec', "正在装 {0} …（主进程 dsh plugin add，没有取消）", spec)
					: localize('dshMarketInstallingBundle', "正在安装 {0} …（依赖多时可能要几分钟）", spec);
			this._render();

			if (transport === 'local') {
				const r = await host.installLocalPlugin(spec);
				this._activeMessage = r.ok
					? localize('dshMarketLocalOk', "已把本地目录装进 profile：{0}", spec)
					: localize('dshMarketLocalFailed', "安装失败：{0}", r.error ?? spec);
			} else if (transport === 'spec') {
				const name = inspect.name?.trim();
				if (!name) {
					throw new Error(localize('dshMarketNeedName', "缺少预检包名：请重新点一次「安装」（装完要按包名核对版本）。"));
				}
				const r = await host.installPluginSpec(spec, name);
				this._activeMessage = r.ok
					? localize('dshMarketSpecOk', "已安装 {0}{1}", r.name || name, r.version ? ` v${r.version}` : '')
					: localize('dshMarketSpecFailed', "安装失败：{0}", r.error ?? spec);
			} else {
				const r = await host.installBundle(spec, `dsh-market-${Date.now().toString(36)}`);
				this._activeMessage = this._resultText(r, spec);
			}
		} catch (e) {
			this._activeMessage = localize('dshMarketInstallError', "安装失败：{0}", e instanceof Error ? e.message : String(e));
		} finally {
			this._busySpec = undefined;
			await this._load();   // 让"已安装"标记与 Host 快照跟上（`_load` 末尾会重绘）
		}
	}

	/** `application` 是权威结论（与侧栏同一套话术口径）。 */
	private _resultText(r: IDshInstallResult, spec: string): string {
		const target = r.bundle ?? r.target ?? spec;
		switch (r.application) {
			case 'applied':
				return localize('dshMarketApplied', "已安装并生效：{0}", target);
			case 'restart-required':
				return localize('dshMarketRestartRequired', "已安装，需重启 Host 生效：{0}", target);
			case 'overridden':
				return localize('dshMarketOverridden', "已写入，但被更高层 patch 覆盖：{0}", target);
			case 'cancelled':
				return localize('dshMarketCancelled', "安装已取消：{0}", target);
			default: {
				const pending = r.pendingBuilds?.length
					? `\n${localize('dshMarketPendingBuilds', "pnpm 拦下了构建脚本：{0} —— 请到侧栏「插件中心 → dsh 组合包 → 添加插件」批准并重装（本页不做批准）。", r.pendingBuilds.join('、'))}`
					: '';
				return `${localize('dshMarketFailed', "安装未成功：{0}", r.failureKind ?? target)}${pending}`;
			}
		}
	}
}
