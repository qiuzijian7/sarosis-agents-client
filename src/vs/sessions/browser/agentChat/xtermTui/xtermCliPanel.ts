/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import "../media/xterm-cli.css";
// xterm.js 基础样式（.xterm / .xterm-screen / .xterm-viewport 定位规则）。
// 官方 terminal 在 terminal.contribution.ts:30 加载同一份；CLI 面板此前只加载了
// 自己的 xterm-cli.css，缺失基础规则会导致字符网格定位与尺寸错乱。
import "../../../../workbench/contrib/terminal/browser/media/xterm.css";
import type { Terminal as XtermTerminalType } from '@xterm/xterm';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { importAMDNodeModule } from '../../../../amdX.js';
import type {
	IAgentChatMessage,
	IToolCall,
	IChatAttachment,
	IAgentInfo,
	IProviderInfo,
	IModelInfo,
	IImageModelGroup,
	StreamPhase,
	IWorktreeItem,
	IWorkspaceItem,
	ISessionInfo,
	IAgentSessionMeta,
	IContextUsage,
	ICheckpointInfo,
	OrchestrationPlan,
	AgentStatus,
} from '../agentChatTypes.js';
import type { IChatPanel, IChatPanelCallbacks } from '../iChatPanel.js';
import { createAnsiThemeFromCssVars, type AnsiTheme } from './ansiTheme.js';
import { renderMarkdownToAnsi } from './mdToAnsi.js';
import {
	renderToolTrail,
	renderUserMessage,
	renderAssistantFooter,
	SPINNER_FRAMES,
	type ToolCallInfo,
	type ThinkingInfo,
} from './toolTreeRenderer.js';
import { computeTailPatch, countRenderedLines, encodeTailPatch } from './tailDiff.js';

// ── 字体与单元格尺寸 ──────────────────────────────────────────────────
// xterm.js 把 fontFamily 直接写入 canvas 的 ctx.font，canvas **不解析 CSS 变量**
// （`var(--vscode-editor-font-family)` 会被整串丢弃 → 字体回退 → 字符宽度测量
// 失准 → 换行错位）。因此这里必须是真实字体名栈，不能用 var()。
const CLI_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace";
const CLI_FONT_SIZE = 12;
const CLI_LINE_HEIGHT = 1.0;

/** 从 CSS 变量读取一个颜色值（返回 undefined 表示未定义） */
function readCssColor(name: string): string | undefined {
	if (typeof document === 'undefined') { return undefined; }
	const raw = getComputedStyle(document.body).getPropertyValue(name).trim();
	return raw || undefined;
}

/**
 * 把 VS Code 的 CSS 变量映射为 xterm 的 ITheme。
 * 缺失的变量由 xterm 用自身默认值兜底，因此这里只给出读到的键。
 */
function readXtermThemeFromCssVars(): Record<string, string> {
	const theme: Record<string, string> = {};
	const background = readCssColor('--vscode-editor-background');
	const foreground = readCssColor('--vscode-editor-foreground');
	if (background) { theme['background'] = background; }
	if (foreground) { theme['foreground'] = foreground; }
	const selection = readCssColor('--vscode-editor-selectionBackground');
	if (selection) { theme['selectionBackground'] = selection; }
	const cursor = readCssColor('--vscode-terminalCursor-foreground') ?? readCssColor('--vscode-editorCursor-foreground');
	if (cursor) { theme['cursor'] = cursor; }
	return theme;
}

/**
 * 实测等宽字符单元格尺寸（**兜底路径** —— 首选是读 xterm 自己的实测值，见 `_getCellSize` ✓）。
 *
 * ★ 口径必须与 xterm 6 的 DOM CharSizeService **一致**（探针 span + `W` 重复 + **不设 lineHeight**
 * ⇒ 走 `line-height: normal` ⇒ 高度 = 字体自然度量 ascent+descent ✓）。
 * ⚠ 此前这里 `lineHeight = 1.0` ⇒ 测出 12px（= fontSize ✗），而 xterm 6 的真实行高是字体度量
 * ≈1.25×fontSize ≈ 15px ✗✗ ⇒ rows 被算多 ⇒ 屏幕渲染高度 > 容器 ⇒ **底部行被 overflow:hidden
 * 裁掉、滚动到底也看不见**（2026-09-21「建议下一步之后的内容无法显示」的根因 ✗✗✓）。
 */
function measureCell(host: HTMLElement): { width: number; height: number } {
	const probe = document.createElement('span');
	probe.style.position = 'absolute';
	probe.style.visibility = 'hidden';
	probe.style.whiteSpace = 'pre';
	probe.style.fontFamily = CLI_FONT_FAMILY;
	probe.style.fontSize = `${CLI_FONT_SIZE}px`;
	probe.style.fontKerning = 'none';
	probe.style.letterSpacing = '0';
	probe.textContent = 'W'.repeat(100);
	host.appendChild(probe);
	const rect = probe.getBoundingClientRect();
	probe.remove();
	return {
		width: rect.width > 0 ? rect.width / 100 : 7.2,
		height: rect.height > 0 ? rect.height : 14,
	};
}

// ★ 2026-09-21：`countRenderedLines` 与尾区 diff 逻辑已抽到 `./tailDiff.js` ✓ ——
// 行数换算错一行 ⇒ CPL 错位 ⇒ 终端内容错乱 ✗✓，这类数学**必须可脱离 xterm 单测** ✓✓
//（行为用例见 `xtermCliPanel.render.test.ts` ✓）。此处只保留 import ✓。

/**
 * xterm.js-based CLI chat panel — renders LLM content in a real terminal
 * emulator instance (not a DOM simulation).
 *
 * This panel uses xterm.js to render all chat output (user messages,
 * assistant markdown, tool calls, thinking) as ANSI escape sequences
 * in a character-grid terminal. The input area and status bar remain
 * as DOM elements for better UX (textarea, keyboard handling).
 *
 * Architecture:
 *  ┌──────────────────────────────────────┐
 *  │  xterm.js Terminal (output)          │
 *  │  markdown → ANSI → terminal.write()  │
 *  ├──────────────────────────────────────┤
 *  │  HTML textarea (input)               │
 *  ├──────────────────────────────────────┤
 *  │  DOM status bar                      │
 *  └──────────────────────────────────────┘
 *
 * Ported from Hermes-Agent TUI rendering approach, adapted for xterm.js
 * in a VS Code editor pane context.
 */
