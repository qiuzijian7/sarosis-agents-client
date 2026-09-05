import { IDisposable } from '../../../base/common/lifecycle.js';
import { $, append, clearNode, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { IAgentChatMessage, IWorkspaceItem, IWorktreeItem, CHAT_MODE_UI, CHAT_MODE_ORDER } from './agentChatTypes.js';
import { positionDropdownAbove, positionDropdownBelow, disposeOutsideClick, registerOutsideClickClose } from './modules/dropdownHelpers.js';
import { renderHistoryOverlay } from './modules/historyOverlay.js';
import { AgentChatPanelComposer } from './agentChatPanel.composer.js';
import { defaultPortOf, normalizeConfigHtml, normalizePanelUrl, validatePanelUrl, type ConfigHtmlCfg } from '../../contrib/agentStudio/common/configHtmlConfig.js';

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
		// header 中 worktree 选择器 → 弹出方向：向下
		positionDropdownBelow(this._worktreeDropdownEl, this._worktreeTrigger);

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

protected override _openWorktreeContextMenu(wt: IWorktreeItem, e: MouseEvent): void {
		// 关闭已有右键菜单，避免叠加
		this._closeWorktreeContextMenu();

		const body = this._dropdownBody(this._worktreeTrigger);
		const menu = append(body, $(".chat-worktree-context-menu"));
		this._worktreeContextMenuEl = menu;

		const debugItem = append(menu, $(".chat-worktree-context-menu-item"));
		append(debugItem, $("span.chat-worktree-context-menu-icon", undefined, '🔧'));
		append(debugItem, $("span.chat-worktree-context-menu-label", undefined, '调试'));

		// 定位到鼠标右键位置（与 dropdown 同一 viewport）
		menu.style.position = 'fixed';
		menu.style.left = `${e.clientX}px`;
		menu.style.top = `${e.clientY}px`;
		menu.style.zIndex = '1000';

		this._register(addDisposableListener(debugItem, EventType.CLICK, () => {
			this._closeWorktreeContextMenu();
			this._closeWorktreeDropdown();
			this._onDebugWorktree?.({ path: wt.path, branch: wt.branch });
		}));

		this._worktreeContextMenuOutsideClick = this._registerOutsideClickClose(
			menu, null, () => this._closeWorktreeContextMenu()
		);
	}

protected override _closeWorktreeContextMenu(): void {
		this._disposeOutsideClick(this._worktreeContextMenuOutsideClick);
		this._worktreeContextMenuOutsideClick = null;
		if (this._worktreeContextMenuEl) {
			this._worktreeContextMenuEl.remove();
			this._worktreeContextMenuEl = null;
		}
	}

/**
 * 打开 agent 页签栏右键菜单（当前 session 重命名）。
 * 复用 worktree 右键菜单的样式类与 outside-click 机制。
 */
protected _openSessionContextMenu(e: MouseEvent): void {
	e.preventDefault();
	e.stopPropagation();

	const sessionId = this._getSessionId();
	const sessionName = this._getSessionName();
	if (!sessionId) { return; }

	this._closeSessionContextMenu();

	const menuEl = $('div.chat-worktree-context-menu.session-context-menu');
	const renameItem = $('div.chat-worktree-context-menu-item', undefined, '重命名');

	const triggerDoc = (e.currentTarget as HTMLElement | null)?.ownerDocument ?? mainWindow.document;
	menuEl.style.position = 'fixed';
	menuEl.style.left = `${e.clientX}px`;
	menuEl.style.top = `${e.clientY}px`;
	menuEl.style.zIndex = '1000';

	renameItem.addEventListener('click', (ev) => {
		ev.stopPropagation();
		this._closeSessionContextMenu();
		this._openSessionRenameOverlay(sessionId, sessionName ?? undefined, renameItem);
	});

	menuEl.appendChild(renameItem);
	triggerDoc.body.appendChild(menuEl);
	this._sessionContextMenuEl = menuEl;

	this._sessionContextMenuOutsideClick = this._registerOutsideClickClose(menuEl, null, () => this._closeSessionContextMenu());
}

/**
 * 关闭 agent 页签栏右键菜单。
 */
protected _closeSessionContextMenu(): void {
	this._disposeOutsideClick(this._sessionContextMenuOutsideClick);
	this._sessionContextMenuOutsideClick = null;
	if (this._sessionContextMenuEl) {
		this._sessionContextMenuEl.remove();
		this._sessionContextMenuEl = null;
	}
}

/**
 * 在「重命名」菜单项处就地展开 input 浮层，回车确认 / Esc 取消。
 * 直接调用宿主注入的 onRenameSession 回调上报新名称。
 */
protected _openSessionRenameOverlay(sessionId: string, sessionName: string | undefined, anchor: HTMLElement): void {
	const input = $('input.chat-session-rename-input') as HTMLInputElement;
	input.type = 'text';
	input.value = sessionName ?? '';
	input.placeholder = '输入新的会话名称';
	input.maxLength = 120;

	const rect = anchor.getBoundingClientRect();
	const doc = anchor.ownerDocument;
	input.style.position = 'fixed';
	input.style.left = `${rect.left}px`;
	input.style.top = `${rect.bottom + 4}px`;
	input.style.zIndex = '1001';
	input.style.minWidth = '180px';

	doc.body.appendChild(input);
	input.focus();
	input.select();

	const commit = () => {
		const newName = input.value.trim();
		const disposables = this._sessionRenameOverlayDisposables;
		this._sessionRenameOverlayDisposables = null;
		disposables?.forEach(d => d.dispose());
		input.remove();
		if (newName && newName !== sessionName) {
			this._onRenameSession?.(sessionId, newName);
		}
	};

	const onKeyDown = (ev: KeyboardEvent) => {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			commit();
		} else if (ev.key === 'Escape') {
			ev.preventDefault();
			const disposables = this._sessionRenameOverlayDisposables;
			this._sessionRenameOverlayDisposables = null;
			disposables?.forEach(d => d.dispose());
			input.remove();
		}
	};

	const onBlur = () => commit();

	const d1 = addDisposableListener(input, EventType.KEY_DOWN, onKeyDown);
	const d2 = addDisposableListener(input, EventType.BLUR, onBlur);
	this._sessionRenameOverlayDisposables = [d1, d2];
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
		// header 中 workspace 选择器 → 弹出方向：向下
		positionDropdownBelow(this._workspaceDropdownEl, this._workspaceTrigger);

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
			{ id: 'confightml', codicon: 'codicon codicon-globe', label: 'ConfigHtml' },
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
		} else if (activeTab === 'confightml') {
			void this._renderSettingsConfigHtmlTab(contentArea);
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

	/** ConfigHtml 配置页签：本地 HTML / URL 面板双模式。
	 *  逻辑复用 common/configHtmlConfig.ts，与 native 设置面板（AgentSettingsEditorPane 的
	 *  ConfigHtml tab）同一份契约；服务拉起经回调转主进程（spec 只带 url/port，由实现方补全）。 */
	protected async _renderSettingsConfigHtmlTab(container: HTMLElement): Promise<void> {
		const desc = append(container, $(".chat-settings-tab-desc"));
		desc.textContent = '配置 ConfigHtml 预览来源（两种模式互斥）。预览固定在独立页签中打开。';

		const cfg: ConfigHtmlCfg | undefined = this._onGetConfigHtmlCfg ? await this._onGetConfigHtmlCfg() : undefined;
		const mode: 'local' | 'url' = cfg?.url ? 'url' : 'local';

		const inputStyle = 'width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:4px 8px;font-size:12px;';
		// ★ 操作日志（对齐 native 设置页 ConfigHtml tab）：启动/停止/保存全链路，
		//   错误详情（含主进程带回的子进程输出尾部）不再只剩「失败 ✗」四个字。
		//   先创建（detached），函数末尾 append 到 container —— 位置在保存按钮之后。
		const logEl = $('div.chat-settings-confightml-log');
		logEl.style.cssText = 'margin-top:8px;max-height:130px;overflow:auto;background:var(--vscode-terminal-background,#111);border:1px solid var(--vscode-input-border);border-radius:4px;padding:6px 8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;';
		const log = (text: string, cls: 'info' | 'ok' | 'err' | 'dim' = 'info') => {
			const line = append(logEl, $('div'));
			line.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`;
			line.style.color = cls === 'err'
				? 'var(--vscode-testing-iconFailed, #f48771)'
				: cls === 'ok'
					? 'var(--vscode-testing-iconPassed, #3fb950)'
					: cls === 'dim'
						? 'var(--vscode-descriptionForeground, #8b949e)'
						: 'var(--vscode-foreground)';
			while (logEl.childElementCount > 200) { logEl.removeChild(logEl.firstElementChild!); }
			logEl.scrollTop = logEl.scrollHeight;
		};
		log('ConfigHtml 页签已就绪。启动/停止/保存的全链路会记录在这里。', 'dim');
		const flash = (btn: HTMLButtonElement, text: string, ok: boolean) => {
			const old = btn.textContent;
			btn.textContent = text;
			btn.style.color = ok ? 'var(--vscode-testing-iconPassed, #3fb950)' : 'var(--vscode-testing-iconFailed, #f48771)';
			setTimeout(() => { btn.textContent = old; btn.style.color = ''; }, 2500);
		};

		// ── 预览模式（radio 切换）──
		const modeRow = append(container, $(".chat-settings-config-row"));
		append(modeRow, $("span.config-row-label", undefined, '预览模式'));
		const modeGroup = append(modeRow, $('div'));
		modeGroup.style.display = 'flex';
		modeGroup.style.gap = '16px';
		let currentMode: 'local' | 'url' = mode;
		const sections: Record<'local' | 'url', HTMLElement> = {
			local: append(container, $('div')),
			url: append(container, $('div')),
		};
		for (const [v, t] of [['local', '本地 HTML'], ['url', 'URL 面板']] as const) {
			const wrap = append(modeGroup, $('label'));
			wrap.style.display = 'flex';
			wrap.style.gap = '4px';
			wrap.style.alignItems = 'center';
			wrap.style.cursor = 'pointer';
			const radio = append(wrap, $('input')) as HTMLInputElement;
			radio.type = 'radio';
			radio.name = 'chat-config-html-mode';
			radio.value = v;
			radio.checked = v === mode;
			radio.onchange = () => {
				if (!radio.checked) { return; }
				currentMode = v;
				for (const k of ['local', 'url'] as const) { sections[k].style.display = k === currentMode ? '' : 'none'; }
			};
			append(wrap, $('span', undefined, t));
		}

		// ── 本地 HTML 区块 ──
		const fileRow = append(sections.local, $(".chat-settings-config-row"));
		append(fileRow, $("span.config-row-label", undefined, '预览源文件'));
		const fileInput = append(fileRow, $("input")) as HTMLInputElement;
		fileInput.type = 'text';
		fileInput.value = cfg?.htmlPath ?? 'config.html';
		fileInput.placeholder = 'config.html（相对 agent 目录）';
		fileInput.style.cssText = inputStyle;

		// ── URL 区块 ──
		const urlRow = append(sections.url, $(".chat-settings-config-row"));
		append(urlRow, $("span.config-row-label", undefined, '面板地址'));
		const urlInput = append(urlRow, $("input")) as HTMLInputElement;
		urlInput.type = 'text';
		urlInput.value = cfg?.url ?? '';
		urlInput.placeholder = 'http://127.0.0.1:5600';
		urlInput.style.cssText = inputStyle;
		const portRow = append(sections.url, $(".chat-settings-config-row"));
		append(portRow, $("span.config-row-label", undefined, '服务端口'));
		const portInput = append(portRow, $("input")) as HTMLInputElement;
		portInput.type = 'number';
		portInput.value = String(defaultPortOf(cfg, cfg?.url ?? ''));
		portInput.placeholder = '5600';
		portInput.style.cssText = inputStyle;
		// 失焦自动补全 scheme（127.0.0.1:5600 → http://…），防探活 URL 拼接错乱
		urlInput.addEventListener('blur', () => {
			const fixed = normalizePanelUrl(urlInput.value);
			if (fixed && fixed !== urlInput.value) {
				urlInput.value = fixed;
				log(`面板地址已规范化：${fixed}`, 'dim');
			}
		});
		const expectRow = append(sections.url, $(".chat-settings-config-row"));
		append(expectRow, $("span.config-row-label", undefined, '健康特征串'));
		const expectInput = append(expectRow, $("input")) as HTMLInputElement;
		expectInput.type = 'text';
		expectInput.value = cfg?.server?.healthExpect ?? '';
		expectInput.placeholder = '可选：响应体需包含的子串';
		expectInput.title = '留空 = 只探活不校验身份。若该端口可能被其他程序占用，填入面板页面里的固定文字（如标题），探活时会校验。';
		expectInput.style.cssText = inputStyle;
		const svcRow = append(sections.url, $(".chat-settings-config-row"));
		const startBtn = append(svcRow, $("button.monaco-button.monaco-text-button.chat-settings-open-full-btn")) as HTMLButtonElement;
		startBtn.textContent = '▶ 启动服务';
		const stopBtn = append(svcRow, $("button.monaco-button.monaco-text-button.chat-settings-open-full-btn")) as HTMLButtonElement;
		stopBtn.textContent = '■ 停止服务';
		const previewBtn = append(svcRow, $("button.monaco-button.monaco-text-button.chat-settings-open-full-btn")) as HTMLButtonElement;
		previewBtn.textContent = '🌐 打开预览';

		startBtn.onclick = () => {
			const url = normalizePanelUrl(urlInput.value);
			if (!url) { flash(startBtn, '请先填地址', false); log('✗ 启动失败：地址为空', 'err'); return; }
			urlInput.value = url;
			// ★ spec 只带 url/port：实现方（onEnsureConfigHtmlServer）会走共享 buildEnsureSpec
			//   补全 command/args/cwd——之前实现方只透传，主进程 spawn 无参 node 直接挂住 30s。
			const spec = { url, port: Number(portInput.value) || undefined, healthExpect: expectInput.value.trim() || undefined };
			startBtn.textContent = '启动中…';
			log(`▶ 启动服务：${url}（端口 ${spec.port ?? '-'}，启动中最长约 30s，请留意本日志）`, 'dim');
			// ★ 前端并行探活动态：主进程 ensure 是一次性 invoke（内部轮询最长 30s、期间静默），
			//   这里每 2s 自探一次端口，把进展实时写进日志——消除「卡住」的观感。
			const t0 = Date.now();
			let alive = false;
			const poll = setInterval(() => {
				if (alive) { return; }
				const s = Math.round((Date.now() - t0) / 1000);
				if (s > 45) { clearInterval(poll); return; }
				fetch(url + '/', { mode: 'no-cors', signal: AbortSignal.timeout(1500) })
					.then(() => {
						if (!alive) { alive = true; log(`✓ 端口已有响应（${s}s）——等待主进程确认返回…`, 'ok'); }
					})
					.catch(() => {
						if (s > 0 && s % 4 === 0) { log(`⏳ 探活中 ${s}s（服务尚未响应，可能仍在启动）…`, 'dim'); }
					});
			}, 2000);
			const done = () => { clearInterval(poll); startBtn.textContent = '▶ 启动服务'; };
			void this._onEnsureConfigHtmlServer?.(spec)
				.then(r => {
					done();
					if (r.ok) {
						log(r.alreadyRunning ? `✓ 服务已在运行（${url}）` : `✓ 面板服务已就绪（${url}）`, 'ok');
					} else {
						// 失败详情全量进日志：含主进程带回的子进程输出尾部
						log(`✗ 启动失败：${r.error ?? '未知错误'}`, 'err');
					}
					flash(startBtn, r.ok ? (r.alreadyRunning ? '已在运行 ✓' : '已就绪 ✓') : '失败 ✗（详见日志）', r.ok);
				})
				.catch(err => {
					done();
					log(`✗ 调用主进程异常：${err instanceof Error ? err.message : String(err)}`, 'err');
					flash(startBtn, '失败 ✗（详见日志）', false);
				});
		};
		stopBtn.onclick = () => {
			const url = normalizePanelUrl(urlInput.value);
			const spec = { url, port: Number(portInput.value) || undefined };
			log(`■ 停止服务：${url}`, 'dim');
			void this._onStopConfigHtmlServer?.(spec)
				.then(r => {
					log(r.killed.length ? `✓ 已结束 ${r.killed.length} 个进程：${r.killed.join(', ')}` : '没有进程在监听该端口（服务未运行）', r.killed.length ? 'ok' : 'dim');
					flash(stopBtn, r.killed.length ? `已停止 ✓（${r.killed.length} 个进程）` : '未在运行', true);
				})
				.catch(err => {
					log(`✗ 停止异常：${err instanceof Error ? err.message : String(err)}`, 'err');
					flash(stopBtn, '失败 ✗（详见日志）', false);
				});
		};
		previewBtn.onclick = () => {
			const url = normalizePanelUrl(urlInput.value);
			if (!url) { flash(previewBtn, '请先填地址', false); return; }
			urlInput.value = url;
			void this._onOpenConfigHtmlPreview?.(url);
		};

		// ── 保存 ──
		const saveRow = append(container, $(".chat-settings-config-row"));
		const saveBtn = append(saveRow, $("button.monaco-button.monaco-text-button.chat-settings-open-full-btn")) as HTMLButtonElement;
		saveBtn.textContent = '💾 保存配置';
		saveBtn.onclick = () => {
			const next = currentMode === 'url'
				? normalizeConfigHtml('url', { url: urlInput.value, port: Number(portInput.value), prev: cfg })
				: normalizeConfigHtml('local', { htmlPath: fileInput.value });
			if (currentMode === 'url') {
				const expect = expectInput.value.trim();
				if (expect) { next.server = { ...(next.server ?? {}), healthExpect: expect }; }
				else if (next.server) { delete next.server.healthExpect; }
				const err = validatePanelUrl(next.url ?? '');
				if (err) { flash(saveBtn, err, false); log(`✗ 保存失败：${err}`, 'err'); return; }
			}
			log(`💾 保存配置：${JSON.stringify(next)}`, 'dim');
			void this._onSaveConfigHtmlCfg?.(next)
				.then(() => {
					log('✓ 已保存到 agent 元数据（.agent.md frontmatter）', 'ok');
					flash(saveBtn, '已保存 ✓', true);
				})
				.catch(err => {
					log(`✗ 保存失败：${err instanceof Error ? err.message : String(err)}`, 'err');
					flash(saveBtn, '保存失败 ✗', false);
				});
		};

		// 操作日志区（最后挂载：位于保存按钮下方）
		append(container, logEl);
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

		// ChatMode 下拉框（2026-08-21）：Craft / Ask / Plan 三档单选。
		// 替代旧的 chatOnly 布尔开关项。仅 Plan 档位向 LLM 暴露
		// plan_enter/plan_exit/plan_explore（见 chatModeConfig.PLAN_EXCLUSIVE_TOOLS）。
		for (const modeId of CHAT_MODE_ORDER) {
			const meta = CHAT_MODE_UI[modeId];
			const isActive = this._chatMode === modeId;
			const item = append(this._modeDropdownEl, $(`.mode-item${isActive ? '.active' : ''}`));
			const ic = append(item, $(".mode-item-icon"));
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
			p.setAttribute('d', meta.svgPath);
			sv.appendChild(p);
			ic.appendChild(sv);

			const text = append(item, $(".mode-item-text"));
			append(text, $("span.mode-item-label", undefined, meta.label));
			append(text, $("span.mode-item-tooltip", undefined, meta.description));
			if (isActive) { append(item, $("span.mode-item-check", undefined, '✓')); }

			this._register(
				addDisposableListener(item, EventType.CLICK, () => {
					this._closeModeDropdown();
					if (this._chatMode === modeId) { return; }
					this._chatMode = modeId;
					this._onChangeChatMode?.(modeId);
					this._refreshInputArea();
				}),
			);
		}

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
