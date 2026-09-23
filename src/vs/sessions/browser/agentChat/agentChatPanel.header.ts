import { $, append, clearNode, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { IAgentChatMessage, IMessagePart, flattenMessageParts, STATUS_MAP, AgentStatus, mergeTurnMessageParts } from './agentChatTypes.js';
import { AgentChatPanelSend } from './agentChatPanel.send.js';

// Feature: header. Extracted from AgentChatPanelBase.
export class AgentChatPanelHeader extends AgentChatPanelSend {

protected override _renderTabsContainer(): void {
		// Create tabs container
		const tabsContainer = append(this._container, $('.chat-tabs-container'));

		// Create tabs list (role="tablist")
		this._tabsContainer = append(tabsContainer, $('.chat-tabs', { role: 'tablist' }));

		// Render tabs
		this._renderTabs();
	}

protected override _renderTabs(): void {
		if (!this._tabsContainer) {
			return;
		}

		clearNode(this._tabsContainer);

		// Create a tab for each available agent
		for (const agent of this._availableAgents) {
			const tab = append(this._tabsContainer, $('.chat-tab', { role: 'tab' }));

			// Mark active tab
			if (this._agent && agent.id === this._agent.id) {
				tab.classList.add('active');
				tab.setAttribute('aria-selected', 'true');
			} else {
				tab.setAttribute('aria-selected', 'false');
			}

			// Agent avatar/icon
			const avatar = append(tab, $('.chat-tab-avatar'));
			if (agent.avatarUrl) {
				const img = append(avatar, $('img')) as HTMLImageElement;
				img.src = agent.avatarUrl;
				img.alt = agent.name;
				img.style.width = '16px';
				img.style.height = '16px';
				img.style.borderRadius = '2px';
			} else if (agent.icon) {
				// Use icon emoji — no background, matches preset panel style
				const iconEl = append(avatar, $('.chat-tab-avatar-icon'));
				iconEl.textContent = agent.icon;
			} else {
				const fallback = append(avatar, $('.chat-tab-avatar-fallback'));
				fallback.textContent = agent.name.charAt(0).toUpperCase();
			}

			// Agent name
			const label = append(tab, $('.chat-tab-label'));
			label.textContent = agent.name;

			// Click handler to switch agent
			this._register(
				addDisposableListener(tab, EventType.CLICK, () => {
					this._onSelectAgent(agent.id);
				})
			);

			// 右键菜单：对当前 session 重命名（复用 Dropdowns 中的自定义菜单）
			this._register(
				addDisposableListener(tab, EventType.CONTEXT_MENU, (ev) => {
					this._openSessionContextMenu(ev);
				})
			);
		}
	}

protected override _renderEmptyState(): void {
		// 还原原 webview AgentChat.tsx 的空状态结构：
		// <div class="chat-empty">
		//   <div class="chat-empty-inner">
		//     <div class="chat-empty-icon">💬</div>
		//     <h2 class="chat-empty-title">Agent Studio</h2>
		//     <p class="chat-empty-desc">选择一个 Agent 开始对话</p>
		//   </div>
		// </div>
		const empty = append(this._container, $(".chat-empty"));
		const inner = append(empty, $(".chat-empty-inner"));
		append(inner, $(".chat-empty-icon", undefined, "💬"));
		append(inner, $("h2.chat-empty-title", undefined, "Agent Studio"));
		append(inner, $("p.chat-empty-desc", undefined, "选择一个 Agent 开始对话"));
	}

protected override _renderHeader(): void {
		const emp = this._agent!;
		const status = emp.status as keyof typeof STATUS_MAP;
		const statusInfo = STATUS_MAP[status] || STATUS_MAP[AgentStatus.Idle];

		const header = append(this._container, $(".chat-header"));

		// Left: agent selector dropdown trigger
		const left = append(header, $(".chat-header-left"));

		// Agent selector trigger (clickable, replaces static avatar+name)
		this._agentSelectorTrigger = append(left, $(".chat-header-agent-selector"));

		// Avatar with status dot
		const avatarWrap = append(this._agentSelectorTrigger, $(".chat-header-avatar-wrap"));
		const avatarBorder = append(avatarWrap, $(".chat-header-avatar-border"));
		if (emp.avatarUrl) {
			const img = append(
				avatarBorder,
				$("img.chat-header-avatar-img"),
			) as HTMLImageElement;
			img.src = emp.avatarUrl;
			img.alt = emp.name;
		} else if (emp.icon) {
			// Use icon emoji — no background, matches preset panel style
			const iconEl = append(avatarBorder, $(".chat-header-avatar-icon"));
			iconEl.textContent = emp.icon;
		} else {
			const fallback = append(avatarBorder, $(".chat-header-avatar-fallback"));
			fallback.textContent = emp.name.charAt(0).toUpperCase();
		}
		const statusDot = append(avatarWrap, $(".chat-header-status-dot"));
		statusDot.style.backgroundColor = statusInfo.dot;
		if (statusInfo.animated) {
			statusDot.classList.add("animated");
		}

		// Name + role
		const info = append(this._agentSelectorTrigger, $(".chat-header-info"));
		append(info, $("span.chat-header-name", undefined, emp.name));
		const roleText = emp.role?.split(/[，,]/)[0] || "";
		append(
			info,
			$(
				"span.chat-header-role",
				undefined,
				`${roleText} · ${statusInfo.label}`,
			),
		);

		// Chevron icon for dropdown
		const chevronWrap = append(this._agentSelectorTrigger, $(".chat-header-dropdown-chevron"));
		const chevronSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		chevronSvg.setAttribute("width", "12");
		chevronSvg.setAttribute("height", "12");
		chevronSvg.setAttribute("viewBox", "0 0 24 24");
		chevronSvg.setAttribute("fill", "none");
		chevronSvg.setAttribute("stroke", "currentColor");
		chevronSvg.setAttribute("stroke-width", "2.5");
		chevronSvg.setAttribute("stroke-linecap", "round");
		chevronSvg.setAttribute("stroke-linejoin", "round");
		const chevronPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
		chevronPath.setAttribute("d", "M6 9l6 6 6-6");
		chevronSvg.appendChild(chevronPath);
		chevronWrap.appendChild(chevronSvg);

		// Click handler for dropdown toggle
		this._register(
			addDisposableListener(this._agentSelectorTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._dropdownOpen) {
					this._closeAgentDropdown();
				} else {
					this._openAgentDropdown();
				}
			}),
		);

		// Auto-orchestrate toggle (PM only) — REMOVED: task orchestration entry point closed

		// ── 渠道绑定标识：当前会话绑定了飞书 chat_id（或为渠道默认会话）时显示 ──
		//   ★ 2026-09-22 修复「聊天框看不到关联标签」：徽章此前只创建不设样式
		//   （`.chat-header-feishu-badge` 的规则仅存在于旧 webview 的 CSS），裸 <span> 在
		//   `.chat-header-left`（flex + min-width:0）里会被压成 0 宽 ⇒ 肉眼不可见。
		//   现在样式补进 media/agentChat.css，并按状态区分「精确绑定 / 默认会话」。
		if (this._feishuBoundChatId) {
			const badge = append(left, $("span.chat-header-feishu-badge"));
			if (this._feishuBindingIsDefault) {
				badge.classList.add("is-default");
			}
			// 品牌 logo 由 host 注入（面板层拿不到 contrib 的 channelIcons）
			if (this._feishuBindingIcon) {
				badge.appendChild(this._feishuBindingIcon);
			}
			append(
				badge,
				$(
					"span.chat-header-feishu-badge-label",
					undefined,
					this._feishuBindingIsDefault ? "飞书 · 默认会话" : "飞书",
				),
			);
			badge.title = this._feishuBindingIsDefault
				? `本会话是飞书渠道的默认会话\n所有未精确绑定的群/私聊消息将进入此会话`
				: `本会话已绑定飞书会话：${this._feishuBoundChatId}\n该群/私聊的消息将路由到此会话`;
		}

		// ── 工作区 + Worktree 选择器（从输入框 toolbar 移到 header agent 选择器右侧） ──
		const wsLabel = this._workspaces.find(w => w.id === this._selectedWorkspaceId)?.name ||
			this._workspaces[0]?.name || '工作区';
		this._workspaceTrigger = this._appendToolbarBtn(left, {
			title: '切换工作区',
			svgPath: 'M20.5 5.5H3.5a1 1 0 00-1 1v13a1 1 0 001 1h17a1 1 0 001-1v-13a1 1 0 00-1-1zM2 8.5h20M9 2.5v3M15 2.5v3',
			hasLabel: true,
			label: wsLabel,
			showChevron: true,
			cssClass: 'workspace-tag',
		});
		this._register(addDisposableListener(this._workspaceTrigger, EventType.CLICK, (e) => {
			e.stopPropagation();
			if (this._workspaceDropdownEl) {
				this._closeWorkspaceDropdown();
			} else {
				this._openWorkspaceDropdown();
			}
		}));

		const wtLabel = this._getWorktreeLabel();
		this._worktreeTrigger = this._appendToolbarBtn(left, {
			title: '切换 Worktree',
			svgPath: 'M6 3v12M18 9v12M6 21l12-12',
			hasLabel: true,
			label: wtLabel,
			showChevron: true,
			cssClass: 'worktree-tag',
		});
		this._register(addDisposableListener(this._worktreeTrigger, EventType.CLICK, (e) => {
			e.stopPropagation();
			if (this._worktreeDropdownEl) {
				this._closeWorktreeDropdown();
			} else {
				this._openWorktreeDropdown();
			}
		}));

		// Spacer
		append(left, $(".chat-header-spacer"));

	// Right: action buttons (message-nav / new / history / settings / html preview)
	const actions = append(header, $(".chat-header-actions"));

	// HTML 预览按钮——使用 Codicon 原生图标（小眼睛）
		const htmlPreviewBtn = append(actions, $("button.chat-header-action-btn.chat-header-btn"));
		htmlPreviewBtn.title = 'HTML 预览';
		const eyeIcon = append(htmlPreviewBtn, $("span.codicon.codicon-eye"));
		eyeIcon.style.fontSize = '15px';
		this._register(
			addDisposableListener(htmlPreviewBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onOpenHtmlPreview?.();
			}),
		);

		// 1. Message-nav (会话消息列表)
		this._msgNavTrigger = this._appendHeaderActionBtn(actions, {
			title: '会话消息列表',
			svgPath: 'M4 6h16M4 12h10M4 18h16',
		});
		// Disable if no user messages
		const userMsgCount = this._messages.filter(m => m.role === 'user').length;
		if (userMsgCount === 0) {
			this._msgNavTrigger.classList.add('disabled');
			this._msgNavTrigger.setAttribute('aria-disabled', 'true');
		}
		if (this._activeHeaderPanel === 'message-nav') {
			this._msgNavTrigger.classList.add('active');
		}
		this._register(
			addDisposableListener(this._msgNavTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._msgNavTrigger && this._msgNavTrigger.classList.contains('disabled')) { return; }
				// Toggle: same pattern as history button
				if (this._activeHeaderPanel === 'message-nav') {
					this._activeHeaderPanel = null;
				} else {
					this._activeHeaderPanel = 'message-nav';
				}
				this._render();
			}),
		);

		// 2. New session —— 图标 = 气泡（左下）+ 右上角小加号。
		// 2026-09-15 用户选定（备选对照页 `.codebuddy/mockups/new-chat-icon-options.html` 方案 F）：
		// 纯加号（原 `M12 5v14M5 12h14`）与「新建任何东西」无区分；气泡给"聊天"语义，
		// 加号独立在右上角 ⇒ 15px 显示下两个形状仍能分辨（内嵌加号会糊成一团）。
		// 仍需保持与相邻按钮同一套描边风格（viewBox 24 / stroke 2 / round，见 _appendHeaderActionBtn）。
		const newBtn = this._appendHeaderActionBtn(actions, {
			title: '新建会话',
			svgPath: 'M16 15a2 2 0 0 1-2 2H7l-3 3V8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2zM19.5 2.25v3.5M17.75 4h3.5',
		});
		this._register(
			addDisposableListener(newBtn, EventType.CLICK, () => {
				console.log('[AgentChatPanel] New Session button clicked, _onNewSession exists:', !!this._onNewSession);
				try {
					this._onNewSession?.();
				} catch (err) {
					console.error('[AgentChatPanel] Error in _onNewSession:', err);
				}
			}),
		);

		// 3. History (clock icon)
		const historyBtn = this._appendHeaderActionBtn(actions, {
			title: '聊天历史',
			svgPath: 'M12 8v4l3 2',
		});
		// Add the outer circle for the clock icon
		const historyClockSvg = historyBtn.querySelector('svg');
		if (historyClockSvg) {
			const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			c.setAttribute('cx', '12');
			c.setAttribute('cy', '12');
			c.setAttribute('r', '9');
			historyClockSvg.insertBefore(c, historyClockSvg.firstChild);
		}
		if (this._activeHeaderPanel === 'history') {
			historyBtn.classList.add('active');
		}
		this._register(
			addDisposableListener(historyBtn, EventType.CLICK, () => {
				this._activeHeaderPanel = this._activeHeaderPanel === 'history' ? null : 'history';
				this._render();
			}),
		);

		// 4. Settings (gear)
		const settingsBtn = this._appendHeaderActionBtn(actions, {
			title: '设置',
			svgPath: 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
		});
		const gearSvg = settingsBtn.querySelector('svg');
		if (gearSvg) {
			const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			c.setAttribute('cx', '12');
			c.setAttribute('cy', '12');
			c.setAttribute('r', '3');
			gearSvg.insertBefore(c, gearSvg.firstChild);
		}
	this._register(
		addDisposableListener(settingsBtn, EventType.CLICK, () => {
			if (this._activeHeaderPanel === 'settings') {
				this._activeHeaderPanel = null;
			} else {
				this._activeHeaderPanel = 'settings';
			}
			this._render();
		}),
	);
	}

