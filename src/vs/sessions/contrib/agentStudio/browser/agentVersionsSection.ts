/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「版本 / 市场版本」区块（从 `agentSettingsEditorPane.ts` 外提，2026-10-12）。
 *
 * 外提原因：那个 Pane 超了 2500 行的规模预算（`test/common/fileSizeBudget.test.ts` 守着），
 * 而「版本历史 + 商城版本」是一块**自洽的协作对象**：自己建 DOM、自己拉数据、自己渲染、
 * 自己处理回滚/安装/下架。
 *
 * ## 为什么正文是**逐字搬**的
 *
 * 被搬代码对服务与"活状态"的引用一字未改 —— 由下面这批 **getter** 转发到 `deps`：
 *   · 服务：agentVersionService / marketplaceService / notificationService / dialogService / agentStudioService
 *   · 活状态：_agentId / _readOnly / _agent（用**函数**读取，所以"切只读/换 agent"无需同步 push ✓）
 * 于是搬迁只改了 3 个入口名 + 3 处自调用 + 1 处挂载点（`this._tabContentContainer` ⇒ `this._parent`）✓。
 *
 * ## 行为网
 *
 * `test/browser/agentSettingsVersionsSection.test.ts`（21 条，jsdom 真 DOM）在**搬迁前就已全绿**，
 * 搬迁后必须仍全绿 ⇒ 那就是"行为没变"的证据。改这里的行为前先看它 ✓。
 */

import { IAgentVersionService, type AgentCommitMeta } from '../common/agentVersionTypes.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { IMarketplaceService, IMarketplaceVersion, PackageKind } from '../common/marketplace.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { Agent } from '../../../common/agentStudioTypes.js';
import { compareSemver } from './publishVersioning.js';
import { gitUnavailableReason } from './gitVersionCore.js';
import * as DOM from '../../../../base/browser/dom.js';

const { $: $$ } = DOM;

/** 宿主注入面：服务 + 三个"活状态"读取函数（不要传快照值，否则只读/换 agent 会读到旧值 ✗）。 */
export interface IVersionsSectionDeps {
	readonly agentVersionService: IAgentVersionService;
	readonly marketplaceService: IMarketplaceService;
	readonly agentStudioService: IAgentStudioService;
	readonly notificationService: INotificationService;
	readonly dialogService: IDialogService;
	/** 当前 agent id（未打开时可空）。 */
	readonly agentId: () => string | undefined;
	/** 当前是否只读。 */
	readonly readOnly: () => boolean;
	/** 当前 agent（用于本地版本回落）。 */
	readonly agent: () => Agent | undefined;
}

/** 版本 / 商城版本区块。挂在宿主给的父元素上，自管自己的 DOM 与加载状态。 */
export class AgentVersionsSection {

	private readonly _parent: HTMLElement;
	private readonly _deps: IVersionsSectionDeps;

	private _versionsListContainer: HTMLElement | undefined;
	private _marketplaceVersionsContainer: HTMLElement | undefined;
	private _versionsLoading = false;
	private _marketplaceVersionsLoading = false;
	private _versionCommits: AgentCommitMeta[] = [];
	private _localMarketVersion: string | undefined;

	constructor(parent: HTMLElement, deps: IVersionsSectionDeps) {
		this._parent = parent;
		this._deps = deps;
		this.build();
	}

	// ── deps 转发（正文一字未改的关键）──
	private get agentVersionService(): IAgentVersionService { return this._deps.agentVersionService; }
	private get marketplaceService(): IMarketplaceService { return this._deps.marketplaceService; }
	private get agentStudioService(): IAgentStudioService { return this._deps.agentStudioService; }
	private get notificationService(): INotificationService { return this._deps.notificationService; }
	private get dialogService(): IDialogService { return this._deps.dialogService; }
	private get _agentId(): string | undefined { return this._deps.agentId(); }
	private get _readOnly(): boolean { return this._deps.readOnly(); }
	private get _agent(): Agent | undefined { return this._deps.agent(); }