export class XtermCliPanel extends Disposable implements IChatPanel {
	private readonly _container: HTMLElement;
	private _terminalEl!: HTMLElement;
	private _terminal: XtermTerminalType | undefined;
	private _textarea!: HTMLTextAreaElement;
	private _statusBar!: HTMLElement;
	private readonly _disposables: DisposableStore;

	// ── State ──
	private _messages: IAgentChatMessage[] = [];
	private _agent: IAgentInfo | null = null;
	private _isSending = false;
	private _streamPhase: StreamPhase = 'idle';
	private _currentModel = '';
	private _chatOnly: boolean = false;
	private _contextUsage: IContextUsage | null = null;
	private _streamTextBuffer = '';
	private _streamThinkingBuffer = '';
	private _attachments: IChatAttachment[] = [];
	private _theme: AnsiTheme;

	// ── xterm layout ──
	private _cols = 80;
	/** 实测的等宽单元格尺寸（缓存，避免每次布局都插入探针测量） */
	private _cellMetrics: { width: number; height: number } | undefined;
	/** 当前内容渲染后占据的逻辑行数（由 countRenderedLines 推导） */
	private _contentLines = 1;

	// ── Spinner ──
	private _spinnerFrame = SPINNER_FRAMES[0]!;
	private _spinnerIdx = 0;
	private _spinnerInterval: number | null = null;

	// ── Expanded sections ──
	private readonly _expandedSections = new Set<string>(['thinking', 'tools']);

	// ── Pending render flag (while xterm is loading) ──
	private _pendingRender = false;

	// ─── 尾区增量重写（2026-09-21，修复"每 delta 全量重写整个终端 ⇒ 闪烁/底部截断" ✗✗✓）───
	// 此前 `updateMessage` / `setStreamTextBuffer` / `setStreamThinkingBuffer` / spinner 全部走
	// `_rerender()`（term.reset() + 全部消息整体重写 ✗）⇒ CPU ∝ 会话总长度、每帧全屏重绘 ✗。
	// 现改为：流式只重写**最后一条 assistant 消息的变化后缀**（历史区一个字节都不动 ✓✓）。
	/** 上次实际写入终端的 ANSI（messageId → payload，含结尾 `\r\n` ✓）—— 增量 diff 的比对基线。 */
	private readonly _writtenAnsi = new Map<string, string>();
	/** 上次写入占据的**显示行数**（按当前 cols 折行 ✓）。 */
	private readonly _writtenLines = new Map<string, number>();
	/** 尾区同步节流定时器（0 = 无 ✓）。 */
	private _tailSyncTimer = 0;
	/** 尾区重写最小间隔（ms）—— 多个增量源（delta/thinking/spinner）合并到每 ~80ms 一次 ✓。 */
	private static readonly TAIL_SYNC_MIN_INTERVAL_MS = 80;

	// ── Callbacks ──
	private readonly _onSendMessage: IChatPanelCallbacks['onSendMessage'];

	// ── Detail callbacks ──
	// @ts-ignore — assigned via setters, read when features are added
	private _onOpenCompressionDetail: ((data: Record<string, unknown>) => void) | null = null;
	// @ts-ignore
	private _onOpenMemoryDetail: ((agentId: string, memoryType?: string, contentPreview?: string) => void) | null = null;
	// @ts-ignore
	private _onOpenCodebaseDetail: (() => void) | null = null;

	private readonly _onComposerTextChange?: (text: string) => void;

	constructor(opts: IChatPanelCallbacks) {
		super();
		this._onSendMessage = opts.onSendMessage;
		this._onComposerTextChange = opts.onComposerTextChange;
		this._disposables = new DisposableStore();
		this._register(this._disposables);
		this._theme = createAnsiThemeFromCssVars();

		this._container = document.createElement('div');
		this._container.className = 'xterm-cli-panel';
		this._buildDOM();
		this._startSpinner();
		// xterm.js must be loaded asynchronously via importAMDNodeModule —
		// direct `import from '@xterm/xterm'` fails in the browser renderer.
		void this._initTerminal();
	}

	/**
	 * Asynchronously load the xterm.js Terminal constructor via the AMD
	 * module loader (required for browser renderer compatibility).
	 */
	private async _initTerminal(): Promise<void> {
		const xtermMod = await importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js');
		if (this._store.isDisposed) { return; }

		const Terminal = xtermMod.Terminal;


		// 对齐 Hermes-Agent TUI 的文本渲染策略：
		// - 最小化 lineHeight（1.0，无额外行间距）
		// - letterSpacing=0（零字符间距）
		// - 较小的 fontSize（12px，增加信息密度）
		// Hermes-Agent 纯 ANSI 渲染器中不控制这些属性，
		// 但我们用 xterm.js 必须显式设置
		this._terminal = new Terminal({
			fontFamily: CLI_FONT_FAMILY,
			fontSize: CLI_FONT_SIZE,
			lineHeight: CLI_LINE_HEIGHT,
			letterSpacing: 0,
			cursorBlink: false,
			cursorStyle: 'bar',
			disableStdin: true,
			scrollback: 5000,
			convertEol: true,
			allowProposedApi: true,
			// 主题跟随 VS Code（此前硬编码 #1e1e1e/#d4d4d4，亮色主题下文字不可见）
			theme: readXtermThemeFromCssVars(),
		});
		this._terminal.open(this._terminalEl);

		// 手动计算 cols 和 rows，基于容器尺寸
		// 避免依赖 @xterm/addon-fit（未安装）
		// xterm 字符宽度 ≈ 7.5px (13px font * 0.6 char-width)
		// xterm 行高 ≈ 18px (13px font * 1.3 lineHeight + padding)
		this._refitTerminal();

		// ResizeObserver: 监听 xterm 容器尺寸变化，自动重新计算 cols
		// 解决水平溢出问题：容器宽度变化时，xterm 自动调整列数
		const resizeObserver = new ResizeObserver(() => {
			this._refitTerminal();
		});
		resizeObserver.observe(this._terminalEl);
		this._disposables.add({ dispose: () => resizeObserver.disconnect() });

		// Track terminal dimensions
		this._disposables.add(this._terminal.onResize(({ cols }) => {
			this._cols = cols;
		}));

		// Copy selection to clipboard
		this._disposables.add(this._terminal.onSelectionChange(() => {
			const sel = this._terminal!.getSelection();
			if (sel) {
				navigator.clipboard?.writeText(sel).catch(() => { /* ignore */ });
			}
		}));

		// Render any messages that arrived while xterm was loading
		if (this._pendingRender || this._messages.length > 0) {
			this._pendingRender = false;
			this._rerender();
		}

		// 关键：xterm 加载完成后，DOM 布局已稳定，重新计算 xterm 容器高度
		// 修复从 web 切换到 CLI 时的空白问题：
		// - _initChatPanel() 调用 panel.layout() 时 wrapper 高度为 0（DOM 未布局完成）
		// - xterm 异步加载完成后，wrapper 已有正确高度
		// - 此处需要主动 layout 一次
		this._recomputeLayout();
	}