/**
 * 轻量刷新 header：只替换 header 元素本身，不触碰消息区/输入区。
 *
 * 存在的理由：外部（Agent 设置页）修改了 agent 的 icon/name 后，
 * NativeChatEditorPane 需要把变更同步到已打开的聊天框。而 setAgent() →
 * _render() 会 clearNode 整个容器并重建消息列表，代价是滚动位置丢失 +
 * 消息闪烁，对一个「只改了图标」的变更来说完全不可接受。
 *
 * 因此这里只做：移除旧 header → 用当前 _agent 重新 append 一个新 header。
 * 消息区 DOM 完全不动。
 */
protected override _refreshHeaderOnly(): void {
	if (!this._agent) { return; }
	const oldHeader = this._container.querySelector('.chat-header');
	if (!oldHeader) {
		// 没有 header（如空状态）→ 交给 _render 完整重建
		this._render();
		return;
	}
	oldHeader.remove();
	this._agentSelectorTrigger = null;
	this._renderHeader();
}

/**
 * 就地更新 agent 运行状态圆点（含角色行的状态文案），不重建 header。
 *
 * 为什么不用 `patchAgent()`：后者走 `_refreshHeaderOnly()` → 移除旧 header +
 * 完整 `_renderHeader()`，对「只换圆点颜色」这种每次发送/结束都会发生的高频
 * 变更过重，且会让下拉触发器等引用失效。这里直接改已渲染节点。
 *
 * 状态映射（2026-09-18 简化）：发送中 = working（绿·呼吸），其余一律 idle（灰）。
 */
