/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentMarketEditorPane.css';

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import * as DOM from '../../../../base/browser/dom.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import type { Agent } from '../../../common/agentStudioTypes.js';
import {
	IMarketplaceService,
	IMarketplacePackage,
	IMarketplacePackageDetail,
	IUpgradeInfo,
	PackageKind,
} from '../common/marketplace.js';
import { AgentMarketEditorInput } from './agentMarketEditorInput.js';
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../common/sarosPaths.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ISkillRegistry } from '../common/skills.js';

const { $: $$ } = DOM;

/**
 * EditorPane that renders the Agent Market (Agent 商城) page in the editor area.
 *
 * Data is fetched from the AnyDev marketplace server (saros.marketplace.url).
 * Each card supports four states: not-installed (Install), installing (⏳),
 * installed (Delete), upgradable (Upgrade).
 *
 * Toolbar provides:
 *   - ⬆ Upload: publish a local agent to the marketplace
 *   - ✏ Custom: create a custom agent locally
 */
export class AgentMarketEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentMarket';

	private _container: HTMLElement | undefined;
	private _gridContainer: HTMLElement | undefined;
	private _countBadge: HTMLElement | undefined;
	private _searchInput: HTMLInputElement | undefined;

	// Data
	private _packages: readonly IMarketplacePackage[] = [];
	private _loading = false;
	private _searchQuery = '';

	// State tracking
	private _installingSlugs = new Set<string>();
	private _upgradingSlugs = new Set<string>();
	private _upgrades = new Map<string, IUpgradeInfo>(); // slug → upgrade info
	private _installedSlugs = new Set<string>();         // from installed-packages.json
	private _localAgentNames = new Set<string>();        // from agentStudioService.getAgents()
	private _localAgentIds = new Set<string>();          // from agentStudioService.getAgents() — 用于交叉校验
	private _builtinAgentIds = new Set<string>();        // source==='builtin' 的产品内置 agent id — 用于商城展示过滤
	private _packageDetails = new Map<string, IMarketplacePackageDetail>(); // slug → detail (含 manifest)

	private _initialized = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
			@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
	) {
		super(AgentMarketEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('agent-market-editor');
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof AgentMarketEditorInput)) {
			return;
		}

		console.log('[AgentMarket] setInput 被调用, _container:', !!this._container, '_initialized:', this._initialized);

		if (this._container && !this._initialized) {
			this._buildUI(this._container);
			this._initialized = true;
			await this._loadPackages();
			await this._loadUpgrades();
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  UI BUILD
	// ══════════════════════════════════════════════════════════════════════════

	private _buildUI(container: HTMLElement): void {
		container.replaceChildren();

		// ── Scrollable root ───────────────────────────────────────────
		const scroll = $$('div.agent-market-scroll');
		container.appendChild(scroll);

		// ── Hero header ───────────────────────────────────────────────
		const hero = $$('div.agent-market-hero');

		const heroText = $$('div.agent-market-hero-text');
		const title = $$('h1.agent-market-title');
		title.textContent = '🛒 Agent 商城';
		heroText.appendChild(title);

		const subtitle = $$('p.agent-market-subtitle');
		subtitle.textContent = '从 AnyDev 商城浏览、安装、升级智能体';
		heroText.appendChild(subtitle);
		hero.appendChild(heroText);

		// Search row: search box (left) + action buttons (right)
		const searchRow = $$('div.agent-market-search-row');

		// Search box
		const searchBox = $$('div.agent-market-search-box');
		const searchIcon = $$('span.agent-market-search-icon');
		searchIcon.textContent = '🔍';
		searchBox.appendChild(searchIcon);

		this._searchInput = document.createElement('input');
		this._searchInput.type = 'text';
		this._searchInput.className = 'agent-market-search-input';
		this._searchInput.placeholder = '搜索智能体（名称、描述、标签…）';
		this._register(DOM.addDisposableListener(this._searchInput, 'input', () => {
			this._searchQuery = this._searchInput!.value.toLowerCase().trim();
			this._renderGrid();
		}));
		searchBox.appendChild(this._searchInput);
		searchRow.appendChild(searchBox);

		// Action buttons
		const heroActions = $$('div.agent-market-hero-actions');

		const installFileBtn = $$('button.agent-market-action-btn') as HTMLButtonElement;
		installFileBtn.textContent = '📂 从文件安装';
		installFileBtn.title = '从本地文件或文件夹安装 Agent';
		installFileBtn.onclick = () => this._showInstallFromFileDialog();
		heroActions.appendChild(installFileBtn);

		const refreshBtn = $$('button.agent-market-action-btn') as HTMLButtonElement;
		refreshBtn.textContent = '🔄 刷新';
		refreshBtn.title = '刷新商城数据';
		refreshBtn.onclick = () => this._refresh();
		heroActions.appendChild(refreshBtn);

		searchRow.appendChild(heroActions);
		hero.appendChild(searchRow);

		scroll.appendChild(hero);

		// ── Toolbar: count ────────────────────────────────────────────
		const toolbar = $$('div.agent-market-toolbar');

		const countBadge = $$('span.agent-market-count');
		this._countBadge = countBadge;
		toolbar.appendChild(countBadge);

		scroll.appendChild(toolbar);

		// ── Card grid ─────────────────────────────────────────────────
		const grid = $$('div.agent-market-grid');
		this._gridContainer = grid;
		scroll.appendChild(grid);
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  DATA LOADING
	// ══════════════════════════════════════════════════════════════════════════

	private async _loadPackages(): Promise<void> {
		this._loading = true;
		this._renderGrid();

		try {
			// Load marketplace packages (kind=agent) — 加超时保护防止永久卡住
			console.log('[AgentMarket] 开始加载 agent 包列表...');
			const listPromise = this.marketplaceService.listPackages({ kind: 'agent' as PackageKind, pageSize: 200 });
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('listPackages 超时（30s），请检查 marketplace.proxyRequest 命令是否已注册')), 30000)
			);
			const { items } = await Promise.race([listPromise, timeoutPromise]);
			console.log('[AgentMarket] 获取到', items.length, '个 agent 包');

		// Load local agents for builtin filtering + name matching
		try {
			const agents = await this.agentStudioService.getAgents();
			this._localAgentNames.clear();
			this._localAgentIds.clear();
			this._builtinAgentIds.clear();
			for (const a of agents) {
				if (a.name) { this._localAgentNames.add(a.name.toLowerCase()); }
				if (a.id) { this._localAgentIds.add(a.id); }
				if (a.source === 'builtin' && a.id) { this._builtinAgentIds.add(a.id); }
			}
		} catch { /* ignore — local agent list is best-effort */ }

		// 过滤内置 agent：商城不展示已随产品内置的 agent（source==='builtin'）。
		// 关键：仅按"产品内置"过滤，绝不按"本地已安装"过滤——已安装的自定义 agent
		// 仍应在商城展示（显示 删除/升级 按钮），否则商城会被掏空（本 bug：用 _localAgentIds
		// 会把已安装的 gr-gc专家/GR埋点专家/PPT专家 等自定义 agent 也一并隐藏 → 0 个智能体）。
		this._packages = items.filter(pkg =>
			!this._builtinAgentIds.has(pkg.slug) && !this._builtinAgentIds.has(pkg.id)
		);
		console.log('[AgentMarket] 过滤内置后剩余', this._packages.length, '个 agent 包');

			// Load installed records from installed-packages.json
			const installed = await this.marketplaceService.getInstalled();
			this._installedSlugs.clear();
			for (const entry of installed) {
				this._installedSlugs.add(entry.storeId);
			}
			console.log('[AgentMarket] 已安装记录:', installed.length, '条');

			// 交叉校验：installed-packages.json 中的 agent 记录若本地目录不存在，
			// 视为残留（目录被外部删除但记录未清理），从 _installedSlugs 中移除。
			const staleRecords: Array<{ kind: PackageKind; storeId: string }> = [];
			for (const slug of [...this._installedSlugs]) {
				const pkg = items.find(p => p.slug === slug || p.id === slug);
				if (pkg?.kind === 'agent' && !this._localAgentIds.has(slug) && !this._localAgentIds.has(pkg.id)) {
					this._installedSlugs.delete(slug);
					staleRecords.push({ kind: 'agent' as PackageKind, storeId: slug });
				}
			}
			// 持久化清理：把已识别的残留记录写回 installed-packages.json，
			// 避免每次启动重复校正，同时修正依赖 getInstalled() 的其他消费方（如升级检查）。
			if (staleRecords.length > 0) {
				void this.marketplaceService.removeInstalledRecords(staleRecords);
			}

			// Fetch package details (含 manifest 中的 skillRefs/mcpRefs) — 并行获取
			this._packageDetails.clear();
			const detailResults = await Promise.allSettled(
				items.map(pkg => this.marketplaceService.getPackage(pkg.slug))
			);
			let detailCount = 0;
			for (let i = 0; i < detailResults.length; i++) {
				const result = detailResults[i];
				if (result.status === 'fulfilled') {
					this._packageDetails.set(items[i].slug, result.value as IMarketplacePackageDetail);
					detailCount++;
				} else {
					console.warn('[AgentMarket] 获取详情失败:', items[i].slug, result.reason);
				}
			}
			console.log('[AgentMarket] 成功获取', detailCount, '/', items.length, '个包详情');

			this._loading = false;
			this._renderGrid();
			console.log('[AgentMarket] 渲染完成');
		} catch (err) {
			console.error('[AgentMarket] loadPackages failed:', err);
			this._renderError(err);
		} finally {
			this._loading = false;
		}
	}

	private async _loadUpgrades(): Promise<void> {
		try {
			const installed = await this.marketplaceService.getInstalled();
			const agentItems = installed.filter(i => i.kind === 'agent');
			if (agentItems.length === 0) { return; }

			const upgrades = await this.marketplaceService.checkUpgrades(agentItems);
			this._upgrades.clear();
			for (const u of upgrades) {
				this._upgrades.set(u.storeId, u);
			}
			this._renderGrid();
		} catch (err) {
			// Upgrade check failure should not block browsing
			console.warn('[AgentMarket] upgrade check failed:', err);
		}
	}

	/** 刷新商城数据：重新加载包列表 + 升级检查 */
	private async _refresh(): Promise<void> {
		this._packages = [];
		this._packageDetails.clear();
		this._upgrades.clear();
		this._installedSlugs.clear();
		await this._loadPackages();
		await this._loadUpgrades();
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  DEPENDENCY CHECK
	// ══════════════════════════════════════════════════════════════════════════

	/** 从缓存详情中读取 agent 的 skill/mcp 依赖声明 */
	private _getDeps(slug: string): { skillRefs: string[]; mcpRefs: string[] } {
		const detail = this._packageDetails.get(slug);
		if (!detail?.versions?.length) { return { skillRefs: [], mcpRefs: [] }; }
		const latest = detail.versions.find(v => v.isLatest) || detail.versions[0];
		const manifest = latest.manifest as Record<string, unknown> | undefined;
		return {
			skillRefs: Array.isArray(manifest?.skillRefs) ? (manifest!.skillRefs as string[]) : [],
			mcpRefs: Array.isArray(manifest?.mcpRefs) ? (manifest!.mcpRefs as string[]) : [],
		};
	}

	/** 检查 agent 的依赖是否已安装，返回缺失列表 */
	private _checkDeps(slug: string): { missingSkills: string[]; missingMcps: string[] } {
		const { skillRefs, mcpRefs } = this._getDeps(slug);
		// 缺失判定：既看商城安装记录（_installedSlugs），也看本地技能注册表
		// （builtin/user 技能不在 installed-packages.json 里，只看前者会误判缺失）
		const missingSkills = skillRefs.filter(s =>
			!this._installedSlugs.has(s) && !this.skillRegistry.getSkill(s)
		);
		const missingMcps = mcpRefs.filter(m => !this._installedSlugs.has(m));
		return { missingSkills, missingMcps };
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  RENDER
	// ══════════════════════════════════════════════════════════════════════════

	private _getFilteredPackages(): readonly IMarketplacePackage[] {
		if (!this._searchQuery) { return this._packages; }
		const q = this._searchQuery;
		return this._packages.filter(p =>
			p.name.toLowerCase().includes(q) ||
			(p.description ?? '').toLowerCase().includes(q) ||
			(p.category ?? '').toLowerCase().includes(q) ||
			p.tags.some(t => t.toLowerCase().includes(q))
		);
	}

	private _renderGrid(): void {
		const grid = this._gridContainer;
		if (!grid) { return; }
		grid.replaceChildren();

		if (this._loading) {
			const loading = $$('div.agent-market-empty');
			loading.textContent = '⏳ 正在从商城加载智能体列表…';
			grid.appendChild(loading);
			if (this._countBadge) { this._countBadge.textContent = ''; }
			return;
		}

		const packages = this._getFilteredPackages();

		if (this._countBadge) {
			this._countBadge.textContent = `${packages.length} 个智能体`;
		}

		if (packages.length === 0) {
			const empty = $$('div.agent-market-empty');
			empty.textContent = this._searchQuery
				? `没有匹配 "${this._searchQuery}" 的智能体`
				: '商城暂无可安装的智能体';
			grid.appendChild(empty);
			return;
		}

		for (const pkg of packages) {
			grid.appendChild(this._createCard(pkg));
		}
	}

	private _renderError(err: unknown): void {
		const grid = this._gridContainer;
		if (!grid) { return; }
		grid.replaceChildren();

		const rawMsg = err instanceof Error ? err.message : String(err);
		const isNetworkError = /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(rawMsg);

		const errorEl = $$('div.agent-market-error');
		errorEl.textContent = isNetworkError
			? '❌ 无法连接到商城服务器，请检查网络或服务器状态后重试'
			: `❌ 加载失败：${rawMsg}`;
		grid.appendChild(errorEl);
	}

	private _isPackageInstalled(pkg: IMarketplacePackage): boolean {
		return this._installedSlugs.has(pkg.slug)
			|| this._installedSlugs.has(pkg.id)
			|| this._localAgentNames.has(pkg.name.toLowerCase());
	}

	private _createCard(pkg: IMarketplacePackage): HTMLElement {
		const isInstalled = this._isPackageInstalled(pkg);
		const isInstalling = this._installingSlugs.has(pkg.slug);
		const isUpgrading = this._upgradingSlugs.has(pkg.slug);
		const upgrade = this._upgrades.get(pkg.slug);

		const card = $$('div.agent-market-card');

		// ── Top: icon + name + meta ─────────────────────────────────
		const header = $$('div.agent-market-card-header');

		const icon = $$('div.agent-market-card-icon');
		icon.textContent = pkg.icon || '🤖';
		header.appendChild(icon);

		const titleBox = $$('div.agent-market-card-title-box');
		const name = $$('div.agent-market-card-name');
		name.textContent = pkg.name;
		titleBox.appendChild(name);

		const role = $$('div.agent-market-card-role');
		role.textContent = pkg.authorName ? `by ${pkg.authorName}` : (pkg.category ?? 'Agent');
		titleBox.appendChild(role);
		header.appendChild(titleBox);

		// Version badge (top-right)
		if (pkg.latestVersion) {
			const verBadge = $$('span.agent-market-card-cat');
			verBadge.textContent = `v${pkg.latestVersion}`;
			header.appendChild(verBadge);
		}
		card.appendChild(header);

		// ── Description ─────────────────────────────────────────────
		const desc = $$('p.agent-market-card-desc');
		desc.textContent = pkg.description || '(暂无描述)';
		card.appendChild(desc);

		// ── Tags ────────────────────────────────────────────────────
		const tagList = (pkg.tags ?? []).slice(0, 5);
		if (tagList.length > 0) {
			const tags = $$('div.agent-market-card-tags');
			for (const tag of tagList) {
				const tagEl = $$('span.agent-market-card-tag');
				tagEl.textContent = tag;
				tags.appendChild(tagEl);
			}
			card.appendChild(tags);
		}

		// ── Dependency warning (if installed but missing deps) ──────
		if (isInstalled) {
			const { missingSkills, missingMcps } = this._checkDeps(pkg.slug);
			const totalMissing = missingSkills.length + missingMcps.length;
			if (totalMissing > 0) {
				const depWarn = $$('div.agent-market-dep-warning');
				const parts: string[] = [];
				if (missingSkills.length > 0) { parts.push(`Skill: ${missingSkills.join(', ')}`); }
				if (missingMcps.length > 0) { parts.push(`MCP: ${missingMcps.join(', ')}`); }
				depWarn.textContent = `⚠ 缺少 ${totalMissing} 个依赖（${parts.join('；')}）`;
				depWarn.title = `点击安装缺失的依赖\n${parts.join('\n')}`;
				depWarn.style.cursor = 'pointer';
				depWarn.onclick = (e) => {
					e.stopPropagation();
					this._installMissingDeps(missingSkills, missingMcps);
				};
				card.appendChild(depWarn);
			}
		}

		// ── Footer: downloads + action button ──────────────────────
		const footer = $$('div.agent-market-card-footer');

		const stats = $$('div.agent-market-card-model');
		if (typeof pkg.downloads === 'number' && pkg.downloads > 0) {
			stats.textContent = `⬇ ${this._formatCount(pkg.downloads)}`;
		} else {
			stats.textContent = '';
		}
		footer.appendChild(stats);

		// Action button — 4 states (priority: upgrading > installing > upgrade > installed > install)
		if (isUpgrading) {
			const badge = $$('span.agent-market-badge.upgrading');
			badge.textContent = '⏳ 升级中';
			footer.appendChild(badge);
		} else if (isInstalling) {
			const badge = $$('span.agent-market-badge.installing');
			badge.textContent = '⏳ 安装中';
			footer.appendChild(badge);
		} else if (isInstalled && upgrade) {
			// Upgradable
			const upgradeBtn = $$('button.agent-market-btn.upgrade') as HTMLButtonElement;
			upgradeBtn.textContent = `⬆ 升级 v${upgrade.latest}`;
			upgradeBtn.title = `当前 v${upgrade.current} → 最新 v${upgrade.latest}`;
			upgradeBtn.onclick = (e) => { e.stopPropagation(); this._upgradePackage(pkg, upgrade); };
			footer.appendChild(upgradeBtn);
		} else if (isInstalled) {
			// Installed — show delete button
			const deleteBtn = $$('button.agent-market-btn.delete') as HTMLButtonElement;
			deleteBtn.textContent = '✕ 删除';
			deleteBtn.onclick = (e) => { e.stopPropagation(); this._uninstallPackage(pkg); };
			footer.appendChild(deleteBtn);
		} else {
			// Not installed — show install button
			const installBtn = $$('button.agent-market-btn.install') as HTMLButtonElement;
			installBtn.textContent = '⬇ 安装';
			installBtn.onclick = (e) => { e.stopPropagation(); this._installPackage(pkg); };
			footer.appendChild(installBtn);
		}

		card.appendChild(footer);
		return card;
	}

	private _formatCount(n: number): string {
		if (n >= 10000) { return `${(n / 10000).toFixed(1)}万`; }
		if (n >= 1000) { return `${(n / 1000).toFixed(1)}k`; }
		return String(n);
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  ACTIONS: Install / Uninstall / Upgrade
	// ══════════════════════════════════════════════════════════════════════════

	private async _installPackage(pkg: IMarketplacePackage): Promise<void> {
		if (this._installingSlugs.has(pkg.slug)) { return; }
		this._installingSlugs.add(pkg.slug);
		this._renderGrid();

		try {
			const result = await this.marketplaceService.download(pkg.slug, pkg.latestVersion ?? '', 'agent');
			this._installedSlugs.add(pkg.slug);
			// Clear any stale upgrade entry
			this._upgrades.delete(pkg.slug);

			// Auto-download missing skill/MCP dependencies
			const { missingSkills, missingMcps } = this._checkDeps(pkg.slug);
			if (missingSkills.length > 0 || missingMcps.length > 0) {
				const allMissing = [
					...missingSkills.map(s => ({ slug: s, kind: 'skill' as PackageKind })),
					...missingMcps.map(m => ({ slug: m, kind: 'mcp' as PackageKind })),
				];
			this.notificationService.info(`正在自动安装 ${allMissing.length} 个关联依赖...`);
			for (const dep of allMissing) {
				try {
					await this.marketplaceService.download(dep.slug, '', dep.kind);
					this._installedSlugs.add(dep.slug);
				} catch (depErr) {
					const reason = depErr instanceof Error ? depErr.message : String(depErr);
					console.warn(`[AgentMarket] 依赖 ${dep.kind}:${dep.slug} 自动安装失败:`, depErr);
					this.notificationService.warn(`依赖 ${dep.kind}:${dep.slug} 自动安装失败（${reason}），已跳过`);
				}
			}
			}

			this.notificationService.info(`✅ ${pkg.name} v${result.version} 安装成功`);
		} catch (err) {
			this.notificationService.error(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._installingSlugs.delete(pkg.slug);
			this._renderGrid();
		}
	}

	/** 一键安装缺失的 skill/mcp 依赖 */
	private async _installMissingDeps(missingSkills: string[], missingMcps: string[]): Promise<void> {
		const allDeps = [
			...missingSkills.map(s => ({ slug: s, kind: 'skill' as PackageKind })),
			...missingMcps.map(m => ({ slug: m, kind: 'mcp' as PackageKind })),
		];
		if (allDeps.length === 0) { return; }

		const confirmed = await this.dialogService.confirm({
			message: `将安装以下 ${allDeps.length} 个依赖包：\n${allDeps.map(d => `  • ${d.kind}: ${d.slug}`).join('\n')}`,
			primaryButton: '安装',
			cancelButton: '取消',
		});
		if (!confirmed.confirmed) { return; }

		let ok = 0;
		let fail = 0;
		for (const dep of allDeps) {
			try {
				// 获取最新版本
				const detail = await this.marketplaceService.getPackage(dep.slug);
				const latestVer = detail.versions.find(v => v.isLatest)?.version ?? detail.latestVersion ?? '';
				await this.marketplaceService.download(dep.slug, latestVer, dep.kind);
				this._installedSlugs.add(dep.slug);
				ok++;
			} catch (err) {
				console.error(`[AgentMarket] install dep ${dep.kind}/${dep.slug} failed:`, err);
				fail++;
			}
		}
		if (fail === 0) {
			this.notificationService.info(`✅ ${ok} 个依赖安装成功`);
		} else {
			this.notificationService.warn(`⚠️ ${ok} 成功, ${fail} 失败。请手动安装失败的依赖。`);
		}
		this._renderGrid();
	}

	private async _uninstallPackage(pkg: IMarketplacePackage): Promise<void> {
		const confirmed = await this.dialogService.confirm({
			message: `确定要卸载智能体 "${pkg.name}" 吗？本地安装目录和配置将被删除。`,
			primaryButton: '卸载',
			cancelButton: '取消',
		});
		if (!confirmed.confirmed) { return; }

		try {
			await this.marketplaceService.uninstall(pkg.slug, 'agent');
			this._installedSlugs.delete(pkg.slug);
			this._installedSlugs.delete(pkg.id);
			this._upgrades.delete(pkg.slug);
			this.notificationService.info(`✅ ${pkg.name} 已卸载`);
			this._renderGrid();
		} catch (err) {
			this.notificationService.error(`卸载失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async _upgradePackage(pkg: IMarketplacePackage, upgrade: IUpgradeInfo): Promise<void> {
		if (this._upgradingSlugs.has(pkg.slug)) { return; }
		this._upgradingSlugs.add(pkg.slug);
		this._renderGrid();

		try {
			const result = await this.marketplaceService.download(pkg.slug, upgrade.latest, 'agent');
			this._upgrades.delete(pkg.slug);
			this.notificationService.info(`✅ ${pkg.name} 已升级到 v${result.version}`);
		} catch (err) {
			this.notificationService.error(`升级失败: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._upgradingSlugs.delete(pkg.slug);
			this._renderGrid();
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  INSTALL FROM FILE: modal dialog with file/folder selector
	// ══════════════════════════════════════════════════════════════════════════

	private async _showInstallFromFileDialog(): Promise<void> {
		// Show modal first, then let user browse for file/folder
		this._showInstallModal();
	}

	private _showInstallModal(): void {
		const { overlay, dialog } = this._createOverlay('📂 从文件安装 Agent');
		dialog.style.maxWidth = '540px';

		const body = $$('div.am-dialog-body');

		// ── File display area (empty initially) ──
		const fileDisplay = $$('div.am-file-display');
		const fileIcon = $$('span.am-file-icon');
		fileIcon.textContent = '📄';
		fileDisplay.appendChild(fileIcon);

		const fileInfo = $$('div.am-file-info');
		const fileName = $$('div.am-file-name');
		fileName.textContent = '未选择文件';
		fileName.style.color = 'var(--vscode-descriptionForeground)';
		const filePath = $$('div.am-file-path');
		filePath.textContent = '点击右侧按钮选择 .tar.gz 或包含 agent.json 的文件夹';
		fileInfo.appendChild(fileName);
		fileInfo.appendChild(filePath);
		fileDisplay.appendChild(fileInfo);

		const browseBtn = $$('button.am-browse-btn') as HTMLButtonElement;
		browseBtn.textContent = '浏览…';
		fileDisplay.appendChild(browseBtn);
		body.appendChild(fileDisplay);

		// ── Preview area (hidden until file loaded) ──
		const previewArea = $$('div.am-install-preview');
		previewArea.style.display = 'none';
		body.appendChild(previewArea);

		// ── Loading spinner (hidden) ──
		const loadingRow = $$('div.am-install-loading');
		loadingRow.style.display = 'none';
		const spinner = $$('div.am-install-spinner');
		loadingRow.appendChild(spinner);
		const loadingText = $$('span');
		loadingText.textContent = '正在解析文件…';
		loadingRow.appendChild(loadingText);
		body.appendChild(loadingRow);

		dialog.appendChild(body);

		// ── Footer ──
		const footer = $$('div.am-dialog-footer');
		const cancelBtn = $$('button.am-btn-secondary') as HTMLButtonElement;
		cancelBtn.textContent = '取消';
		cancelBtn.onclick = () => overlay.remove();
		footer.appendChild(cancelBtn);

		const installBtn = $$('button.am-btn-primary') as HTMLButtonElement;
		installBtn.textContent = '✓ 安装';
		installBtn.disabled = true;
		footer.appendChild(installBtn);
		dialog.appendChild(footer);

		// State: parsed agent data (set after file selection)
		let parsedAgent: Partial<Agent> | undefined;

		// ── Browse button → open file dialog ──
		browseBtn.onclick = async () => {
			browseBtn.disabled = true;
			loadingRow.style.display = 'flex';

			try {
				const selected = await this.fileDialogService.showOpenDialog({
					title: '选择 Agent 包文件或文件夹',
					canSelectFiles: true,
					canSelectFolders: true,
					canSelectMany: false,
					filters: [
						{ name: 'Agent 包', extensions: ['tar.gz', 'gz', 'zip'] },
						{ name: 'JSON', extensions: ['json'] },
					],
				});

				if (!selected || selected.length === 0) {
					loadingRow.style.display = 'none';
					browseBtn.disabled = false;
					return;
				}

				const selectedUri = selected[0];
				const selectedName = selectedUri.path.split('/').pop() || selectedUri.fsPath;

				// Update file display
				fileIcon.textContent = selectedUri.path.endsWith('.tar.gz') || selectedUri.path.endsWith('.gz') ? '📦' : '📁';
				fileName.textContent = selectedName;
				fileName.style.color = 'var(--vscode-foreground)';
				filePath.textContent = selectedUri.fsPath;

				// Parse agent data
				let agentData: Partial<Agent> | undefined;

				if (selectedUri.path.endsWith('.tar.gz') || selectedUri.path.endsWith('.gz')) {
					const result = await this._parseAgentFromArchive(selectedUri);
					agentData = result.agentData;
				} else if (selectedUri.path.endsWith('.json')) {
					const content = await this.fileService.readFile(selectedUri);
					const parsed = JSON.parse(content.value.toString());
					agentData = parsed.agent || parsed;
				} else {
					// Folder — look for agent.json
					const agentJsonUri = URI.joinPath(selectedUri, 'agent.json');
					if (await this.fileService.exists(agentJsonUri)) {
						const content = await this.fileService.readFile(agentJsonUri);
						const parsed = JSON.parse(content.value.toString());
						agentData = parsed.agent || parsed;
					} else {
						throw new Error('所选文件夹中未找到 agent.json');
					}
				}

				if (!agentData || !agentData.name) {
					throw new Error('无法从所选文件中解析出 Agent 信息');
				}

				parsedAgent = agentData;

				// Render preview card + form fields
				previewArea.replaceChildren();
				previewArea.style.display = 'block';

				// Preview card
				const card = $$('div.am-install-preview-card');
				const avatar = $$('div.am-install-preview-avatar');
				avatar.textContent = agentData.icon || '🤖';
				card.appendChild(avatar);
				const cardMeta = $$('div.am-install-preview-meta');
				const cardNameRow = $$('div');
				const cardName = $$('span.am-install-preview-name');
				cardName.textContent = agentData.name;
				cardNameRow.appendChild(cardName);
				if (agentData.version) {
					const ver = $$('span.am-install-preview-version');
					ver.textContent = `v${agentData.version}`;
					cardNameRow.appendChild(ver);
				}
				cardMeta.appendChild(cardNameRow);
				const cardRole = $$('div.am-install-preview-role');
				cardRole.textContent = `${agentData.role || 'assistant'} · ${agentData.category || 'General'}`;
				cardMeta.appendChild(cardRole);
				card.appendChild(cardMeta);
				previewArea.appendChild(card);

				// Editable fields
				const fields = [
					{ label: '名称', key: 'name', value: agentData.name || '' },
					{ label: '角色', key: 'role', value: agentData.role || 'assistant' },
					{ label: '版本', key: 'version', value: agentData.version || '1.0.0' },
					{ label: '描述', key: 'description', value: agentData.description || '' },
				];
				const inputs: Record<string, HTMLInputElement> = {};

				for (const field of fields) {
					const group = $$('div.am-install-form-group');
					const lbl = $$('label.am-install-form-label');
					lbl.textContent = field.label;
					group.appendChild(lbl);
					const input = $$('input.am-install-form-input') as HTMLInputElement;
					input.type = 'text';
					input.value = field.value;
					input.placeholder = field.label;
					group.appendChild(input);
					inputs[field.key] = input;
					previewArea.appendChild(group);
				}

				// Read-only info grid
				const infoGrid = $$('div.am-install-info-grid');
				const infoItems = [
					{ label: '模型', value: agentData.model || 'default' },
					{ label: '图标', value: agentData.icon || '🤖' },
					{ label: '技能', value: (agentData.skills || []).join(', ') || '无' },
					{ label: '分类', value: agentData.category || 'General' },
				];
				for (const item of infoItems) {
					const itemEl = $$('div.am-install-info-item');
					const itemLabel = $$('div.am-install-info-item-label');
					itemLabel.textContent = item.label;
					itemEl.appendChild(itemLabel);
					const itemValue = $$('div.am-install-info-item-value');
					itemValue.textContent = item.value;
					itemEl.appendChild(itemValue);
					infoGrid.appendChild(itemEl);
				}
				previewArea.appendChild(infoGrid);

				// Enable install button — store inputs for later
				installBtn.disabled = false;
				(installBtn as any)._inputs = inputs;

				loadingRow.style.display = 'none';
			} catch (err) {
				loadingRow.style.display = 'none';
				previewArea.style.display = 'none';
				installBtn.disabled = true;
				this.notificationService.error(`解析失败: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				browseBtn.disabled = false;
			}
		};

		// ── Install button ──
		installBtn.onclick = async () => {
			if (!parsedAgent) { return; }
			const inputs = (installBtn as any)._inputs as Record<string, HTMLInputElement> | undefined;
			if (!inputs) { return; }

			const name = inputs['name']?.value?.trim();
			if (!name) {
				this.notificationService.warn('请输入名称');
				return;
			}

			installBtn.disabled = true;
			installBtn.textContent = '安装中…';

			try {
				const createData: Partial<Agent> = {
					...parsedAgent,
					name,
					role: inputs['role']?.value?.trim() || 'assistant',
					version: inputs['version']?.value?.trim() || '1.0.0',
					description: inputs['description']?.value?.trim() || '',
					source: 'custom',
				};
				await this.agentStudioService.createAgent(createData);
				this.notificationService.info(`✅ Agent "${name}" 安装成功`);
				overlay.remove();
			} catch (err) {
				this.notificationService.error(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
				installBtn.disabled = false;
				installBtn.textContent = '✓ 安装';
			}
		};
	}

	private async _parseAgentFromArchive(archiveUri: URI): Promise<{ agentData: Partial<Agent>; sourceDir: URI }> {
		const tmpDir = resolveSarosPath(this._getSarosRoot(), SarosPath.tmp, `install-${Date.now()}`);
		await this.fileService.createFolder(tmpDir);

		const archivePath = archiveUri.fsPath;
		const extractDir = tmpDir.fsPath;
		try {
			await this.commandService.executeCommand('marketplace.extractTar', { tarFile: archivePath, extractDir });
		} catch {
			throw new Error('无法解压文件，请确保是有效的 tar.gz 包');
		}

		const agentJsonUri = URI.joinPath(tmpDir, 'agent.json');
		if (await this.fileService.exists(agentJsonUri)) {
			const content = await this.fileService.readFile(agentJsonUri);
			const parsed = JSON.parse(content.value.toString());
			return { agentData: parsed.agent || parsed, sourceDir: tmpDir };
		}
		throw new Error('包中未找到 agent.json');
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  OVERLAY HELPER
	// ══════════════════════════════════════════════════════════════════════════

	private _createOverlay(titleText: string): { overlay: HTMLElement; dialog: HTMLElement } {
		const overlay = $$('div.am-overlay');
		overlay.style.position = 'absolute';
		overlay.style.inset = '0';
		overlay.style.background = 'rgba(0,0,0,0.5)';
		overlay.style.display = 'flex';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.zIndex = '1000';
		overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); } };

		const dialog = $$('div.am-dialog');
		dialog.style.background = 'var(--vscode-editor-background)';
		dialog.style.border = '1px solid var(--vscode-panel-border)';
		dialog.style.borderRadius = '8px';
		dialog.style.width = '460px';
		dialog.style.maxWidth = '90vw';
		dialog.style.maxHeight = '85vh';
		dialog.style.overflowY = 'auto';
		dialog.style.boxShadow = '0 8px 32px rgba(0,0,0,0.4)';
		dialog.onclick = (e) => e.stopPropagation();

		// Header
		const head = $$('div.am-dialog-head');
		head.style.display = 'flex';
		head.style.alignItems = 'center';
		head.style.justifyContent = 'space-between';
		head.style.padding = '14px 18px';
		head.style.borderBottom = '1px solid var(--vscode-panel-border)';

		const title = $$('span');
		title.textContent = titleText;
		title.style.fontSize = '14px';
		title.style.fontWeight = '600';
		head.appendChild(title);

		const closeBtn = $$('button') as HTMLButtonElement;
		closeBtn.textContent = '✕';
		closeBtn.style.background = 'none';
		closeBtn.style.border = 'none';
		closeBtn.style.color = 'var(--vscode-descriptionForeground)';
		closeBtn.style.cursor = 'pointer';
		closeBtn.style.fontSize = '16px';
		closeBtn.onclick = () => overlay.remove();
		head.appendChild(closeBtn);
		dialog.appendChild(head);

		overlay.appendChild(dialog);
		this._container?.appendChild(overlay);

		return { overlay, dialog };
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  LIFECYCLE
	// ══════════════════════════════════════════════════════════════════════════

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	override dispose(): void {
		super.dispose();
	}

	private _getSarosRoot(): URI {
		return userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
	}
}