	build(): void {
		const section = $$('div.agent-settings-tab-pane');
		section.dataset.tabPane = 'versions';

		const desc = $$('div.tab-pane-desc');
		desc.textContent = '版本历史记录。每次修改 Agent 系统提示词后会自动生成版本快照，可查看差异或回滚到历史版本。';
		section.appendChild(desc);

		// 工具栏：刷新按钮
		const toolbar = $$('div.versions-toolbar');
		toolbar.style.display = 'flex';
		toolbar.style.alignItems = 'center';
		toolbar.style.gap = '8px';
		toolbar.style.marginBottom = '12px';

		const refreshBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		refreshBtn.textContent = '🔄 刷新';
		refreshBtn.onclick = () => {
			this.refreshHistory();
			this.refreshMarketplace();
		};
		toolbar.appendChild(refreshBtn);

		const hint = $$('span');
		hint.textContent = '点击版本行展开 diff 详情';
		hint.style.fontSize = '11px';
		hint.style.color = 'var(--vscode-descriptionForeground)';
		toolbar.appendChild(hint);
		section.appendChild(toolbar);

		// ── 商城版本区块（Releases）──
		const mkTitle = $$('div.versions-section-title');
		mkTitle.textContent = '商城版本（Releases）';
		mkTitle.style.fontSize = '12px';
		mkTitle.style.fontWeight = '600';
		mkTitle.style.margin = '4px 0 8px 0';
		mkTitle.style.color = 'var(--vscode-foreground)';
		section.appendChild(mkTitle);

		this._marketplaceVersionsContainer = $$('div.marketplace-versions-list');
		this._marketplaceVersionsContainer.style.marginBottom = '16px';
		section.appendChild(this._marketplaceVersionsContainer);

		// ── 本地历史区块（Git）──
		const localTitle = $$('div.versions-section-title');
		localTitle.textContent = '本地历史（Git）';
		localTitle.style.fontSize = '12px';
		localTitle.style.fontWeight = '600';
		localTitle.style.margin = '4px 0 8px 0';
		localTitle.style.color = 'var(--vscode-foreground)';
		section.appendChild(localTitle);

		// 列表容器
		this._versionsListContainer = $$('div.versions-list');
		this._versionsListContainer.style.maxHeight = 'calc(100vh - 320px)';
		this._versionsListContainer.style.overflowY = 'auto';
		this._versionsListContainer.textContent = '点击上方刷新按钮加载版本历史';
		this._versionsListContainer.style.padding = '16px';
		this._versionsListContainer.style.textAlign = 'center';
		this._versionsListContainer.style.color = 'var(--vscode-descriptionForeground)';
		section.appendChild(this._versionsListContainer);

		this._parent.appendChild(section);
	}

	async refreshHistory(): Promise<void> {
		if (!this._agentId || this._versionsLoading) { return; }
		this._versionsLoading = true;

		if (this._versionsListContainer) {
			this._versionsListContainer.textContent = '';
			const loading = $$('div');
			loading.textContent = '⏳ 加载版本历史...';
			loading.style.padding = '16px';
			loading.style.textAlign = 'center';
			loading.style.color = 'var(--vscode-descriptionForeground)';
			this._versionsListContainer.appendChild(loading);
		}

		try {
			// Git 不可用时给出**具体**原因，避免误导为"尚未初始化"或"环境不支持"
			// （桌面端最常见成因是主进程通道未就绪，与运行环境无关）
			if (!this.agentVersionService.isAvailable()) {
				const container = this._versionsListContainer;
				if (container) {
					const reason = gitUnavailableReason();
					container.textContent = reason
						? `Git 版本管理暂不可用：${reason}`
						: '当前环境不支持 Git 版本管理（需在桌面客户端中使用）';
					container.style.padding = '12px 4px';
					container.style.color = 'var(--vscode-descriptionForeground)';
				}
				return;
			}
			this._versionCommits = await this.agentVersionService.history(this._agentId, 50);
			// 兼容旧 agent（版本管理落地前创建、无 .git）：首次打开版本页自动初始化仓库，
			// 与 autoCommit 的懒初始化行为对齐。
			if (this._versionCommits.length === 0) {
				await this.agentVersionService.init(this._agentId);
				this._versionCommits = await this.agentVersionService.history(this._agentId, 50);
			}
			this._renderVersionList();
		} catch (err) {
			if (this._versionsListContainer) {
				this._versionsListContainer.textContent = '';
				const errEl = $$('div');
				errEl.textContent = `加载失败: ${err instanceof Error ? err.message : String(err)}`;
				errEl.style.color = 'var(--vscode-errorForeground)';
				errEl.style.padding = '16px';
				errEl.style.textAlign = 'center';
				this._versionsListContainer.appendChild(errEl);
			}
		} finally {
			this._versionsLoading = false;
		}
	}