protected override _refreshAgentStatusDot(status: AgentStatus): void {
	const dot = this._container.querySelector<HTMLElement>(".chat-header-status-dot");
	if (!dot) {
		// header 尚未渲染（空状态）→ 无需更新，下次 _renderHeader 会用新 status
		return;
	}
	const statusInfo = STATUS_MAP[status] || STATUS_MAP[AgentStatus.Idle];
	dot.style.backgroundColor = statusInfo.dot;
	dot.classList.toggle("animated", statusInfo.animated);

	// 角色行文案是 `${role} · ${statusLabel}`，状态变化需同步，
	// 否则圆点已变绿、文字还写着「空闲」。
	const roleEl = this._container.querySelector<HTMLElement>(".chat-header-role");
	if (roleEl && this._agent?.role) {
		const roleText = this._agent.role.split(/[，,]/)[0] || "";
		roleEl.textContent = `${roleText} · ${statusInfo.label}`;
	}
}

protected override _updateHeaderSelectors(): void {
		// 切换工作区/worktree 后轻量刷新 header 里两个选择器的 label（不重建 header）
		if (this._workspaceTrigger) {
			const wsLabel = this._workspaces.find(w => w.id === this._selectedWorkspaceId)?.name ||
				this._workspaces[0]?.name || '工作区';
			const labelEl = this._workspaceTrigger.querySelector('.toolbar-btn-label');
			if (labelEl) { labelEl.textContent = wsLabel; }
		}
		if (this._worktreeTrigger) {
			const labelEl = this._worktreeTrigger.querySelector('.toolbar-btn-label');
			if (labelEl) { labelEl.textContent = this._getWorktreeLabel(); }
		}
	}

