import { IDisposable } from '../../../base/common/lifecycle.js';
import { $, append, clearNode, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { IAgentChatMessage, IWorkspaceItem } from './agentChatTypes.js';
import { positionDropdownAbove, disposeOutsideClick, registerOutsideClickClose } from './modules/dropdownHelpers.js';
import { renderHistoryOverlay } from './modules/historyOverlay.js';
import { AgentChatPanelComposer } from './agentChatPanel.composer.js';

// Feature: dropdowns. Extracted from AgentChatPanelBase.
export class AgentChatPanelDropdowns extends AgentChatPanelComposer {

	/**
	 * 获取 dropdown 容器应挂载的 document.body。popout 独立窗口是另一个 window，
	 * 若 append 到 mainWindow.document.body，则 trigger.getBoundingClientRect()
	 * 拿到的 popout 视口坐标与挂载点不在同一 viewport，定位完全错乱。
	 * 用 trigger 所在 document 即可（trigger 与 dropdown 必须同 viewport）。
	 */
	private _dropdownBody(trigger: HTMLElement | null | undefined): HTMLElement {
		return trigger?.ownerDocument?.body ?? mainWindow.document.body;
	}

protected override _openWorktreeDropdown(): void {
		this._closeAllDropdowns();
		this._activeHeaderPanel = 'worktree';
		if (this._worktreeTrigger) { this._worktreeTrigger.classList.add('open'); }

		this._worktreeDropdownEl = append(this._dropdownBody(this._worktreeTrigger), $(".chat-worktree-dropdown"));
		// 输入框中 worktree 选择器 → 弹出方向：向上（避免被输入框遮挡）
		this._positionDropdownAbove(this._worktreeDropdownEl, this._worktreeTrigger);

		const head = append(this._worktreeDropdownEl, $(".chat-worktree-dropdown-header"));
		head.textContent = 'Worktrees';

		const list = append(this._worktreeDropdownEl, $(".chat-worktree-dropdown-list"));

		// 显示加载提示
		const loadingEl = append(list, $(".chat-worktree-dropdown-loading", undefined, '加载中...'));

		// 异步加载 worktree 列表（参考 React WorktreeSwitcher 的逻辑）
		this._loadWorktreesAndRender(list, loadingEl);

		this._disposeOutsideClick(this._worktreeDropdownOutsideClick);
		this._worktreeDropdownOutsideClick = this._registerOutsideClickClose(this._worktreeDropdownEl, this._worktreeTrigger, () => this._closeWorktreeDropdown());
	}

protected override _closeWorktreeDropdown(): void {
		this._disposeOutsideClick(this._worktreeDropdownOutsideClick);
		this._worktreeDropdownOutsideClick = null;
		if (this._worktreeDropdownEl) {
			this._worktreeDropdownEl.remove();
			this._worktreeDropdownEl = null;
		}
		if (this._worktreeTrigger) { this._worktreeTrigger.classList.remove('open'); }
		if (this._activeHeaderPanel === 'worktree') {
			this._activeHeaderPanel = null;
		}
	}

protected override _getWorktreeLabel(): string {
		if (!this._selectedWorktreePath) { return '主仓库'; }
		const current = this._worktrees.find(w => w.path === this._selectedWorktreePath);
		if (current?.branch) { return current.branch; }
		return this._selectedWorktreePath.split(/[\\/]/).filter(Boolean).pop() || this._selectedWorktreePath;
	}

protected override _openWorkspaceDropdown(): void {
		this._closeAllDropdowns();
		if (this._workspaceTrigger) { this._workspaceTrigger.classList.add('open'); }

		this._workspaceDropdownEl = append(this._dropdownBody(this._workspaceTrigger), $(".workspace-dropdown"));
		// 输入框中 workspace 选择器 → 弹出方向：向上（避免被输入框遮挡）
		this._positionDropdownAbove(this._workspaceDropdownEl, this._workspaceTrigger);

		// 如果有外部提供的加载回调，先异步加载
		const renderItems = (list: IWorkspaceItem[]) => {
			if (!this._workspaceDropdownEl) { return; }
			// 清空
			while (this._workspaceDropdownEl.firstChild) { this._workspaceDropdownEl.firstChild.remove(); }
			for (const ws of list) {
				const item = append(this._workspaceDropdownEl, $(".workspace-dropdown-item"));
				if (ws.id === this._selectedWorkspaceId) {
					item.classList.add('active');
				}
				append(item, $("span.workspace-dropdown-name", undefined, ws.name));
				append(item, $("span.workspace-dropdown-path", undefined, ws.path));
				this._register(addDisposableListener(item, EventType.CLICK, () => {
					this._closeWorkspaceDropdown();
					if (ws.id !== this._selectedWorkspaceId) {
					this._selectedWorkspaceId = ws.id;
					this._onSelectWorkspace?.(ws.id, ws.name);
					// 轻量刷新输入区域（保存/恢复输入框内容），避免 _render() 全量重建清空输入框
					this._refreshInputArea();
					}
				}));
			}
		};

		const staticItems = this._workspaces;
		if (staticItems.length > 0) {
			renderItems(staticItems);
		} else if (this._onLoadWorkspaces) {
			this._onLoadWorkspaces().then(loaded => {
				this._workspaces = loaded.slice();
				renderItems(loaded as unknown as IWorkspaceItem[]);
			}).catch(() => { /* 静默忽略 */ });
		}

		this._disposeOutsideClick(this._workspaceDropdownOutsideClick);
		this._workspaceDropdownOutsideClick = this._registerOutsideClickClose(
			this._workspaceDropdownEl, this._workspaceTrigger, () => this._closeWorkspaceDropdown()
		);
	}

protected override _closeWorkspaceDropdown(): void {
		this._disposeOutsideClick(this._workspaceDropdownOutsideClick);
		this._workspaceDropdownOutsideClick = null;
		if (this._workspaceDropdownEl) {
			this._workspaceDropdownEl.remove();
			this._workspaceDropdownEl = null;
		}
		if (this._workspaceTrigger) { this._workspaceTrigger.classList.remove('open'); }
	}

protected override _renderSettingsOverlay(): void {
		this._settingsOverlayEl = append(this._container, $(".chat-settings-overlay"));
		this._renderSettingsOverlayContent('prompt');
	}

protected override _renderSettingsOverlayContent(activeTab: string): void {
		if (!this._settingsOverlayEl) { return; }
		clearNode(this._settingsOverlayEl);

		// Header (title + close button)
		const header = append(this._settingsOverlayEl, $(".chat-settings-header"));
		const titleLeft = append(header, $(".chat-settings-title-left"));
		const gearIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		gearIcon.setAttribute('width', '16');
		gearIcon.setAttribute('height', '16');
		gearIcon.setAttribute('viewBox', '0 0 24 24');
		gearIcon.setAttribute('fill', 'none');
		gearIcon.setAttribute('stroke', 'currentColor');
		gearIcon.setAttribute('stroke-width', '2');
		const gearPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		gearPath.setAttribute('d', 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z');
		gearIcon.appendChild(gearPath);
		const gearCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		gearCircle.setAttribute('cx', '12');
		gearCircle.setAttribute('cy', '12');
		gearCircle.setAttribute('r', '3');
		gearIcon.appendChild(gearCircle);
		titleLeft.appendChild(gearIcon);
		append(titleLeft, $("span.chat-settings-title", undefined, 'Agent 配置'));

		// Close button (right-aligned)
		const closeBtn = append(header, $("button.chat-settings-close-btn"));
		closeBtn.title = '关闭';
		const closeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		closeSvg.setAttribute('width', '16');
		closeSvg.setAttribute('height', '16');
		closeSvg.setAttribute('viewBox', '0 0 24 24');
		closeSvg.setAttribute('fill', 'none');
		closeSvg.setAttribute('stroke', 'currentColor');
		closeSvg.setAttribute('stroke-width', '2');
		closeSvg.setAttribute('stroke-linecap', 'round');
		const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		closePath.setAttribute('d', 'M18 6L6 18M6 6l12 12');
		closeSvg.appendChild(closePath);
		closeBtn.appendChild(closeSvg);
		this._register(
			addDisposableListener(closeBtn, EventType.CLICK, () => {
				this._activeHeaderPanel = null;
				this._render();
			}),
		);

		// Tab bar — 使用 Codicon 原生图标 + monaco-button 样式
		const tabBar = append(this._settingsOverlayEl, $(".chat-settings-tabs"));
		const tabs: { id: string; codicon: string; label: string }[] = [
			{ id: 'prompt', codicon: 'codicon codicon-comment-discussion', label: 'Prompt' },
			{ id: 'skills', codicon: 'codicon codicon-tools', label: '技能' },
			{ id: 'mcp', codicon: 'codicon codicon-server', label: 'MCP' },
			{ id: 'knowledge', codicon: 'codicon codicon-library', label: '知识库' },
			{ id: 'rules', codicon: 'codicon codicon-checklist', label: '规则' },
		];
		// Channel 绑定 tab：仅当提供飞书绑定回调时显示
		if (this._onListFeishuBindings) {
			tabs.push({ id: 'channel', codicon: 'codicon codicon-broadcast', label: 'Channel 绑定' });
		}
		for (const tab of tabs) {
			const tabBtn = append(tabBar, $("button.chat-settings-tab"));
			if (tab.id === activeTab) { tabBtn.classList.add('active'); }
			append(tabBtn, $("span.tab-icon." + tab.codicon));
			append(tabBtn, $("span.tab-label", undefined, tab.label));
			this._register(
				addDisposableListener(tabBtn, EventType.CLICK, () => {
					this._renderSettingsOverlayContent(tab.id);
				}),
			);
		}

		// Content area
		const contentArea = append(this._settingsOverlayEl, $(".chat-settings-content"));

		// Render tab content
		if (activeTab === 'prompt') {
			this._renderSettingsPromptTab(contentArea);
		} else if (activeTab === 'skills') {
			this._renderSettingsSkillsTab(contentArea);
		} else if (activeTab === 'mcp') {
			this._renderSettingsMcpTab(contentArea);
		} else if (activeTab === 'knowledge') {
			this._renderSettingsKnowledgeTab(contentArea);
		} else if (activeTab === 'rules') {
			this._renderSettingsRulesTab(contentArea);
		} else if (activeTab === 'channel') {
			this._renderSettingsChannelTab(contentArea);
		}

		// Footer with "Open full editor" button — 使用 VS Code 原生 monaco-button
		const footer = append(this._settingsOverlayEl, $(".chat-settings-footer"));
		const openFullBtn = append(footer, $("button.monaco-button.monaco-text-button.chat-settings-open-full-btn"));
		openFullBtn.textContent = '在完整编辑器中打开 →';
		this._register(
			addDisposableListener(openFullBtn, EventType.CLICK, () => {
				this._activeHeaderPanel = null;
				this._render();
				this._onOpenSettings?.();
			}),
		);
	}

protected override _renderSettingsPromptTab(container: HTMLElement): void {
		const desc = append(container, $(".chat-settings-tab-desc"));
		desc.textContent = '编辑 Agent 的系统提示词';

		const textarea = append(container, $("textarea.chat-settings-prompt-editor")) as HTMLTextAreaElement;
		textarea.spellcheck = false;
		textarea.placeholder = '输入系统提示词...';
		// 使用当前 agent 的实际系统提示词，而非硬编码默认值
		textarea.value = this._agent?.customPrompt ?? '';

		const actions = append(container, $(".chat-settings-tab-actions"));
		append(actions, $("span.dirty-hint", undefined, '● 未保存'));
		const spacer = append(actions, $("div"));
		spacer.style.flex = '1';
		const saveBtn = append(actions, $("button.monaco-button.monaco-text-button.action-btn.primary", undefined, '保存'));
		this._register(
			addDisposableListener(saveBtn, EventType.CLICK, () => {
				// TODO: save system prompt via callback
				console.log('[Settings] Save prompt clicked');
			}),
		);
	}

protected override _renderSettingsSkillsTab(container: HTMLElement): void {
		const desc = append(container, $(".chat-settings-tab-desc"));
		desc.textContent = '为 Agent 配置技能。点击右侧可用技能添加，点击左侧已安装技能移除。';

		const panel = append(container, $(".skills-dnd-panel"));

		// Left: installed skills
		const leftCol = append(panel, $(".skills-column"));
		const leftHeader = append(leftCol, $(".skills-column-header"));
		leftHeader.textContent = '已安装技能';
		const leftList = append(leftCol, $(".skills-list"));

		// Right: available skills
		const rightCol = append(panel, $(".skills-column"));
		const rightHeader = append(rightCol, $(".skills-column-header"));
		rightHeader.textContent = '可用技能';
		const rightFilter = append(rightCol, $('input.skills-filter-input')) as HTMLInputElement;
		rightFilter.type = 'text';
		rightFilter.placeholder = '搜索技能...';
		const rightList = append(rightCol, $(".skills-list"));

		const allSkills = this._onListSkills();
		const agentSkillIds = this._onGetAgentSkills?.() ?? [];

		const renderSkillsLists = (filterText: string = '') => {
			// Installed skills
			leftList.replaceChildren();
			if (agentSkillIds.length === 0) {
				const empty = append(leftList, $(".skills-empty"));
				empty.textContent = '暂无已安装技能';
			} else {
				for (const skillId of agentSkillIds) {
					const skill = allSkills.find(s => s.id === skillId);
					const item = append(leftList, $(".skill-item.installed"));
					const info = append(item, $(".skill-item-info"));
					const nameEl = append(info, $("span.skill-item-name"));
					nameEl.textContent = skill?.name || skillId;
					if (skill?.category) {
						append(info, $("span.skill-item-cat", undefined, skill.category));
					}
					const removeBtn = append(item, $("button.skill-remove-btn")) as HTMLButtonElement;
					removeBtn.title = '移除';
					removeBtn.textContent = '✕';
					this._register(addDisposableListener(removeBtn, EventType.CLICK, async (e) => {
						e.stopPropagation();
						removeBtn.disabled = true;
						try {
							await this._onRemoveSkill?.(skillId);
							const idx = agentSkillIds.indexOf(skillId);
							if (idx >= 0) { agentSkillIds.splice(idx, 1); }
							renderSkillsLists(rightFilter.value);
						} catch {
							removeBtn.disabled = false;
						}
					}));
				}
			}

			// Available skills
			rightList.replaceChildren();
			const available = allSkills.filter(s =>
				!agentSkillIds.includes(s.id) &&
				(!filterText || s.name.toLowerCase().includes(filterText.toLowerCase()))
			);
			if (available.length === 0) {
				const empty = append(rightList, $(".skills-empty"));
				empty.textContent = filterText ? '未找到匹配的技能' : '无可用技能';
			} else {
				for (const skill of available) {
					const item = append(rightList, $(".skill-item.available"));
					const info = append(item, $(".skill-item-info"));
					const nameEl = append(info, $("span.skill-item-name"));
					nameEl.textContent = skill.name;
					if (skill.category) {
						append(info, $("span.skill-item-cat", undefined, skill.category));
					}
					const addBtn = append(item, $("button.skill-add-btn")) as HTMLButtonElement;
					addBtn.title = '添加';
					addBtn.textContent = '+';
					this._register(addDisposableListener(addBtn, EventType.CLICK, async (e) => {
						e.stopPropagation();
						addBtn.disabled = true;
						try {
							await this._onAddSkill?.(skill.id);
							agentSkillIds.push(skill.id);
							renderSkillsLists(rightFilter.value);
						} catch {
							addBtn.disabled = false;
						}
					}));
				}
			}
		};

		this._register(addDisposableListener(rightFilter, EventType.INPUT, () => {
			renderSkillsLists(rightFilter.value);
		}));

		renderSkillsLists();
	}

protected override _renderSettingsMcpTab(container: HTMLElement): void {
		const desc = append(container, $(".chat-settings-tab-desc"));
		desc.textContent = 'MCP（Model Context Protocol）配置：连接外部工具和数据源。';

		const servers = this._onListMcpServers?.() ?? [];

		if (servers.length === 0) {
			const placeholder = append(container, $(".chat-settings-empty"));
			placeholder.textContent = '暂无已连接的 MCP 服务器';
		} else {
			const list = append(container, $(".skills-list.mcp-server-list"));
			for (const server of servers) {
				const item = append(list, $(".skill-item.mcp-server-item"));
				append(item, $("span.skill-item-icon.codicon.codicon-server"));
				const info = append(item, $(".skill-item-info"));
				const nameEl = append(info, $("span.skill-item-name"));
				nameEl.textContent = server.name;
				const statusEl = append(info, $("span.skill-item-cat"));
				statusEl.textContent = `${server.status} · ${server.toolCount} 个工具`;
				// 状态指示灯
				const dot = append(item, $("span.mcp-status-dot"));
				if (server.status === 'connected' || server.status === 'running') {
					dot.style.background = '#4ec9b0';
				} else if (server.status === 'error') {
					dot.style.background = '#f48771';
				} else {
					dot.style.background = '#cccccc';
				}
			}
		}

		// 操作按钮——使用 VS Code 原生 monaco-button
		const actions = append(container, $(".chat-settings-tab-actions"));
		const addBtn = append(actions, $("button.monaco-button.monaco-text-button.action-btn.primary", undefined, '配置 MCP 服务器'));
		this._register(
			addDisposableListener(addBtn, EventType.CLICK, () => {
				this._onOpenMcpSettings?.();
			}),
		);
	}

protected override _renderSettingsKnowledgeTab(container: HTMLElement): void {
		const desc = append(container, $(".chat-settings-tab-desc"));
		desc.textContent = '知识库检索配置';

		const section = append(container, $(".chat-settings-section.expanded"));
		const sectionHeader = append(section, $(".config-section-header", undefined, '基础设置'));
		sectionHeader.style.padding = '8px 12px';
		sectionHeader.style.fontSize = '12px';
		sectionHeader.style.fontWeight = '600';
		sectionHeader.style.borderBottom = '1px solid rgba(128,128,128,0.1)';

		const body = append(section, $(".config-section-body"));
		body.style.padding = '10px 12px';
		body.style.display = 'flex';
		body.style.flexDirection = 'column';
		body.style.gap = '10px';

		const row1 = append(body, $(".config-row"));
		row1.style.display = 'flex';
		row1.style.alignItems = 'center';
		row1.style.justifyContent = 'space-between';
		append(row1, $("span.config-row-label", undefined, '启用知识库'));
		const toggle1 = append(row1, $("div.toggle-switch.on"));
		this._register(
			addDisposableListener(toggle1, EventType.CLICK, (e) => {
				e.stopPropagation();
				toggle1.classList.toggle('on');
			}),
		);

		const row2 = append(body, $(".config-row"));
		row2.style.display = 'flex';
		row2.style.alignItems = 'center';
		row2.style.justifyContent = 'space-between';
		append(row2, $("span.config-row-label", undefined, '检索策略'));
		const select = append(row2, $("select.config-select")) as HTMLSelectElement;
		for (const opt of ['hybrid（混合）', 'vector（向量）', 'keyword（关键词）']) {
			const o = document.createElement('option');
			o.textContent = opt;
			select.appendChild(o);
		}
	}

protected override _renderSettingsRulesTab(container: HTMLElement): void {
		const desc = append(container, $(".chat-settings-tab-desc"));
		desc.textContent = 'Agent 行为规则和约束';

		const list = append(container, $(".chat-settings-rules-list"));
		const rules = [
			{ icon: '🔒', name: '安全规则', desc: '禁止执行危险命令（rm -rf 等）' },
			{ icon: '📝', name: '代码审查规则', desc: '修改前先阅读文件，修改后检查 lint' },
			{ icon: '🎯', name: '任务完成规则', desc: '完成后验证编译并总结改动' },
		];
		for (const rule of rules) {
			const card = append(list, $(".chat-settings-rule-card"));
			append(card, $("span.rule-icon", undefined, rule.icon));
			const content = append(card, $(".rule-content"));
			append(content, $("div.rule-name", undefined, rule.name));
			append(content, $("div.rule-desc", undefined, rule.desc));
			const toggle = append(card, $("div.toggle-switch.on"));
			this._register(
				addDisposableListener(toggle, EventType.CLICK, (e) => {
					e.stopPropagation();
					toggle.classList.toggle('on');
				}),
			);
		}
	}

protected override _renderSettingsChannelTab(container: HTMLElement): void {
		// 重渲染前清空（绑定/解绑后复用同一 container 重新渲染）
		clearNode(container);

		const desc = append(container, $(".chat-settings-tab-desc"));
		desc.textContent = '配置此 Agent 与各消息渠道（Channel）的绑定关系。当前已支持「飞书」渠道：可设为渠道默认处理 Agent，或按会话（chat_id）精确绑定。';

		// 缺少回调或尚未选定 Agent：提示
		if (!this._onListFeishuBindings || !this._agent?.id) {
			const note = append(container, $("div.chat-settings-note"));
			note.textContent = this._agent?.id ? '（当前环境暂不支持 Channel 绑定）' : '（请先选择一个 Agent）';
			return;
		}
		const agentId = this._agent.id;

		// ── 渠道分组：飞书（Feishu） ──
		const group = append(container, $(".chat-channel-group"));
		const groupHeader = append(group, $(".chat-channel-group-header"));
		const groupIcon = append(groupHeader, $("span.chat-channel-group-icon"));
		groupIcon.textContent = '🔵';
		const groupTitle = append(groupHeader, $("span.chat-channel-group-title"));
		groupTitle.textContent = '飞书 (Feishu)';

		// Section 1: 飞书渠道默认 Agent
		const sec1 = append(group, $(".chat-binding-section"));
		const sec1Title = append(sec1, $("div.chat-binding-section-title"));
		sec1Title.textContent = '飞书渠道默认 Agent';
		const defRow = append(sec1, $("div.chat-binding-default-row"));
		const toggle = document.createElement('input');
		toggle.type = 'checkbox';
		toggle.id = 'chat-feishu-default-toggle';
		const curDefault = this._onGetFeishuDefaultAgent?.();
		toggle.checked = (curDefault === agentId);
		toggle.onchange = () => {
			this._onSetFeishuDefaultAgent?.(toggle.checked ? agentId : undefined);
		};
		append(defRow, toggle);
		const defLabel = append(defRow, $("label.chat-binding-default-label"));
		defLabel.textContent = '将此 Agent 设为飞书渠道的默认处理 Agent（无精确群绑定时生效）';
		defLabel.setAttribute('for', 'chat-feishu-default-toggle');

		// Section 2: 群聊绑定（按会话 chat_id）
		const sec2 = append(group, $(".chat-binding-section"));
		const sec2Title = append(sec2, $("div.chat-binding-section-title"));
		sec2Title.textContent = '群聊绑定（按会话）';
		const hint = append(sec2, $("div.chat-binding-hint"));
		hint.textContent = '在飞书群中发送 /bind list 可查看本群 chat_id。绑定的群聊消息将自动路由给本 Agent。';
		const addRow = append(sec2, $("div.chat-binding-add-row"));
		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'chat-binding-input';
		input.placeholder = '输入飞书群聊会话 ID（chat_id）';
		input.onkeydown = (e) => {
			if (e.key === 'Enter') { e.preventDefault(); void doBind(); }
		};
		append(addRow, input);
		const addBtn = append(addRow, $("button.monaco-button.monaco-text-button.chat-settings-add-btn")) as HTMLButtonElement;
		addBtn.textContent = '➕ 绑定';

		const listContainer = append(sec2, $("div.chat-binding-list"));

		const doBind = () => {
			const chatId = input.value.trim();
			if (!chatId) { return; }
			this._onAddFeishuBinding?.(chatId);
			// 乐观重渲染：列表从回调实时读取，失败绑定自然不会出现在列表
			this._renderSettingsChannelTab(container);
		};
		addBtn.onclick = () => void doBind();

		const renderList = () => {
			listContainer.replaceChildren();
			const bindings = this._onListFeishuBindings!();
			const mine = bindings.filter(b => b.agentId === agentId);
			if (mine.length === 0) {
				const empty = append(listContainer, $("div.skills-empty"));
				empty.textContent = '暂无绑定的飞书群聊';
				return;
			}
			for (const b of mine) {
				const item = append(listContainer, $("div.skill-item.installed"));
				const info = append(item, $("div.skill-item-info"));
				const nameEl = append(info, $("span.skill-item-name"));
				nameEl.textContent = b.conversationId;
				const removeBtn = append(item, $("button.skill-remove-btn")) as HTMLButtonElement;
				removeBtn.title = '解除绑定';
				removeBtn.textContent = '✕';
				removeBtn.onclick = () => {
					this._onRemoveFeishuBinding?.(b.conversationId);
					this._renderSettingsChannelTab(container);
				};
			}
		};
		renderList();
	}

protected override _renderMsgNavOverlay(): void {
		this._msgNavOverlayEl = append(this._container, $(".chat-msg-nav-overlay"));
		this._renderMsgNavOverlayContent();
	}

protected override _renderMsgNavOverlayContent(): void {
		if (!this._msgNavOverlayEl) { return; }
		clearNode(this._msgNavOverlayEl);

		// Header (title + close button)
		const header = append(this._msgNavOverlayEl, $(".chat-msg-nav-header"));
		const titleLeft = append(header, $(".chat-msg-nav-title-left"));
		const listIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		listIcon.setAttribute('width', '16');
		listIcon.setAttribute('height', '16');
		listIcon.setAttribute('viewBox', '0 0 20 20');
		listIcon.setAttribute('fill', 'none');
		listIcon.setAttribute('stroke', 'currentColor');
		listIcon.setAttribute('stroke-width', '1.6');
		const li1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		li1.setAttribute('d', 'M3 5h14M3 10h14M3 15h14');
		li1.setAttribute('stroke-linecap', 'round');
		listIcon.appendChild(li1);
		titleLeft.appendChild(listIcon);
		append(titleLeft, $("span.chat-msg-nav-title", undefined, '会话消息'));

		// Close button (right-aligned)
		const closeBtn = append(header, $("button.chat-msg-nav-close-btn"));
		closeBtn.title = '关闭';
		const closeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		closeSvg.setAttribute('width', '16');
		closeSvg.setAttribute('height', '16');
		closeSvg.setAttribute('viewBox', '0 0 24 24');
		closeSvg.setAttribute('fill', 'none');
		closeSvg.setAttribute('stroke', 'currentColor');
		closeSvg.setAttribute('stroke-width', '2');
		closeSvg.setAttribute('stroke-linecap', 'round');
		closeSvg.setAttribute('stroke-linejoin', 'round');
		const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		closePath.setAttribute('d', 'M18 6L6 18M6 6l12 12');
		closeSvg.appendChild(closePath);
		closeBtn.appendChild(closeSvg);
		this._register(
			addDisposableListener(closeBtn, EventType.CLICK, () => {
				this._activeHeaderPanel = null;
				this._render();
			}),
		);

		// Search box
		const searchWrap = append(this._msgNavOverlayEl, $(".chat-msg-nav-search"));
		const searchInput = append(searchWrap, $("input.chat-msg-nav-search-input", { type: 'text', placeholder: '搜索消息...' })) as HTMLInputElement;

		// Message list (grouped by date)
		const listEl = append(this._msgNavOverlayEl, $(".chat-msg-nav-list"));

		if (this._messages.length === 0) {
			append(listEl, $(".chat-msg-nav-empty", undefined, '当前对话还没有消息'));
		} else {
			this._renderMsgNavItems(listEl, searchInput);
		}

		// Footer (message count)
		const footer = append(this._msgNavOverlayEl, $(".chat-msg-nav-footer"));
		footer.textContent = `共 ${this._messages.length} 条消息`;

		// Search filter
		this._register(
			addDisposableListener(searchInput, EventType.INPUT, () => {
				this._renderMsgNavItems(listEl, searchInput);
			}),
		);
	}

protected override _renderMsgNavItems(listEl: HTMLElement, searchInput: HTMLInputElement): void {
		clearNode(listEl);
		const query = (searchInput.value || '').toLowerCase();

		// Group messages by date
		const groups = this._groupMessagesByDate();

		for (const group of groups) {
			if (group.msgs.length === 0) { continue; }

			// Date divider
			const divider = append(listEl, $(".chat-msg-nav-date-divider"));
			divider.textContent = group.label;

			for (const m of group.msgs) {
				const summary = this._getMessageSummary(m);
				if (query && !summary.toLowerCase().includes(query)) { continue; }

				const item = append(listEl, $(".chat-msg-nav-item"));

				// Role dot
				const dot = append(item, $("span.chat-msg-nav-role-dot", { 'data-role': m.role }));
				dot.title = m.role === 'user' ? '你' : m.role === 'assistant' ? '助手' : m.role === 'system' ? '系统' : '工具';

				// Content
				const content = append(item, $(".chat-msg-nav-item-content"));
				const text = append(content, $("span.chat-msg-nav-item-text"));
				text.textContent = summary;
				const time = append(content, $("span.chat-msg-nav-item-time"));
				time.textContent = this._formatMsgTime(m.timestamp);

				this._register(
					addDisposableListener(item, EventType.CLICK, () => {
						this._activeHeaderPanel = null;
						this._render();
						this._scrollToMessage(m.id);
						this._onScrollToMessage?.(m.id);
					}),
				);
			}
		}
	}

protected override _groupMessagesByDate(): { label: string; msgs: IAgentChatMessage[] }[] {
		const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
		const yesterdayStart = new Date(todayStart.getTime() - 86400000);
		const weekStart = new Date(todayStart.getTime() - 7 * 86400000);

		const groups: { label: string; msgs: IAgentChatMessage[]; order: number }[] = [
			{ label: '今天', msgs: [], order: 0 },
			{ label: '昨天', msgs: [], order: 1 },
			{ label: '本周更早', msgs: [], order: 2 },
			{ label: '更早', msgs: [], order: 3 },
		];

		for (const m of this._messages) {
			const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
			if (t >= todayStart.getTime()) {
				groups[0].msgs.push(m);
			} else if (t >= yesterdayStart.getTime()) {
				groups[1].msgs.push(m);
			} else if (t >= weekStart.getTime()) {
				groups[2].msgs.push(m);
			} else {
				groups[3].msgs.push(m);
			}
		}

		return groups.filter(g => g.msgs.length > 0).map(({ label, msgs }) => ({ label, msgs: msgs.reverse() }));
	}

protected override _getMessageSummary(m: IAgentChatMessage): string {
		const roleLabel = m.role === 'user' ? '你' : m.role === 'assistant' ? '助手' : m.role === 'system' ? '系统' : '工具';
		let content = '';
		if (m.content) {
			content = (m.content || '').replace(/\n/g, ' ').trim();
		} else if (m.toolCalls && m.toolCalls.length > 0) {
			const tc = m.toolCalls[0];
			content = `${tc.name} · ${tc.args || ''}`.slice(0, 60);
		}
		const summary = content.slice(0, 50) + (content.length > 50 ? '…' : '');
		return `${roleLabel}：${summary}`;
	}

protected override _formatMsgTime(timestamp: number | undefined): string {
		if (!timestamp) { return ''; }
		try {
			const d = new Date(timestamp);
			const now = new Date();
			const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
			const diffDays = Math.round((todayStart.getTime() - msgDate.getTime()) / 86400000);

			const hh = d.getHours().toString().padStart(2, '0');
			const mm = d.getMinutes().toString().padStart(2, '0');

			if (diffDays === 0) {
				// Within 5 minutes: "刚刚"
				const diffMin = Math.round((now.getTime() - d.getTime()) / 60000);
				if (diffMin <= 1) { return '刚刚'; }
				if (diffMin <= 60) { return `${diffMin}分钟前`; }
				return `${hh}:${mm}`;
			} else if (diffDays === 1) {
				return `昨天 ${hh}:${mm}`;
			} else if (diffDays <= 7) {
				return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
			} else {
				return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
			}
		} catch {
			return '';
		}
	}

protected override _scrollToMessage(messageId: string): void {
		if (!this._messagesContainer) { return; }
		let el = this._messagesContainer.querySelector(`[data-msg-id="${messageId}"]`) as HTMLElement | null;

		if (!el) {
			// 目标消息不在 DOM 中——可能在懒加载未渲染范围内。
			// 强制渲染全部消息后重试。
			this._forceRenderAllMessages();
			el = this._messagesContainer.querySelector(`[data-msg-id="${messageId}"]`) as HTMLElement | null;
			if (!el) { return; } // 仍然找不到——消息不存在
		}

		el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		// 不再自动跟随：滚动到历史消息意味着用户正在查看历史
		this._isAtBottom = false;
		// 更新按钮状态（内联 80px 阈值检查）
		const dist = this._messagesContainer.scrollHeight - this._messagesContainer.scrollTop - this._messagesContainer.clientHeight;
		const show = dist >= 80;
		this._showScrollBtn = show;
		if (this._scrollToBottomBtn) { this._scrollToBottomBtn.classList.toggle("visible", show); }
		// 高亮闪烁效果
		el.classList.add('chat-message-flash');
		mainWindow.setTimeout(() => el.classList.remove('chat-message-flash'), 1200);
		// 跳转后刷新标记位置
		this._scrollbar.refreshScrollMarkers();
	}

protected override _forceRenderAllMessages(): void {
		if (!this._messagesContainer) { return; }
		const firstRendered = this._messagesContainer.firstElementChild as HTMLElement | null;
		if (!firstRendered) { return; }

		const firstRenderedId = firstRendered.getAttribute('data-msg-id');
		if (!firstRenderedId) { return; }
		const firstRenderedIdx = this._messages.findIndex(m => m.id === firstRenderedId);
		if (firstRenderedIdx <= 0) { return; } // 所有消息已渲染

		// 一次性插入所有未渲染的消息
		const frag = document.createDocumentFragment();
		for (let i = 0; i < firstRenderedIdx; i++) {
			const el = this._createMessageElement(this._messages[i]);
			frag.appendChild(el);
		}
		// 保持滚动位置
		const prevScrollHeight = this._messagesContainer.scrollHeight;
		const prevScrollTop = this._messagesContainer.scrollTop;
		firstRendered.parentNode?.insertBefore(frag, firstRendered);
		const scrollDiff = this._messagesContainer.scrollHeight - prevScrollHeight;
		if (scrollDiff > 0) {
			this._messagesContainer.scrollTop = prevScrollTop + scrollDiff;
		}

		// 全部消息已渲染——断开懒加载 observer
		if (this._lazyLoadObserver) {
			this._lazyLoadObserver.disconnect();
			this._lazyLoadObserver = null;
		}
	}

	protected override _openModeDropdown(customTrigger?: HTMLElement | null): void {
		this._closeAllDropdowns();
		this._modeDropdownTrigger = customTrigger ?? this._modeTrigger;
		if (this._modeDropdownTrigger) { this._modeDropdownTrigger.classList.add('open'); }

		this._modeDropdownEl = append(this._dropdownBody(this._modeDropdownTrigger), $(".mode-dropdown-composer"));
		this._positionDropdownAbove(this._modeDropdownEl, this._modeDropdownTrigger);

		// ChatOnly toggle dropdown — legacy mode selector replaced by simple chatOnly on/off
		const chatOnlyItem = append(this._modeDropdownEl, $(`.mode-item${this._chatOnly ? '.active' : ''}`));
		const ic = append(chatOnlyItem, $(".mode-item-icon"));
		const sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		sv.setAttribute('width', '14');
		sv.setAttribute('height', '14');
		sv.setAttribute('viewBox', '0 0 24 24');
		sv.setAttribute('fill', 'none');
		sv.setAttribute('stroke', 'currentColor');
		sv.setAttribute('stroke-width', '2');
		sv.setAttribute('stroke-linecap', 'round');
		sv.setAttribute('stroke-linejoin', 'round');
		const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		// Eye icon
		p.setAttribute('d', 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z');
		sv.appendChild(p);
		ic.appendChild(sv);

		const text = append(chatOnlyItem, $(".mode-item-text"));
		append(text, $("span.mode-item-label", undefined, '纯聊模式'));
		append(text, $("span.mode-item-tooltip", undefined, this._chatOnly ? '纯聊：已开启（禁止工具执行）' : '纯聊：关闭中（允许工具执行）'));

		this._register(
			addDisposableListener(chatOnlyItem, EventType.CLICK, () => {
				this._closeModeDropdown();
				this._chatOnly = !this._chatOnly;
				this._refreshInputArea();
			}),
		);

		this._disposeOutsideClick(this._modeDropdownOutsideClick);
		this._modeDropdownOutsideClick = this._registerOutsideClickClose(this._modeDropdownEl, this._modeDropdownTrigger, () => this._closeModeDropdown());
	}

	protected override _closeModeDropdown(): void {
		this._disposeOutsideClick(this._modeDropdownOutsideClick);
		this._modeDropdownOutsideClick = null;
		if (this._modeDropdownEl) {
			this._modeDropdownEl.remove();
			this._modeDropdownEl = null;
		}
		if (this._modeDropdownTrigger) { this._modeDropdownTrigger.classList.remove('open'); }
		this._modeDropdownTrigger = null;
	}

	protected override _openProviderDropdown(customTrigger?: HTMLElement | null): void {
		this._closeAllDropdowns();
		this._providerDropdownTrigger = customTrigger ?? this._providerTrigger;
		if (this._providerDropdownTrigger) { this._providerDropdownTrigger.classList.add('open'); }

		this._providerDropdownEl = append(this._dropdownBody(this._providerDropdownTrigger), $(".provider-dropdown"));
		this._positionDropdownAbove(this._providerDropdownEl, this._providerDropdownTrigger);

		if (this._providers.length === 0) {
			append(this._providerDropdownEl, $(".provider-dropdown-empty", undefined, '暂无可用 Provider'));
		} else {
			for (const p of this._providers) {
				const item = append(this._providerDropdownEl, $(`.provider-dropdown-item${this._currentProvider === p.id ? '.active' : ''}`));
				append(item, $("span.provider-dropdown-name", undefined, p.label));
				this._register(
					addDisposableListener(item, EventType.CLICK, () => {
						this._closeProviderDropdown();
						if (p.id !== this._currentProvider) {
							this._currentProvider = p.id;
							this._onSelectProvider?.(p.id);
							// 轻量刷新输入区域（保存/恢复输入框内容），避免 _render() 全量重建清空输入框
							this._refreshInputArea();
						}
					}),
				);
			}
		}

		this._disposeOutsideClick(this._providerDropdownOutsideClick);
		this._providerDropdownOutsideClick = this._registerOutsideClickClose(this._providerDropdownEl, this._providerDropdownTrigger, () => this._closeProviderDropdown());
	}

protected override _closeProviderDropdown(): void {
		this._disposeOutsideClick(this._providerDropdownOutsideClick);
		this._providerDropdownOutsideClick = null;
		if (this._providerDropdownEl) {
			this._providerDropdownEl.remove();
			this._providerDropdownEl = null;
		}
		if (this._providerDropdownTrigger) { this._providerDropdownTrigger.classList.remove('open'); }
		this._providerDropdownTrigger = null;
	}

protected override _openModelDropdown(customTrigger?: HTMLElement | null): void {
		this._closeAllDropdowns();
		this._modelDropdownTrigger = customTrigger ?? this._modelTrigger;
		if (this._modelDropdownTrigger) { this._modelDropdownTrigger.classList.add('open'); }

		this._modelDropdownEl = append(this._dropdownBody(this._modelDropdownTrigger), $(".provider-dropdown.model-dropdown"));
		this._positionDropdownAbove(this._modelDropdownEl, this._modelDropdownTrigger);

		// 仅显示当前 provider 对应的 model
		const filtered = this._currentProvider
			? this._models.filter(m => !m.provider || m.provider === this._currentProvider)
			: this._models;

		if (filtered.length === 0) {
			append(this._modelDropdownEl, $(".provider-dropdown-empty", undefined, '暂无可用模型'));
		} else {
			for (const m of filtered) {
				const item = append(this._modelDropdownEl, $(`.provider-dropdown-item${this._currentModel === m.id ? '.active' : ''}`));
				append(item, $("span.provider-dropdown-name", undefined, m.label));
				if (m.provider) {
					append(item, $("span.provider-dropdown-detail", undefined, m.provider));
				}
				this._register(
					addDisposableListener(item, EventType.CLICK, () => {
						this._closeModelDropdown();
						if (m.id !== this._currentModel) {
							this._currentModel = m.id;
							this._onSelectModel?.(m.id);
							// 轻量刷新输入区域（保存/恢复输入框内容），避免 _render() 全量重建清空输入框
							this._refreshInputArea();
						}
					})
				);
			}
		}

		this._disposeOutsideClick(this._modelDropdownOutsideClick);
		this._modelDropdownOutsideClick = this._registerOutsideClickClose(this._modelDropdownEl, this._modelDropdownTrigger, () => this._closeModelDropdown());
	}

protected override _closeModelDropdown(): void {
		this._disposeOutsideClick(this._modelDropdownOutsideClick);
		this._modelDropdownOutsideClick = null;
		if (this._modelDropdownEl) {
			this._modelDropdownEl.remove();
			this._modelDropdownEl = null;
		}
		if (this._modelDropdownTrigger) { this._modelDropdownTrigger.classList.remove('open'); }
		this._modelDropdownTrigger = null;
	}

protected override _renderHistoryOverlay(): void {
		this._historyOverlayEl = renderHistoryOverlay(
			this._container,
			{ agentSessions: this._agentSessions },
			{
				onRenameSession: this._onRenameSession,
				onDeleteSession: this._onDeleteSession,
				onForkSession: this._onForkSession,
				onOpenSession: this._onOpenSession,
				onNewSession: this._onNewSession,
				onClose: () => { this._activeHeaderPanel = null; this._render(); },
			},
			(d) => this._register(d),
		);
	}

protected override _positionDropdownAbove(el: HTMLElement, trigger: HTMLElement | null): void {
		positionDropdownAbove(el, trigger);
	}

protected override _disposeOutsideClick(d: IDisposable | null): void {
		disposeOutsideClick(d);
	}

protected override _registerOutsideClickClose(panel: HTMLElement, trigger: HTMLElement | null, onClose: () => void): IDisposable {
		return registerOutsideClickClose(panel, trigger, onClose, (d) => this._register(d));
	}
}