	private _renderVersionList(): void {
		if (!this._versionsListContainer) { return; }
		this._versionsListContainer.textContent = '';
		// 有内容时左对齐（初始化时设的 center 仅用于空状态提示）
		this._versionsListContainer.style.textAlign = 'left';

		if (this._versionCommits.length === 0) {
			const empty = $$('div');
			empty.textContent = '暂无版本历史（可能是尚未初始化 Git 仓库）';
			empty.style.padding = '16px';
			empty.style.textAlign = 'center';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			this._versionsListContainer.appendChild(empty);
			return;
		}

		const countEl = $$('div');
		countEl.textContent = `共 ${this._versionCommits.length} 条记录`;
		countEl.style.color = 'var(--vscode-descriptionForeground)';
		countEl.style.fontSize = '11px';
		countEl.style.marginBottom = '8px';
		countEl.style.padding = '0 4px';
		countEl.style.textAlign = 'center';
		this._versionsListContainer.appendChild(countEl);

		for (const c of this._versionCommits) {
			this._versionsListContainer.appendChild(this._renderVersionCommitRow(c));
		}
	}

	private _renderVersionCommitRow(c: AgentCommitMeta): HTMLElement {
		const row = $$('div.version-commit-row');
		row.style.padding = '10px 12px';
		row.style.marginBottom = '6px';
		row.style.border = '1px solid var(--vscode-panel-border, #3c3c3c)';
		row.style.borderRadius = '6px';
		row.style.cursor = 'pointer';
		row.style.transition = 'background 0.15s';
		row.style.textAlign = 'left';

		row.onmouseenter = () => { row.style.background = 'var(--vscode-list-hoverBackground, #2a2d2e)'; };
		row.onmouseleave = () => { row.style.background = ''; };

		// ── 头部：SHA + 时间 ──
		const head = $$('div');
		head.style.display = 'flex';
		head.style.justifyContent = 'space-between';
		head.style.alignItems = 'center';
		head.style.marginBottom = '4px';

		const shaBadge = $$('code');
		shaBadge.textContent = c.shortSha;
		shaBadge.style.fontSize = '11px';
		shaBadge.style.fontFamily = 'monospace';
		shaBadge.style.background = 'var(--vscode-badge-background, #4d4d4d)';
		shaBadge.style.color = 'var(--vscode-badge-foreground, #fff)';
		shaBadge.style.padding = '1px 6px';
		shaBadge.style.borderRadius = '3px';
		head.appendChild(shaBadge);

		const timeEl = $$('span');
		timeEl.textContent = this._formatVersionTime(c.time);
		timeEl.style.fontSize = '10px';
		timeEl.style.color = 'var(--vscode-descriptionForeground)';
		head.appendChild(timeEl);
		row.appendChild(head);

		// ── 消息 ──
		const msg = $$('div');
		msg.textContent = c.message;
		msg.style.fontSize = '12px';
		msg.style.color = 'var(--vscode-foreground)';
		msg.style.marginBottom = '6px';
		msg.style.lineHeight = '1.4';
		msg.style.textAlign = 'left';
		row.appendChild(msg);

		// ── 折叠区：diff + 操作 ──
		const detail = $$('div.version-commit-detail');
		detail.style.display = 'none';
		detail.style.marginTop = '8px';
		detail.style.textAlign = 'left';
		row.appendChild(detail);

		// Diff 文本
		const diffPre = $$('pre');
		diffPre.style.fontSize = '11px';
		diffPre.style.fontFamily = 'monospace';
		diffPre.style.padding = '8px';
		diffPre.style.background = 'var(--vscode-editor-background, #1e1e1e)';
		diffPre.style.borderRadius = '4px';
		diffPre.style.maxHeight = '300px';
		diffPre.style.overflowY = 'auto';
		diffPre.style.whiteSpace = 'pre-wrap';
		diffPre.style.wordBreak = 'break-all';
		diffPre.style.margin = '0 0 8px 0';
		detail.appendChild(diffPre);

		// 操作按钮
		const actions = $$('div');
		actions.style.display = 'flex';
		actions.style.gap = '8px';
		detail.appendChild(actions);

		const rollbackBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		rollbackBtn.textContent = '回滚到此版本';
		rollbackBtn.style.background = 'var(--vscode-inputValidation-warningBackground, #352a05)';
		rollbackBtn.style.border = '1px solid var(--vscode-inputValidation-warningBorder, #b89500)';
		rollbackBtn.style.color = 'var(--vscode-inputValidation-warningForeground, #ccc)';
		rollbackBtn.style.padding = '4px 12px';
		rollbackBtn.style.fontSize = '11px';
		if (this._readOnly) {
			rollbackBtn.disabled = true;
			rollbackBtn.title = '只读模式下不可回滚';
			rollbackBtn.style.opacity = '0.5';
		}
		rollbackBtn.onclick = (e) => {
			e.stopPropagation();
			if (!this._readOnly) { void this._handleVersionRollback(c.sha); }
		};
		actions.appendChild(rollbackBtn);
		detail.appendChild(actions);

		// ── 点击展开/收起 diff ──
		let loaded = false;
		const self = this;
		row.onclick = async () => {
			if (detail.style.display === 'block') {
				detail.style.display = 'none';
				return;
			}
			if (loaded) {
				detail.style.display = 'block';
				return;
			}
			detail.style.display = 'block';
			diffPre.textContent = '加载 diff...';
			try {
				const result = await self.agentVersionService.diff(self._agentId!, c.sha);
				diffPre.textContent = result?.unified || '无差异数据';
				self._colorizeVersionDiff(diffPre);
			} catch (err) {
				diffPre.textContent = `加载失败: ${err instanceof Error ? err.message : String(err)}`;
			}
			loaded = true;
		};

		return row;
	}