protected override _appendHeaderActionBtn(parent: HTMLElement, opts: { title: string; svgPath: string }): HTMLElement {
		const el = append(parent, $(".chat-header-action-btn.chat-header-btn"));
		el.title = opts.title;
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", "15");
		svg.setAttribute("height", "15");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
		pathEl.setAttribute("d", opts.svgPath);
		svg.appendChild(pathEl);
		el.appendChild(svg);
		return el;
	}

protected override _openAgentDropdown(): void {
		if (this._dropdownOpen) { return; }
		this._dropdownOpen = true;
		this._dropdownFilter = "";

		// Toggle chevron rotation via class
		if (this._agentSelectorTrigger) {
			this._agentSelectorTrigger.classList.add("open");
		}

		// Create dropdown panel on trigger's document.body — popout 独立窗口是另一个 window，
		// mainWindow.document.body 挂在主窗口 DOM 上，定位坐标错乱
		const dropdownBody = this._agentSelectorTrigger?.ownerDocument?.body ?? mainWindow.document.body;
		this._agentDropdownEl = append(dropdownBody, $(".chat-agent-dropdown"));

		// Fixed position aligned to the chat container
		const containerRect = this._container.getBoundingClientRect();
		const headerHeight = 52; // approximate header height (padding + content + border)
		this._agentDropdownEl.style.position = "fixed";
		this._agentDropdownEl.style.top = (containerRect.top + headerHeight) + "px";
		this._agentDropdownEl.style.left = (containerRect.left + 14) + "px";
		this._agentDropdownEl.style.width = (containerRect.width - 28) + "px";
		this._agentDropdownEl.style.maxHeight = Math.min(320, containerRect.bottom - containerRect.top - headerHeight - 20) + "px";

		this._renderAgentDropdownContent();

		// Close on outside click（监听 trigger 所在 window 的 document）
		const outsideDoc = this._agentSelectorTrigger?.ownerDocument ?? mainWindow.document;
		const outsideHandler = addDisposableListener(outsideDoc.body, EventType.CLICK, (e) => {
			if (this._agentDropdownEl && !this._agentDropdownEl.contains(e.target as Node) &&
				this._agentSelectorTrigger && !this._agentSelectorTrigger.contains(e.target as Node)) {
				this._closeAgentDropdown();
			}
		});
		this._register(outsideHandler);

		// Auto-focus search
		if (this._agentSearchInput) {
			this._agentSearchInput.focus();
		}
	}