	get element(): HTMLElement { return this._container; }

	// ═══════════════════════════════════════════════════════════════════
	// Terminal refit
	// ═══════════════════════════════════════════════════════════════════

	/** 垂直固有开销 = `.xterm` 上下 padding 4+4（xterm-cli.css ✓）。
	 *  ⚠ 必须与 `_recomputeLayout` 反推高度用的是**同一个值** ✗✓（差 1px ⇒ rows 少一行 ✗）。 */
	private static readonly TERM_VPAD = 8;
	/** 水平固有开销 = 左右 padding 4×2 + 滚动条余量 12。 */
	private static readonly TERM_HPAD = 20;

	/**
	 * ★ 单元格尺寸**首选读 xterm 自己的实测值**（2026-09-21 底部截断根因 ✗✗✓）：
	 * xterm 6 的行高 = 字体自然度量（`fontBoundingBoxAscent + Descent`，≈1.25×fontSize ≈ 15px @12px ✓），
	 * 而不是 `fontSize × lineHeight`（12px ✗）—— 用 12 算出的 rows=103 实际渲染要 ~1545px ✗ ⇒
	 * 屏幕底部 ~20 行被容器 `overflow:hidden` 裁掉 ⇒ **滚动到底也看不见最后几行**
	 * （「建议下一步」之后的内容无法显示 ✗✗）。
	 * ⇒ `term._core.dimensions.css.cell`（渲染服务真实 css 尺寸，与 fit addon 同源 ✓）；
	 *    兜底才用 `measureCell`（已对齐 xterm 的 DOM 测量口径 ✓）。
	 * 每次 refit 现读（不缓存）⇒ 字体异步加载/主题变更后自动跟随 ✓。
	 */
	private _getCellSize(): { width: number; height: number } {
		// xterm 6 有 `dimensions` getter；5.x 走 `_renderService.dimensions`（fit addon 同款路径 ✓）
		const core = (this._terminal as any)?._core;
		const dims = core?.dimensions?.css?.cell ?? core?._renderService?.dimensions?.css?.cell;
		if (dims && dims.width > 0 && dims.height > 0) {
			return { width: dims.width, height: dims.height };
		}
		if (!this._cellMetrics) {
			this._cellMetrics = measureCell(this._terminalEl);
		}
		return this._cellMetrics;
	}

	/**
	 * 手动计算 xterm 的 cols 和 rows，基于容器尺寸。
	 * 避免依赖 @xterm/addon-fit（项目未安装）。
	 * ⚠ 行高/列宽必须用 xterm 实测值（`_getCellSize` ✓），自行估算会系统性失真 ✗。
	 */
	private _refitTerminal(): void {
		const term = this._terminal;
		if (!term || !this._terminalEl) { return; }
		const rect = this._terminalEl.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) { return; }

		const cell = this._getCellSize();
		const charWidth = cell.width;
		const lineHeightEstimate = cell.height;

		const cols = Math.max(20, Math.floor((rect.width - XtermCliPanel.TERM_HPAD) / charWidth));
		const rows = Math.max(3, Math.floor((rect.height - XtermCliPanel.TERM_VPAD) / lineHeightEstimate));

		this._diag('refit',
			`rect=${Math.round(rect.width)}x${Math.round(rect.height)} cell=${charWidth.toFixed(2)}x${lineHeightEstimate.toFixed(2)} cols=${cols} rows=${rows}`,
			1000);

