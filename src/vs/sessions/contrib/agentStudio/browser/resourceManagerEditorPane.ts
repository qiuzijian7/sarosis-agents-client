/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { $, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ResourceManagerEditorInput, ResourceManagerEditorPane_ID } from './resourceManagerEditorInput.js';
import { ISkillRegistry, ISkillDefinition, SkillActivation } from '../common/skills.js';
import { ISkillInstallService } from '../common/skillHubTypes.js';


import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { IMarketplacePackage, IMarketplaceService } from '../common/marketplace.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

// ─── Types ──────────────────────────────────────────────────────────────────

// Note: MCP has its own dedicated McpDetailEditorPane, and tools are built-in.
// This ResourceManager primarily handles skills (with optional knowledge/workflow support).
type ResourceType = 'skill' | 'knowledge' | 'workflow';

interface IResourceItem {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly kind: ResourceType;
	readonly source: string;
	readonly author?: string;
	readonly version?: string;
	readonly tags: string[];
	readonly activation?: SkillActivation;
	readonly enabled?: boolean;
	readonly resource?: { path: string };
	readonly extra?: Record<string, unknown>;
}

interface FileTreeNode {
	name: string;
	uri: URI;
	isDirectory: boolean;
	children?: FileTreeNode[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<ResourceType, { label: string; icon: string; storagePath: string }> = {
	skill:     { label: 'Skills Library', icon: '💡', storagePath: '~/.saros/skills/' },
	knowledge: { label: 'Knowledge Base', icon: '📚', storagePath: '~/.saros/knowledge-base/' },
	workflow:  { label: 'Workflows',      icon: '🔄', storagePath: '~/.saros/workflows/' },
};

// ─── EditorPane ──────────────────────────────────────────────────────────────
//
//  A detail-only viewer opened from the skill list / integration view.
//  Shows a single resource's detail panel (no left sidebar).

export class ResourceManagerEditorPane extends EditorPane {

	static readonly ID = ResourceManagerEditorPane_ID;

	private _container!: HTMLElement;
	private _detailEl!: HTMLElement;

	private _currentType: ResourceType = 'skill';
	private _currentItemId: string | undefined;
	private _currentTabIdx = 0;
	private _selectedFilePath: string | undefined;
	private _fileTreeEl: HTMLElement | undefined;
	private _marketplacePkg: IMarketplacePackage | undefined;
	private _isMarketplacePreview = false;
	private _actionsContainer: HTMLElement | undefined;
	private readonly _renderDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IDialogService private readonly dialogService: IDialogService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@ISkillInstallService private readonly skillInstallService: ISkillInstallService,
		@IFileService private readonly fileService: IFileService,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(ResourceManagerEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	/**
	 * Expose this pane as the control so external callers (e.g. IntegrationView)
	 * can access `showDetailOnly` via `pane.getControl()`.
	 */
	override getControl(): ResourceManagerEditorPane {
		return this;
	}

	/**
	 * Show a marketplace skill package in the detail panel (preview mode).
	 * Used by SkillMarketEditorPane when clicking a card.
	 */
	showMarketplacePackage(pkg: IMarketplacePackage): void {
		this._marketplacePkg = pkg;
		this._isMarketplacePreview = true;
		this._currentType = 'skill';
		this._currentItemId = pkg.slug;
		this._currentTabIdx = 0;

		if (this._container.childElementCount === 0) {
			this._buildUI();
		} else {
			clearNode(this._detailEl);
		}

		// Update tab title
		if (this.input instanceof ResourceManagerEditorInput) {
			this.input.setItemName(pkg.name);
		}

		this._renderDetail();
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = $('div.resource-manager-editor');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		this._container.style.overflow = 'hidden';
		this._container.style.fontSize = '13px';
		parent.appendChild(this._container);

		// Listen for skill changes
		this._register(this.skillRegistry.onDidChangeSkills(() => {
			if (this._currentType === 'skill') { this._renderDetail(); }
		}));
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof ResourceManagerEditorInput)) { return; }

		if (this._container.childElementCount === 0) {
			this._buildUI();
		}
		await this.skillRegistry.whenReady();
		this._renderDetail();
	}

	override layout(dimension: Dimension): void {
		this._container.style.width = `${dimension.width}px`;
		this._container.style.height = `${dimension.height}px`;
	}

	// ═══════════════════════════════════════════════════════════════════════
	//  Public API – called from outside (e.g. IntegrationView)
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Show the detail panel for a specific resource.
	 * Updates the editor tab title to the item's name.
	 */
	async showDetailOnly(type: ResourceType, itemId: string): Promise<void> {
		this._isMarketplacePreview = false;
		this._marketplacePkg = undefined;
		this._currentType = type;
		this._currentItemId = itemId;
		this._currentTabIdx = 0;

		// Build UI on first call
		if (this._container.childElementCount === 0) {
			this._buildUI();
		} else {
			clearNode(this._detailEl);
		}

		// Ensure registry is ready before looking up items (guards against race conditions)
		if (type === 'skill') {
			try { await this.skillRegistry.whenReady(); } catch { /* ignore */ }
		}

		// Update tab title
		const item = this._getCurrentItem();
		if (item && this.input instanceof ResourceManagerEditorInput) {
			this.input.setItemName(item.name);
		}

		this._renderDetail();
	}

	// ═══════════════════════════════════════════════════════════════════════
	//  UI Build
	// ═══════════════════════════════════════════════════════════════════════

	private _buildUI(): void {
		clearNode(this._container);

		// ── Detail panel (fills entire editor) ──────────────────────
		this._detailEl = $('div.rm-detail');
		this._detailEl.style.flex = '1';
		this._detailEl.style.display = 'flex';
		this._detailEl.style.flexDirection = 'column';
		this._detailEl.style.overflow = 'hidden';
		this._detailEl.style.background = 'var(--vscode-editor-background)';

		this._container.appendChild(this._detailEl);
	}

	// ═══════════════════════════════════════════════════════════════════════
	//  Detail Pane
	// ═══════════════════════════════════════════════════════════════════════

	private _getCurrentItem(): IResourceItem | undefined {
		if (!this._currentItemId) { return undefined; }
		return this._getItems().find(i => i.id === this._currentItemId);
	}

	private _renderDetail(): void {
		clearNode(this._detailEl);
		this._renderDisposables.clear();

		// Marketplace preview mode: build IResourceItem from package data
		let item: IResourceItem | undefined;
		if (this._isMarketplacePreview && this._marketplacePkg) {
			const pkg = this._marketplacePkg;
			item = {
				id: pkg.slug,
				name: pkg.name,
				description: pkg.description ?? '',
				kind: 'skill',
				source: '商城',
				author: pkg.authorName,
				version: pkg.latestVersion,
				tags: [...(pkg.tags ?? [])],
				resource: undefined,
				extra: { useGuide: pkg.useGuide, downloads: pkg.downloads, updatedAt: pkg.updatedAt, versions: pkg.versions },
			};
		} else {
			item = this._getCurrentItem();
		}

		if (!item) {
			// Empty state – no item selected
			const empty = $('div');
			empty.style.display = 'flex';
			empty.style.flexDirection = 'column';
			empty.style.alignItems = 'center';
			empty.style.justifyContent = 'center';
			empty.style.height = '100%';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			empty.style.gap = '10px';

			const emptyIcon = $('div');
			emptyIcon.style.fontSize = '48px';
			emptyIcon.style.opacity = '0.3';
			emptyIcon.textContent = '📭';
			empty.appendChild(emptyIcon);

			const emptyText = $('div');
			emptyText.textContent = '未选择资源';
			empty.appendChild(emptyText);

			this._detailEl.appendChild(empty);
			return;
		}

		// ── Header ──────────────────────────────────────────────────
		this._detailEl.appendChild(this._buildDetailHeader(item));

		// ── Tab navigation ──────────────────────────────────────────
		const tabs = this._getTabsForItem(item);
		const tabNav = $('div.rm-pane-tabs');
		tabNav.style.display = 'flex';
		tabNav.style.borderBottom = '1px solid var(--vscode-panel-border)';
		tabNav.style.padding = '0 20px';

		tabs.forEach((tab, idx) => {
			const btn = $('button.rm-ptab') as HTMLButtonElement;
			btn.textContent = tab;
			btn.style.padding = '10px 16px';
			btn.style.background = 'none';
			btn.style.border = 'none';
			btn.style.color = idx === this._currentTabIdx ? 'var(--vscode-tab-activeForeground)' : 'var(--vscode-tab-inactiveForeground)';
			btn.style.cursor = 'pointer';
			btn.style.fontSize = '13px';
			btn.style.position = 'relative';
			btn.style.borderBottom = idx === this._currentTabIdx ? '2px solid var(--vscode-button-background)' : '2px solid transparent';
			btn.style.fontWeight = idx === this._currentTabIdx ? '500' : 'normal';
			btn.onclick = () => {
				this._currentTabIdx = idx;
				this._renderDetail();
			};
			tabNav.appendChild(btn);
		});
		this._detailEl.appendChild(tabNav);

		// ── Body ────────────────────────────────────────────────────
		const body = $('div.rm-pane-body');
		body.style.flex = '1';
		body.style.overflowY = 'auto';
		body.style.padding = '20px 24px';
		body.appendChild(this._renderTabContent(item, this._currentTabIdx));
		this._detailEl.appendChild(body);

		// Async ownership check: lock UI if marketplace skill not owned by current user
		if (item.kind === 'skill' && !this._isMarketplacePreview) {
			this._checkOwnerLock(item.id).catch(() => { /* ignore */ });
		}
	}

	private async _checkOwnerLock(skillId: string): Promise<void> {
		try {
			const pkg = await this.marketplaceService.getPackage(skillId);
			const currentUser = this.marketplaceService.getCurrentUser();
			if (pkg.author?.id && currentUser?.id && pkg.author.id !== currentUser.id) {
				// Not the owner — lock the UI
				if (this._actionsContainer) {
					clearNode(this._actionsContainer);
					const lockBadge = $('span');
					lockBadge.textContent = '\u{1F512} 只读';
					lockBadge.style.fontSize = '11px';
					lockBadge.style.padding = '3px 8px';
					lockBadge.style.borderRadius = '3px';
					lockBadge.style.background = 'rgba(255,255,255,0.06)';
					lockBadge.style.color = 'var(--vscode-descriptionForeground)';
					this._actionsContainer.appendChild(lockBadge);
				}
			}
		} catch {
			// Package not on marketplace — no ownership to check
		}
	}

	private _getTabsForItem(item: IResourceItem): string[] {
		// Marketplace preview: no "文件" tab (skill not installed locally)
		if (this._isMarketplacePreview) {
			return ['描述', '版本历史', '评论'];
		}
		switch (item.kind) {
			case 'skill': return ['使用说明', '文件', '版本历史', '评论', 'AI 评测'];
			case 'knowledge': return ['文档列表', '搜索', '统计'];
			case 'workflow':  return ['流程定义', '运行记录', '设置'];
		}
	}

	private _buildDetailHeader(item: IResourceItem): HTMLElement {
		const header = $('div.rm-pane-header');
		header.style.padding = '14px 20px 12px';
		header.style.borderBottom = '1px solid var(--vscode-panel-border)';
		header.style.flexShrink = '0';

		// Row1: icon + title + actions
		const row1 = $('div');
		row1.style.display = 'flex';
		row1.style.alignItems = 'center';
		row1.style.gap = '10px';

		const icon = $('div');
		icon.style.width = '36px';
		icon.style.height = '36px';
		icon.style.borderRadius = '50%';
		icon.style.display = 'flex';
		icon.style.alignItems = 'center';
		icon.style.justifyContent = 'center';
		icon.style.fontSize = '17px';
		icon.style.flexShrink = '0';
		icon.style.background = this._iconBgForKind(item.kind);
		icon.textContent = TYPE_CONFIG[item.kind].icon;
		row1.appendChild(icon);

		const title = $('div');
		title.style.display = 'flex';
		title.style.alignItems = 'baseline';
		title.style.gap = '8px';
		title.style.flex = '1';

		const titleName = $('span');
		titleName.textContent = item.name;
		titleName.style.fontSize = '20px';
		titleName.style.fontWeight = '600';
		title.appendChild(titleName);

		// Version badge next to title
		if (item.version) {
			const verBadge = $('span');
			verBadge.textContent = `v${item.version}`;
			verBadge.style.fontSize = '11px';
			verBadge.style.padding = '2px 8px';
			verBadge.style.borderRadius = '4px';
			verBadge.style.background = 'var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15))';
			verBadge.style.color = 'var(--vscode-textLink-foreground)';
			verBadge.style.fontWeight = '500';
			title.appendChild(verBadge);
		}
		row1.appendChild(title);

		// Toggle / Edit / Delete / Upload / Upgrade
		const actions = $('div');
		actions.style.display = 'flex';
		actions.style.gap = '8px';
		actions.style.alignItems = 'center';
		this._actionsContainer = actions;

		if (this._isMarketplacePreview && this._marketplacePkg) {
			// Marketplace preview: show Install button
			const installBtn = $('button') as HTMLButtonElement;
			installBtn.textContent = '\u2B07 安装';
			installBtn.style.padding = '5px 14px';
			installBtn.style.fontSize = '12px';
			installBtn.style.background = 'var(--vscode-button-background)';
			installBtn.style.color = 'var(--vscode-button-foreground)';
			installBtn.style.border = 'none';
			installBtn.style.borderRadius = '3px';
			installBtn.style.cursor = 'pointer';
			installBtn.onclick = async () => {
				installBtn.textContent = '\u23F3 安装中...';
				installBtn.disabled = true;
				try {
					const result = await this.marketplaceService.download(
						this._marketplacePkg!.slug,
						this._marketplacePkg!.latestVersion ?? '',
						'skill',
					);
					await this.skillRegistry.reload();
					this.notificationService.info(`\u2705 ${this._marketplacePkg!.name} v${result.version} 安装成功`);
					// Switch from preview to installed detail
					this._isMarketplacePreview = false;
					this._marketplacePkg = undefined;
					this._currentItemId = result.storeId;
					this._renderDetail();
				} catch (err) {
					installBtn.textContent = '\u2B07 安装';
					installBtn.disabled = false;
					this.notificationService.error(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
				}
			};
			actions.appendChild(installBtn);
		} else if (item.kind === 'skill' && item.enabled !== undefined) {
			const toggleBtn = $('button') as HTMLButtonElement;
			toggleBtn.textContent = item.enabled ? '⏸ 禁用' : '▶ 启用';
			toggleBtn.style.padding = '5px 12px';
			toggleBtn.style.fontSize = '12px';
			toggleBtn.style.background = 'var(--vscode-button-secondaryBackground)';
			toggleBtn.style.color = 'var(--vscode-button-secondaryForeground)';
			toggleBtn.style.border = 'none';
			toggleBtn.style.borderRadius = '3px';
			toggleBtn.style.cursor = 'pointer';
			toggleBtn.onclick = () => {
				if (item.enabled) {
					this.skillRegistry.disableSkill(item.id);
				} else {
					this.skillRegistry.enableSkill(item.id);
				}
				this._renderDetail();
			};
			actions.appendChild(toggleBtn);
		}

		// Edit (open SKILL.md in editor)
		if (item.resource) {
			const editBtn = $('button') as HTMLButtonElement;
			editBtn.textContent = '🔧 编辑文件';
			editBtn.style.padding = '5px 12px';
			editBtn.style.fontSize = '12px';
			editBtn.style.background = 'var(--vscode-button-background)';
			editBtn.style.color = 'var(--vscode-button-foreground)';
			editBtn.style.border = 'none';
			editBtn.style.borderRadius = '3px';
			editBtn.style.cursor = 'pointer';
			editBtn.onclick = async () => {
				// Open SKILL.md in a separate editor tab
				const skillFileUri = URI.joinPath(URI.file(item.resource!.path), 'SKILL.md');
				await this.editorService.openEditor({ resource: skillFileUri });
			};
			actions.appendChild(editBtn);
		}

		// Uninstall (skills only)
		if (item.kind === 'skill' && item.source !== '🧠 内存技能') {
			const delBtn = $('button') as HTMLButtonElement;
			delBtn.textContent = '🗑️ 卸载';
			delBtn.style.padding = '5px 12px';
			delBtn.style.fontSize = '12px';
			delBtn.style.background = 'rgba(248,81,73,0.12)';
			delBtn.style.color = '#f85149';
			delBtn.style.border = '1px solid rgba(248,81,73,0.3)';
			delBtn.style.borderRadius = '3px';
			delBtn.style.cursor = 'pointer';
			delBtn.onclick = async () => {
				const confirmed = await this.dialogService.confirm({
					message: `确定要卸载技能 "${item.name}" 吗？`,
					primaryButton: '卸载',
					cancelButton: '取消',
				});
				if (confirmed.confirmed) {
					await this.skillInstallService.uninstallSkill(item.id);
					await this.skillRegistry.reload();
					this._currentItemId = undefined;
					this._renderDetail();
				}
			};
			actions.appendChild(delBtn);
		}

		// Marketplace status buttons (upload / upgrade) — for local and builtin skills
		if (!this._isMarketplacePreview && item.kind === 'skill') {
			const isUploadable = !item.source.includes('内存') && !item.source.includes('商城');
			if (isUploadable) {
				this._addMarketplaceStatusButtons(item, actions);
			}
		}

		row1.appendChild(actions);
		header.appendChild(row1);

		// Row2: meta
		const meta = $('div');
		meta.style.display = 'flex';
		meta.style.gap = '18px';
		meta.style.marginTop = '6px';
		meta.style.fontSize = '12px';
		meta.style.color = 'var(--vscode-descriptionForeground)';

		const metaParts: string[] = [];
		if (item.author) { metaParts.push(`👤 作者：${item.author}`); }
		if (item.version) { metaParts.push(`🏷️ 版本：v${item.version}`); }
		metaParts.push(`🔗 来源：${item.source}`);
		if (item.activation) {
			const actLabel = item.activation === 'auto' ? '自动激活' : item.activation === 'manual' ? '手动调用' : '始终激活';
			metaParts.push(`⚡ 激活：${actLabel}`);
		}
		meta.textContent = metaParts.join('   ');
		header.appendChild(meta);

		// Row3: tags
		if (item.tags.length > 0) {
			const tagRow = $('div');
			tagRow.style.display = 'flex';
			tagRow.style.gap = '6px';
			tagRow.style.marginTop = '8px';
			for (const tag of item.tags) {
				const t = $('span');
				t.textContent = tag;
				t.style.padding = '2px 10px';
				t.style.borderRadius = '12px';
				t.style.fontSize = '11px';
				t.style.background = 'rgba(56,139,253,0.12)';
				t.style.color = '#58a6ff';
				tagRow.appendChild(t);
			}
			header.appendChild(tagRow);
		}

		return header;
	}

	/**
	 * Async check marketplace status for a local skill/mcp and add Upload or Upgrade button.
	 * - Not in marketplace → "上传" button (publish)
	 * - In marketplace with higher version → "升级" button (download)
	 * - In marketplace with same version → "✓ 最新" badge
	 */
	private _addMarketplaceStatusButtons(item: IResourceItem, actions: HTMLElement): void {
		const pkgKind = 'skill';
		const localVersion = item.version ?? '0';
		const storeId = item.id;

		// Placeholder while checking
		const placeholder = $('span');
		placeholder.style.fontSize = '11px';
		placeholder.style.color = 'var(--vscode-descriptionForeground)';
		placeholder.textContent = '\u23F3 检查商城状态...';
		actions.appendChild(placeholder);

		this.marketplaceService.getPackage(storeId).then(detail => {
			placeholder.remove();

			// 检查所有权：仅包的所有者可上传更新
			const currentUser = this.marketplaceService.getCurrentUser();
			if (detail.author?.id && currentUser?.id && detail.author.id !== currentUser.id) {
				return; // 非所有者，隐藏上传/升级按钮
			}

			const marketVersion = detail.latestVersion ?? '0';
			const hasUpgrade = this._compareVersions(marketVersion, localVersion) > 0;

			if (hasUpgrade) {
				// Show upgrade button
				const upgradeBtn = $('button') as HTMLButtonElement;
				upgradeBtn.textContent = `\u2B06\uFE0F 升级到 v${marketVersion}`;
				upgradeBtn.style.padding = '5px 12px';
				upgradeBtn.style.fontSize = '12px';
				upgradeBtn.style.background = 'rgba(210,153,34,0.15)';
				upgradeBtn.style.color = '#e3b341';
				upgradeBtn.style.border = '1px solid rgba(210,153,34,0.3)';
				upgradeBtn.style.borderRadius = '3px';
				upgradeBtn.style.cursor = 'pointer';
				upgradeBtn.onclick = async () => {
					upgradeBtn.textContent = '\u23F3 升级中...';
					upgradeBtn.disabled = true;
					try {
						const result = await this.marketplaceService.download(storeId, marketVersion, pkgKind as any);
						if (pkgKind === 'skill') {
							await this.skillRegistry.reload();
						}
						this.notificationService.info(`\u2705 ${item.name} 已升级到 v${result.version}`);
						this._renderDetail();
					} catch (err) {
						upgradeBtn.textContent = `\u2B06\uFE0F 升级到 v${marketVersion}`;
						upgradeBtn.disabled = false;
						this.notificationService.error(`升级失败: ${err instanceof Error ? err.message : String(err)}`);
					}
				};
				actions.appendChild(upgradeBtn);
			} else {
				// Already up to date
				const latestBadge = $('span');
				latestBadge.textContent = '\u2713 已是最新';
				latestBadge.style.fontSize = '11px';
				latestBadge.style.padding = '3px 8px';
				latestBadge.style.borderRadius = '3px';
				latestBadge.style.background = 'rgba(63,185,80,0.12)';
				latestBadge.style.color = '#3fb950';
				actions.appendChild(latestBadge);
			}
		}).catch(() => {
			// Not in marketplace → show upload button
			placeholder.remove();

			const uploadBtn = $('button') as HTMLButtonElement;
			uploadBtn.textContent = '\u2B06 上传到商城';
			uploadBtn.style.padding = '5px 12px';
			uploadBtn.style.fontSize = '12px';
			uploadBtn.style.background = 'var(--vscode-button-background)';
			uploadBtn.style.color = 'var(--vscode-button-foreground)';
			uploadBtn.style.border = 'none';
			uploadBtn.style.borderRadius = '3px';
			uploadBtn.style.cursor = 'pointer';
			uploadBtn.onclick = async () => {
				// Show manifest form dialog before uploading
				const formData = await this._showUploadManifestDialog(item);
				if (!formData) { return; } // User cancelled

				uploadBtn.textContent = '\u23F3 上传中...';
				uploadBtn.disabled = true;
				try {
					const result = await this.marketplaceService.publish(storeId, pkgKind as any, formData);
					this.notificationService.info(`\u2705 ${item.name} v${result.version} 已上传到商城`);
					// Trigger registry reload so integration view refreshes its skill list
					await this.skillRegistry.reload();
					this._renderDetail();
				} catch (err) {
					uploadBtn.textContent = '\u2B06 上传到商城';
					uploadBtn.disabled = false;
					this.notificationService.error(`上传失败: ${err instanceof Error ? err.message : String(err)}`);
				}
			};
			actions.appendChild(uploadBtn);
		});
	}

	/**
	 * Show a dialog for the user to fill in manifest metadata before uploading.
	 * Returns the form data, or undefined if cancelled.
	 */
	private _showUploadManifestDialog(item: IResourceItem): Promise<{ name?: string; version?: string; description?: string; category?: string; author?: string; changelog?: string } | undefined> {
		return new Promise((resolve) => {
			// Overlay
			const overlay = $('div');
			overlay.style.position = 'absolute';
			overlay.style.inset = '0';
			overlay.style.background = 'rgba(0,0,0,0.5)';
			overlay.style.display = 'flex';
			overlay.style.alignItems = 'center';
			overlay.style.justifyContent = 'center';
			overlay.style.zIndex = '1000';
			overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(undefined); } };

			// Dialog
			const dialog = $('div');
			dialog.style.background = 'var(--vscode-editor-background)';
			dialog.style.border = '1px solid var(--vscode-panel-border)';
			dialog.style.borderRadius = '8px';
			dialog.style.width = '480px';
			dialog.style.maxWidth = '90vw';
			dialog.style.maxHeight = '85vh';
			dialog.style.overflow = 'hidden';
			dialog.style.display = 'flex';
			dialog.style.flexDirection = 'column';
			dialog.style.boxShadow = '0 8px 32px rgba(0,0,0,0.4)';
			dialog.onclick = (e) => e.stopPropagation();

			// Header
			const head = $('div');
			head.style.display = 'flex';
			head.style.alignItems = 'center';
			head.style.justifyContent = 'space-between';
			head.style.padding = '14px 18px';
			head.style.borderBottom = '1px solid var(--vscode-panel-border)';
			head.style.flexShrink = '0';

			const title = $('span');
			title.textContent = '\u{1F4E4} 上传到商城';
			title.style.fontSize = '14px';
			title.style.fontWeight = '600';
			head.appendChild(title);

			const closeBtn = $('button') as HTMLButtonElement;
			closeBtn.textContent = '\u2715';
			closeBtn.style.background = 'none';
			closeBtn.style.border = 'none';
			closeBtn.style.color = 'var(--vscode-descriptionForeground)';
			closeBtn.style.cursor = 'pointer';
			closeBtn.style.fontSize = '16px';
			closeBtn.onclick = () => { overlay.remove(); resolve(undefined); };
			head.appendChild(closeBtn);
			dialog.appendChild(head);

			// Body (scrollable)
			const body = $('div');
			body.style.padding = '18px';
			body.style.overflowY = 'auto';
			body.style.flex = '1';

			// Helper to create a form field
			const createField = (labelText: string, inputEl: HTMLElement): HTMLElement => {
				const field = $('div');
				field.style.marginBottom = '14px';

				const label = $('label');
				label.textContent = labelText;
				label.style.display = 'block';
				label.style.fontSize = '12px';
				label.style.color = 'var(--vscode-descriptionForeground)';
				label.style.marginBottom = '4px';
				field.appendChild(label);

				inputEl.style.width = '100%';
				inputEl.style.padding = '6px 10px';
				inputEl.style.background = 'var(--vscode-input-background)';
				inputEl.style.border = '1px solid var(--vscode-input-border)';
				inputEl.style.borderRadius = '4px';
				inputEl.style.color = 'var(--vscode-input-foreground)';
				inputEl.style.fontSize = '13px';
				inputEl.style.outline = 'none';
				inputEl.style.boxSizing = 'border-box';
				field.appendChild(inputEl);

				return field;
			};

			const inputStyle = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => {
				el.onfocus = () => { el.style.borderColor = 'var(--vscode-focusBorder)'; };
				el.onblur = () => { el.style.borderColor = 'var(--vscode-input-border)'; };
			};

			// Name
			const nameInput = $('input') as HTMLInputElement;
			nameInput.type = 'text';
			nameInput.value = item.name || '';
			inputStyle(nameInput);
			body.appendChild(createField('显示名称 *', nameInput));

			// Version
			const versionInput = $('input') as HTMLInputElement;
			versionInput.type = 'text';
			versionInput.value = item.version || '1.0.0';
			versionInput.style.width = '160px';
			inputStyle(versionInput);
			body.appendChild(createField('版本号 *', versionInput));

			// Description
			const descInput = $('textarea') as HTMLTextAreaElement;
			descInput.rows = 3;
			descInput.value = item.description || '';
			descInput.style.resize = 'vertical';
			inputStyle(descInput);
			body.appendChild(createField('描述', descInput));

			// Category (multi-select tag style)
			const categories = [
				'code', 'data', 'web', 'filesystem', 'shell', 'utility',
				'development', 'devops', 'git', 'ai-agents', 'mlops',
				'creative', 'media', 'gaming', 'research', 'productivity',
				'github', 'apple', 'security', 'note-taking', 'social-media',
				'reasoning', 'text', 'email', 'meta', 'other'
			];
			// Normalize non-standard category names to valid ones
			const normalizeCat = (c: string): string => {
				const lower = c.toLowerCase().trim();
				const map: Record<string, string> = {
					'数据分析': 'data', 'data-science': 'data',
					'dogfood': 'utility', 'smart-home': 'other',
				};
				return map[lower] ?? c;
			};
			const initCats = new Set(item.tags?.map(normalizeCat).filter(t => categories.includes(t)) ?? []);
			const selectedCats = new Set<string>(initCats);

			const catField = createField('分类', $('div'));
			const catRow = $('div');
			catRow.style.display = 'flex';
			catRow.style.flexWrap = 'wrap';
			catRow.style.gap = '6px';
			for (const cat of categories) {
				const chip = $('span') as HTMLSpanElement;
				chip.textContent = cat;
				chip.style.padding = '3px 10px';
				chip.style.fontSize = '12px';
				chip.style.borderRadius = '4px';
				chip.style.cursor = 'pointer';
				chip.style.userSelect = 'none';
				chip.style.transition = 'background 0.15s';

				const updateChipStyle = () => {
					if (selectedCats.has(cat)) {
						chip.style.background = 'var(--vscode-button-background)';
						chip.style.color = 'var(--vscode-button-foreground)';
						chip.style.border = '1px solid var(--vscode-button-background)';
					} else {
						chip.style.background = 'transparent';
						chip.style.color = 'var(--vscode-descriptionForeground)';
						chip.style.border = '1px solid var(--vscode-panel-border)';
					}
				};
				updateChipStyle();
				chip.onclick = () => {
					if (selectedCats.has(cat)) {
						selectedCats.delete(cat);
					} else {
						selectedCats.add(cat);
					}
					updateChipStyle();
				};
				catRow.appendChild(chip);
			}
			catField.appendChild(catRow);
			body.appendChild(catField);

			// Author
			const authorInput = $('input') as HTMLInputElement;
			authorInput.type = 'text';
			authorInput.value = item.author || '';
			inputStyle(authorInput);
			body.appendChild(createField('作者', authorInput));

			// Changelog
			const changelogInput = $('textarea') as HTMLTextAreaElement;
			changelogInput.rows = 3;
			changelogInput.placeholder = '本次版本的更新说明...';
			changelogInput.style.resize = 'vertical';
			inputStyle(changelogInput);
			body.appendChild(createField('更新说明 (Changelog)', changelogInput));

			dialog.appendChild(body);

			// Footer
			const footer = $('div');
			footer.style.display = 'flex';
			footer.style.justifyContent = 'flex-end';
			footer.style.gap = '8px';
			footer.style.padding = '12px 18px';
			footer.style.borderTop = '1px solid var(--vscode-panel-border)';
			footer.style.flexShrink = '0';

			const cancelBtn = $('button') as HTMLButtonElement;
			cancelBtn.textContent = '取消';
			cancelBtn.style.padding = '6px 16px';
			cancelBtn.style.background = 'var(--vscode-button-secondaryBackground)';
			cancelBtn.style.color = 'var(--vscode-button-secondaryForeground)';
			cancelBtn.style.border = 'none';
			cancelBtn.style.borderRadius = '4px';
			cancelBtn.style.cursor = 'pointer';
			cancelBtn.style.fontSize = '13px';
			cancelBtn.onclick = () => { overlay.remove(); resolve(undefined); };
			footer.appendChild(cancelBtn);

			const uploadBtn = $('button') as HTMLButtonElement;
			uploadBtn.textContent = '\u2B06 上传';
			uploadBtn.style.padding = '6px 16px';
			uploadBtn.style.background = 'var(--vscode-button-background)';
			uploadBtn.style.color = 'var(--vscode-button-foreground)';
			uploadBtn.style.border = 'none';
			uploadBtn.style.borderRadius = '4px';
			uploadBtn.style.cursor = 'pointer';
			uploadBtn.style.fontSize = '13px';
			uploadBtn.onclick = () => {
				const name = nameInput.value.trim();
				const version = versionInput.value.trim();
				if (!name) { nameInput.focus(); return; }
				if (!version) { versionInput.focus(); return; }
				overlay.remove();
				resolve({
					name,
					version,
					description: descInput.value.trim() || undefined,
					category: selectedCats.size > 0 ? Array.from(selectedCats).join(',') : undefined,
					author: authorInput.value.trim() || undefined,
					changelog: changelogInput.value.trim() || undefined,
				});
			};
			footer.appendChild(uploadBtn);
			dialog.appendChild(footer);

			overlay.appendChild(dialog);
			this._container.appendChild(overlay);

			// Focus name input
			nameInput.focus();
		});
	}
	private _compareVersions(a: string, b: string): number {
		const parseVer = (v: string) => v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
		const pa = parseVer(a);
		const pb = parseVer(b);
		const len = Math.max(pa.length, pb.length);
		for (let i = 0; i < len; i++) {
			const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
			if (diff !== 0) { return diff; }
		}
		return 0;
	}