protected override _closeAgentDropdown(): void {
		if (!this._dropdownOpen) { return; }
		this._dropdownOpen = false;

		if (this._agentSelectorTrigger) {
			this._agentSelectorTrigger.classList.remove("open");
		}

		if (this._agentDropdownEl) {
			this._agentDropdownEl.remove();
			this._agentDropdownEl = null;
		}
		this._agentSearchInput = null;
		this._agentDropdownList = null;
		this._dropdownFilter = "";
	}

protected override _renderAgentDropdownContent(): void {
		if (!this._agentDropdownEl) { return; }

		// Search input
		const searchWrap = append(this._agentDropdownEl, $(".chat-agent-dropdown-search"));
		const searchIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		searchIcon.setAttribute("width", "14");
		searchIcon.setAttribute("height", "14");
		searchIcon.setAttribute("viewBox", "0 0 24 24");
		searchIcon.setAttribute("fill", "none");
		searchIcon.setAttribute("stroke", "currentColor");
		searchIcon.setAttribute("stroke-width", "2");
		searchIcon.classList.add("search-icon");
		const circleEl = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		circleEl.setAttribute("cx", "11");
		circleEl.setAttribute("cy", "11");
		circleEl.setAttribute("r", "8");
		searchIcon.appendChild(circleEl);
		const lineEl = document.createElementNS("http://www.w3.org/2000/svg", "line");
		lineEl.setAttribute("x1", "21");
		lineEl.setAttribute("y1", "21");
		lineEl.setAttribute("x2", "16.65");
		lineEl.setAttribute("y2", "16.65");
		searchIcon.appendChild(lineEl);
		searchWrap.appendChild(searchIcon);

		this._agentSearchInput = append(searchWrap, $("input.chat-agent-dropdown-input")) as HTMLInputElement;
		this._agentSearchInput.placeholder = "搜索 Agent...";
		this._agentSearchInput.value = this._dropdownFilter;

		this._register(
			addDisposableListener(this._agentSearchInput, EventType.INPUT, () => {
				this._dropdownFilter = this._agentSearchInput?.value || "";
				this._renderAgentList();
			}),
		);

		// Prevent Enter key from bubbling up
		this._register(
			addDisposableListener(this._agentSearchInput, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === "Escape") {
					this._closeAgentDropdown();
				}
				e.stopPropagation();
			}),
		);

		// Agent list
		this._agentDropdownList = append(this._agentDropdownEl, $(".chat-agent-dropdown-list"));
		this._renderAgentList();
	}

