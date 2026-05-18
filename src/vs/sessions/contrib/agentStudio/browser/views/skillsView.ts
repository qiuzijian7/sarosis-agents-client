/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { $, clearNode } from '../../../../../base/browser/dom.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { URI } from '../../../../../base/common/uri.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { ISkillRegistry, ISkillDefinition } from '../../common/skills.js';
import { ISkillInstallService, ISkillHubEntry } from '../../common/skillHubTypes.js';

type ViewMode = 'list' | 'install-hubs' | 'install-entries';

/**
 * Skills View —— 从 ISkillRegistry 拉取真实 skill 列表，支持从 Hub 安装。
 *
 * 数据来源：
 *   - 内置 skill (硬编码常量数组，随产品发布)
 *   - 用户全局目录 `<userRoamingDataHome>/sarosis/skills/<id>/SKILL.md`
 *   - 工作区目录 `<workspaceFolder>/.sarosisworkspace/agents/<agentDir>/skills/<id>/SKILL.md`
 *   - 扩展通过 ISkillRegistry.registerSkill 运行时注册
 *   - 从 Skill Hub 在线安装
 *
 * UI 责任仅限于"展示 + 触发激活 + 安装管理" —— 真正的 skill 注入由 ExecutionProvider
 * 在每轮 turn 调用 `resolveActivations()` 完成；此 view 不直接修改对话。
 */