	private async _handleVersionRollback(sha: string): Promise<void> {
		if (!this._agentId) { return; }
		try {
			await this.agentVersionService.rollback(this._agentId, sha);
			this.notificationService.info(`Agent 已回滚到版本 ${sha.slice(0, 7)}，请刷新 prompt 页签查看内容`);
			await this.refreshHistory();
		} catch (err) {
			this.notificationService.error(`回滚失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── 商城版本（Releases）──────────────────────────────────────

	async refreshMarketplace(): Promise<void> {
		if (!this._agentId || !this._marketplaceVersionsContainer || this._marketplaceVersionsLoading) { return; }
		this._marketplaceVersionsLoading = true;
		const container = this._marketplaceVersionsContainer;
		container.textContent = '⏳ 加载商城版本...';
		container.style.padding = '12px 4px';
		container.style.color = 'var(--vscode-descriptionForeground)';
		container.style.fontSize = '12px';
		try {
			const [detail, installed] = await Promise.all([
				this.marketplaceService.getPackage(this._agentId),
				this.marketplaceService.getInstalled().catch(() => [] as { kind: string; storeId: string; version?: string }[]),
			]);
			// 本地版本：installed-packages.json 记录优先，fallback 到 agent 声明的 version
			const record = installed.find(e => e.kind === 'agent' && e.storeId === this._agentId);
			this._localMarketVersion = record?.version ?? this._agent?.version;
			this._renderMarketplaceVersions(detail.versions ?? []);
		} catch {
			container.textContent = '尚未发布到商城（或商城不可达）';
		} finally {
			this._marketplaceVersionsLoading = false;
		}
	}

	private _renderMarketplaceVersions(versions: readonly IMarketplaceVersion[]): void {
		const container = this._marketplaceVersionsContainer;
		if (!container) { return; }
		container.textContent = '';
		container.style.padding = '0';
		if (versions.length === 0) {
			container.textContent = '商城暂无已发布版本';
			container.style.padding = '12px 4px';
			container.style.color = 'var(--vscode-descriptionForeground)';
			container.style.fontSize = '12px';
			return;
		}
		// 按版本号降序展示（最新在前）
		const sorted = [...versions].sort((a, b) => compareSemver(b.version, a.version));
		for (const v of sorted) {
			container.appendChild(this._renderMarketplaceVersionRow(v));
		}
	}

	private _renderMarketplaceVersionRow(v: IMarketplaceVersion): HTMLElement {
		const row = $$('div.marketplace-version-row');
		row.style.padding = '8px 12px';
		row.style.marginBottom = '6px';
		row.style.border = '1px solid var(--vscode-panel-border, #3c3c3c)';
		row.style.borderRadius = '6px';
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '8px';

		// 版本号 + latest 徽章
		const verBadge = $$('code');
		verBadge.textContent = `v${v.version}`;
		verBadge.style.fontSize = '11px';
		verBadge.style.fontFamily = 'monospace';
		verBadge.style.background = 'var(--vscode-badge-background, #4d4d4d)';
		verBadge.style.color = 'var(--vscode-badge-foreground, #fff)';
		verBadge.style.padding = '1px 6px';
		verBadge.style.borderRadius = '3px';
		row.appendChild(verBadge);

		if (v.isLatest) {
			const latestBadge = $$('span');
			latestBadge.textContent = 'latest';
			latestBadge.style.fontSize = '10px';
			latestBadge.style.padding = '1px 6px';
			latestBadge.style.borderRadius = '3px';
			latestBadge.style.background = 'var(--vscode-testing-iconPassed, #73c991)';
			latestBadge.style.color = '#000';
			row.appendChild(latestBadge);
		}

		// changelog（截断单行）
		const changelog = $$('span');
		changelog.textContent = v.changelog || '';
		changelog.style.flex = '1';
		changelog.style.fontSize = '11px';
		changelog.style.color = 'var(--vscode-descriptionForeground)';
		changelog.style.overflow = 'hidden';
		changelog.style.textOverflow = 'ellipsis';
		changelog.style.whiteSpace = 'nowrap';
		changelog.title = v.changelog || '';
		row.appendChild(changelog);

		// 安装此版本（商城回滚：覆盖安装旧版本，并写入本地 git 历史）
		// 本地已是该版本时不显示按钮，改为「当前版本」标记
		if (this._localMarketVersion && v.version === this._localMarketVersion) {
			const currentTag = $$('span');
			currentTag.textContent = '当前版本';
			currentTag.style.fontSize = '11px';
			currentTag.style.padding = '2px 10px';
			currentTag.style.borderRadius = '4px';
			currentTag.style.background = 'var(--vscode-badge-background, #4d4d4d)';
			currentTag.style.color = 'var(--vscode-badge-foreground, #fff)';
			row.appendChild(currentTag);
		} else {
			const installBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
			installBtn.textContent = '安装此版本';
			installBtn.style.fontSize = '11px';
			installBtn.style.padding = '2px 10px';
			if (this._readOnly) {
				installBtn.disabled = true;
				installBtn.title = '只读模式下不可安装';
				installBtn.style.opacity = '0.5';
			} else {
				installBtn.onclick = (e) => { e.stopPropagation(); void this._handleInstallMarketVersion(v); };
			}
			row.appendChild(installBtn);
		}

		// 下架（仅作者/owner + 仅最新版本）：历史版本不允许单独下架
		if (this._agent && this.agentStudioService.canUploadAgent(this._agent) && !this._readOnly && v.isLatest) {
			const deleteBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
			deleteBtn.textContent = '下架';
			deleteBtn.style.fontSize = '11px';
			deleteBtn.style.padding = '2px 10px';
			deleteBtn.style.color = 'var(--vscode-errorForeground, #f14c4c)';
			deleteBtn.onclick = (e) => { e.stopPropagation(); void this._handleDeleteMarketVersion(v); };
			row.appendChild(deleteBtn);
		}

		return row;
	}

	/** 安装商城指定版本（含旧版本回滚）：下载覆盖安装 + 本地 git 记录 */
	private async _handleInstallMarketVersion(v: IMarketplaceVersion): Promise<void> {
		if (!this._agentId) { return; }
		try {
			this.notificationService.info(`正在安装 v${v.version}...`);
			await this.marketplaceService.download(this._agentId, v.version, 'agent' as PackageKind);
			// 商城回滚也写入本地 git 历史，保持双轨一致
			try {
				await this.agentVersionService.autoCommit(this._agentId, `install: v${v.version} from marketplace`);
			} catch { /* non-critical */ }
			this.notificationService.info(`已安装 v${v.version}，请重新打开设置页查看内容`);
			this.refreshHistory();
			this.refreshMarketplace();
		} catch (err) {
			this.notificationService.error(`安装 v${v.version} 失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 下架商城指定版本（仅作者）。删除 latest 版本时提示服务端会重算最新版本。 */
	private async _handleDeleteMarketVersion(v: IMarketplaceVersion): Promise<void> {
		if (!this._agentId) { return; }
		const confirm = await this.dialogService.confirm({
			message: `确定下架 v${v.version} 吗？`,
			detail: v.isLatest
				? '该版本是当前最新版本，下架后商城最新版本将回退到次新版本。已安装的用户不受影响。'
				: '下架后其他用户将无法再下载该版本，已安装的用户不受影响。',
			primaryButton: '下架',
			cancelButton: '取消',
		});
		if (!confirm.confirmed) { return; }
		try {
			await this.marketplaceService.deleteVersion(this._agentId, v.version);
			this.notificationService.info(`v${v.version} 已下架`);
			this.refreshMarketplace();
		} catch (err) {
			this.notificationService.error(`下架失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private _formatVersionTime(iso: string): string {
		try {
			const d = new Date(iso);
			return d.toLocaleString('zh-CN', {
				month: '2-digit', day: '2-digit',
				hour: '2-digit', minute: '2-digit',
			});
		} catch { return iso.slice(0, 16); }
	}

	private _colorizeVersionDiff(pre: HTMLElement): void {
		const text = pre.textContent || '';
		const lines = text.split('\n');
		pre.textContent = '';
		for (const line of lines) {
			const span = $$('span');
			if (line.startsWith('+') && !line.startsWith('+++')) {
				span.style.color = 'var(--vscode-testing-iconPassed, #73c991)';
			} else if (line.startsWith('-') && !line.startsWith('---')) {
				span.style.color = 'var(--vscode-testing-iconFailed, #f14c4c)';
			} else if (line.startsWith('@@')) {
				span.style.color = 'var(--vscode-textLink-foreground, #3794ff)';
			}
			span.textContent = line + '\n';
			pre.appendChild(span);
		}
	}
}