protected override _renderAgentList(): void {
		if (!this._agentDropdownList) { return; }
		clearNode(this._agentDropdownList);

		const filter = this._dropdownFilter.toLowerCase().trim();
		const filtered = filter
			? this._availableAgents.filter(e =>
				(e.name || '').toLowerCase().includes(filter) ||
				(e.role || '').toLowerCase().includes(filter)
			)
			: this._availableAgents;

		if (filtered.length === 0) {
			const noResults = append(this._agentDropdownList, $(".chat-agent-dropdown-no-results"));
			noResults.textContent = "未找到匹配的 Agent";
			return;
		}

		for (const agent of filtered) {
			const item = append(this._agentDropdownList, $(".chat-agent-dropdown-item"));
			if (this._agent?.id === agent.id) {
				item.classList.add("active");
			}

			// Mini avatar
			const miniAvatar = append(item, $(".chat-agent-dropdown-item-avatar"));
			if (agent.avatarUrl) {
				const img = append(miniAvatar, $("img")) as HTMLImageElement;
				img.src = agent.avatarUrl;
				img.alt = agent.name;
			} else if (agent.icon) {
				// Use icon emoji — no background, matches preset panel style
				const iconEl = append(miniAvatar, $(".chat-agent-dropdown-item-avatar-icon"));
				iconEl.textContent = agent.icon;
			} else {
				const fallback = append(miniAvatar, $(".chat-agent-dropdown-item-avatar-fallback"));
				fallback.textContent = agent.name.charAt(0).toUpperCase();
			}

			// Name + role
			const itemInfo = append(item, $(".chat-agent-dropdown-item-info"));
			append(itemInfo, $(".chat-agent-dropdown-item-name", undefined, agent.name));
			const roleText = agent.role?.split(/[，,]/)[0] || "";
			append(itemInfo, $(".chat-agent-dropdown-item-role", undefined, roleText));

			// Click to select (mirrors React AgentChat.tsx logic)
			this._register(
				addDisposableListener(item, EventType.CLICK, (e) => {
					e.stopPropagation();
					// Select agent first (matches React: selectAgent + setActiveAgent)
					if (agent.id !== this._agent?.id) {
						this._onSelectAgent(agent.id);
					}
					// Then close dropdown and clear filter (matches React: setDropdownOpen + setDropdownFilter)
					this._closeAgentDropdown();
				}),
			);
		}
	}