		this._cols = cols;
		try {
			(term as any).resize?.(cols, rows);
		} catch { /* ignore */ }
	}

	/**
	 * 强制重新计算 xterm 容器高度。
	 * 与 `layout()` 不同：使用 `requestAnimationFrame` 等待 DOM 布局完成，
	 * 并使用容器的 `getBoundingClientRect()`（而非 `clientHeight`）来读取实际高度。
	 *
	 * 解决"从 web 切换到 CLI 后仍有空白"问题：
	 * - `_initChatPanel()` 第一次调用 `panel.layout()` 时，wrapper 高度为 0（DOM 未布局完成）
	 * - `layout()` 检测到 0 高度后直接 return，xterm 容器高度永远保持默认 200px
	 * - xterm 异步加载完成后，需要再调用一次 layout 才能正确计算
	 */
	private _recomputeLayout(): void {
		requestAnimationFrame(() => {
			if (!this._container || !this._terminalEl) { return; }
			const wrapper = this._container.querySelector('.xterm-cli-content-wrapper') as HTMLElement | null;
			if (!wrapper) { return; }

			const rect = wrapper.getBoundingClientRect();
			const wrapperHeight = rect.height;
			if (wrapperHeight <= 0) {
				// wrapper 还未布局完成，再重试一次
				this._recomputeLayout();
				return;
			}

			// 内容行数由「将要写入/已写入的 ANSI 文本」推导，而非读取
			// term.buffer.active.length —— 后者由上一轮的 rows 决定，用它反推
			// 会让高度每重算一次就收缩一轮，最终撞上 min-height 下限（大片空白）。
			// ★★★ cell 必须读 xterm 实测值（`_getCellSize` ✓）—— xterm 6 行高 ≈1.25×fontSize，
			//   用 fontSize×lineHeight 估算会把 rows 算多 ⇒ 底部行被裁掉（滚动到底也看不见 ✗✗✓）。
			const cellHeight = this._getCellSize().height;
			const contentLines = Math.max(1, this._contentLines);
			const contentHeight = contentLines * cellHeight + 12;
			// ★★ 2026-09-21（日志实锤 rem=3.8px ⇒ 末行被切 ✗✓）：先算**整数行数**再反推像素 ✓ ——
			//   高度恒为 `整数行 × cell + TERM_VPAD` ⇒ 末行永远完整 ✓✓（`rem` 结构性归零 ✓）。
			//   ⚠ TERM_VPAD 必须与 `_refitTerminal` 的垂直开销**一致** ✗✓（差一个像素 ⇒ rows 少一行 ✗）。
			const avail = Math.max(40, Math.min(contentHeight, wrapperHeight));
			const rowsFit = Math.max(1, Math.floor((avail - XtermCliPanel.TERM_VPAD) / cellHeight));
			const newHeight = rowsFit * cellHeight + XtermCliPanel.TERM_VPAD;

			// ★ 截断定位关键量 ✓：want 被 wrapper 夹住 ⇒ 视口不足（内容进 scrollback ✓）；
			//   slack 恒为 0 ✓ —— 若日志里 slack≠0 ⇒ 说明 TERM_VPAD 的口径与 _refitTerminal 漂了 ✗✓
			this._diag('layout',
				`wrapper=${Math.round(wrapperHeight)} contentLines=${contentLines} cell=${cellHeight.toFixed(1)} ` +
				`want=${contentHeight} set=${newHeight} clamped=${contentHeight > wrapperHeight} ` +
				`rows=${rowsFit} slack=${(newHeight - XtermCliPanel.TERM_VPAD - rowsFit * cellHeight).toFixed(1)}px`,
				500);

			this._terminalEl.style.height = `${newHeight}px`;
			this._terminalEl.style.width = `${rect.width}px`;

			// 重新计算 cols/rows
			this._refitTerminal();
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// DOM construction
	// ═══════════════════════════════════════════════════════════════════

	private _buildDOM(): void {
		// Wrapper for xterm — fills available space, contains the xterm
		// container which is positioned at the bottom. This way:
		// - Input is always at the very bottom of the panel
		// - xterm content sticks to the bottom of the available area
		// - No huge gap between content and input
		const contentWrapper = document.createElement('div');
		contentWrapper.className = 'xterm-cli-content-wrapper';

		// xterm container (Terminal instance is created asynchronously in _initTerminal)
		this._terminalEl = document.createElement('div');
		this._terminalEl.className = 'xterm-cli-terminal';

		contentWrapper.appendChild(this._terminalEl);

		// Input area (DOM textarea)
		const inputArea = document.createElement('div');
		inputArea.className = 'xterm-cli-input-area';

		const promptRow = document.createElement('div');
		promptRow.className = 'xterm-cli-prompt-row';

		const promptSymbol = document.createElement('span');
		promptSymbol.className = 'xterm-cli-prompt-symbol';
		promptSymbol.textContent = '\u276f';  // ❯

		this._textarea = document.createElement('textarea');
		this._textarea.className = 'xterm-cli-textarea';
		this._textarea.placeholder = 'Ask anything...';
		this._textarea.rows = 1;
		this._textarea.style.resize = 'none';

		promptRow.appendChild(promptSymbol);
		promptRow.appendChild(this._textarea);
		inputArea.appendChild(promptRow);

		// Status bar
		this._statusBar = document.createElement('div');
		this._statusBar.className = 'xterm-cli-status';

		// Assemble
		this._container.appendChild(contentWrapper);
		this._container.appendChild(inputArea);
		this._container.appendChild(this._statusBar);

		// Wire events
		this._disposables.add(addDisposableListener(this._textarea, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this._handleSend();
			}
		}));
		this._disposables.add(addDisposableListener(this._textarea, EventType.INPUT, () => {
			this._autoResizeTextarea();
			// 草稿持久化钩子（per-session，pane 侧 debounce 落 localStorage）
			this._onComposerTextChange?.(this.getComposerText());
		}));
	}

	private _autoResizeTextarea(): void {
		this._textarea.style.height = 'auto';
		const max = 200;
		const h = Math.min(this._textarea.scrollHeight, max);
		this._textarea.style.height = h + 'px';
	}

	private _handleSend(): void {
		const text = this._textarea.value.trim();
		if (!text || this._isSending) { return; }
		const attachments = this._attachments.length > 0 ? this._attachments.slice() : undefined;
		this._onSendMessage(text, undefined, attachments);
		this._textarea.value = '';
		this._autoResizeTextarea();
		this._attachments = [];
	}

	private _startSpinner(): void {
		this._spinnerInterval = window.setInterval(() => {
			this._spinnerIdx = (this._spinnerIdx + 1) % SPINNER_FRAMES.length;
			this._spinnerFrame = SPINNER_FRAMES[this._spinnerIdx]!;
			// Only re-render if there are running tools
			// ★ 走尾区增量（工具 trail 就在最后一条 assistant 消息里 ✓）⇒
			//   diff 只会命中 spinner 那一帧所在的行 ✓✓；此前是每 80ms **全量重写整个终端** ✗✗✓
			//   （这才是"工具一跑就狂闪"的真凶 ✓）。
			if (this._hasRunningTools()) {
				this._scheduleTailSync();
			}
		}, 80);
	}

	private _hasRunningTools(): boolean {
		return this._messages.some(m =>
			m.toolCalls?.some(tc => tc.status === 'running'),
		);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════

	private _rerender(): void {
		const term = this._terminal;
		if (!term) {
			// xterm not yet loaded — defer render until _initTerminal completes
			this._pendingRender = true;
			return;
		}

		// 重新计算 cols — 手动根据容器宽度算出正确的列数，
		// 确保长行在终端宽度处换行，不溢出。
		this._refitTerminal();

		term.reset();

		// ★ 全量重写 ⇒ 增量 diff 的基线（_writtenAnsi/_writtenLines）**全部作废** ✗ ⇒
		//   必须随本次渲染重建 ✓（否则下一次尾区 diff 会拿过期基线 ⇒ 光标错位/内容错乱 ✗✓）。
		this._writtenAnsi.clear();
		this._writtenLines.clear();

		const parts: string[] = [];

		for (const msg of this._messages) {
			const ansi = msg.role === 'user'
				? this._renderUserMsg(msg)
				: msg.role === 'assistant'
					? this._renderAssistantMsg(msg)
					: '';
			if (!ansi) { continue; }
			const normalized = this._normalizeMsgAnsi(ansi);
			this._writtenAnsi.set(msg.id, normalized);
			// ★ 账本口径（日志实锤 DRIFT Δ=-81 = N-1 ✗✓）：**每条只存"内容行数"** ✓ ——
			//   `countRenderedLines` 对以 `\r\n` 结尾的串会多算一个"末尾空行"，而拼成大 payload
			//   后这些空行**被相邻消息共享**（只有最末尾那一个真实存在 ✓）⇒ 必须逐条减 1 ✗✓。
			//   不变量：`_contentLines === Σ_written + 1`（见 `_assertContentLinesConsistent` ✓）。
			this._writtenLines.set(msg.id, countRenderedLines(normalized, Math.max(20, this._cols - 3)) - 1);
			parts.push(normalized);
		}

		const payload = parts.join('');
		// 先用「即将写入的文本」算出逻辑行数，再写 —— 高度推导不依赖 xterm buffer，
		// 因此不会随每次重算而收缩（修复底部大片空白）。
		this._contentLines = countRenderedLines(payload, Math.max(20, this._cols - 3));
		this._diag('rerender', `msgs=${this._messages.length} lines=${this._contentLines} cols=${this._cols} rows=${term.rows}`, 0);
		this._assertContentLinesConsistent('rerender');
		term.write(payload, () => {
			// 渲染完成后重新计算 xterm 容器高度，让内容贴底显示
			// 使用 _recomputeLayout() 等待 DOM 布局稳定（避免 wrapperHeight=0 的问题）
			this._recomputeLayout();
			this._diag('rerender-written',
				`bufferLen=${term.buffer.active.length} cursorY=${term.buffer.active.cursorY} viewportY=${term.buffer.active.viewportY}`, 0);
		});
		this._renderStatusBar();
	}

	// ─── 诊断打点（2026-09-21：底部截断定位 ✓）────────────────────────────────────
	/**
	 * 按 tag 限频的诊断日志（`[XtermLayout]` 前缀 ✓）；被限频跳过的条数会在下一次输出时带出 ✓。
	 *
	 * ⚠ 设计取向：**默认可读** —— 一次复现后，把控制台里所有 `[XtermLayout]` 行贴回来即可 ✓。
	 * 四个量刻意选成能"一眼判死因" ✓：
	 *   · `rerender` / `tail`：写入路径与**行数账本**（漂移 ⇒ 截断/空白 ✓✓）；
	 *   · `layout`：容器高度推导（`want` 被 `wrapper` 夹住 ⇒ 视口不足 ⇒ 内容进 scrollback ✓；
	 *     `set % cell ≠ 0` ⇒ **最后一行被切半行** ✗✓ —— 与"截断在半行"的截图症状吻合 ✓）；
	 *   · `refit`：cols/rows 推导链 ✓。
	 */
	private readonly _diagLastAt = new Map<string, number>();
	private readonly _diagSkipped = new Map<string, number>();

	private _diag(tag: string, msg: string, minIntervalMs = 500): void {
		const now = Date.now();
		const last = this._diagLastAt.get(tag) ?? -Infinity;
		if (now - last < minIntervalMs) {
			this._diagSkipped.set(tag, (this._diagSkipped.get(tag) ?? 0) + 1);
			return;
		}
		this._diagLastAt.set(tag, now);
		const skipped = this._diagSkipped.get(tag) ?? 0;
		if (skipped > 0) { this._diagSkipped.set(tag, 0); }
		console.info(`[XtermLayout] ${tag}: ${msg}${skipped > 0 ? `  (+${skipped} 条被限频合并)` : ''}`);
	}

	/**
	 * 账本自检 ✓✓：`_contentLines`（驱动 `_recomputeLayout` 的高度 ✓）必须 == Σ`_writtenLines`。
	 * 漂移 ⇒ 容器高度算错 ⇒ **底部截断/大片空白**的直接元凶 ✗✓ ⇒ 立刻 warn（不限频 ✓）。
	 */
	private _assertContentLinesConsistent(where: string): void {
		if (this._writtenLines.size === 0) { return; }
		let sum = 0;
		this._writtenLines.forEach(v => { sum += v; });
		// ★ 口径（日志实锤 Δ=-81 = N-1 ✗✓）：`_writtenLines` 每条存的是**内容行数**（不含末尾空行 ✓），
		//   而 `_contentLines` = 全部内容行 + **1 个共享末尾空行**（光标所在 ✓）⇒ 不变量 = Σ+1 ✓。
		const expected = sum + 1;
		if (expected !== this._contentLines) {
			console.warn(
				`[XtermLayout] ⚠ DRIFT @${where}: _contentLines=${this._contentLines} ` +
				`vs Σ_written+1=${expected}（Δ=${this._contentLines - expected}）— 高度推导已失真 ✗✓`,
			);
		}
	}

	/**
	 * 归一化每条消息的 payload：**必须以 `\r\n` 结尾** ✓。
	 *
	 * 这是尾区增量的**光标前提** ✗✓：所有消息写入后光标都停在"末尾内容行之后的新行起点"，
	 * 后续 `\x1b[<n>F` 的行数换算才成立 ✓。渲染器是否自带结尾换行不保证（`renderUserMessage` ✗）
	 * ⇒ 统一在此处补齐 ✓。
	 */
	private _normalizeMsgAnsi(ansi: string): string {
		return ansi.endsWith('\r\n') ? ansi : ansi + '\r\n';
	}

	/**
	 * 尾区同步节流（80ms 尾随 ✓）—— delta / thinking / spinner / 工具回填全部汇到这里 ✓，
	 * 合并成每 ~80ms 最多一次尾区重写 ✓（现状是每事件一次**全量** ✗✗）。
	 */
	private _scheduleTailSync(): void {
		if (this._tailSyncTimer !== 0) { return; }
		this._tailSyncTimer = window.setTimeout(() => {
			this._tailSyncTimer = 0;
			this._syncTailNow();
		}, XtermCliPanel.TAIL_SYNC_MIN_INTERVAL_MS);
	}

	/**
	 * 立即做一次尾区同步：只重写**最后一条 assistant 消息**的变化后缀 ✓。
	 *
	 * ⚠ 仅当它是**最后一条消息**时才能增量 —— 中间消息的变化无法定位光标 ⇒ 回退全量 ✓
	 * （该场景极少：工具结果回填旧消息 ✓，事件频率低 ✓）。
	 * ⚠ 任何一步算不出来（无基线 / 超视口 / 终端未就绪 ✓）⇒ **直接全量** ✓（宁全量、不错乱 ✓✓）。
	 */
	private _syncTailNow(): void {
		const term = this._terminal;
		if (!term) { this._pendingRender = true; return; }
		const lastIdx = this._messages.length - 1;
		const last = lastIdx >= 0 ? this._messages.findLast(m => m.role === 'assistant') : undefined;
		if (!last || this._messages[lastIdx] !== last) {
			// 最后一条不是 assistant（刚发用户消息 ✓ / 无消息 ✓）⇒ 尾区无意义，不动作 ✓
			this._diag('tail-skip', `lastIdx=${lastIdx} lastAssistant=${last ? 'not-last' : 'none'} msgs=${this._messages.length}`, 1000);
			return;
		}
		this._rewriteMessageTail(last);
	}

	/**
	 * ★ 尾区增量重写核心 ✓✓（2026-09-21：用户闪烁/底部截断的真凶修复 ✓）。
	 *
	 * 原理：渲染新 payload，与**上次实际写入**的基线按 `\r\n` 逐行 diff ✓，找到首个变化行；
	 * 只把"变化后缀"写回终端：
	 *   `\x1b[<oldSuffix>F` 光标上移到后缀首行（CPL，顺带归列 1 ✓）
	 *   `\x1b[0J`          清到缓冲区尾 ✓
	 *   写新后缀（以 `\r\n` 结尾 ⇒ 光标回到新行起点，与全量写入后的状态一致 ✓）
	 *
	 * 历史区（前缀行）**一个字节都不重写** ✓✓ ⇒ CPU ∝ 后缀长度（不再是整个会话 ✗✓）、
	 * 屏幕不重排 ⇒ 零闪烁 ✓✓。
	 *
	 * 三个保护 ✓：
	 *   ① 无基线（首写/基线被 reset 清掉后还没补 ✓）⇒ 按"全新后缀"处理（oldSuffix=0，只擦不写旧 ✓）；
	 *   ② **CPL 视口上限**：`\x1b[<n>F` 进不了 scrollback（会被视口顶截断 ✗✓）⇒
	 *      `oldSuffix > rows - 1` 时回退全量 `_rerender()` ✓（超长消息罕见 ✓）；
	 *   ③ diff 结果为空（内容没变 ✓ 流式期常态）⇒ **一次终端写都不发生** ✓✓。
	 */
	private _rewriteMessageTail(msg: IAgentChatMessage): void {
		const term = this._terminal;
		if (!term) { this._pendingRender = true; return; }
		const next = this._normalizeMsgAnsi(this._renderAssistantMsg(msg));
		const prev = this._writtenAnsi.get(msg.id);
		const cols = Math.max(20, this._cols - 3);

		// 全部 diff/行数数学都在纯函数里（可单测 ✓✓）—— 本方法只做 IO 与账本 ✓
		const patch = computeTailPatch(prev, next, cols, term.rows);
		if (patch.kind === 'noop') { return; }          // 内容没变 ⇒ 一次终端写都不发生 ✓✓
		if (patch.kind === 'full') {
			this._diag('tail-full', `id=${msg.id.slice(0, 8)} suffix超视口 ⇒ 回退全量`, 1000);
			this._rerender();
			return;
		}

		this._diag('tail',
			`id=${msg.id.slice(0, 8)} up=${patch.up} old=${patch.oldTotalLines} new=${patch.newTotalLines} ` +
			`Δ=${patch.newTotalLines - patch.oldTotalLines} content=${this._contentLines} rows=${term.rows}`,
			500);
		term.write(encodeTailPatch(patch), () => {
			this._recomputeLayout(); // 与全量路径一致：写完再按内容行数重排容器高度 ✓
			this._diag('tail-written',
				`bufferLen=${term.buffer.active.length} cursorY=${term.buffer.active.cursorY} viewportY=${term.buffer.active.viewportY}`,
				500);
		});

		// 登记新基线 ✓ + 行数账本 ✓（patch 的 *TotalLines 是"含末尾空行"口径 ✓ ⇒ 存账本前 −1 ✓；
		//   无基线（old=0）时旧内容行 = 0 ✓ —— 两个口径都在同一侧减 ⇒ Δ 不受影响 ✓）。
		const newContentLines = patch.newTotalLines - 1;
		const oldContentLines = patch.oldTotalLines > 0 ? patch.oldTotalLines - 1 : 0;
		this._writtenAnsi.set(msg.id, next);
		this._contentLines += newContentLines - oldContentLines;
		if (this._contentLines < 1) { this._contentLines = 1; }
		this._writtenLines.set(msg.id, newContentLines);
		this._assertContentLinesConsistent('tail');
	}

	private _renderUserMsg(msg: IAgentChatMessage): string {
		const text = msg.content || '';
		const ansi = renderUserMessage(text, this._theme);
		return ansi;
	}

	private _renderAssistantMsg(msg: IAgentChatMessage): string {
		const t = this._theme;
		const parts: string[] = [];

		// Thinking + Tool calls (rendered as tree)
		const hasThinking = (msg.thinking && msg.thinking.trim()) ||
			(msg.isThinking && this._streamThinkingBuffer);
		const hasTools = msg.toolCalls && msg.toolCalls.length > 0;

		if (hasThinking || hasTools) {
			const thinking: ThinkingInfo | null = hasThinking ? {
				text: msg.thinking || this._streamThinkingBuffer,
				isRunning: msg.isThinking ?? false,
				durationMs: (msg.metadata as any)?.durationMs,
			} : null;

			const tools: ToolCallInfo[] = (msg.toolCalls ?? []).map((tc: IToolCall) => ({
				id: tc.id,
				name: tc.name,
				args: tc.args,
				result: tc.result,
				status: tc.status === 'running' ? 'running'
					: tc.status === 'error' ? 'error'
					: 'success',
				durationMs: (msg.metadata as any)?.durationMs,
				displayName: tc.displayName,
			}));

			const trail = renderToolTrail(thinking, tools, {
				cols: this._cols,
				t: this._theme,
				expandedSections: this._expandedSections,
				spinnerFrame: this._spinnerFrame,
			});

			if (trail) {
				parts.push(trail);
				parts.push('\r\n');
			}
		}

		// Markdown text content
		const text = msg.isStreaming ? this._streamTextBuffer : msg.content;
		if (text && text.trim()) {
			const md = renderMarkdownToAnsi(text, {
				cols: this._cols - 3,
				t: this._theme,
				paddingLeft: 3,
			});
			parts.push(md);
			parts.push('\r\n');
		}

		// Footer: ▣ Mode · Model · Duration
		if (!msg.isStreaming || msg.streamPhase === 'idle') {
			const durationMs = (msg.metadata as any)?.durationMs as number | undefined;
			const interrupted = msg.streamPhase === 'error';
			parts.push('   ' + renderAssistantFooter(
				this._chatOnly ? '只读' : '正常',
				this._currentModel || 'unknown',
				t,
				durationMs,
				interrupted,
			));
			parts.push('\r\n');
		}

		return parts.join('');
	}

	private _renderStatusBar(): void {
		clearNode(this._statusBar);

		if (this._isSending) {
			const left = document.createElement('span');
			left.className = 'xterm-status-left';
			const spinner = document.createElement('span');
			spinner.className = 'xterm-spinner';
			spinner.textContent = this._spinnerFrame;
			const text = document.createElement('span');
			text.textContent = this._streamPhase === 'tool_executing' ? 'Running tools...' : 'Thinking...';
			left.appendChild(spinner);
			left.appendChild(text);
			this._statusBar.appendChild(left);
		} else {
			const left = document.createElement('span');
			left.className = 'xterm-status-left';
			left.textContent = 'Ready';
			this._statusBar.appendChild(left);
		}

		// Right: token usage
		if (this._contextUsage) {
			const right = document.createElement('span');
			right.className = 'xterm-status-right';
			const tokens = this._contextUsage.used ?? 0;
			const limit = this._contextUsage.limit ?? 0;
			const pct = limit > 0 ? Math.round((tokens / limit) * 100) : 0;
			right.textContent = `${tokens.toLocaleString()} tokens (${pct}%)`;
			this._statusBar.appendChild(right);
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — Agent / providers
	// ═══════════════════════════════════════════════════════════════════

	setAgent(agent: IAgentInfo | null): void {
		this._agent = agent;
	}

	getAgent(): IAgentInfo | null {
		return this._agent;
	}

	patchAgent(agent: IAgentInfo): void {
		// TUI 面板无 header 渲染，仅需替换字段
		if (!this._agent || this._agent.id !== agent.id) { return; }
		this._agent = agent;
	}

	setAgentStatus(status: AgentStatus): void {
		// TUI 面板无状态圆点；仅记录字段，保持与 Chat 面板一致的实体语义。
		if (!this._agent || this._agent.status === status) { return; }
		this._agent = { ...this._agent, status };
	}

	setAvailableAgents(_agents: IAgentInfo[]): void { /* no-op */ }

	setProviders(_providers: IProviderInfo[]): void { /* no-op */ }

	setModels(_models: IModelInfo[]): void { /* no-op */ }

	setCurrentProvider(_provider: string): void { /* no-op */ }

	setCurrentModel(model: string): void {
		this._currentModel = model;
	}

	// 图片模型（2026-09-10）：CLI 面板不渲染该下拉，no-op。
	setImageModels(_groups: IImageModelGroup[]): void { /* no-op */ }

	setCurrentImageModel(_preference: string): void { /* no-op */ }

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — Messages
	// ═══════════════════════════════════════════════════════════════════

	setMessages(messages: IAgentChatMessage[]): void {
		this._messages = messages.slice();
		this._rerender();
	}

	addMessage(message: IAgentChatMessage): void {
		this._messages.push(message);
		const term = this._terminal;
		if (!term) {
			// xterm not yet loaded — will be rendered when _initTerminal completes
			this._pendingRender = true;
			return;
		}
		// Incremental write — append to terminal（★ 必须登记基线 ✗✓：否则后续 tail diff
		// 拿不到这条消息的上次写入 ⇒ 只能回退全量 ✗）
		const ansi = this._normalizeMsgAnsi(
			message.role === 'user' ? this._renderUserMsg(message) : this._renderAssistantMsg(message),
		);
		// ★ 内容行数（−1 去掉末尾空行 ✓ 口径同上）；append 后缓冲区净增正是这么多 ✓
		//   （写入发生在光标所在的空行上 ⇒ 老空行被占用、新空行出现 ⇒ 净增 = 内容行 ✓✓）。
		const lines = countRenderedLines(ansi, Math.max(20, this._cols - 3)) - 1;
		term.write(ansi);
		this._writtenAnsi.set(message.id, ansi);
		this._writtenLines.set(message.id, lines);
		this._contentLines += lines;
		this._diag('add', `id=${message.id.slice(0, 8)} role=${message.role} lines=${lines} content=${this._contentLines}`, 500);
		this._assertContentLinesConsistent('addMessage');
	}

	updateMessage(messageId: string, updates: Partial<IAgentChatMessage>): void {
		const idx = this._messages.findIndex(m => m.id === messageId);
		if (idx < 0) { return; }
		this._messages[idx] = { ...this._messages[idx], ...updates };
		// ★ 尾区增量（2026-09-21 ✓）：**末位消息**（流式期的常态 ✓）只重写变化后缀 ✓✓；
		//   中间消息（工具结果回填旧消息 ✓ 罕见 ✓）无法定位光标 ⇒ 全量 ✓。
		//   此前这里是 `this._rerender()` —— **每个 delta 都把整个终端 reset + 全量重写** ✗✗✓
		//   = 用户报的闪烁/底部截断真凶 ✓✓。
		const msg = this._messages[idx];
		if (idx === this._messages.length - 1 && msg.role === 'assistant') {
			this._scheduleTailSync();
		} else {
			this._rerender();
		}
	}

	getMessages(): IAgentChatMessage[] {
		return [...this._messages];
	}

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — System messages (stubs)
	// ═══════════════════════════════════════════════════════════════════

	addCompressionNotice(_info: { originalCount: number; compressedCount: number; tokensSaved: number; durationMs: number; beforeText?: string; afterText?: string; summary?: string }): void { /* stub */ }
	addMemoryNotice(_info: { content: string; memoryType?: string; priority?: number; sceneName?: string; assistantContentPreview?: string; iteration?: number; noticeId?: string; status?: 'pending' | 'saved' | 'failed'; entries?: Array<{ type: string; content: string }>; skillId?: string; skillTitle?: string; agentId?: string; clickable?: boolean }): void { /* stub */ }
	updateMemoryNotice(_noticeId: string, _status: 'saved' | 'failed', _newContent?: string): void { /* stub */ }
	removeMemoryNotice(_noticeId: string): void { /* stub */ }
	addCodebaseNotice(_info: { operation: string; summary?: string }): void { /* stub */ }
	clearSystemMessages(): void { /* stub */ }
	setOpenCompressionDetailCallback(cb: (data: Record<string, unknown>) => void): void { this._onOpenCompressionDetail = cb; }
	setOpenMemoryDetailCallback(cb: (agentId: string, memoryType?: string, contentPreview?: string) => void): void { this._onOpenMemoryDetail = cb; }
	setOpenCodebaseDetailCallback(cb: () => void): void { this._onOpenCodebaseDetail = cb; }

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — Stream state
	// ═══════════════════════════════════════════════════════════════════

	setSending(sending: boolean, _options?: { triggerExecuteNext?: boolean }): void {
		this._isSending = sending;
		this._renderStatusBar();
	}

	setStreamPhase(phase: StreamPhase): void {
		this._streamPhase = phase;
		this._renderStatusBar();
	}

	setStreamTextBuffer(buffer: string): void {
		this._streamTextBuffer = buffer;
		// ★ 尾区增量 ✓（不再每 delta 全量重写 ✗✓）；最后一条 assistant 存在才需要动 ✓
		if (this._messages.findLast(m => m.role === 'assistant')) {
			this._scheduleTailSync();
		}
	}

	setStreamThinkingBuffer(buffer: string): void {
		this._streamThinkingBuffer = buffer;
		if (this._messages.findLast(m => m.role === 'assistant')) {
			this._scheduleTailSync();
		}
	}

	setStreamUsage(_usage: { input?: number; output?: number; seen?: boolean } | null): void {
		this._renderStatusBar();
	}

	setCompactedBaseline(_baseline: number): void { /* no-op */ }
	setContextUsage(usage: IContextUsage | null): void {
		this._contextUsage = usage;
		this._renderStatusBar();
	}

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — Session / worktree / mode
	// ═══════════════════════════════════════════════════════════════════

	// ChatOnly toggle — replaces legacy setChatMode(mode: ChatMode)
	setChatOnly(chatOnly: boolean): void {
		this._chatOnly = chatOnly;
	}

	setSessionInfo(_info: ISessionInfo | null): void { /* no-op */ }
	setAgentSessions(_sessions: ReadonlyArray<IAgentSessionMeta>): void { /* no-op */ }
	setWorktrees(_items: ReadonlyArray<IWorktreeItem>): void { /* no-op */ }
	setSelectedWorktree(_path: string): void { /* no-op */ }
	setWorkspaces(_items: ReadonlyArray<IWorkspaceItem>): void { /* no-op */ }
	setSelectedWorkspace(_id: string): void { /* no-op */ }
	setCheckpoint(_info: ICheckpointInfo | null): void { /* no-op */ }
	setCheckpoints(_list: ICheckpointInfo[]): void { /* no-op */ }

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — Orchestration
	// ═══════════════════════════════════════════════════════════════════

	showOrchestrationPlanDialog(_plan: OrchestrationPlan): void { /* stub */ }
	closeOrchestrationPlanDialog(): void { /* stub */ }

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — UI operations
	// ═══════════════════════════════════════════════════════════════════

	focusInput(): void {
		this._textarea?.focus();
	}

	getComposerText(): string { return this._textarea?.value ?? ''; }
	setComposerText(text: string): void { if (this._textarea) { this._textarea.value = text; } }

	layout(width: number, height: number): void {
		// 委托给 _recomputeLayout —— 内部使用 rAF 等待 DOM 布局完成
		// 即使首次调用时 wrapper 高度为 0，rAF 也会重试直到布局完成
		// 同时更新输入框的宽度
		if (this._textarea) {
			this._textarea.style.maxWidth = `${width - 40}px`;
		}
		// width/height 参数保留用于将来扩展
		void width; void height;
		this._recomputeLayout();
	}

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — Attachments
	// ═══════════════════════════════════════════════════════════════════

	getAttachments(): ReadonlyArray<IChatAttachment> {
		return this._attachments;
	}

	clearAttachments(): void {
		this._attachments = [];
	}

	addFileContext(filePath: string, content: string): void {
		const fileName = filePath.split(/[\\/]/).pop() || filePath;
		this._attachments.push({
			id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			type: 'file',
			name: fileName,
			mimeType: 'text/plain',
			data: content,
			size: content.length,
			isPasted: false,
			filePath,
		});
	}

	addTextContext(name: string, content: string): void {
		this._attachments.push({
			id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			type: 'file',
			name,
			mimeType: 'text/plain',
			data: content,
			size: content.length,
			isPasted: false,
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// IChatPanel — CLI mode query
	// ═══════════════════════════════════════════════════════════════════

	getCliMode(): boolean {
		return true; // This panel IS the CLI mode
	}

	// ═══════════════════════════════════════════════════════════════════
	// Dispose
	// ═══════════════════════════════════════════════════════════════════

	override dispose(): void {
		if (this._spinnerInterval !== null) {
			window.clearInterval(this._spinnerInterval);
			this._spinnerInterval = null;
		}
		// ★ 尾区节流定时器也必须清 ✗ —— 否则释放后仍会触发 ⇒ 往已 dispose 的终端写 ✗✓
		if (this._tailSyncTimer !== 0) { window.clearTimeout(this._tailSyncTimer); this._tailSyncTimer = 0; }
		this._terminal?.dispose();
		this._disposables.dispose();
		super.dispose();
	}
}

// ── Helper: clearNode (avoid importing from dom.js to keep deps minimal) ──
function clearNode(node: HTMLElement): void {
	while (node.firstChild) {
		node.removeChild(node.firstChild);
	}
}