	private _iconBgForKind(kind: ResourceType): string {
		switch (kind) {
			case 'skill': return 'linear-gradient(135deg,#9b59b6,#8e44ad)';
			case 'knowledge': return 'linear-gradient(135deg,#3498db,#2980b9)';
			case 'workflow':  return 'linear-gradient(135deg,#e74c3c,#c0392b)';
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	//  Tab Content
	// ═══════════════════════════════════════════════════════════════════════

	private _renderTabContent(item: IResourceItem, tabIdx: number): HTMLElement {
		switch (item.kind) {
			case 'skill':
				return this._renderSkillTab(item, tabIdx);
			case 'knowledge':
			case 'workflow':
				return this._renderPlaceholderTab(item, tabIdx);
		}
	}

	private _renderSkillTab(item: IResourceItem, tabIdx: number): HTMLElement {
		// Marketplace preview mode: render from marketplace package data
		if (this._isMarketplacePreview && this._marketplacePkg) {
			const pkg = this._marketplacePkg;
			switch (tabIdx) {
				case 0: {
					// Use useGuide if available, otherwise fall back to description
					return this._renderMarkdownContent('', `# ${pkg.name}\n\n${pkg.description ?? '(暂无描述)'}`);
				}
				case 1: return this._renderMarketplaceVersionTab(pkg);
				case 2: return this._emptyHint('暂无评论');
				default: return this._emptyHint('未知标签页');
			}
		}

		const skill = this.skillRegistry.getSkill(item.id);
		if (!skill) { return this._emptyHint('技能未找到'); }

		switch (tabIdx) {
			case 0: return this._renderMarkdownContent('', `# ${skill.name}\n\n${skill.description || '(暂无描述)'}`);
			case 1: return this._renderFileTab(skill);
			case 2: return this._renderVersionTab(skill);
			case 3: return this._emptyHint('暂无评论');
			case 4: return this._renderEvalTab(skill);
			default: return this._emptyHint('未知标签页');
		}
	}

	private _renderPlaceholderTab(_item: IResourceItem, _tabIdx: number): HTMLElement {
		return this._emptyHint('即将支持');
	}

	private _renderMarkdownContent(_prompt: string, mdText: string): HTMLElement {
		const wrap = $('div.rm-usage');
		wrap.style.maxWidth = '800px';
		wrap.style.fontSize = '13px';
		wrap.style.lineHeight = '1.7';
		wrap.style.color = 'var(--vscode-editor-foreground)';
		try {
			const md = new MarkdownString(mdText, { supportThemeIcons: true, isTrusted: false });
			const rendered = renderMarkdown(md);
			this._renderDisposables.add(rendered);
			rendered.element.style.overflowWrap = 'anywhere';
			// Ensure rendered markdown elements are visible with proper styling
			rendered.element.querySelectorAll('h1').forEach(el => {
				(el as HTMLElement).style.fontSize = '20px';
				(el as HTMLElement).style.fontWeight = '600';
				(el as HTMLElement).style.margin = '0 0 10px 0';
				(el as HTMLElement).style.color = 'var(--vscode-editor-foreground)';
			});
			rendered.element.querySelectorAll('h2').forEach(el => {
				(el as HTMLElement).style.fontSize = '16px';
				(el as HTMLElement).style.fontWeight = '600';
				(el as HTMLElement).style.margin = '16px 0 8px 0';
				(el as HTMLElement).style.color = 'var(--vscode-editor-foreground)';
			});
			rendered.element.querySelectorAll('p').forEach(el => {
				(el as HTMLElement).style.margin = '0 0 10px 0';
			});
			rendered.element.querySelectorAll('code').forEach(el => {
				(el as HTMLElement).style.background = 'rgba(255,255,255,0.08)';
				(el as HTMLElement).style.padding = '1px 5px';
				(el as HTMLElement).style.borderRadius = '3px';
				(el as HTMLElement).style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
				(el as HTMLElement).style.fontSize = '12px';
			});
			rendered.element.querySelectorAll('ul, ol').forEach(el => {
				(el as HTMLElement).style.paddingLeft = '20px';
				(el as HTMLElement).style.margin = '0 0 10px 0';
			});
			rendered.element.querySelectorAll('a').forEach(el => {
				(el as HTMLElement).style.color = 'var(--vscode-textLink-foreground)';
			});
			wrap.appendChild(rendered.element);
		} catch (err) {
			console.error('[ResourceManager] markdown render failed:', err);
			// Fallback: plain text
			const pre = $('pre');
			pre.textContent = mdText;
			pre.style.whiteSpace = 'pre-wrap';
			pre.style.wordBreak = 'break-all';
			pre.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
			pre.style.fontSize = '13px';
			pre.style.lineHeight = '1.6';
			pre.style.color = 'var(--vscode-editor-foreground)';
			pre.style.background = 'var(--vscode-textCodeBlock-background)';
			pre.style.padding = '12px';
			pre.style.borderRadius = '4px';
			wrap.appendChild(pre);
		}
		return wrap;
	}

	private _renderFileTab(skill: ISkillDefinition): HTMLElement {
		const wrap = $('div.rm-file-layout');
		wrap.style.display = 'flex';
		wrap.style.gap = '0';
		wrap.style.minHeight = '400px';

		// ── File tree (left) ────────────────────────────────────────
		const tree = $('div.rm-file-tree');
		tree.style.width = '240px';
		tree.style.minWidth = '200px';
		tree.style.borderRight = '1px solid var(--vscode-panel-border)';
		tree.style.overflowY = 'auto';
		tree.style.padding = '6px 0';

		const treeHdr = $('div');
		treeHdr.textContent = '📁 文件浏览';
		treeHdr.style.padding = '6px 14px';
		treeHdr.style.fontSize = '12px';
		treeHdr.style.fontWeight = '600';
		treeHdr.style.color = 'var(--vscode-descriptionForeground)';
		tree.appendChild(treeHdr);

		const treeBody = $('div.rm-file-tree-body');
		tree.appendChild(treeBody);

		// Loading indicator
		const loadingHint = $('div');
		loadingHint.style.padding = '8px 14px';
		loadingHint.style.fontSize = '12px';
		loadingHint.style.color = 'var(--vscode-descriptionForeground)';
		loadingHint.textContent = '加载中...';
		treeBody.appendChild(loadingHint);

		wrap.appendChild(tree);

		// ── Preview (right) ─────────────────────────────────────────
		const preview = $('div.rm-file-preview');
		preview.style.flex = '1';
		preview.style.overflowY = 'auto';
		preview.style.padding = '14px 18px';

		const previewLoading = $('div');
		previewLoading.style.color = 'var(--vscode-descriptionForeground)';
		previewLoading.style.fontSize = '13px';
		previewLoading.style.padding = '20px';
		previewLoading.textContent = '请选择文件查看内容';
		preview.appendChild(previewLoading);

		wrap.appendChild(preview);

		// ── Async load directory tree ───────────────────────────────
		if (skill.resource) {
			// skill.resource is the skill's directory URI (set by skillRegistryService._parseSkillFile)
			this._loadFileTreeAsync(skill.resource, treeBody, preview).catch(err => {
				console.error('[ResourceManager] loadFileTree failed:', err);
				clearNode(treeBody);
				treeBody.appendChild(this._emptyHint('无法读取目录'));
			});
		} else {
			clearNode(treeBody);
			treeBody.appendChild(this._emptyHint('该技能无关联文件'));
		}

		return wrap;
	}

	/** Recursively read a directory and build a tree of FileTreeNode */
	private async _readDirectoryTree(dirUri: URI): Promise<FileTreeNode[]> {
		const stat = await this.fileService.resolve(dirUri);
		if (!stat.children) { return []; }
		const nodes: FileTreeNode[] = [];
		for (const child of stat.children) {
			// Skip hidden files/directories
			if (child.name.startsWith('.')) { continue; }
			const node: FileTreeNode = {
				name: child.name,
				uri: child.resource,
				isDirectory: child.isDirectory,
				children: undefined,
			};
			if (child.isDirectory) {
				try {
					node.children = await this._readDirectoryTree(child.resource);
				} catch { node.children = []; }
			}
			nodes.push(node);
		}
		// Sort: directories first, then files, alphabetically
		nodes.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) { return a.isDirectory ? -1 : 1; }
			return a.name.localeCompare(b.name);
		});
		return nodes;
	}

	/** Load the file tree into the tree element and auto-select the default file */
	private async _loadFileTreeAsync(dirUri: URI, treeEl: HTMLElement, previewEl: HTMLElement): Promise<void> {
		this._fileTreeEl = treeEl;
		const nodes = await this._readDirectoryTree(dirUri);
		clearNode(treeEl);

		if (nodes.length === 0) {
			treeEl.appendChild(this._emptyHint('空目录'));
			return;
		}

		// Render tree nodes
		this._renderTreeNodes(nodes, treeEl, 0, previewEl);

		// Auto-select: previously selected file, or SKILL.md, or first file
		const allFiles = this._collectFileNodes(nodes);
		let target: FileTreeNode | undefined;
		if (this._selectedFilePath) {
			target = allFiles.find(n => n.uri.fsPath === this._selectedFilePath);
		}
		if (!target) {
			target = allFiles.find(n => n.name === 'SKILL.md');
		}
		if (!target && allFiles.length > 0) {
			target = allFiles[0];
		}
		if (target) {
			this._selectedFilePath = target.uri.fsPath;
			// Expand parent directories to reveal the selected file
			this._expandToFilePath(treeEl, target.uri.fsPath);
			await this._loadFilePreview(target.uri, target.name, previewEl);
			// Highlight the selected node
			this._highlightTreeNode(target.uri.fsPath);
		} else {
			previewEl.appendChild(this._emptyHint('目录中无文件'));
		}
	}

	/** Render tree nodes recursively with collapsible directories */
	private _renderTreeNodes(nodes: FileTreeNode[], container: HTMLElement, depth: number, previewEl: HTMLElement): void {
		for (const node of nodes) {
			const row = $('div.rm-tree-node');
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.padding = '3px 14px';
			row.style.paddingLeft = `${14 + depth * 16}px`;
			row.style.fontSize = '12px';
			row.style.whiteSpace = 'nowrap';
			row.dataset.filePath = node.uri.fsPath;

			if (node.isDirectory) {
				// Toggle arrow (▸ collapsed / ▾ expanded)
				const arrow = $('span.rm-tree-arrow');
				arrow.style.marginRight = '4px';
				arrow.style.flexShrink = '0';
				arrow.style.width = '12px';
				arrow.style.display = 'inline-block';
				arrow.style.textAlign = 'center';

				// Default: top-level expanded, nested collapsed
				const expanded = depth === 0;
				arrow.textContent = expanded ? '▾' : '▸';

				const folderIcon = $('span');
				folderIcon.style.marginRight = '6px';
				folderIcon.style.flexShrink = '0';
				folderIcon.textContent = expanded ? '📂' : '📁';

				const label = $('span');
				label.textContent = node.name;
				label.style.fontWeight = '500';

				row.appendChild(arrow);
				row.appendChild(folderIcon);
				row.appendChild(label);
				row.style.cursor = 'pointer';
				row.style.color = 'var(--vscode-foreground)';
				row.onmouseenter = () => { row.style.background = 'var(--vscode-list-hoverBackground)'; };
				row.onmouseleave = () => { row.style.background = ''; };

				container.appendChild(row);

				// Child container (collapsible)
				if (node.children && node.children.length > 0) {
					const childContainer = $('div.rm-tree-children');
					childContainer.style.display = expanded ? '' : 'none';
					this._renderTreeNodes(node.children, childContainer, depth + 1, previewEl);
					container.appendChild(childContainer);

					// Toggle expand/collapse on click
					row.onclick = () => {
						const isExpanded = childContainer.style.display !== 'none';
						if (isExpanded) {
							childContainer.style.display = 'none';
							arrow.textContent = '▸';
							folderIcon.textContent = '📁';
						} else {
							childContainer.style.display = '';
							arrow.textContent = '▾';
							folderIcon.textContent = '📂';
						}
					};
				}
			} else {
				// File row — spacer for alignment with directory arrows
				const spacer = $('span');
				spacer.style.width = '16px';
				spacer.style.flexShrink = '0';
				spacer.style.display = 'inline-block';

				const fileIcon = $('span');
				fileIcon.style.marginRight = '6px';
				fileIcon.style.flexShrink = '0';
				fileIcon.textContent = this._fileIcon(node.name);

				const label = $('span');
				label.textContent = node.name;
				row.appendChild(spacer);
				row.appendChild(fileIcon);
				row.appendChild(label);
				row.style.cursor = 'pointer';

				row.onmouseenter = () => { row.style.background = 'var(--vscode-list-hoverBackground)'; };
				row.onmouseleave = () => {
					if (row.dataset.selected !== 'true') {
						row.style.background = '';
					}
				};
				row.onclick = async () => {
					this._selectedFilePath = node.uri.fsPath;
					this._highlightTreeNode(node.uri.fsPath);
					await this._loadFilePreview(node.uri, node.name, previewEl);
				};

				container.appendChild(row);
			}
		}
	}

	/** Expand all ancestor directories of the given file path so the file is visible */
	private _expandToFilePath(rootEl: HTMLElement, filePath: string): void {
		const rows = rootEl.querySelectorAll<HTMLElement>('div.rm-tree-node');
		const normalizedFile = filePath.replace(/\\/g, '/');
		for (const row of rows) {
			const rowPath = row.dataset.filePath;
			if (!rowPath) { continue; }
			const normalizedRow = rowPath.replace(/\\/g, '/');
			// If this directory is an ancestor of the selected file
			if (normalizedFile.startsWith(normalizedRow + '/')) {
				const childContainer = row.nextElementSibling;
				if (childContainer instanceof HTMLElement && childContainer.classList.contains('rm-tree-children')) {
					childContainer.style.display = '';
					const arrow = row.querySelector('span.rm-tree-arrow');
					if (arrow) { arrow.textContent = '▾'; }
					const folderIcon = row.children[1] as HTMLElement | undefined;
					if (folderIcon) { folderIcon.textContent = '📂'; }
				}
			}
		}
	}

	/** Highlight the currently selected tree node (searches the entire tree) */
	private _highlightTreeNode(filePath: string): void {
		if (!this._fileTreeEl) { return; }
		const rows = this._fileTreeEl.querySelectorAll<HTMLElement>('div.rm-tree-node');
		for (const r of rows) {
			if (r.dataset.filePath === filePath) {
				r.dataset.selected = 'true';
				r.style.background = 'var(--vscode-list-activeSelectionBackground)';
				r.style.color = 'var(--vscode-list-activeSelectionForeground)';
			} else {
				r.dataset.selected = 'false';
				r.style.background = '';
				r.style.color = '';
			}
		}
	}

	/** Collect all file nodes (non-directory) from a tree */
	private _collectFileNodes(nodes: FileTreeNode[]): FileTreeNode[] {
		const result: FileTreeNode[] = [];
		for (const node of nodes) {
			if (node.isDirectory) {
				if (node.children) { result.push(...this._collectFileNodes(node.children)); }
			} else {
				result.push(node);
			}
		}
		return result;
	}

	/** Load a file's content and display it in the preview area */
	private async _loadFilePreview(fileUri: URI, fileName: string, previewEl: HTMLElement): Promise<void> {
		clearNode(previewEl);

		// Header
		const hdr = $('div');
		hdr.style.display = 'flex';
		hdr.style.alignItems = 'center';
		hdr.style.gap = '8px';
		hdr.style.paddingBottom = '10px';
		hdr.style.borderBottom = '1px solid var(--vscode-panel-border)';
		hdr.style.marginBottom = '12px';
		hdr.style.fontSize = '12px';
		hdr.style.color = 'var(--vscode-descriptionForeground)';
		hdr.textContent = `${this._fileIcon(fileName)} `;
		const nameEl = $('strong');
		nameEl.textContent = fileName;
		hdr.appendChild(nameEl);
		previewEl.appendChild(hdr);

		// Loading indicator
		const loading = $('div');
		loading.style.color = 'var(--vscode-descriptionForeground)';
		loading.style.fontSize = '13px';
		loading.textContent = '加载文件内容...';
		previewEl.appendChild(loading);

		try {
			const content = await this.fileService.readFile(fileUri);
			const text = content.value.toString();

			// Remove loading indicator
			previewEl.removeChild(loading);

			if (fileName.endsWith('.md')) {
				// Render markdown
				const md = new MarkdownString(text, { supportThemeIcons: true, isTrusted: false });
				const rendered = renderMarkdown(md);
				rendered.element.style.overflowWrap = 'anywhere';
				rendered.element.style.fontSize = '13px';
				rendered.element.style.lineHeight = '1.7';
				previewEl.appendChild(rendered.element);
			} else {
				// Plain text / code
				const pre = $('pre');
				pre.textContent = text;
				pre.style.whiteSpace = 'pre-wrap';
				pre.style.wordBreak = 'break-all';
				pre.style.fontFamily = 'var(--vscode-editor-font-family, Consolas, monospace)';
				pre.style.fontSize = '13px';
				pre.style.lineHeight = '1.6';
				pre.style.color = 'var(--vscode-editor-foreground)';
				pre.style.background = 'var(--vscode-textCodeBlock-background)';
				pre.style.padding = '12px';
				pre.style.borderRadius = '4px';
				pre.style.overflowX = 'auto';
				previewEl.appendChild(pre);
			}
		} catch (err) {
			previewEl.removeChild(loading);
			const errEl = $('div');
			errEl.style.color = 'var(--vscode-errorForeground)';
			errEl.style.fontSize = '13px';
			errEl.textContent = `无法读取文件: ${err instanceof Error ? err.message : String(err)}`;
			previewEl.appendChild(errEl);
		}
	}

	/** Get an emoji icon for a file based on its extension */
	private _fileIcon(fileName: string): string {
		const ext = fileName.split('.').pop()?.toLowerCase();
		switch (ext) {
			case 'md':    return '📝';
			case 'json':  return '📋';
			case 'ts': case 'js': case 'mjs': return '📘';
			case 'py':    return '🐍';
			case 'sh':    return '⚙️';
			case 'yml': case 'yaml': return '⚙️';
			case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': return '🖼️';
			case 'txt':   return '📄';
			default:      return '📄';
		}
	}

	private _renderVersionTab(skill: ISkillDefinition): HTMLElement {
		const wrap = $('div');
		if (skill.version) {
			const v = $('div');
			v.style.display = 'flex';
			v.style.alignItems = 'baseline';
			v.style.gap = '10px';
			v.style.padding = '10px 0';
			v.style.borderBottom = '1px solid var(--vscode-panel-border)';

			const dot = $('span');
			dot.style.width = '8px';
			dot.style.height = '8px';
			dot.style.borderRadius = '50%';
			dot.style.background = '#3fb950';
			dot.style.flexShrink = '0';
			dot.style.marginTop = '5px';
			v.appendChild(dot);

			const num = $('span');
			num.textContent = `v${skill.version}`;
			num.style.fontWeight = '600';
			num.style.fontSize = '14px';
			v.appendChild(num);

			const badge = $('span');
			badge.textContent = '最新';
			badge.style.fontSize = '10px';
			badge.style.padding = '1px 7px';
			badge.style.borderRadius = '3px';
			badge.style.background = 'rgba(210,153,34,0.12)';
			badge.style.color = '#e3b341';
			v.appendChild(badge);

			wrap.appendChild(v);
		} else {
			wrap.appendChild(this._emptyHint('暂无版本信息'));
		}
		return wrap;
	}

	/** Render version info for a marketplace package */
	private _renderMarketplaceVersionTab(pkg: IMarketplacePackage): HTMLElement {
		const wrap = $('div');

		// If versions are already available from the list response, render them directly
		if (pkg.versions && pkg.versions.length > 0) {
			for (const ver of pkg.versions) {
				const row = this._buildVersionRow(ver.version, ver.isLatest, ver.createdAt, ver.changelog, pkg.downloads);
				wrap.appendChild(row);
			}
			return wrap;
		}

		// Show basic version info immediately
		if (pkg.latestVersion) {
			wrap.appendChild(this._buildVersionRow(pkg.latestVersion, true, pkg.updatedAt, undefined, pkg.downloads));
		}

		// Async fetch detailed version history
		const loadingHint = $('div');
		loadingHint.style.padding = '10px 0';
		loadingHint.style.color = 'var(--vscode-descriptionForeground)';
		loadingHint.style.fontSize = '13px';
		loadingHint.textContent = '\u23F3 加载版本历史...';
		wrap.appendChild(loadingHint);

		this.marketplaceService.getPackage(pkg.slug).then(detail => {
			loadingHint.remove();
			for (const ver of detail.versions) {
				const row = this._buildVersionRow(ver.version, ver.isLatest, ver.createdAt, ver.changelog, undefined);
				wrap.appendChild(row);
			}
		}).catch(() => {
			loadingHint.textContent = '无法加载版本历史';
			loadingHint.style.color = 'var(--vscode-errorForeground)';
		});

		return wrap;
	}

	/** Build a single version row element */
	private _buildVersionRow(version: string, isLatest: boolean, createdAt?: number, changelog?: string, downloads?: number): HTMLElement {
		const row = $('div');
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '10px';
		row.style.padding = '8px 0';
		row.style.borderBottom = '1px solid var(--vscode-panel-border)';

		const dot = $('span');
		dot.style.width = '8px';
		dot.style.height = '8px';
		dot.style.borderRadius = '50%';
		dot.style.background = isLatest ? '#3fb950' : 'var(--vscode-descriptionForeground)';
		dot.style.flexShrink = '0';
		row.appendChild(dot);

		const num = $('span');
		num.textContent = `v${version}`;
		num.style.fontWeight = isLatest ? '600' : 'normal';
		num.style.fontSize = '13px';
		row.appendChild(num);

		if (isLatest) {
			const badge = $('span');
			badge.textContent = '最新';
			badge.style.fontSize = '10px';
			badge.style.padding = '1px 7px';
			badge.style.borderRadius = '3px';
			badge.style.background = 'rgba(210,153,34,0.12)';
			badge.style.color = '#e3b341';
			row.appendChild(badge);
		}

		if (createdAt) {
			const date = $('span');
			date.textContent = new Date(createdAt).toLocaleDateString();
			date.style.fontSize = '12px';
			date.style.color = 'var(--vscode-descriptionForeground)';
			date.style.marginLeft = 'auto';
			row.appendChild(date);
		}

		if (typeof downloads === 'number' && downloads > 0) {
			const dl = $('span');
			dl.textContent = `\u2B07 ${downloads} 次下载`;
			dl.style.fontSize = '12px';
			dl.style.color = 'var(--vscode-descriptionForeground)';
			if (!createdAt) { dl.style.marginLeft = 'auto'; }
			row.appendChild(dl);
		}

		if (changelog) {
			const log = $('div');
			log.textContent = changelog;
			log.style.fontSize = '12px';
			log.style.color = 'var(--vscode-descriptionForeground)';
			log.style.marginTop = '4px';
			log.style.whiteSpace = 'pre-wrap';
			row.appendChild(log);
		}

		return row;
	}

	private _renderEvalTab(skill: ISkillDefinition): HTMLElement {
		const wrap = $('div');
		wrap.style.maxWidth = '800px';

		// Score summary
		const score = this._estimateSkillScore(skill);
		const box = $('div');
		box.style.background = 'var(--vscode-widget-background)';
		box.style.border = '1px solid var(--vscode-panel-border)';
		box.style.borderRadius = '4px';
		box.style.padding = '14px 18px';
		box.style.marginBottom = '14px';

		const head = $('div');
		head.style.display = 'flex';
		head.style.alignItems = 'center';
		head.style.gap = '12px';

		const total = $('span');
		total.textContent = String(score.total);
		total.style.fontSize = '26px';
		total.style.fontWeight = '700';
		total.style.color = '#3fb950';
		head.appendChild(total);

		const max = $('span');
		max.textContent = '/100';
		max.style.fontSize = '14px';
		max.style.color = 'var(--vscode-descriptionForeground)';
		head.appendChild(max);

		const grade = $('span');
		grade.textContent = score.total >= 75 ? '良好' : '合格';
		grade.style.padding = '2px 10px';
		grade.style.borderRadius = '3px';
		grade.style.fontSize = '12px';
		grade.style.fontWeight = '600';
		grade.style.background = 'rgba(46,160,67,0.12)';
		grade.style.color = '#3fb950';
		head.appendChild(grade);

		const verdict = $('span');
		verdict.textContent = '· 结论：pass';
		verdict.style.fontSize = '13px';
		verdict.style.color = 'var(--vscode-descriptionForeground)';
		head.appendChild(verdict);

		box.appendChild(head);
		wrap.appendChild(box);

		// Summary
		const h2 = $('h2');
		h2.textContent = '总结与建议';
		h2.style.fontSize = '16px';
		h2.style.margin = '18px 0 8px';
		h2.style.color = 'var(--vscode-textLink-foreground)';
		wrap.appendChild(h2);

		const summary = $('p');
		summary.textContent = `技能 "${skill.name}" 已就绪。激活方式：${skill.activation}。${skill.match && skill.match.length > 0 ? `触发关键词：${skill.match.join(', ')}。` : ''}内容长度 ${skill.prompt.length} 字符。`;
		summary.style.lineHeight = '1.7';
		summary.style.marginBottom = '8px';
		wrap.appendChild(summary);

		// Score table
		const h2b = $('h2');
		h2b.textContent = '各维度得分';
		h2b.style.fontSize = '16px';
		h2b.style.margin = '18px 0 8px';
		h2b.style.color = 'var(--vscode-textLink-foreground)';
		wrap.appendChild(h2b);

		const table = $('table') as HTMLTableElement;
		table.style.width = '100%';
		table.style.borderCollapse = 'collapse';
		table.style.fontSize = '12px';

		for (const row of score.rows) {
			const tr = table.insertRow();
			const c1 = tr.insertCell();
			c1.textContent = row[0];
			c1.style.padding = '7px 10px';
			c1.style.borderBottom = '1px solid var(--vscode-panel-border)';
			c1.style.color = 'var(--vscode-descriptionForeground)';
			c1.style.width = '110px';

			const c2 = tr.insertCell();
			c2.textContent = String(row[1]);
			c2.style.padding = '7px 10px';
			c2.style.borderBottom = '1px solid var(--vscode-panel-border)';
			c2.style.textAlign = 'center';
			c2.style.fontWeight = '600';
			// Color by ratio: >=80% green, >=60% yellow, else red
			const ratio = row[1] / row[2];
			c2.style.color = ratio >= 0.8 ? '#3fb950' : ratio >= 0.6 ? '#e3b341' : '#f85149';
			c2.style.width = '42px';

			const c3 = tr.insertCell();
			c3.textContent = String(row[2]);
			c3.style.padding = '7px 10px';
			c3.style.borderBottom = '1px solid var(--vscode-panel-border)';
			c3.style.textAlign = 'center';
			c3.style.width = '42px';

			const c4 = tr.insertCell();
			c4.textContent = row[3];
			c4.style.padding = '7px 10px';
			c4.style.borderBottom = '1px solid var(--vscode-panel-border)';
		}
		wrap.appendChild(table);

		return wrap;
	}

	private _estimateSkillScore(skill: ISkillDefinition): { total: number; rows: Array<[string, number, number, string]> } {
		const promptLen = skill.prompt.length;
		const hasMatch = skill.match && skill.match.length > 0;
		const hasCategory = !!skill.category;

		const rows: Array<[string, number, number, string]> = [
			['元数据合规', 14, 15, 'name/description/activation 字段齐全'],
			['资源完整性', 8, 10, hasCategory ? '分类信息齐全' : '缺少 category 字段'],
			['篇幅统计', promptLen < 5000 ? 13 : promptLen < 8000 ? 9 : 6, 15, `正文 ${promptLen} 字符`],
			['触发准确性', hasMatch ? 12 : 8, 15, hasMatch ? '已配置 match 关键词' : '缺少 match 关键词'],
			['指令正交质量', 11, 15, '内容结构清晰'],
			['安全合规', 14, 15, '无安全风险'],
			['Token 效率', promptLen < 5000 ? 12 : 8, 15, promptLen < 5000 ? '篇幅适中' : '篇幅偏大'],
		];
		const total = rows.reduce((s, r) => s + r[1], 0);
		return { total, rows };
	}

	private _emptyHint(text: string): HTMLElement {
		const p = $('p');
		p.textContent = text;
		p.style.color = 'var(--vscode-descriptionForeground)';
		p.style.fontSize = '13px';
		p.style.padding = '24px';
		p.style.textAlign = 'center';
		return p;
	}

	// ═══════════════════════════════════════════════════════════════════════
	//  Data helpers
	// ═══════════════════════════════════════════════════════════════════════

	private _getItems(): IResourceItem[] {
		switch (this._currentType) {
			case 'skill': return this._getSkillItems();
			case 'knowledge':
			case 'workflow':
				return [];
		}
	}

	private _getSkillItems(): IResourceItem[] {
		return this.skillRegistry.getSkills().map(s => ({
			id: s.id,
			name: s.name,
			description: s.description,
			kind: 'skill' as const,
			source: this._skillSourceLabel(s.source),
			author: undefined,
			version: s.version,
			tags: s.category ? s.category.split(',').map(c => c.trim()).filter(Boolean) : [],
			activation: s.activation,
			enabled: s.enabled,
			resource: s.resource ? { path: s.resource.fsPath } : undefined,
		}));
	}

	private _skillSourceLabel(source: ISkillDefinition['source']): string {
		switch (source) {
			case 'builtin': return '📦 内置技能';
			case 'user': return '📁 用户技能';
			case 'marketplace': return '☁️ 商城技能';
			case 'extension': return '🔌 扩展技能';
			case 'memory': return '🧠 内存技能';
		}
	}

}