protected override _aggregateTurns(messages: IAgentChatMessage[]): IAgentChatMessage[] {
		if (!messages.length) { return []; }

		const aggregated: IAgentChatMessage[] = [];
		let i = 0;

		while (i < messages.length) {
			const current = messages[i];

			// Skip non-assistant or messages without turnId
			if (current.role !== 'assistant' || !current.turnId) {
				aggregated.push(current);
				i++;
				continue;
			}

			// Collect consecutive assistant messages with same turnId
			const turnId = current.turnId;
			const turnMessages: IAgentChatMessage[] = [current];
			let j = i + 1;
			while (j < messages.length && messages[j].role === 'assistant' && messages[j].turnId === turnId) {
				turnMessages.push(messages[j]);
				j++;
			}

			if (turnMessages.length === 1) {
				aggregated.push(current);
			} else {
				// 阶段E：按 turn 顺序拼接有序 parts（不再做 textPosition 偏移运算）。
				// 每条 turn 消息的 parts 已表达其自身顺序，顺次连接即为整回合的正确顺序，
				// 结构上不可能错位。content/toolCalls 由 parts 反推为派生兼容字段。
				//
				// ★ 2026-09-23：**相邻文本段必须合并成一个 part**（用户报「一条消息被拆成 2 段」的
				//   数据源修复 ✓）。旧实现是"改上一个 part + 再 push 另一个" ⇒ parts 数组里
				//   产生**相邻 text part** ⇒ 渲染层各建一块 ⇒ 视觉上"两块" ✗✓（t64/t65 实测 ✓）。
				//   逻辑搬到纯函数 `mergeTurnMessageParts`（可单测 ✓ 红线见 mergeTurnMessageParts.test.ts ✓）。
				const mergedParts: IMessagePart[] = mergeTurnMessageParts(turnMessages);
				const flat = flattenMessageParts(mergedParts);

				const lastMsg = turnMessages[turnMessages.length - 1];
				const merged: IAgentChatMessage = {
					...lastMsg,
					id: `turn-${turnId}`,
					content: flat.content,
					toolCalls: flat.toolCalls.length > 0 ? flat.toolCalls : undefined,
					parts: mergedParts.length > 0 ? mergedParts : undefined,
					thinking: turnMessages.map(m => m.thinking).filter(Boolean).join('\n\n') || undefined,
				};
				aggregated.push(merged);
			}

			i = j;
		}

		return aggregated;
	}
}