export class SkillsViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private filterRow!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private countBadge!: HTMLElement;
	private skills: ISkillDefinition[] = [];
	private activeCategory = 'All';
	private searchQuery = '';
	private viewMode: ViewMode = 'list';
	private loadingHubId: string | undefined;

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
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@ISkillInstallService private readonly skillInstallService: ISkillInstallService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorService private readonly editorService: IEditorService,
		@ILogService private readonly logService: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.logService.info('[SkillsView] constructor called');
		this.logService.info(`[SkillsView] skillRegistry available: ${!!this.skillRegistry}`);
		this.logService.info(`[SkillsView] initial getSkills() count: ${this.skillRegistry.getSkills().length}`);
		this._register(this.skillRegistry.onDidChangeSkills(() => {
			const count = this.skillRegistry.getSkills().length;
			this.logService.info(`[SkillsView] onDidChangeSkills fired, skills count: ${count}, viewMode: ${this.viewMode}`);
			if (this.viewMode === 'list') {
				this._refresh();
			}
		}));
		this._register(this.skillInstallService.onDidChangeEntries(() => {
			this.logService.info(`[SkillsView] onDidChangeEntries fired, viewMode: ${this.viewMode}`);
			if (this.viewMode === 'install-entries') {
				this._renderHubEntries(this.loadingHubId!);
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('skills-view');

		// Header with count + install button
		const header = $('div.skills-header');
		const title = $('h3.skills-title');
		title.textContent = '💡 Skills Library';
		header.appendChild(title);

		this.countBadge = $('span.skills-count');
		header.appendChild(this.countBadge);

		// Install button
		const installBtn = $('button.skills-install-btn');
		installBtn.textContent = '+ Install';
		installBtn.title = 'Install skills from hub or local file';
		installBtn.onclick = () => this._showInstallHubs();
		header.appendChild(installBtn);

		container.appendChild(header);

		// Search bar
		const searchRow = $('div.skills-search-row');
		this.searchInput = $('input.skills-search-input') as HTMLInputElement;
		this.searchInput.type = 'text';
		this.searchInput.placeholder = '🔍 Search skills by name, description, or id...';
		this.searchInput.oninput = () => {
			this.searchQuery = this.searchInput.value.trim().toLowerCase();
			this._renderSkills();
		};
		searchRow.appendChild(this.searchInput);

		// Clear button
		const clearBtn = $('button.skills-search-clear-btn');
		clearBtn.textContent = '✕';
		clearBtn.title = 'Clear search';
		clearBtn.onclick = () => {
			this.searchInput.value = '';
			this.searchQuery = '';
			this._renderSkills();
		};
		searchRow.appendChild(clearBtn);
		container.appendChild(searchRow);

		// Filter container (rebuilt on each refresh because categories are dynamic)
		this.filterRow = $('div.skills-filters');
		this.filterRow.id = 'skills-filter-row';
		container.appendChild(this.filterRow);

		// Skills list
		this.listContainer = $('div.skills-list');
		container.appendChild(this.listContainer);

		// Initial refresh - make sure SkillRegistry is ready
		// Use setTimeout to ensure this runs after the DOM is fully rendered
		this.logService.info('[SkillsView] renderBody called, scheduling initial _refresh()');
		setTimeout(() => this._refresh(), 0);
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.logService.info(`[SkillsView] setVisible(${visible}), viewMode: ${this.viewMode}`);
		if (visible) {
			// Force refresh when the view becomes visible
			if (this.viewMode === 'list') {
				this._refresh();
			}
		}
	}

	private _refresh(): void {
		this.viewMode = 'list';
		const allSkills = [...this.skillRegistry.getSkills()];

		// 去重逻辑：
		// - 同 id + 同 contentHash → 完全相同的技能副本，保留高优先级来源
		// - 同 id + 不同 contentHash → 同名但内容不同的版本，均保留（附加来源后缀区分）
		const sourcePriority: Record<string, number> = { workspace: 4, user: 3, extension: 2, memory: 1, builtin: 0 };
		const deduped = new Map<string, ISkillDefinition>();

		for (const s of allSkills) {
			const baseKey = s.id; // id 已由 name 生成（name.toLowerCase().replace(/\s+/g, '-')）
			const contentKey = `${baseKey}::${s.contentHash ?? 'no-hash'}`;

			// 先检查是否有相同内容的重复
			const existingSameContent = deduped.get(contentKey);
			if (existingSameContent) {
				// 同名 + 同内容 → 保留高优先级来源
				const existingPri = sourcePriority[existingSameContent.source] ?? 0;
				const newPri = sourcePriority[s.source] ?? 0;
				if (newPri > existingPri) {
					deduped.set(contentKey, s);
				}
			} else {
				deduped.set(contentKey, s);
			}
		}
		this.skills = [...deduped.values()];

		this.logService.info(`[SkillsView] _refresh: total skills = ${this.skills.length} (before dedup: ${allSkills.length})`);
		if (this.skills.length === 0) {
			this.logService.warn('[SkillsView] _refresh: NO SKILLS returned from registry!');
		} else {
			// 按 source 分组统计
			const bySource = new Map<string, number>();
			for (const s of this.skills) {
				bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
			}
			const sourceInfo = [...bySource.entries()].map(([k, v]) => `${k}:${v}`).join(', ');
			this.logService.info(`[SkillsView] _refresh: by source = { ${sourceInfo} }`);
			// 显示前 5 个 skill 的 id 以供调试
			const sample = this.skills.slice(0, 5).map(s => s.id).join(', ');
			this.logService.info(`[SkillsView] _refresh: first 5 ids = [${sample}]`);
		}
		this._updateCount();
		this._renderFilters();
		this._renderSkills();
	}

	private _updateCount(): void {
		const total = this.skills.length;
		const active = this.skills.filter(s => s.activation === 'always' || s.activation === 'auto').length;
		if (this.searchQuery) {
			const matched = this.skills.filter(s => {
				const q = this.searchQuery;
				return s.name.toLowerCase().includes(q)
					|| s.id.toLowerCase().includes(q)
					|| (s.description ?? '').toLowerCase().includes(q)
					|| (s.category ?? '').toLowerCase().includes(q);
			}).length;
			this.countBadge.textContent = `${matched}/${total} matched`;
		} else {
			this.countBadge.textContent = `${active}/${total} auto-activate`;
		}
	}

	private _renderFilters(): void {
		if (!this.filterRow) { return; }
		clearNode(this.filterRow);
		const categories = ['All', ...Array.from(new Set(this.skills.map(s => s.category ?? 'misc')))];
		for (const cat of categories) {
			const btn = $('button.skill-filter-btn');
			btn.textContent = cat;
			if (cat === this.activeCategory) { btn.classList.add('active'); }
			btn.onclick = () => {
				this.filterRow.querySelectorAll('.skill-filter-btn').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				this.activeCategory = cat;
				this._renderSkills();
			};
			this.filterRow.appendChild(btn);
		}
	}

	private _renderSkills(): void {
		if (!this.listContainer) {
			this.logService.warn('[SkillsView] _renderSkills: listContainer is null/undefined!');
			return;
		}
		clearNode(this.listContainer);

		// 先按分类过滤
		let filtered = this.activeCategory === 'All'
			? this.skills
			: this.skills.filter(s => (s.category ?? 'misc') === this.activeCategory);

		// 再按搜索关键词过滤
		if (this.searchQuery) {
			filtered = filtered.filter(s => {
				const q = this.searchQuery;
				return s.name.toLowerCase().includes(q)
					|| s.id.toLowerCase().includes(q)
					|| (s.description ?? '').toLowerCase().includes(q)
					|| (s.category ?? '').toLowerCase().includes(q);
			});
		}

		this.logService.info(`[SkillsView] _renderSkills: activeCategory="${this.activeCategory}", searchQuery="${this.searchQuery}", filtered=${filtered.length}, total=${this.skills.length}`);

		if (filtered.length === 0) {
			const empty = $('div.skills-empty');
			const p = $('p');
			if (this.searchQuery) {
				p.append(
					'No skills match "',
					Object.assign($('b'), { textContent: this.searchQuery }),
					'". Try a different search term.'
				);
			} else {
				p.append(
					'No skills in this category. Click ',
					Object.assign($('b'), { textContent: '+ Install' }),
					' to add from a hub, or drop a SKILL.md into ',
					Object.assign($('code'), { textContent: '.sarosisworkspace/agents/<agentDir>/skills/<id>/' }),
					'.'
				);
			}
			empty.appendChild(p);
			this.listContainer.appendChild(empty);
			return;
		}

		for (const skill of filtered) {
			const item = $('div.skill-item');
			item.classList.toggle('skill-enabled', skill.enabled !== false);

			// 启用/禁用开关
			const toggleContainer = $('div.skill-toggle');
			const toggle = $('input.skill-toggle-input') as HTMLInputElement;
			toggle.type = 'checkbox';
			toggle.checked = skill.enabled !== false;
			toggle.title = skill.enabled !== false ? 'Disable this skill' : 'Enable this skill';
			toggle.onchange = async () => {
				try {
					if (toggle.checked) {
						this.skillRegistry.enableSkill(skill.id);
					} else {
						this.skillRegistry.disableSkill(skill.id);
					}
					// 更新本地状态
					skill.enabled = toggle.checked;
					item.classList.toggle('skill-enabled', skill.enabled !== false);
				} catch (err) {
					console.error('[SkillsView] Failed to toggle skill:', err);
					// 回滚 UI 状态
					toggle.checked = !toggle.checked;
				}
			};
			const toggleSlider = $('span.toggle-slider');
			toggleContainer.appendChild(toggle);
			toggleContainer.appendChild(toggleSlider);
			item.appendChild(toggleContainer);

			const iconEl = $('span.skill-icon');
			iconEl.textContent = this._iconFor(skill);
			item.appendChild(iconEl);

			const info = $('div.skill-info');
			const nameRow = $('div.skill-name-row');
			const nameEl = $('span.skill-name');
			nameEl.textContent = skill.name;
			nameRow.appendChild(nameEl);

			const catBadge = $('span.skill-category-badge');
			catBadge.textContent = skill.category ?? 'misc';
			nameRow.appendChild(catBadge);

			const activationBadge = $('span.skill-category-badge');
			activationBadge.textContent = skill.activation;
			activationBadge.classList.add(`skill-activation-${skill.activation}`);
			nameRow.appendChild(activationBadge);

			const sourceBadge = $('span.skill-category-badge');
			sourceBadge.textContent = skill.source;
			nameRow.appendChild(sourceBadge);

			info.appendChild(nameRow);

			const descEl = $('div.skill-desc');
			descEl.textContent = skill.description || '(no description)';
			info.appendChild(descEl);
			item.appendChild(info);

			// 卸载按钮（仅 source === 'user' 的可卸载）
			if (skill.source === 'user') {
				const uninstallBtn = $('button.skill-uninstall-btn');
				uninstallBtn.textContent = '✕';
				uninstallBtn.title = 'Uninstall this skill';
				uninstallBtn.onclick = async (e) => {
					e.stopPropagation();
					const confirmed = await this.dialogService.confirm({
						message: `Uninstall skill "${skill.name}"?`,
						detail: 'This will remove the SKILL.md file from your user skills directory.',
						primaryButton: 'Uninstall',
					});
					if (confirmed.confirmed) {
						await this.skillInstallService.uninstallSkill(skill.id);
						this._refresh();
					}
				};
				item.appendChild(uninstallBtn);
			}

			// 点击 skill item 在编辑器中打开对应的 SKILL.md 文件
			item.style.cursor = skill.resource ? 'pointer' : 'default';
			item.onclick = (e) => {
				// 避免按钮点击（如 toggle、uninstall）冒泡触发打开
				const target = e.target as HTMLElement;
				if (target.tagName === 'INPUT' || target.tagName === 'BUTTON' || target.closest('button')) {
					return;
				}
				if (skill.resource) {
					// skill.resource 是技能文件夹 URI，需要拼接 SKILL.md
					const skillFileUri = URI.joinPath(skill.resource, 'SKILL.md');
					this.editorService.openEditor({
						resource: skillFileUri,
						options: { pinned: false, preserveFocus: false },
					});
				} else {
					this.logService.info(`[SkillsView] skill "${skill.name}" has no resource URI (source: ${skill.source}), cannot open file.`);
				}
			};

			this.listContainer.appendChild(item);
		}
	}

	// ─── Install UI ────────────────────────────────────────────────

	private _showInstallHubs(): void {
		this.viewMode = 'install-hubs';
		clearNode(this.filterRow);
		clearNode(this.listContainer);

		const panel = $('div.skill-install-panel');

		// Header
		const header = $('div.skill-install-header');
		const title = $('h4.skill-install-title');
		title.textContent = 'Install Skills';
		header.appendChild(title);

		const backBtn = $('button.skill-install-back-btn');
		backBtn.textContent = '← Back';
		backBtn.onclick = () => this._refresh();
		header.appendChild(backBtn);

		panel.appendChild(header);

		// ── 从 Hub 安装 ──────────────────────────────
		const hubSection = $('div.skill-install-section');
		const hubTitle = $('div.skill-install-section-title');
		hubTitle.textContent = 'From Skill Hubs';
		hubSection.appendChild(hubTitle);

		const hubDesc = $('div.skill-install-section-desc');
		hubDesc.textContent = 'Browse and install skills from open-source repositories';
		hubSection.appendChild(hubDesc);

		const hubGrid = $('div.skill-hub-grid');
		const hubs = this.skillInstallService.getHubs();
		for (const hub of hubs) {
			const card = $('div.skill-hub-card');
			if (hub.official) {
				card.classList.add('skill-hub-card-official');
			}

			const hubIcon = $('span.skill-hub-icon');
			hubIcon.textContent = hub.icon ?? '📦';
			card.appendChild(hubIcon);

			const hubInfo = $('div.skill-hub-info');
			const hubName = $('div.skill-hub-name');
			hubName.textContent = hub.name;
			if (hub.official) {
				const officialBadge = $('span.skill-hub-official-badge');
				officialBadge.textContent = 'Official';
				hubName.appendChild(officialBadge);
			}
			hubInfo.appendChild(hubName);

			const hubDescEl = $('div.skill-hub-desc');
			hubDescEl.textContent = hub.description;
			hubInfo.appendChild(hubDescEl);

			const hubType = $('div.skill-hub-type');
			hubType.textContent = hub.type === 'github' ? 'GitHub' : hub.type === 'url' ? 'URL' : hub.type === 'local' ? 'Local' : hub.type;
			hubInfo.appendChild(hubType);

			card.appendChild(hubInfo);
			card.onclick = () => this._showHubEntries(hub.id);
			hubGrid.appendChild(card);
		}
		hubSection.appendChild(hubGrid);
		panel.appendChild(hubSection);

		// ── 从本地文件安装 ──────────────────────────
		const localSection = $('div.skill-install-section');
		const localTitle = $('div.skill-install-section-title');
		localTitle.textContent = 'From Local File';
		localSection.appendChild(localTitle);

		const localDesc = $('div.skill-install-section-desc');
		localDesc.textContent = 'Import a SKILL.md file from your computer';
		localSection.appendChild(localDesc);

		const localActions = $('div.skill-install-local-actions');
		const fileInput = $('input.skill-file-input') as HTMLInputElement;
		fileInput.type = 'file';
		fileInput.accept = '.md,.markdown';
		fileInput.style.display = 'none';
		fileInput.onchange = async () => {
			const file = fileInput.files?.[0];
			if (!file) { return; }
			const text = await file.text();
			const result = await this.skillInstallService.installFromContent(text);
			if (result.success) {
				this._refresh();
			} else {
				await this.dialogService.info(
					`Failed to install skill: ${result.error ?? 'Unknown error'}`,
					'Installation Failed'
				);
			}
		};
		localActions.appendChild(fileInput);

		const browseBtn = $('button.skill-install-browse-btn');
		browseBtn.textContent = '📁 Browse SKILL.md';
		browseBtn.onclick = () => fileInput.click();
		localActions.appendChild(browseBtn);

		// Paste content
		const pasteBtn = $('button.skill-install-paste-btn');
		pasteBtn.textContent = '📋 Paste Content';
		pasteBtn.onclick = () => this._showPasteDialog();
		localActions.appendChild(pasteBtn);

		localSection.appendChild(localActions);
		panel.appendChild(localSection);

		// ── 从 URL 安装 ────────────────────────────
		const urlSection = $('div.skill-install-section');
		const urlTitle = $('div.skill-install-section-title');
		urlTitle.textContent = 'From URL';
		urlSection.appendChild(urlTitle);

		const urlDesc = $('div.skill-install-section-desc');
		urlDesc.textContent = 'Install from a direct SKILL.md URL (GitHub raw, Gist, etc.)';
		urlSection.appendChild(urlDesc);

		const urlRow = $('div.skill-install-url-row');
		const urlInput = $('input.skill-url-input') as HTMLInputElement;
		urlInput.type = 'text';
		urlInput.placeholder = 'https://raw.githubusercontent.com/.../SKILL.md';
		urlRow.appendChild(urlInput);

		const urlBtn = $('button.skill-install-url-btn');
		urlBtn.textContent = 'Install';
		urlBtn.onclick = async () => {
			const url = urlInput.value.trim();
			if (!url) { return; }
			urlBtn.textContent = 'Installing...';
			(urlBtn as HTMLButtonElement).disabled = true;
			try {
				const content = await this._fetchUrlContent(url);
				if (!content) {
					throw new Error('Failed to download content');
				}
				const result = await this.skillInstallService.installFromContent(content);
				if (result.success) {
					this._refresh();
				} else {
					await this.dialogService.info(
						`Failed to install: ${result.error ?? 'Unknown error'}`,
						'Installation Failed'
					);
				}
			} catch (err) {
				await this.dialogService.info(
					`Error: ${err instanceof Error ? err.message : String(err)}`,
					'Installation Failed'
				);
			} finally {
				urlBtn.textContent = 'Install';
				(urlBtn as HTMLButtonElement).disabled = false;
			}
		};
		urlRow.appendChild(urlBtn);
		urlSection.appendChild(urlRow);
		panel.appendChild(urlSection);

		this.listContainer.appendChild(panel);
	}

	private async _showHubEntries(hubId: string): Promise<void> {
		this.viewMode = 'install-entries';
		this.loadingHubId = hubId;
		clearNode(this.listContainer);

		const hub = this.skillInstallService.getHubs().find(h => h.id === hubId);

		// Header
		const header = $('div.skill-install-header');
		const title = $('h4.skill-install-title');
		title.textContent = hub?.name ?? hubId;
		header.appendChild(title);

		const backBtn = $('button.skill-install-back-btn');
		backBtn.textContent = '← Back to Hubs';
		backBtn.onclick = () => this._showInstallHubs();
		header.appendChild(backBtn);

		// Refresh button
		const refreshBtn = $('button.skill-hub-refresh-btn');
		refreshBtn.textContent = '🔄 Refresh';
		refreshBtn.onclick = () => {
			void this.skillInstallService.fetchHubEntries(hubId);
		};
		header.appendChild(refreshBtn);

		this.listContainer.appendChild(header);

		// Loading
		const loading = $('div.skill-hub-loading');
		loading.textContent = 'Loading skills from hub...';
		this.listContainer.appendChild(loading);

		// Fetch entries
		const entries = await this.skillInstallService.fetchHubEntries(hubId);
		this._renderHubEntries(hubId, entries);
	}

	private _renderHubEntries(hubId: string, entries?: readonly ISkillHubEntry[]): void {
		// Remove loading indicator
		const loadingEl = this.listContainer.querySelector('.skill-hub-loading');
		if (loadingEl) { loadingEl.remove(); }

		// Clear existing entries (keep header)
		const existingEntries = this.listContainer.querySelectorAll('.skill-hub-entry');
		existingEntries.forEach(el => el.remove());
		const existingEmpty = this.listContainer.querySelector('.skill-hub-entries-empty');
		if (existingEmpty) { existingEmpty.remove(); }

		const allEntries = entries ?? this.skillInstallService.getCachedEntries(hubId);

		if (allEntries.length === 0) {
			const empty = $('div.skill-hub-entries-empty');
			empty.textContent = 'No skills found in this hub. Try refreshing.';
			this.listContainer.appendChild(empty);
			return;
		}

		for (const entry of allEntries) {
			const item = $('div.skill-hub-entry');
			if (entry.installed) {
				item.classList.add('skill-hub-entry-installed');
			}

			const icon = $('span.skill-hub-entry-icon');
			icon.textContent = this._iconForCategory(entry.category);
			item.appendChild(icon);

			const info = $('div.skill-hub-entry-info');
			const nameRow = $('div.skill-hub-entry-name-row');
			const name = $('span.skill-hub-entry-name');
			name.textContent = entry.name;
			nameRow.appendChild(name);

			if (entry.category) {
				const catBadge = $('span.skill-category-badge');
				catBadge.textContent = entry.category;
				nameRow.appendChild(catBadge);
			}
			if (entry.activation) {
				const actBadge = $('span.skill-category-badge');
				actBadge.textContent = entry.activation;
				nameRow.appendChild(actBadge);
			}
			if (entry.installed) {
				const installedBadge = $('span.skill-hub-entry-installed-badge');
				installedBadge.textContent = 'Installed';
				nameRow.appendChild(installedBadge);
			}

			info.appendChild(nameRow);

			const desc = $('div.skill-hub-entry-desc');
			desc.textContent = entry.description || '(no description)';
			info.appendChild(desc);
			item.appendChild(info);

			// Install / Reinstall button
			if (!entry.installed) {
				const installBtn = $('button.skill-hub-entry-install-btn');
				installBtn.textContent = 'Install';
				installBtn.onclick = async (e) => {
					e.stopPropagation();
					installBtn.textContent = 'Installing...';
					(installBtn as HTMLButtonElement).disabled = true;
					const result = await this.skillInstallService.installFromHub(hubId, entry.id);
					if (result.success) {
						entry.installed = true;
						installBtn.textContent = 'Installed ✓';
						(installBtn as HTMLButtonElement).disabled = true;
						item.classList.add('skill-hub-entry-installed');
						// 添加已安装标记
						if (!item.querySelector('.skill-hub-entry-installed-badge')) {
							const badge = $('span.skill-hub-entry-installed-badge');
							badge.textContent = 'Installed';
							nameRow.appendChild(badge);
						}
					} else {
						installBtn.textContent = 'Install';
						(installBtn as HTMLButtonElement).disabled = false;
						await this.dialogService.info(
							`Failed to install "${entry.name}": ${result.error ?? 'Unknown error'}`,
							'Installation Failed'
						);
					}
				};
				item.appendChild(installBtn);
			}

			this.listContainer.appendChild(item);
		}
	}

	private async _showPasteDialog(): Promise<void> {
		// 用一个简单的 textarea 替代 modal dialog
		const overlay = $('div.skill-paste-overlay');
		const dialog = $('div.skill-paste-dialog');

		const title = $('h4');
		title.textContent = 'Paste SKILL.md Content';
		dialog.appendChild(title);

		const textarea = $('textarea.skill-paste-textarea') as HTMLTextAreaElement;
		textarea.placeholder = 'Paste the SKILL.md content here...\n\n---\nname: my-skill\ndescription: ...\n---\nSkill body...';
		dialog.appendChild(textarea);

		const actions = $('div.skill-paste-actions');

		const cancelBtn = $('button');
		cancelBtn.textContent = 'Cancel';
		cancelBtn.onclick = () => overlay.remove();
		actions.appendChild(cancelBtn);

		const installBtn = $('button.primary');
		installBtn.textContent = 'Install';
		installBtn.onclick = async () => {
			const content = textarea.value.trim();
			if (!content) { return; }
			installBtn.textContent = 'Installing...';
			(installBtn as HTMLButtonElement).disabled = true;
			const result = await this.skillInstallService.installFromContent(content);
			if (result.success) {
				overlay.remove();
				this._refresh();
			} else {
				installBtn.textContent = 'Install';
				(installBtn as HTMLButtonElement).disabled = false;
				await this.dialogService.info(
					`Failed to install: ${result.error ?? 'Unknown error'}`,
					'Installation Failed'
				);
			}
		};
		actions.appendChild(installBtn);

		dialog.appendChild(actions);
		overlay.appendChild(dialog);
		this.listContainer.parentElement?.appendChild(overlay);
	}

	private async _fetchUrlContent(url: string): Promise<string | undefined> {
		try {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			return await response.text();
		} catch {
			return undefined;
		}
	}

	private _iconFor(s: ISkillDefinition): string {
		switch (s.category) {
			case 'code': return '💻';
			case 'git': return '🔀';
			case 'meta': return '🧠';
			case 'docs': return '📝';
			default: return '💡';
		}
	}

	private _iconForCategory(category?: string): string {
		switch (category) {
			case 'code': return '💻';
			case 'git': return '🔀';
			case 'meta': return '🧠';
			case 'docs': return '📝';
			case 'review': return '🔍';
			case 'writing': return '✍️';
			case 'data': return '📊';
			default: return '📦';
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			// 计算可用高度：总高度减去 header (~40px) + search row (~36px) + filter row (~36px)
			this.listContainer.style.height = `${Math.max(0, height - 112)}px`;
		}
		if (this.filterRow) {
			this.filterRow.style.width = `${width}px`;
		}
	}
}
