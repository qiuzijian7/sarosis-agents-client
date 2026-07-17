import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { renderMarkdown } from '../../../base/browser/markdownRenderer.js';
import type { IMarkdownString } from '../../../base/common/htmlContent.js';
import { IAgentChatMessage, IToolCall, IChatAttachment, ISubAgentData, IConfirmationData, ISuggestedQuestion, IReferenceItem, ILiveWorkflowAskUser, ILiveWorkflowExecution, ILiveWorkflowEvent, ILiveWorkflowSubAgent, ILiveCollectVariable, ITodoItem, ITipMessage, IProgressMessage } from './agentChatTypes.js';
import { AgentChatPanelBase, TOOL_BUILTIN_TITLES, TOOL_TERMINAL_TOOLS, TOOL_LIST_TOOLS, TOOL_CODEBASE_TOOLS } from './agentChatPanel.base.js';

export class AgentChatPanelToolCards extends AgentChatPanelBase {

protected override _createThinkingCard(msg: IAgentChatMessage): HTMLElement {
		const card = $(`.thinking-card${msg.isThinking ? ".active" : ""}`);

		// Header
		const header = $(".thinking-card-header");
		append(card, header);
		const icon = append(header, $("span.thinking-card-icon"));
		if (msg.isThinking) {
			const spinnerSvg = append(icon, $("svg.thinking-spinner"));
			spinnerSvg.setAttribute("width", "14");
			spinnerSvg.setAttribute("height", "14");
			spinnerSvg.setAttribute("viewBox", "0 0 24 24");
			spinnerSvg.setAttribute("fill", "none");
			spinnerSvg.setAttribute("stroke", "currentColor");
			spinnerSvg.setAttribute("stroke-width", "2");
			const spinPath = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"path",
			);
			spinPath.setAttribute("d", "M21 12a9 9 0 11-6.219-8.56");
			spinnerSvg.appendChild(spinPath);
		} else {
			icon.textContent = "...";
		}
		append(
			header,
			$(
				"span.thinking-card-title",
				undefined,
				msg.isThinking ? "思考中..." : "思考过程",
			),
		);
		const toggle = append(header, $("span.thinking-card-toggle.collapsed"));
		toggle.textContent = "▼";

		// Body (initially collapsed, rendered as markdown)
		const body = $(".thinking-card-body");
		append(card, body);
		if (msg.thinking) {
			this._renderMarkdownContent(body, msg.thinking);
		} else {
			body.textContent = msg.isThinking ? "正在思考..." : "";
		}
		body.style.display = "none";

		// Toggle click
		let collapsed = true;
		this._register(
			addDisposableListener(header, EventType.CLICK, () => {
				collapsed = !collapsed;
				body.style.display = collapsed ? "none" : "block";
				toggle.classList.toggle("collapsed", collapsed);
			}),
		);

		return card;
	}

protected override _maybeCreateClarifyCard(tc: IToolCall): HTMLElement | null {
		const key = (tc.name || '').toLowerCase();
		if (key !== 'clarify') { return null; }

		// 解析 args
		let parsed: { question?: string; options?: string[] } = {};
		try {
			parsed = tc.args ? JSON.parse(tc.args) : {};
		} catch {
			// args 可能是流式增量（不完整 JSON），此时不渲染 clarify 卡片
			return null;
		}
		if (!parsed.question || !Array.isArray(parsed.options) || parsed.options.length === 0) {
			return null;
		}

		// 已回答？检测 result
		const isAnswered = tc.status === 'success' && tc.result && tc.result.length > 0;
		const isPending = !isAnswered;

		const card = $('.clarify-card');
		if (isAnswered) { card.classList.add('answered'); }

		// Header — 使用 Codicon 原生图标
		const header = append(card, $('.clarify-card-header'));
		const icon = append(header, $('span.codicon.codicon-question'));
		icon.style.color = 'var(--vscode-charts-blue, #60a5fa)';
		icon.style.fontSize = '16px';
		const title = append(header, $('span.clarify-card-title', undefined, '需要澄清'));
		title.style.fontWeight = '600';
		title.style.fontSize = '13px';

		// Question
		const questionEl = append(card, $('.clarify-card-question'));
		questionEl.textContent = parsed.question;

		// Options — 单选按钮组，参考 VS Code 原生 Button + radio 样式
		if (isPending) {
			let selectedIdx = -1;
			const optionsDiv = append(card, $('.clarify-options'));
			parsed.options.forEach((opt, idx) => {
			const optBtn = append(optionsDiv, $('button.clarify-option')) as HTMLButtonElement;
			append(optBtn, $('span.clarify-option-marker.codicon'));
				const body = append(optBtn, $('span.clarify-option-body'));
				append(body, $('span.clarify-option-label', undefined, opt));

				this._register(addDisposableListener(optBtn, EventType.CLICK, () => {
					selectedIdx = idx;
					// 更新所有选项的选中状态
					optionsDiv.querySelectorAll('.clarify-option').forEach((el, i) => {
						el.classList.toggle('selected', i === idx);
						const m = el.querySelector('.clarify-option-marker');
						if (m) {
							m.className = 'clarify-option-marker codicon ' + (i === idx ? 'codicon-check' : 'codicon-circle-outline');
						}
					});
					submitBtn.disabled = false;
				}));
			});

			// Submit button — VS Code 原生 monaco-button
			const actions = append(card, $('.clarify-actions'));
			const submitBtn = append(actions, $('button.monaco-button.monaco-text-button.clarify-submit')) as HTMLButtonElement;
			submitBtn.textContent = '提交';
			submitBtn.disabled = true;
			this._register(addDisposableListener(submitBtn, EventType.CLICK, () => {
				if (selectedIdx < 0) { return; }
				const selection = parsed.options![selectedIdx];
				submitBtn.disabled = true;
				submitBtn.textContent = '已提交';
				// 禁用所有选项
				optionsDiv.querySelectorAll('.clarify-option').forEach(el => {
					(el as HTMLButtonElement).disabled = true;
				});
				// 调用回调
				this._onClarifySubmit?.(tc.id, selection);
			}));
		}

		// Answered summary
		if (isAnswered) {
			const answerDiv = append(card, $('.clarify-answer'));
			append(answerDiv, $('span.codicon.codicon-check'));
			append(answerDiv, $('span.clarify-answer-text', undefined, tc.result!));
		}

		return card;
	}

protected override _buildTaskCardFromData(data: { title: string; description: string; source?: string; taskId?: string; dependencies?: readonly string[]; attachments?: readonly { name: string; mimeType: string }[] }): HTMLElement | null {
		const card = $('.task-prompt-card');
		// Header row
		const header = append(card, $('.tpc-header'));
		const left = append(header, $('.tpc-header-left'));
		append(left, $('span.tpc-icon', undefined, '📋'));
		append(left, $('span.tpc-title', undefined, data.title || '任务'));
		append(header, $('.tpc-header-right'));
		// Toggle button
		const toggleBtn = append(header, $('.tpc-toggle'));
		toggleBtn.textContent = '▾ 收起';
		// Collapsible body
		const body = append(card, $('.tpc-body'));
		// Description (multi-line)
		const descEl = append(body, $('.tpc-desc'));
		descEl.textContent = data.description || '';
		// Metadata row
		const meta = append(body, $('.tpc-meta'));
		if (data.source) {
			append(meta, $('span.tpc-meta-item', undefined, `来源: ${data.source}`));
		}
		if (data.attachments && data.attachments.length > 0) {
			append(meta, $('span.tpc-meta-item', undefined, `附件: ${data.attachments.map(a => a.name).join(', ')}`));
		}

		// Toggle logic
		let collapsed = false;
		toggleBtn.addEventListener('click', () => {
			collapsed = !collapsed;
			body.style.display = collapsed ? 'none' : '';
			toggleBtn.textContent = collapsed ? '▸ 展开' : '▾ 收起';
		});

		return card;
	}

protected override _appendToolCallsWithPhaseGroups(
		parent: HTMLElement,
		toolCalls: readonly IToolCall[],
		streamPhase?: string,
	): void {
		const section = append(parent, $('.tool-calls-section'));
		const filteredCalls: IToolCall[] = [];
		// update_plan dedup — keep only the last one
		let lastUpdatePlanIdx = -1;
		for (let i = 0; i < toolCalls.length; i++) {
			if (toolCalls[i].name === 'update_plan') { lastUpdatePlanIdx = i; }
		}
		for (let i = 0; i < toolCalls.length; i++) {
			if (toolCalls[i].name === 'update_plan' && i !== lastUpdatePlanIdx) { continue; }
			filteredCalls.push(toolCalls[i]);
		}

		if (filteredCalls.length === 0) { return; }

		// Single-phase case: all tools share the same streamPhase → render
		// under one group header
		if (streamPhase && streamPhase !== 'idle') {
			const phaseInfo = AgentChatPanelBase._PHASE_LABELS[streamPhase];
			if (phaseInfo) {
				const group = append(section, $('.tpc-phase-group'));
				const header = append(group, $('.tpc-phase-header'));
				append(header, $('.tpc-phase-icon')).textContent = phaseInfo.icon;
				append(header, $('.tpc-phase-label')).textContent = phaseInfo.label;
				for (const tc of filteredCalls) {
					const card = this._maybeCreateClarifyCard(tc) ?? this._createToolCallCard(tc);
					group.appendChild(card);
				}
				return;
			}
		}

		// Fallback — no phase grouping
		for (const tc of filteredCalls) {
			const card = this._maybeCreateClarifyCard(tc) ?? this._createToolCallCard(tc);
			section.appendChild(card);
		}
	}

protected override _appendToolCard(container: HTMLElement, tc: IToolCall, msg: IAgentChatMessage): void {
		const clarifyCard = this._maybeCreateClarifyCard(tc);
		if (clarifyCard) {
			container.appendChild(clarifyCard);
			return;
		}
		const wrapper = this._createToolCallCard(tc);
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }
		container.appendChild(wrapper);
	}

protected override _createWriteFileToolCard(tc: IToolCall, key: string): HTMLElement {
		const isRunning = tc.status === 'running';
		const isError = tc.status === 'error';

		// 提取文件路径（fallback 链：tc.filePath → args.filePath → args.path）
		const filePath = this._extractFilePath(tc);

		// ── 状态驱动外壳 ──
		let statusClass = 'tool-card-success';
		if (isError) { statusClass = 'tool-card-error'; }
		else if (isRunning) { statusClass = 'tool-card-running'; }
		const wrapper = $(`.tool-header-wrapper.${statusClass}.write-file-tool-card`);
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }

		// ── Body（默认折叠）—— 必须先创建 body，折叠按钮 handler 才能引用 ──
		const body = append(wrapper, $('.tool-header-children'));

		// ── Header（diff 风格）──
		const headerEl = append(wrapper, $('.tool-header.write-file-header'));
		const row = append(headerEl, $('.tool-header-row'));

		// 左侧：chevron + 标题（语言标签 + 文件名 + 修改标记 + diff 行数）
		const left = append(row, $('.tool-header-left'));
		const titleContainer = append(left, $('.tool-header-title-container.tool-header-title-clickable'));
		const chevron = this._svgChevron(titleContainer, 'tool-header-chevron', 14);

		// 文件名 + 修改标记
		if (filePath) {
			// 语言标签（基于文件扩展名）
			const lang = this._getLanguageTag(filePath);
			if (lang) {
				const langEl = append(titleContainer, $('span.write-file-lang'));
				langEl.textContent = lang;
			}

			const fileName = filePath.split(/[\\/]/).pop() || filePath;
			const fileNameEl = append(titleContainer, $('span.write-file-name'));
			fileNameEl.textContent = fileName;

			const modEl = append(titleContainer, $('span.write-file-modified'));
			modEl.textContent = isRunning ? '(运行中)' : key === 'patch' ? '(修改)' : '(新建)';
		}

		// diff 行数统计（绿色 +N / 红色 -N）
		const diffStats = this._computeDiffStats(tc);
		if (diffStats.added > 0 || diffStats.removed > 0) {
			const diffEl = append(titleContainer, $('span.write-file-diff-stats'));
			if (diffStats.added > 0) {
				const addEl = append(diffEl, $('span.write-file-diff-add'));
				addEl.textContent = `+${diffStats.added}`;
			}
			if (diffStats.removed > 0) {
				const remEl = append(diffEl, $('span.write-file-diff-rem'));
				remEl.textContent = `-${diffStats.removed}`;
			}
		}

		// 点击标题区域（chevron + 文件名 + diff 统计）展开/折叠，不拦截内部按钮点击
		this._register(addDisposableListener(titleContainer, EventType.CLICK, (e) => {
			if ((e.target as HTMLElement)?.closest?.('button')) { return; }
			e.stopPropagation();
			const isExpanded = body.classList.toggle('tool-header-children-expanded');
			if (isExpanded) {
				this._toolCallExpandState.set(tc.id, true);
				chevron.classList.add('tool-header-chevron-expanded');
			} else {
				this._toolCallExpandState.set(tc.id, false);
				chevron.classList.remove('tool-header-chevron-expanded');
			}
		}));

		// 右侧：状态图标 + 「查看文件」按钮
		const right = append(row, $('.tool-header-right'));
		// 查看文件按钮（始终显示）
		if (this._onOpenFile && filePath && !isRunning) {
			const viewLink = append(right, $('button.tool-view-file-link'));
			viewLink.textContent = '查看文件';
			viewLink.title = `在编辑器中打开 ${filePath}`;
			this._register(addDisposableListener(viewLink, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onOpenFile?.(filePath);
			}));
		}
		// 展开/折叠 toggle 按钮（chevron-down SVG，旋转 180° 表示展开态）
		const collapseBtn = append(right, $('button.tool-collapse-btn')) as HTMLButtonElement;
		collapseBtn.title = '展开/折叠';
		this._svgChevronDown(collapseBtn, 'tool-collapse-icon');
		this._register(addDisposableListener(collapseBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			const isExpanded = body.classList.toggle('tool-header-children-expanded');
			if (isExpanded) {
				this._toolCallExpandState.set(tc.id, true);
				chevron.classList.add('tool-header-chevron-expanded');
				collapseBtn.classList.add('tool-collapse-expanded');
			} else {
				this._toolCallExpandState.set(tc.id, false);
				chevron.classList.remove('tool-header-chevron-expanded');
				collapseBtn.classList.remove('tool-collapse-expanded');
			}
		}));

		const inner = append(body, $('.tool-children-wrapper'));
		const innerBox = append(inner, $('.tool-children-wrapper-inner'));
		innerBox.classList.add('write-file-body');

		// 默认折叠（用户可点击展开查看 diff）
		const expanded = this._toolCallExpandState.get(tc.id) ?? false;
		if (expanded) {
			body.classList.add('tool-header-children-expanded');
			chevron.classList.add('tool-header-chevron-expanded');
			collapseBtn.classList.add('tool-collapse-expanded');
		}

		// ── Body 内容：直接 diff 代码块（无 section 包装）──
		if (isRunning && !tc.result) {
			const placeholder = append(innerBox, $('.write-file-placeholder'));
			placeholder.textContent = '正在写入文件...';
		} else if (tc.result) {
			const diffBlock = append(innerBox, $('.write-file-diff-block'));
			if (diffStats.lines && diffStats.lines.length > 0) {
				for (const line of diffStats.lines) {
					const lineEl = append(diffBlock, $(`div.write-file-diff-line.write-file-diff-${line.type}`));
					append(lineEl, $('span.write-file-diff-marker')).textContent = line.type === 'add' ? '+' : line.type === 'rem' ? '-' : ' ';
					append(lineEl, $('span.write-file-diff-content')).textContent = line.text;
				}
			} else {
				// 退化为纯文本预览
				const pre = append(diffBlock, $('.write-file-diff-content'));
				pre.textContent = tc.result;
			}
		}

		// ── 错误详情（无 result 时）──
		if (isError && tc.error && !tc.result) {
			const bottom = append(wrapper, $('.tool-bottom-children'));
			const bh = append(bottom, $('.tool-bottom-children-header'));
			const bchevron = this._svgChevron(bh, 'tool-bottom-children-chevron', 12);
			append(bh, $('span.tool-bottom-children-title')).textContent = '错误详情';
			const bbody = append(bottom, $('.tool-bottom-children-body'));
			append(bbody, $('.tool-bottom-children-content')).textContent = tc.error;
			this._register(addDisposableListener(bh, EventType.CLICK, (e) => {
				e.stopPropagation();
				const open = bbody.classList.toggle('tool-bottom-children-body-open');
				bchevron.classList.toggle('tool-bottom-children-chevron-open', open);
			}));
		}

		// 取消通知
		if (tc.status === 'canceled') {
			this._appendCanceledNotice(wrapper);
		}

		return wrapper;
	}

protected override _svgChevronDown(parent: HTMLElement, className: string): void {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
		const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		poly.setAttribute('points', '6 9 12 15 18 9');
		svg.appendChild(poly);
		parent.appendChild(svg);
	}

protected override _createTerminalToolCard(tc: IToolCall, key: string): HTMLElement {
		const isRunning = tc.status === 'running';
		const isError = tc.status === 'error';
		const isSuccess = tc.status === 'success' || (!isRunning && !isError && tc.status !== 'approval_required' && tc.status !== 'rejected' && tc.status !== 'canceled');

		// 提取命令字符串
		let commandText = '';
		try {
			if (tc.args) {
				const args = JSON.parse(tc.args);
				commandText = typeof args['command'] === 'string' ? args['command']
					: typeof args['cmd'] === 'string' ? args['cmd']
					: typeof args['code'] === 'string' ? args['code'] : '';
			}
		} catch { /* ignore */ }

		// ── 状态驱动外壳 ──
		let statusClass = 'tool-card-success';
		if (isError) { statusClass = 'tool-card-error'; }
		else if (isRunning) { statusClass = 'tool-card-running'; }
		else if (tc.status === 'skipped' || tc.status === 'canceled') { statusClass = 'tool-card-rejected'; }
		const wrapper = $(`.tool-header-wrapper.${statusClass}.terminal-tool-card`);
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }

		// ── Header（单行命令 + 按钮）──
		const headerEl = append(wrapper, $('.tool-header.terminal-header'));
		const row = append(headerEl, $('.tool-header-row'));

		// 左侧：终端 logo + 命令
		const left = append(row, $('.tool-header-left.terminal-left'));
		const titleContainer = append(left, $('.tool-header-title-container.tool-header-title-clickable'));
		const chevron = this._svgChevron(titleContainer, 'tool-header-chevron', 14);

		// 终端 logo（`>_` prompt 风格 SVG）
		this._svgTerminalLogo(titleContainer, 'terminal-logo');
		// 命令文本（去掉前缀"$ "，使用等宽字体）
		const cmdEl = append(titleContainer, $('span.terminal-cmd-text'));
		cmdEl.textContent = commandText || (isRunning ? '执行中…' : '(空命令)');

		// 点击标题区域（chevron + logo + 命令文本）展开/折叠，但不拦截内部按钮点击
		this._register(addDisposableListener(titleContainer, EventType.CLICK, (e) => {
			if ((e.target as HTMLElement)?.closest?.('button')) { return; }
			e.stopPropagation();
			const isExpanded = body.classList.toggle('tool-header-children-expanded');
			if (isExpanded) {
				this._toolCallExpandState.set(tc.id, true);
				chevron.classList.add('tool-header-chevron-expanded');
			} else {
				this._toolCallExpandState.set(tc.id, false);
				chevron.classList.remove('tool-header-chevron-expanded');
			}
		}));

		// 右侧：状态图标 + 复制 + Run in Terminal
		const right = append(row, $('.tool-header-right'));
		if (isRunning) {
			this._svgSpinner(right, 'tool-header-spinner-icon');
		} else if (isError) {
			this._svgAlert(right, 'tool-header-error-icon');
		} else if (isSuccess) {
			this._svgCheck(right, 'tool-header-success-icon');
		}
		if (typeof tc.duration === 'number' && tc.duration >= 0 && !isRunning) {
			append(right, $('span.tool-header-desc2')).textContent = this._formatDuration(tc.duration);
		}
		// 复制按钮
		if (commandText) {
			const copyBtn = append(right, $('button.terminal-copy-btn'));
			copyBtn.title = '复制命令';
			const copySvg = this._svgCopyIcon();
			copyBtn.appendChild(copySvg);
			this._register(addDisposableListener(copyBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				void this._copyToClipboard(commandText);
				copyBtn.classList.add('terminal-copy-done');
				setTimeout(() => copyBtn.classList.remove('terminal-copy-done'), 1200);
			}));
		}
		// 独立终端按钮（绿色框图标）
		if (this._onRunInTerminal && commandText && !isRunning) {
			const termBtn = append(right, $('button.terminal-open-btn'));
			termBtn.title = '在独立终端窗口中运行';
			this._svgTerminalOpenIcon(termBtn, 'terminal-open-icon');
			this._register(addDisposableListener(termBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onRunInTerminal?.(commandText);
			}));
		}
		// ── Body（默认折叠）—— 提前创建以便 header 点击事件引用 ──
		const body = append(wrapper, $('.tool-header-children'));
		const inner = append(body, $('.tool-children-wrapper'));
		const innerBox = append(inner, $('.tool-children-wrapper-inner'));
		innerBox.classList.add('terminal-body');

		const expanded = this._toolCallExpandState.get(tc.id) ?? false;
		if (expanded) {
			body.classList.add('tool-header-children-expanded');
			chevron.classList.add('tool-header-chevron-expanded');
		}

		// ── Body 内容：直接放命令结果（无 section 标签）──
		if (isRunning && !tc.result) {
			const running = append(innerBox, $('.terminal-running-row'));
			// 左侧占位文本 + 右侧「继续下一步」按钮
			const placeholder = append(running, $('span.terminal-placeholder'));
			placeholder.textContent = '运行中，详情可在终端查看';
			// 继续下一步按钮：点击后标记跳过 + 取消执行（用户可继续后续步骤）
			if (this._onCancelExecution) {
				const continueBtn = append(running, $('button.terminal-continue-btn')) as HTMLButtonElement;
				continueBtn.textContent = '继续下一步';
				continueBtn.title = '不等待命令完成，标记为已跳过并继续后续步骤';
				this._register(addDisposableListener(continueBtn, EventType.CLICK, (e) => {
					e.stopPropagation();
					continueBtn.disabled = true;
					continueBtn.textContent = '已跳过';
					// 取消当前执行（agent 端 abort → onCancelExecution → bubble 显示「用户已取消」）
					this._onCancelExecution?.();
				}));
			}
		} else if (tc.result) {
			const output = append(innerBox, $('.terminal-output-block'));
			if (isError) { output.classList.add('terminal-output-error'); }
			const pre = append(output, $('.terminal-output-content'));
			pre.textContent = tc.result;
			// exit code 徽标
			if (typeof tc.exitCode === 'number') {
				const ec = append(output, $(
					`.tool-exit-code.${tc.exitCode === 0 ? 'tool-exit-code-zero' : 'tool-exit-code-nonzero'}`
				));
				ec.textContent = `exit code ${tc.exitCode}`;
			}
		}

		// 错误详情
		if (isError && tc.error && !tc.result) {
			const bottom = append(wrapper, $('.tool-bottom-children'));
			const bh = append(bottom, $('.tool-bottom-children-header'));
			const bchevron = this._svgChevron(bh, 'tool-bottom-children-chevron', 12);
			append(bh, $('span.tool-bottom-children-title')).textContent = '错误详情';
			const bbody = append(bottom, $('.tool-bottom-children-body'));
			append(bbody, $('.tool-bottom-children-content')).textContent = tc.error;
			this._register(addDisposableListener(bh, EventType.CLICK, (e) => {
				e.stopPropagation();
				const open = bbody.classList.toggle('tool-bottom-children-body-open');
				bchevron.classList.toggle('tool-bottom-children-chevron-open', open);
			}));
		}

		// ── 取消通知（canceled 状态）──
		if (tc.status === 'canceled') {
			this._appendCanceledNotice(wrapper);
		}

		return wrapper;
	}

protected override _createToolCallCard(tc: IToolCall): HTMLElement {
		const key = (tc.name || '').toLowerCase();

		// ── update_plan: 专用计划卡片 ──
		if (key === 'update_plan') {
			return this._createPlanCard(tc);
		}

		// ── 写文件/编辑文件：diff 风格专用卡片（默认折叠）──
		if (key === 'file_write' || key === 'patch' || key === 'file_edit' || key === 'create_file') {
			return this._createWriteFileToolCard(tc, key);
		}

		// ── 终端命令：专用终端卡片（复刻 Void 风格：命令预览 + 输出代码块 + exit code）──
		if (TOOL_TERMINAL_TOOLS.has(key)) {
			return this._createTerminalToolCard(tc, key);
		}

		const isRunning = tc.status === 'running';
		const isError = tc.status === 'error';
		const isSuccess = tc.status === 'success' || (!isRunning && !isError && tc.status !== 'approval_required' && tc.status !== 'rejected' && tc.status !== 'canceled');
		const isApproval = tc.status === 'approval_required';
		const isRejected = tc.status === 'rejected';
		const isCanceled = tc.status === 'canceled';
		const isSkipped = tc.status === 'skipped';

		// 状态驱动外壳类（与 void-tool-card.css 对齐）
		let statusClass = 'tool-card-success';
		if (isError) { statusClass = 'tool-card-error'; }
		else if (isRunning) { statusClass = 'tool-card-running'; }
		else if (isApproval) { statusClass = 'tool-card-approval'; }
		else if (isRejected || isCanceled) { statusClass = 'tool-card-rejected'; }
		else if (isSkipped) { statusClass = 'tool-card-rejected'; }
		const wrapper = $(`.tool-header-wrapper.${statusClass}`);
		// P2+: data-tool-id 用于增量更新——状态变化时按 ID 查找并更新单张卡片
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }
		const headerEl = append(wrapper, $('.tool-header'));
		const row = append(headerEl, $('.tool-header-row'));

		// ── 左侧：chevron + 状态感知标题 + 斜体 desc ──
		const left = append(row, $('.tool-header-left'));
		const titleContainer = append(left, $('.tool-header-title-container.tool-header-title-clickable'));
		const chevron = this._svgChevron(titleContainer, 'tool-header-chevron', 14);

		const titleEl = append(titleContainer, $('span.tool-header-title'));
		const titleText = this._getToolTitle(key, tc.displayName, tc.name, isRunning);
		if (isRunning) {
			const lt = append(titleEl, $('span.tool-header-loading-title'));
			lt.appendChild(document.createTextNode(titleText));
			append(lt, $('span.tool-header-loading-dots'));
		} else {
			titleEl.textContent = titleText;
		}

		const desc1 = this._getToolDesc1(key, tc.args, tc.filePath);
		if (desc1) {
			const descEl = append(titleContainer, $('span.tool-header-desc1'));
			descEl.textContent = desc1;
			if (tc.filePath) {
				descEl.classList.add('tool-header-desc1-clickable');
				descEl.title = tc.filePath;
				descEl.addEventListener('click', (e) => {
					e.stopPropagation();
					if (tc.filePath) { this._onOpenFile?.(tc.filePath); }
				});
			}
		}

		// ── 右侧：spinner / error / success 图标 + duration ──
		const right = append(row, $('.tool-header-right'));
		if (isRunning) {
			this._svgSpinner(right, 'tool-header-spinner-icon');
		} else if (isError) {
			this._svgAlert(right, 'tool-header-error-icon');
		} else if (isApproval) {
			this._svgAlert(right, 'tool-header-approval-icon');
		} else if (isRejected || isCanceled) {
			this._svgAlert(right, 'tool-header-rejected-icon');
		} else if (isSuccess) {
			this._svgCheck(right, 'tool-header-success-icon');
		}
		if (typeof tc.duration === 'number' && tc.duration >= 0 && !isRunning && !isApproval) {
			append(right, $('span.tool-header-desc2')).textContent = this._formatDuration(tc.duration);
		}

		// ── 审批按钮（approval_required 状态）──
		if (isApproval) {
			const approvalRow = append(wrapper, $('.tool-approval-row'));
			const securityLabel = tc.securityLevel === 'dangerous'
				? '危险操作'
				: tc.securityLevel === 'cautious'
					? '需谨慎'
					: '需确认';
			const labelEl = append(approvalRow, $('span.tool-approval-label'));
			// 添加盾牌图标
			const shieldSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			shieldSvg.setAttribute('width', '13');
			shieldSvg.setAttribute('height', '13');
			shieldSvg.setAttribute('viewBox', '0 0 24 24');
			shieldSvg.setAttribute('fill', 'none');
			shieldSvg.setAttribute('stroke', 'currentColor');
			shieldSvg.setAttribute('stroke-width', '2');
			const shieldPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			shieldPath.setAttribute('d', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
			shieldSvg.appendChild(shieldPath);
			labelEl.appendChild(shieldSvg);
			labelEl.appendChild(document.createTextNode(securityLabel));

			// 允许一次按钮
			const allowOnceBtn = append(approvalRow, $('button.tool-approval-btn.tool-approval-btn-primary'));
			allowOnceBtn.textContent = '允许一次';
			allowOnceBtn.title = '仅允许此次执行';
			this._register(addDisposableListener(allowOnceBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onToolApprove?.(tc.id, 'allow_once');
			}));

			// 会话中允许按钮
			const allowSessionBtn = append(approvalRow, $('button.tool-approval-btn.tool-approval-btn-secondary'));
			allowSessionBtn.textContent = '会话中允许';
			allowSessionBtn.title = '在当前会话中自动允许';
			this._register(addDisposableListener(allowSessionBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onToolApprove?.(tc.id, 'allow_session');
			}));

			// 始终允许按钮
			const allowAlwaysBtn = append(approvalRow, $('button.tool-approval-btn.tool-approval-btn-secondary'));
			allowAlwaysBtn.textContent = '始终允许';
			allowAlwaysBtn.title = '始终自动允许此工具';
			this._register(addDisposableListener(allowAlwaysBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onToolApprove?.(tc.id, 'allow_always');
			}));

			// 拒绝按钮
			const denyBtn = append(approvalRow, $('button.tool-approval-btn.tool-approval-btn-reject'));
			denyBtn.textContent = '拒绝';
			denyBtn.title = '拒绝此工具调用';
			this._register(addDisposableListener(denyBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onToolApprove?.(tc.id, 'deny');
			}));
		}

		// ── 拒绝通知（rejected 状态）──
		if (isRejected) {
			const rejectedNotice = append(wrapper, $('.tool-rejected-notice'));
			rejectedNotice.textContent = '用户已拒绝此工具调用';
		}

		// ── Body（可折叠 dropdown）──
		const body = append(wrapper, $('.tool-header-children'));
		const inner = append(body, $('.tool-children-wrapper'));
		const innerBox = append(inner, $('.tool-children-wrapper-inner'));
		innerBox.classList.add('tool-section-body'); // 新：Content/Result 双区容器

		// 展开态：跨流式重建保留用户选择，否则回退 defaultShow。
		const expanded = this._toolCallExpandState.get(tc.id) ?? (tc.defaultShow === true);
		if (expanded) {
			body.classList.add('tool-header-children-expanded');
			chevron.classList.add('tool-header-chevron-expanded');
		}

		// ── Content Section：请求参数（可折叠）──
		const hasArgs = tc.args && (() => {
			try { return JSON.stringify(JSON.parse(tc.args), null, 2) !== '{}'; }
			catch { return false; }
		})();

		if (hasArgs) {
			this._appendToolSection(innerBox, {
				label: '请求参数',
				icon: 'content',
				collapsed: false,
				buildContent: (container) => {
					const parsed = JSON.stringify(JSON.parse(tc.args!), null, 2);
					const code = append(container, $('.tool-code-children'));
					const sel = append(code, $('.tool-code-children-selectable'));
					append(sel, $('pre')).textContent = parsed;
				},
			});
		}

		// ── Divider（双区都有内容时才显示）──
		if (hasArgs && tc.result) {
			append(innerBox, $('.tool-section-divider'));
		}

		// ── Result Section：执行结果（可折叠）──
		if (tc.result || isRunning) {
			// 状态徽标
			let statusBadge = '';
			let statusBadgeClass = '';
			if (isRunning) { statusBadge = '执行中'; statusBadgeClass = 'tool-section-badge-running'; }
			else if (isError) { statusBadge = '失败'; statusBadgeClass = 'tool-section-badge-error'; }
			else if (isSuccess) { statusBadge = '成功'; statusBadgeClass = 'tool-section-badge-success'; }

			// 元信息
			let metaText = '';
			if (typeof tc.duration === 'number' && tc.duration >= 0) {
				metaText = this._formatDuration(tc.duration);
			}
			if (typeof tc.exitCode === 'number') {
				metaText = metaText ? `${metaText} · exit ${tc.exitCode}` : `exit ${tc.exitCode}`;
			}

			this._appendToolSection(innerBox, {
				label: '执行结果',
				icon: 'result',
				collapsed: false,
				badge: statusBadge,
				badgeClass: statusBadgeClass,
				meta: metaText,
				buildContent: (container) => {
					if (isRunning && !tc.result) {
						const placeholder = append(container, $('.tool-section-placeholder'));
						placeholder.textContent = '等待结果返回...';
						return;
					}
					const resultText = tc.result!;
					// 增强渲染
					const enhanced = this._maybeCreateEnhancedResult(key, resultText);
					if (enhanced) {
						container.appendChild(enhanced);
					} else if (TOOL_TERMINAL_TOOLS.has(key)) {
						const term = append(container, $('.tool-children-terminal'));
						const codeBox = append(term, $('.tool-terminal-code'));
						append(codeBox, $('pre')).textContent = resultText;
						if (typeof tc.exitCode === 'number') {
							const ec = append(term, $(`.tool-exit-code.${tc.exitCode === 0 ? 'tool-exit-code-zero' : 'tool-exit-code-nonzero'}`));
							ec.textContent = `exit code ${tc.exitCode}`;
						}
					} else if (TOOL_LIST_TOOLS.has(key)) {
						const items = this._parseToolListItems(resultText);
						if (items && items.length > 0) {
							for (const it of items) {
								const itemEl = append(container, $(`.tool-listable-item${it.path ? '.tool-listable-item-clickable' : ''}`));
								const dot = append(itemEl, $('.tool-listable-item-dot'));
								const dotSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
								dotSvg.setAttribute('viewBox', '0 0 100 40');
								const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
								rect.setAttribute('x', '0'); rect.setAttribute('y', '15'); rect.setAttribute('width', '100'); rect.setAttribute('height', '10');
								dotSvg.appendChild(rect);
								dot.appendChild(dotSvg);
								append(itemEl, $('div')).textContent = it.name;
								if (it.path) {
									const p = it.path;
									itemEl.addEventListener('click', (e) => { e.stopPropagation(); this._onOpenFile?.(p); });
								}
							}
						} else {
							const code = append(container, $('.tool-code-children'));
							append(append(code, $('.tool-code-children-selectable')), $('pre')).textContent = resultText;
						}
					} else {
						const code = append(container, $('.tool-code-children'));
						const sel = append(code, $('.tool-code-children-selectable'));
						if (isError) { code.classList.add('tool-result-error'); }
						append(sel, $('pre')).textContent = resultText;
					}
				},
			});
		}

		// 错误（底部可折叠区，void BottomChildren）
		// 仅在 Result 区没有内容时才显示底部「错误详情」折叠区——避免错误信息与 Result 区域内容重复。
		// 已有 result 时，错误信息已在 Result 区（带红色错误样式）展示，无需再渲染底部折叠。
		if (isError && tc.error && !tc.result) {
			const bottom = append(wrapper, $('.tool-bottom-children'));
			const bh = append(bottom, $('.tool-bottom-children-header'));
			const bchevron = this._svgChevron(bh, 'tool-bottom-children-chevron', 12);
			append(bh, $('span.tool-bottom-children-title')).textContent = '错误详情';
			const bbody = append(bottom, $('.tool-bottom-children-body'));
			append(bbody, $('.tool-bottom-children-content')).textContent = tc.error;
			this._register(addDisposableListener(bh, EventType.CLICK, (e) => {
				e.stopPropagation();
				const open = bbody.classList.toggle('tool-bottom-children-body-open');
				bchevron.classList.toggle('tool-bottom-children-chevron-open', open);
			}));
		}

		// ── 展开/折叠点击（点标题行整体）──
		this._register(addDisposableListener(titleContainer, EventType.CLICK, () => {
			const nowExpanded = !body.classList.contains('tool-header-children-expanded');
			body.classList.toggle('tool-header-children-expanded', nowExpanded);
			chevron.classList.toggle('tool-header-chevron-expanded', nowExpanded);
			this._toolCallExpandState.set(tc.id, nowExpanded);
		}));

		return wrapper;
	}

protected override _svgChevron(parent: HTMLElement, className: string, size: number): SVGElement {
		if (!AgentChatPanelBase._svgChevronTpl) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
			const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			poly.setAttribute('points', '9 18 15 12 9 6');
			svg.appendChild(poly);
			AgentChatPanelBase._svgChevronTpl = svg;
		}
		const svg = AgentChatPanelBase._svgChevronTpl.cloneNode(true) as SVGElement;
		svg.setAttribute('class', className);
		svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
		parent.appendChild(svg);
		return svg;
	}

protected override _svgSpinner(parent: HTMLElement, className: string): void {
		if (!AgentChatPanelBase._svgSpinnerTpl) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
			svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', 'M21 12a9 9 0 11-6.219-8.56');
			svg.appendChild(path);
			AgentChatPanelBase._svgSpinnerTpl = svg;
		}
		const svg = AgentChatPanelBase._svgSpinnerTpl.cloneNode(true) as SVGElement;
		svg.setAttribute('class', className);
		parent.appendChild(svg);
	}

protected override _createPlanCard(tc: IToolCall): HTMLElement {
		// _parsePlanArgs 期望 Record<string, unknown>，但 IToolCall.args 是 JSON 字符串
		let parsedArgs: Record<string, unknown> | undefined = undefined;
		if (tc.args) {
			try { parsedArgs = JSON.parse(tc.args); } catch { /* invalid JSON */ }
		}
		const planData = this._parsePlanArgs(parsedArgs);
		const isRunning = tc.status === 'running';
		const statusClass = isRunning ? 'tool-card-running'
			: tc.status === 'error' ? 'tool-card-error'
			: 'tool-card-success';

		const wrapper = $(`.tool-header-wrapper.${statusClass}.plan-card`);
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }

		const body = append(wrapper, $('.plan-card-body'));

		// 标题行
		const titleRow = append(body, $('.plan-card-title-row'));
		const titleContainer = append(titleRow, $('.tool-header-title-container'));
		const titleEl = append(titleContainer, $('span.tool-header-title'));
		const doneCount = planData ? planData.plan.filter(s => s.status === 'completed').length : 0;
		const totalCount = planData ? planData.plan.length : 0;
		titleEl.textContent = isRunning
			? `更新计划 · ${doneCount}/${totalCount}`
			: `已更新计划 · ${doneCount}/${totalCount}`;

		if (isRunning) {
			const spinner = append(titleRow, $('.plan-card-spinner'));
			this._svgSpinner(spinner, '');
		} else {
			const check = append(titleRow, $('span.tool-header-success-icon'));
			this._svgCheck(check, '');
		}

		// 进度条
		if (planData && totalCount > 0) {
			const progressRow = append(body, $('.plan-card-progress'));
			const bar = append(progressRow, $('.plan-card-progress-bar'));
			const pct = Math.round((doneCount / totalCount) * 100);
			bar.style.width = `${pct}%`;
		}

		// 步骤列表
		if (planData && planData.plan.length > 0) {
			const stepsEl = append(body, $('.plan-card-steps'));
			for (let i = 0; i < planData.plan.length; i++) {
				const s = planData.plan[i];
				const stepRow = append(stepsEl, $(`.plan-card-step.step-${s.status}`));
				const dot = append(stepRow, $('span.plan-card-step-dot'));
				if (s.status === 'completed') {
					dot.textContent = '✓';
				} else if (s.status === 'in_progress') {
					dot.textContent = '▶';
					dot.classList.add('pulse');
				} else {
					dot.textContent = '·';
				}
				const stepText = append(stepRow, $('span.plan-card-step-text'));
				stepText.textContent = s.step;
			}
		}

		// explanation（如果有）
		if (planData?.explanation) {
			const footer = append(body, $('.plan-card-footer'));
			const icon = append(footer, $('span.plan-card-footer-icon'));
			icon.textContent = '✏';
			const text = append(footer, $('span.plan-card-footer-text'));
			text.textContent = planData.explanation;
		}

		return wrapper;
	}

protected override _appendToolSection(
		parent: HTMLElement,
		opts: {
			label: string;
			icon: 'content' | 'result';
			collapsed: boolean;
			badge?: string;
			badgeClass?: string;
			meta?: string;
			buildContent: (container: HTMLElement) => void;
		},
	): void {
		const wrapper = append(parent, $('.tool-section'));

		// Header row
		const header = append(wrapper, $('.tool-section-header'));
		const chevron = this._svgChevron(header, 'tool-section-chevron', 12);
		if (!opts.collapsed) { chevron.classList.add('tool-section-chevron-open'); }

		// Icon
		if (opts.icon === 'content') { this._svgSectionContent(header, 'tool-section-icon'); }
		else { this._svgSectionResult(header, 'tool-section-icon'); }

		// Label
		const label = append(header, $('span.tool-section-label'));
		label.textContent = opts.label;

		// Status badge
		if (opts.badge && opts.badgeClass) {
			const badge = append(header, $('span.tool-section-badge'));
			badge.textContent = opts.badge;
			badge.classList.add(opts.badgeClass);
		}

		// Meta (right-aligned)
		if (opts.meta) {
			const meta = append(header, $('span.tool-section-meta'));
			meta.textContent = opts.meta;
		}

		// Content
		const content = append(wrapper, $('.tool-section-content'));
		if (opts.collapsed) { content.classList.add('tool-section-content-collapsed'); }
		opts.buildContent(content);

		// Toggle collapse
		this._register(addDisposableListener(header, EventType.CLICK, (e) => {
			e.stopPropagation();
			const isCollapsed = content.classList.toggle('tool-section-content-collapsed');
			if (isCollapsed) {
				chevron.classList.remove('tool-section-chevron-open');
			} else {
				chevron.classList.add('tool-section-chevron-open');
			}
		}));
	}

protected override _svgSectionContent(parent: HTMLElement, className: string): void {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '12'); svg.setAttribute('height', '12');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z');
		svg.appendChild(path);
		const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		poly.setAttribute('points', '14 2 14 8 20 8');
		svg.appendChild(poly);
		parent.appendChild(svg);
	}

protected override _svgSectionResult(parent: HTMLElement, className: string): void {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '12'); svg.setAttribute('height', '12');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', 'M9 12l2 2 4-4');
		svg.appendChild(path);
		const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		rect.setAttribute('x', '3'); rect.setAttribute('y', '3');
		rect.setAttribute('width', '18'); rect.setAttribute('height', '18');
		rect.setAttribute('rx', '2');
		svg.appendChild(rect);
		parent.appendChild(svg);
	}

protected override _parsePlanArgs(args: Record<string, unknown> | undefined): {
		plan: Array<{ step: string; status: string }>;
		explanation?: string;
	} | null {
		if (!args) { return null; }
		const plan = args['plan'];
		if (!Array.isArray(plan) || plan.length === 0) { return null; }
		const steps = plan.map((s: any, i: number) => ({
			step: typeof s?.step === 'string' ? s.step : `Step ${i + 1}`,
			status: ['pending', 'in_progress', 'completed'].includes(s?.status) ? s.status : 'pending',
		}));
		const explanation = typeof args['explanation'] === 'string' ? args['explanation'] : undefined;
		return { plan: steps, explanation };
	}

protected override _svgCheck(parent: HTMLElement, className: string): void {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		poly.setAttribute('points', '20 6 9 17 4 12');
		svg.appendChild(poly);
		parent.appendChild(svg);
	}

protected override _svgAlert(parent: HTMLElement, className: string): void {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z');
		svg.appendChild(path);
		const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		l1.setAttribute('x1', '12'); l1.setAttribute('y1', '9'); l1.setAttribute('x2', '12'); l1.setAttribute('y2', '13');
		svg.appendChild(l1);
		const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		l2.setAttribute('x1', '12'); l2.setAttribute('y1', '17'); l2.setAttribute('x2', '12.01'); l2.setAttribute('y2', '17');
		svg.appendChild(l2);
		parent.appendChild(svg);
	}

protected override _maybeCreateEnhancedResult(key: string, resultText: string): HTMLElement | null {
		// ── kanban_list: 表格形式展示任务列表 ──
		if (key === 'kanban_list') {
			return this._createKanbanListCard(resultText);
		}
		// ── kanban_show: 任务详情卡片 ──
		if (key === 'kanban_show') {
			return this._createKanbanShowCard(resultText);
		}
		// ── workflow_list: 工作流列表卡片 ──
		if (key === 'workflow_list') {
			return this._createWorkflowListCard(resultText);
		}
		// ── memory_search: 记忆搜索结果卡片 ──
		if (key === 'memory_search') {
			return this._createMemorySearchCard(resultText);
		}
		// ── memory_list: 记忆列表卡片 ──
		if (key === 'memory_list') {
			return this._createMemoryListCard(resultText);
		}
		// ── codebase tools: 知识图谱结构化卡片 ──
		if (TOOL_CODEBASE_TOOLS.has(key)) {
			return this._createCodebaseResultCard(key, resultText);
		}
		return null;
	}

protected override _createCodebaseResultCard(key: string, resultText: string): HTMLElement | null {
		try {
			const data = JSON.parse(resultText);
			if (!data) { return null; }

			const card = $('.codebase-result-card');

			// ── search_graph: BM25 搜索结果列表 ──
			if (key === 'search_graph' && data.nodes && Array.isArray(data.nodes)) {
				return this._renderSearchGraphCard(card, data);
			}
			// ── search_code: 代码搜索 + 上下文 ──
			if (key === 'search_code' && data.results && Array.isArray(data.results)) {
				return this._renderSearchCodeCard(card, data);
			}
			// ── get_architecture: 架构总览 ──
			if (key === 'get_architecture' && (data.totalNodes || data.languages)) {
				return this._renderArchitectureCard(card, data);
			}
			// ── trace_path: 调用链追踪 ──
			if (key === 'trace_path' && (data.hops || data.path)) {
				return this._renderTracePathCard(card, data);
			}
			// ── index_repository: 索引进度/完成 ──
			if (key === 'index_repository') {
				return this._renderIndexRepoCard(card, data);
			}
			// ── 其他 codebase 工具：紧凑统计卡 ──
			return this._renderCodebaseSummaryCard(card, key, data);
		} catch {
			return null;
		}
	}

protected override _renderSearchGraphCard(card: HTMLElement, data: any): HTMLElement {
		const nodes = data.nodes || [];
		const total = data.total ?? nodes.length;
		const hasMore = data.hasMore ?? false;
		const semResults = data.semantic_results || [];

		// Summary strip
		const strip = append(card, $('.codebase-summary'));
		append(strip, $('span.codebase-stat', undefined, `${nodes.length} / ${total} results`));
		if (hasMore) {
			append(strip, $('span.codebase-stat.codebase-stat-more', undefined, 'hasMore → paginate'));
		}
		if (semResults.length > 0) {
			append(strip, $('span.codebase-stat', undefined, `+${semResults.length} semantic`));
		}

		// Column headers
		const hdr = append(card, $('.codebase-result-row.codebase-result-header'));
		append(hdr, $('span.codebase-col-rank', undefined, '#'));
		append(hdr, $('span.codebase-col-name', undefined, 'Symbol'));
		append(hdr, $('span.codebase-col-type', undefined, 'Type'));
		append(hdr, $('span.codebase-col-file', undefined, 'File'));
		append(hdr, $('span.codebase-col-score', undefined, 'Score'));

		const maxShow = Math.min(nodes.length, 10);
		for (let i = 0; i < maxShow; i++) {
			const n = nodes[i];
			const row = append(card, $('.codebase-result-row'));
			append(row, $('span.codebase-col-rank', undefined, String(i + 1)));
			append(row, $('span.codebase-col-name', undefined, n.name || n.id || '?'));
			append(row, $('span.codebase-col-type', undefined, n.type || ''));
			const file = (n.filePath || '').split('/').pop() || n.filePath || '';
			append(row, $('span.codebase-col-file', undefined, file));
			const score = data.scores && data.scores[n.id] ? data.scores[n.id].toFixed(1) : (n.score ? n.score.toFixed(1) : '-');
			append(row, $('span.codebase-col-score', undefined, score));
		}

		// Semantic results section
		if (semResults.length > 0) {
			append(card, $('.codebase-section-title', undefined, '🔮 Semantic Results'));
			for (let i = 0; i < Math.min(semResults.length, 5); i++) {
				const s = semResults[i];
				const srow = append(card, $('.codebase-result-row.codebase-semantic-row'));
				append(srow, $('span.codebase-col-name', undefined, s.name || s.id));
				append(srow, $('span.codebase-col-type', undefined, s.type || ''));
				const sScore = s.score ? s.score.toFixed(2) : '-';
				append(srow, $('span.codebase-col-score', undefined, sScore));
			}
		}

		if (hasMore) {
			append(card, $('.codebase-page-hint', undefined, `⚡ hasMore = true — 共 ${total} 条结果，当前显示前 ${maxShow} 条。用 offset=${maxShow} 翻页查看更多。`));
		}

		return card;
	}

protected override _renderSearchCodeCard(card: HTMLElement, data: any): HTMLElement {
		const results = data.results || [];
		const total = data.total ?? results.length;
		const mode = data.mode || 'compact';

		const strip = append(card, $('.codebase-summary'));
		append(strip, $('span.codebase-stat', undefined, `${results.length} / ${total} matches`));
		append(strip, $('span.codebase-stat', undefined, `mode: ${mode}`));

		for (let i = 0; i < Math.min(results.length, 5); i++) {
			const r = results[i];
			const entry = append(card, $('.codebase-search-code-entry'));

			const meta = append(entry, $('.codebase-search-code-meta'));
			const sym = r.symbol ? ` [${r.type || ''} ${r.symbol}]` : '';
			append(meta, $('span', undefined, `${r.filePath || ''}:${r.lineNo || ''}${sym}`));

			if (r.text) {
				append(entry, $('pre.codebase-search-code-line', undefined, r.text));
			}
			if (r.context) {
				const ctx = append(entry, $('.codebase-search-code-context'));
				append(ctx, $('pre', undefined, r.context));
			}
		}

		return card;
	}

protected override _renderArchitectureCard(card: HTMLElement, data: any): HTMLElement {
		// Stats grid
		const grid = append(card, $('.codebase-arch-grid'));
		const stats: [string, any, string][] = [
			['Total Nodes', data.totalNodes, ''],
			['Total Edges', data.totalEdges, ''],
			['Languages', Array.isArray(data.languages) ? data.languages.length : Object.keys(data.languages || {}).length, ''],
			['Packages', data.packages ? data.packages.length : 0, ''],
		];
		for (const [label, value, ] of stats) {
			if (value === null || value === undefined) { continue; }
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, String(value)));
			append(cell, $('.codebase-arch-label', undefined, label));
		}

		// Communities
		const communities = data.communities || [];
		if (communities.length > 0) {
			append(card, $('.codebase-section-title', undefined, `🏘️ Communities (${communities.length})`));
			const cGrid = append(card, $('.codebase-comm-grid'));
			for (const c of communities.slice(0, 6)) {
				const cc = append(cGrid, $('.codebase-comm-card'));
				append(cc, $('.codebase-comm-name', undefined, c.label || c.name || ''));
				const mems = c.members || c.size || 0;
				const coh = c.cohesion != null ? ` · cohesion ${(c.cohesion * 100).toFixed(0)}%` : '';
				append(cc, $('.codebase-comm-stats', undefined, `${mems} nodes${coh}`));
				if (c.topNodes && c.topNodes.length > 0) {
					const tops = c.topNodes.slice(0, 3).map((n: any) => n.name || n).join(', ');
					append(cc, $('.codebase-comm-top', undefined, `Top: ${tops}`));
				}
			}
		}

		return card;
	}

protected override _renderTracePathCard(card: HTMLElement, data: any): HTMLElement {
		const hops = data.hops || data.path || [];
		if (!Array.isArray(hops) || hops.length === 0) { return card; }

		const strip = append(card, $('.codebase-summary'));
		append(strip, $('span.codebase-stat', undefined, `${hops.length} hops`));
		if (data.mode) { append(strip, $('span.codebase-stat', undefined, `mode: ${data.mode}`)); }

		for (let i = 0; i < Math.min(hops.length, 15); i++) {
			const h = hops[i];
			const row = append(card, $('.codebase-trace-hop'));
			append(row, $('span.codebase-hop-num', undefined, `H${i}`));
			if (i > 0) { append(row, $('span.codebase-hop-arrow', undefined, '→')); }
			append(row, $('span.codebase-hop-name', undefined, h.name || h.function || h.callee || h.caller || '?'));

			const risk = h.risk || (h.depth >= 3 ? 'High' : h.depth >= 2 ? 'Med' : 'Low');
			const riskClass = risk === 'Critical' ? 'codebase-risk-crit' : risk === 'High' ? 'codebase-risk-high' : risk === 'Med' ? 'codebase-risk-med' : 'codebase-risk-low';
			append(row, $('span.codebase-hop-risk.' + riskClass, undefined, risk));
		}

		return card;
	}

protected override _renderIndexRepoCard(card: HTMLElement, data: any): HTMLElement {
		const strip = append(card, $('.codebase-summary'));
		if (data.success !== false) {
			append(strip, $('span.codebase-stat.codebase-stat-ok', undefined, '✓ success'));
		} else {
			append(strip, $('span.codebase-stat.codebase-stat-err', undefined, '✗ failed'));
		}
		if (data.message) {
			append(strip, $('span.codebase-stat', undefined, data.message));
		}

		const grid = append(card, $('.codebase-arch-grid'));
		if (data.filesScanned) {
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, String(data.filesScanned)));
			append(cell, $('.codebase-arch-label', undefined, 'Files Scanned'));
		}
		if (data.nodesExtracted) {
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, String(data.nodesExtracted)));
			append(cell, $('.codebase-arch-label', undefined, 'Nodes'));
		}
		if (data.edgesExtracted) {
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, String(data.edgesExtracted)));
			append(cell, $('.codebase-arch-label', undefined, 'Edges'));
		}
		const excludedDirs = data.excludedDirs || data.skipped || [];
		if (excludedDirs.length > 0) {
			append(card, $('.codebase-page-hint', undefined, `⏭️ Skipped: ${Array.isArray(excludedDirs) ? excludedDirs.length : excludedDirs} paths (e.g. ${String(Array.isArray(excludedDirs) ? excludedDirs.slice(0, 3).join(', ') : excludedDirs)})`));
		}

		return card;
	}

protected override _renderCodebaseSummaryCard(card: HTMLElement, key: string, data: any): HTMLElement {
		// 提取关键字段
		const keys = Object.keys(data).filter(k => !['success', 'message', 'hint', '_scopePath', '_scoped'].includes(k));
		const grid = append(card, $('.codebase-arch-grid'));
		for (const k of keys.slice(0, 6)) {
			const v = data[k];
			if (v === null || v === undefined) { continue; }
			const display = typeof v === 'object' ? JSON.stringify(v).substring(0, 60) : String(v);
			const cell = append(grid, $('.codebase-arch-stat'));
			append(cell, $('.codebase-arch-value', undefined, display));
			append(cell, $('.codebase-arch-label', undefined, k));
		}
		return card;
	}

protected override _createKanbanListCard(resultText: string): HTMLElement | null {
		const text = this._toolResultText(resultText);
		// 尝试解析为结构化数据（kanban_list handler 返回文本格式）
		const lines = text.split('\n').filter(l => l.trim());
		if (lines.length <= 1) { return null; }

		const card = $('.kanban-result-card');
		const tableWrap = append(card, $('.kanban-result-table'));
		// 表头
		const header = append(tableWrap, $('.kanban-result-row.kanban-result-header'));
		append(header, $('span.kanban-col-id', undefined, '#'));
		append(header, $('span.kanban-col-title', undefined, '标题'));
		append(header, $('span.kanban-col-status', undefined, '状态'));
		// 解析每行 — 同时兼容两种后端格式:
		//   (1) `  #abc123  [triage]  任务标题`          (历史带方括号)
		//   (2) `  #abc123  triage    — 任务标题`        (当前无方括号+破折号)
		// ID 段用 \S+ 捕获非空字符（兼容 6 位 hex、长 alphanum、含 -_）
		for (const line of lines) {
			const m = line.match(/#(\S+)\s+(?:\[(\w+)\]|(\w+))\s*[—\-]?\s*(.*)/i);
			if (!m) { continue; }
			const status = (m[2] || m[3] || '').toLowerCase();
			const title = (m[4] || '').replace(/^[—\-\s]+/, '').trim();
			if (!status || !title) { continue; }
			const row = append(tableWrap, $('.kanban-result-row'));
			append(row, $('span.kanban-col-id', undefined, `#${m[1]}`));
			append(row, $('span.kanban-col-title', undefined, title));
			const badge = append(row, $('span.kanban-col-status.kanban-status-badge'));
			badge.textContent = status;
			badge.classList.add(`kanban-status-${status}`);
		}
		return card;
	}

protected override _createKanbanShowCard(resultText: string): HTMLElement | null {
		const text = this._toolResultText(resultText);
		const card = $('.kanban-detail-card');
		for (const line of text.split('\n')) {
			const m = line.match(/^\s+(.+?):\s+(.*)/);
			if (m) {
				const row = append(card, $('.kanban-detail-row'));
				append(row, $('span.kanban-detail-label', undefined, m[1]));
				append(row, $('span.kanban-detail-value', undefined, m[2]));
			}
		}
		return card;
	}

protected override _createWorkflowListCard(resultText: string): HTMLElement | null {
		const text = this._toolResultText(resultText);
		let data: any[];
		try { data = JSON.parse(text); } catch { return null; }
		if (!Array.isArray(data) || data.length === 0) { return null; }

		const card = $('.workflow-list-card');
		for (const wf of data) {
			const item = append(card, $('.workflow-list-item'));
			const header = append(item, $('.workflow-list-item-header'));
			append(header, $('span.codicon.codicon-circuit-board'));
			append(header, $('span.workflow-list-item-name', undefined, wf.name || '(unnamed)'));
			const meta = append(item, $('.workflow-list-item-meta'));
			if (typeof wf.nodeCount === 'number') {
				append(meta, $('span.workflow-list-item-nodes', undefined, `${wf.nodeCount} 节点`));
			}
			if (wf.description) {
				append(item, $('span.workflow-list-item-desc', undefined, wf.description));
			}
		}
		return card;
	}

protected override _createMemorySearchCard(resultText: string): HTMLElement | null {
		const text = this._toolResultText(resultText);
		let data: any[];
		try { data = JSON.parse(text); } catch { return null; }
		if (!Array.isArray(data) || data.length === 0) { return null; }

		const card = $('.memory-search-card');
		for (const mem of data) {
			const item = append(card, $('.memory-search-item'));
			const header = append(item, $('.memory-search-item-header'));
			if (mem.type) {
				const typeBadge = append(header, $('span.memory-type-badge'));
				typeBadge.textContent = mem.type;
			}
			if (mem.tags && Array.isArray(mem.tags)) {
				for (const tag of mem.tags.slice(0, 3)) {
					append(header, $('span.memory-tag-badge', undefined, tag));
				}
			}
			if (mem.content) {
				const preview = mem.content.length > 120 ? mem.content.substring(0, 120) + '…' : mem.content;
				append(item, $('span.memory-search-item-content', undefined, preview));
			}
			if (mem.score !== undefined) {
				append(item, $('span.memory-search-item-score', undefined, `相关度: ${(mem.score * 100).toFixed(0)}%`));
			}
		}
		return card;
	}

protected override _createMemoryListCard(resultText: string): HTMLElement | null {
		const text = this._toolResultText(resultText);
		let data: any[];
		try { data = JSON.parse(text); } catch { return null; }
		if (!Array.isArray(data) || data.length === 0) { return null; }

		// 按类型分组
		const groups: Record<string, any[]> = {};
		for (const mem of data) {
			const type = mem.type || 'unknown';
			if (!groups[type]) { groups[type] = []; }
			groups[type].push(mem);
		}

		const card = $('.memory-list-card');
		for (const [type, entries] of Object.entries(groups)) {
			const section = append(card, $('.memory-list-group'));
			const header = append(section, $('.memory-list-group-header'));
			const label = type === 'episodic' ? '情景记忆' :
				type === 'semantic' ? '语义记忆' :
				type === 'procedural' ? '过程记忆' :
				type === 'working' ? '工作记忆' : type;
			append(header, $('span.codicon.codicon-database'));
			append(header, $('span.memory-list-group-label', undefined, `${label} (${entries.length})`));
			for (const mem of entries) {
				const item = append(section, $('.memory-list-item'));
				if (mem.content) {
					const preview = mem.content.length > 80 ? mem.content.substring(0, 80) + '…' : mem.content;
					append(item, $('span.memory-list-item-content', undefined, preview));
				}
			}
		}
		return card;
	}

protected override _getToolTitle(key: string, displayName: string | undefined, name: string, isRunning: boolean): string {
		const builtin = TOOL_BUILTIN_TITLES[key];
		if (!builtin) {
			const label = displayName || name || 'MCP';
			const prefix = isRunning ? '正在调用' : '调用了';
			return `${prefix} ${label}`;
		}
		return isRunning ? builtin.running : builtin.done;
	}

protected override _getToolDesc1(key: string, args: string | undefined, filePath: string | undefined): string {
		let p: Record<string, unknown> = {};
		try { p = args ? JSON.parse(args) : {}; } catch { p = {}; }
		const basename = (s: string) => {
			const parts = s.replace(/\\/g, '/').split('/').filter(Boolean);
			return parts[parts.length - 1] || s;
		};
		const fp = (filePath || p.file_path || p.filePath || p.path || p.uri) as string | undefined;
		const query = (p.query || p.pattern || p.search_query || p.search) as string | undefined;
		const command = (p.command || p.cmd) as string | undefined;
		const clip = (s: string) => (s.length > 60 ? s.slice(0, 60) + '…' : s);

		if (TOOL_TERMINAL_TOOLS.has(key)) {
			return command ? `"${clip(command)}"` : '';
		}
		if (key.includes('search') || key === 'grep') {
			return query ? `"${clip(query)}"` : '';
		}
		if (fp && typeof fp === 'string') {
			let d = basename(fp);
			const start = (p.start_line ?? p.startLine ?? p.offset) as number | undefined;
			const end = (p.end_line ?? p.endLine) as number | undefined;
			if ((key === 'file_read' || key === 'read_file' || key === 'read') && (start !== undefined && start !== null)) {
				d += ` (${start}${end !== undefined && end !== null ? '-' + end : ''})`;
			}
			return d;
		}
		if (query && typeof query === 'string') { return `"${clip(query)}"`; }
		if (command && typeof command === 'string') { return `"${clip(command)}"`; }
		const firstStr = Object.values(p).find(v => typeof v === 'string' && (v as string).length > 0) as string | undefined;
		return firstStr ? clip(firstStr) : '';
	}

protected override _parseToolListItems(resultText: string): Array<{ name: string; path?: string }> | null {
		if (!resultText) { return null; }
		const basename = (s: string) => {
			const parts = s.replace(/\\/g, '/').split('/').filter(Boolean);
			return parts[parts.length - 1] || s;
		};
		try {
			const parsed = JSON.parse(resultText);
			const arr = Array.isArray(parsed) ? parsed
				: Array.isArray(parsed?.items) ? parsed.items
					: Array.isArray(parsed?.children) ? parsed.children
						: Array.isArray(parsed?.list) ? parsed.list
							: Array.isArray(parsed?.uris) ? parsed.uris
								: null;
			if (!arr) { return null; }
			const mapped: Array<{ name: string; path?: string }> = [];
			for (const it of arr) {
				if (typeof it === 'string') { mapped.push({ name: basename(it), path: it }); continue; }
				if (!it || typeof it !== 'object') { continue; }
				const anyIt = it as Record<string, unknown>;
				const path = (anyIt.path || anyIt.uri || anyIt.fsPath || anyIt.file || '') as string;
				const nameRaw = (anyIt.name || anyIt.content) as string | undefined;
				if (!path && !nameRaw) { continue; }
				const name = (nameRaw || basename(path)) as string;
				if (!name) { continue; }
				const isDir = anyIt.isDirectory === true || anyIt.item_type === 'directory' || anyIt.type === 'directory' || anyIt.type === 'dir';
				mapped.push({ name: `${name}${isDir && !String(name).endsWith('/') ? '/' : ''}`, path: path || undefined });
			}
			return mapped.length > 0 ? mapped : null;
		} catch {
			const lines = resultText.split('\n').map(l => l.trim()).filter(Boolean);
			return lines.length > 0 ? lines.map(l => ({ name: l })) : null;
		}
	}

protected override _createSubAgentCard(sa: ISubAgentData): HTMLElement {
		const isRunning = sa.status === 'running';
		const isDone = sa.status === 'done';
		const isError = sa.status === 'error';

		// Type config
		const typeConfig = sa.type === 'explore' ? { icon: '🔍', label: '探索' } :
							sa.type === 'scout' ? { icon: '🌐', label: '研究' } :
							{ icon: '⚙️', label: '通用' };

		// ── Card container ──
		const saCard = $(`.subagent-card.enhanced${isRunning ? '.active' : ''}${isDone || isError ? '.collapsed' : ''}`);

		// ── Header ──
		const saHeader = append(saCard, $('.subagent-card-header'));
		// Icon
		const headerIcon = append(saHeader, $('span.subagent-card-header-icon'));
		headerIcon.textContent = typeConfig.icon;
		// Title (with shimmer if running)
		const saTitle = append(saHeader, $(`span.subagent-card-title${isRunning ? '.shimmer' : ''}`));
		saTitle.textContent = sa.task || `SubAgent (${typeConfig.label})`;
		// Close button (X icon)
		const closeBtn = append(saHeader, $('button.subagent-card-close-btn'));
		closeBtn.appendChild(this._createCloseIconSVG());

		// ── Body (markdown content) ──
		const saBody = append(saCard, $('.subagent-card-body'));
		const bodyContent = append(saBody, $('.subagent-card-body-content'));

		// Render content based on status
		if (isDone && sa.output) {
			// Done: show output with markdown rendering
			const mdString: IMarkdownString = { value: sa.output, isTrusted: true, supportHtml: true };
			// Track disposable to prevent leaks on DOM rebuild
			const prevDisposable = this._markdownDisposables.get(bodyContent);
			if (prevDisposable) { prevDisposable.dispose(); }
			this._markdownDisposables.set(bodyContent, renderMarkdown(mdString, undefined, bodyContent));
		} else if (isError && sa.error) {
			// Error: show error message
			const errorEl = append(bodyContent, $('div.subagent-card-error'));
			errorEl.textContent = sa.error;
		} else if (sa.task) {
			// Fallback: show task description
			const taskEl = append(bodyContent, $('p.subagent-card-task'));
			taskEl.textContent = sa.task;
		}

		// ── Footer (Execution Summary) ──
		const saFooter = append(saCard, $('.subagent-card-footer'));

		// Status summary
		const statusSummary = append(saFooter, $('span.subagent-exec-summary'));
		const statusLabel = append(statusSummary, $('span.subagent-exec-summary-label'));
		statusLabel.textContent = '状态: ';
		const statusValue = append(statusSummary, $('span.subagent-exec-stat'));
		statusValue.textContent = isRunning ? '运行中' : isDone ? '完成' : isError ? '失败' : '未知';

		// Tool calls summary (if available)
		if (sa.toolTraces && sa.toolTraces.length > 0) {
			const toolsSummary = append(saFooter, $('span.subagent-exec-summary'));
			const toolsLabel = append(toolsSummary, $('span.subagent-exec-summary-label'));
			toolsLabel.textContent = '工具: ';
			const toolsValue = append(toolsSummary, $('span.subagent-exec-stat'));
			const runningCount = sa.toolTraces.filter(t => t.status === 'running').length;
			const doneCount = sa.toolTraces.filter(t => t.status === 'done').length;
			const errorCount = sa.toolTraces.filter(t => t.status === 'error').length;
			toolsValue.textContent = `${doneCount}完成 · ${runningCount}运行 · ${errorCount}失败`;
		}

		// ── Interactions ──
		// Header click → toggle collapse (excluding close button)
		this._register(addDisposableListener(saHeader, EventType.CLICK, () => {
			saCard.classList.toggle('collapsed');
		}));

		// Close button → remove card (with stopPropagation to prevent toggle)
		this._register(addDisposableListener(closeBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			saCard.remove();
		}));

		return saCard;
	}

protected override _createCloseIconSVG(): SVGElement {
		const ns = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('width', '12');
		svg.setAttribute('height', '12');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2.5');
		const l1 = document.createElementNS(ns, 'line');
		l1.setAttribute('x1', '18'); l1.setAttribute('y1', '6'); l1.setAttribute('x2', '6'); l1.setAttribute('y2', '18');
		const l2 = document.createElementNS(ns, 'line');
		l2.setAttribute('x1', '6'); l2.setAttribute('y1', '6'); l2.setAttribute('x2', '18'); l2.setAttribute('y2', '18');
		svg.appendChild(l1); svg.appendChild(l2);
		return svg;
	}

protected override _createLiveWorkflowTraceView(
		workflowExecutions: Record<string, ILiveWorkflowExecution>,
		workflowEvents?: ILiveWorkflowEvent[],
		collectVariables?: Record<string, ILiveCollectVariable>
	): HTMLElement {
		const container = $('.wf-trace');

		for (const [execId, exec] of Object.entries(workflowExecutions)) {
			// ── Workflow Card ──
			const card = append(container, $('.wf-card'));
			card.classList.add(exec.status); // running | completed | failed | cancelled

			// ── Header ──
			const header = append(card, $('.wf-header'));
			const toggle = append(header, $('span.wf-toggle', undefined, '▼'));
			append(header, $('span.wf-icon', undefined, '🔀'));
			append(header, $('span.wf-name', undefined, exec.workflowName || 'Workflow'));
			const statusMap: Record<string, { label: string; cls: string }> = {
				running: { label: '运行中', cls: 'running' },
				completed: { label: '已完成', cls: 'completed' },
				failed: { label: '失败', cls: 'failed' },
				cancelled: { label: '已取消', cls: 'cancelled' },
			};
			const sInfo = statusMap[exec.status] ?? { label: exec.status, cls: 'running' };
			const badge = append(header, $('span.wf-status-badge'));
			badge.classList.add(sInfo.cls);
			if (sInfo.cls === 'running') {
				append(badge, $('span.dot'));
				append(badge, document.createTextNode(sInfo.label));
			} else {
				const icon = sInfo.cls === 'completed' ? '✓' : sInfo.cls === 'failed' ? '✗' : '⛔';
				append(badge, document.createTextNode(`${icon} ${sInfo.label}`));
			}

			// ── Body ──
			const body = append(card, $('.wf-body'));

			// ── Collect Variables Card (if pending) ──
			if (collectVariables) {
				const vars = Object.values(collectVariables).filter(v => v.executionId === execId);
				for (const cv of vars) {
					if (cv.status === 'pending') {
						body.appendChild(this._createCollectVarsCard(execId, cv));
					}
				}
			}

			// ── Node Cards ──
			for (const sa of exec.subAgents) {
				if (sa.id === '__workflow__') { continue; } // skip synthetic root
				body.appendChild(this._createNodeCard(sa));
			}

			// ── Timeline ──
			if (workflowEvents && workflowEvents.length > 0) {
				const events = workflowEvents.filter(e => e.executionId === execId);
				if (events.length > 0) {
					card.appendChild(this._createTimeline(exec, events));
				}
			}

			// ── Header toggle ──
			this._register(addDisposableListener(header, EventType.CLICK, () => {
				const isHidden = body.style.display === 'none';
				body.style.display = isHidden ? '' : 'none';
				toggle.textContent = isHidden ? '▼' : '▶';
				toggle.classList.toggle('collapsed', !isHidden);
			}));
		}

		return container;
	}

protected override _createCollectVarsCard(execId: string, cv: ILiveCollectVariable): HTMLElement {
		const card = $('.collect-vars-card');
		const header = append(card, $('.collect-vars-header'));
		append(header, $('span.icon', undefined, '📝'));
		append(header, $('span.title', undefined, '请填入工作流变量'));

		const form = append(card, $('.collect-vars-form'));
		const inputs: HTMLInputElement[] = [];
		for (const v of cv.variables) {
			const field = append(form, $('.collect-vars-field'));
			append(field, $('label', undefined, `${v.name}${v.defaultValue ? ` (默认: ${v.defaultValue})` : ''}`));
			const input = document.createElement('input');
			input.type = 'text';
			input.className = 'collect-vars-input';
			input.placeholder = v.defaultValue ? `默认: ${v.defaultValue}` : `请输入 ${v.name}`;
			input.value = cv.values[v.name] ?? v.defaultValue ?? '';
			field.appendChild(input);
			inputs.push(input);
		}
		if (this._onSubmitVariables) {
			const btn = append(form, $('button.collect-vars-submit', undefined, '提交')) as HTMLButtonElement;
			this._register(addDisposableListener(btn, EventType.CLICK, () => {
				const values: Record<string, string> = {};
				cv.variables.forEach((v, i) => { values[v.name] = inputs[i]?.value ?? v.defaultValue ?? ''; });
				this._onSubmitVariables!(execId, values);
				btn.disabled = true;
				btn.textContent = '已提交';
			}));
		}
		return card;
	}

protected override _createNodeCard(sa: ILiveWorkflowSubAgent): HTMLElement {
		const isRunning = sa.status === 'running';
		const isDone = sa.status === 'done';
		const isError = sa.status === 'error';

		const card = $('.node-card');
		card.classList.add(sa.status); // running | done | error | pending | cancelled

		// ── Collapse state (persists across re-renders) ──
		const userCollapsed = this._nodeCollapsedState.get(sa.id) === true;
		if (userCollapsed) { card.classList.add('collapsed'); }

		// ── Header ──
		const header = append(card, $('.node-header'));

		// Type icon
		const typeIcons: Record<string, { icon: string; cls: string }> = {
			agent: { icon: '🤖', cls: 'agent' },
			prompt: { icon: '📝', cls: 'prompt' },
			skill: { icon: '⚡', cls: 'skill' },
			tool: { icon: '🔧', cls: 'tool' },
		};
		const typeKey = (sa as any).type ?? 'agent';
		const tInfo = typeIcons[typeKey] ?? typeIcons.agent;
		const iconEl = append(header, $('.node-type-icon'));
		iconEl.classList.add(tInfo.cls);
		iconEl.textContent = tInfo.icon;

		// Info (name + task)
		const info = append(header, $('.node-info'));
		append(info, $('.node-name', undefined, sa.name));
		if (sa.task) {
			append(info, $('.node-task', undefined, sa.task));
		}

		// ── Collapse/expand button ──
		const collapseBtn = append(header, $('button.node-collapse-btn'));
		collapseBtn.classList.add(userCollapsed ? 'collapsed' : 'expanded');
		collapseBtn.title = userCollapsed ? '点击展开' : '点击收缩';
		const chevron = append(collapseBtn, $('span.icon-chevron'));
		chevron.textContent = userCollapsed ? '▶' : '▼';

		// Status indicator
		const statusEl = append(header, $('.node-status'));
		// Duration
		const dur = sa.endTime ? ((sa.endTime - sa.startTime) / 1000).toFixed(1) + 's' : isRunning ? '...' : '';
		if (dur) { append(statusEl, $('span.node-duration', undefined, dur)); }
		// Icon
		if (isRunning) {
			append(statusEl, $('span.spinner'));
		} else if (isDone) {
			append(statusEl, $('span.check', undefined, '✓'));
		} else if (isError) {
			append(statusEl, $('span.error', undefined, '✗'));
		} else {
			append(statusEl, $('span.node-pending', undefined, '等待中'));
		}

		// ── Body (collapsible) ──
		const nodeBody = append(card, $('.node-body'));
		if (userCollapsed) { nodeBody.style.display = 'none'; }

		// Streamed text / output / error
		if (isRunning && sa.streamedText) {
			const out = append(nodeBody, $('.node-output.running'));
			const md: IMarkdownString = { value: sa.streamedText, isTrusted: true, supportHtml: true };
			// Use renderMarkdown with parent element to track disposable lifecycle
			const prevDisposable = this._markdownDisposables.get(out);
			if (prevDisposable) { prevDisposable.dispose(); }
			this._markdownDisposables.set(out, renderMarkdown(md, undefined, out));
		} else if (isDone && (sa.output || sa.streamedText)) {
			const out = append(nodeBody, $('.node-output.done'));
			const text = sa.output || sa.streamedText || '';
			const md: IMarkdownString = { value: text, isTrusted: true, supportHtml: true };
			const prevDisposable = this._markdownDisposables.get(out);
			if (prevDisposable) { prevDisposable.dispose(); }
			this._markdownDisposables.set(out, renderMarkdown(md, undefined, out));
		} else if (isError && sa.error) {
			const out = append(nodeBody, $('.node-output.error'));
			out.textContent = sa.error;
		}

		// Tool calls
		if (sa.toolCalls && sa.toolCalls.length > 0) {
			const toolList = append(nodeBody, $('.tool-list'));
			for (const tc of sa.toolCalls as any[]) {
				const item = append(toolList, $('.tool-item'));
				const ti = append(item, $('.tool-icon'));
				ti.textContent = '🔧';
				append(item, $('span.tool-name', undefined, tc.name ?? 'unknown'));
				const ts = append(item, $('span.tool-status'));
				ts.classList.add(tc.status ?? 'done');
				const tIcon = tc.status === 'running' ? 'running...' : tc.status === 'error' ? '✗ error' : '✓ done';
				ts.textContent = tIcon;
			}
		}

		// ── Summary row (visible only when collapsed) ──
		const summary = append(card, $('.node-summary'));
		summary.style.display = userCollapsed ? 'block' : 'none';
		const toolCount = sa.toolCalls?.length ?? 0;
		const outputLen = (sa.output?.length ?? sa.streamedText?.length ?? 0);
		const parts: string[] = [];
		if (toolCount > 0) { parts.push(`${toolCount} 个工具调用`); }
		if (outputLen > 0) { parts.push(`输出约 ${outputLen} 字`); }
		if (isRunning) { parts.unshift('处理中'); }
		append(summary, $('span.node-summary-text', undefined, parts.join(' · ') || '暂无输出'));

		// ── Collapse/expand interaction ──
		// Toggle via button click. State is persisted in _nodeCollapsedState
		// so that DOM rebuilds (streaming updates) respect the user's choice
		// and do NOT auto-expand a manually-collapsed node.
		this._register(addDisposableListener(collapseBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			this._toggleNodeCollapse(sa.id, card, nodeBody, summary, collapseBtn, chevron);
		}));
		// Also allow header click (excluding the button itself) to toggle
		this._register(addDisposableListener(header, EventType.CLICK, (e) => {
			if (e.target === collapseBtn || collapseBtn.contains(e.target as Node)) { return; }
			this._toggleNodeCollapse(sa.id, card, nodeBody, summary, collapseBtn, chevron);
		}));

		return card;
	}

protected override _createTimeline(exec: ILiveWorkflowExecution, events: ILiveWorkflowEvent[]): HTMLElement {
		const timeline = $('.wf-timeline');

		// Build ordered node list from events
		const nodeOrder: string[] = [];
		const nodeStatus: Record<string, string> = {};
		for (const e of events) {
			if (e.kind === 'subagent_start' && e.nodeId !== '__workflow__' && !nodeOrder.includes(e.nodeId)) {
				nodeOrder.push(e.nodeId);
			}
			if (e.kind === 'subagent_start') {
				nodeStatus[e.nodeId] = 'active';
			}
			if (e.kind === 'subagent_end') {
				nodeStatus[e.nodeId] = e.status === 'done' ? 'done' : e.status === 'error' ? 'error' : 'done';
			}
		}
		// Also include nodes from subAgents
		for (const sa of exec.subAgents) {
			if (sa.id === '__workflow__') { continue; }
			if (!nodeOrder.includes(sa.id)) { nodeOrder.push(sa.id); }
			if (sa.status === 'running') { nodeStatus[sa.id] = 'active'; }
			else if (sa.status === 'done') { nodeStatus[sa.id] = 'done'; }
			else if (sa.status === 'error') { nodeStatus[sa.id] = 'error'; }
		}

		// Render: start → node1 → node2 → ... → end
		append(timeline, this._createTimelineItem('start', exec.status === 'running' ? 'active' : 'done'));
		for (let i = 0; i < nodeOrder.length; i++) {
			const nodeId = nodeOrder[i];
			const label = events.find(e => e.nodeId === nodeId)?.nodeName ?? nodeId;
			const st = nodeStatus[nodeId] ?? '';
			append(timeline, $('span.wf-timeline-arrow', undefined, '→'));
			append(timeline, this._createTimelineItem(label, st));
		}
	append(timeline, $('span.wf-timeline-arrow', undefined, '→'));
	const endStatus = exec.status === 'completed' ? 'done' : exec.status === 'failed' ? 'error' : exec.status === 'cancelled' ? 'done' : 'active';
	append(timeline, this._createTimelineItem('end', endStatus));

		return timeline;
	}

protected override _createTimelineItem(label: string, status: string): HTMLElement {
		const el = $('.wf-timeline-item');
		if (status) { el.classList.add(status); }
		el.textContent = label;
		return el;
	}

protected override _createConfirmationCard(cf: IConfirmationData): HTMLElement {
		// Terminal confirmation card (has command field)
		if (cf.command) {
			return this._createTerminalConfirmationCard(cf);
		}

		const card = $('.confirmation-card');
		const header = append(card, $('.confirmation-card-header'));
		append(header, $('span.confirmation-card-title', undefined, cf.title));
		// Security level badge
		if (cf.securityLevel) {
			const badge = append(header, $(`span.security-badge.${cf.securityLevel}`));
			badge.textContent = cf.securityLevel === 'safe' ? '安全' : cf.securityLevel === 'cautious' ? '注意' : '危险';
		}
		const body = append(card, $('.confirmation-card-body'));
		append(body, $('p.confirmation-card-message', undefined, cf.message));
		if (cf.detail) {
			append(body, $('pre.confirmation-card-detail', undefined, cf.detail));
		}
		const actions = append(body, $('.confirmation-card-actions'));
		// Main action buttons
		for (const btn of cf.buttons) {
			const el = append(actions, $(
				`button.confirmation-card-btn${btn.primary ? '.primary' : ''}${btn.danger ? '.danger' : ''}`,
				undefined,
				btn.label,
			));
			this._register(addDisposableListener(el, EventType.CLICK, () => {
				this._onConfirmationAction?.(cf.id, btn.id);
			}));
		}
		// Auto-confirm options (once/session/workspace/always)
		if (cf.autoConfirmOptions?.length) {
			const autoSection = append(body, $('.confirmation-auto-options'));
			append(autoSection, $('span.confirmation-auto-options-label', undefined, '自动确认:'));
			for (const opt of cf.autoConfirmOptions) {
				const btn = append(autoSection, $('button.confirmation-auto-btn'));
				btn.textContent = opt.label;
				this._register(addDisposableListener(btn, EventType.CLICK, () => {
					this._onConfirmationAction?.(cf.id, opt.id);
				}));
			}
		}
		return card;
	}

protected override _createTerminalConfirmationCard(cf: IConfirmationData): HTMLElement {
		const card = $('.confirmation-card.confirmation-card-terminal');
		const header = append(card, $('.confirmation-title-bar'));
		const titleContent = append(header, $('.confirmation-title-content'));
		// Terminal icon (chevron-right + line)
		const svgIcon = append(titleContent, $('svg'));
		svgIcon.setAttribute('width', '16');
		svgIcon.setAttribute('height', '16');
		svgIcon.setAttribute('viewBox', '0 0 24 24');
		svgIcon.setAttribute('fill', 'none');
		svgIcon.setAttribute('stroke', 'currentColor');
		svgIcon.setAttribute('stroke-width', '2');
		const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		polyline.setAttribute('points', '4 17 10 11 4 5');
		svgIcon.appendChild(polyline);
		const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		line.setAttribute('x1', '12');
		line.setAttribute('y1', '19');
		line.setAttribute('x2', '20');
		line.setAttribute('y2', '19');
		svgIcon.appendChild(line);

		append(titleContent, $('span.confirmation-title', undefined, '执行终端命令'));
		const badge = append(titleContent, $('span.confirmation-security-badge.security-cautious'));
		badge.textContent = '终端操作';

		// Command preview
		const cmdSection = append(card, $('.confirmation-terminal-command'));
		const cmdHeader = append(cmdSection, $('.terminal-command-header'));
		append(cmdHeader, $('span.terminal-prompt', undefined, '$'));
		const cmdText = cf.command || '';
		const isLong = cmdText.length > 100;
		const displayCmd = isLong ? cmdText.substring(0, 100) + '...' : cmdText;
		append(cmdHeader, $('code.terminal-command-text', undefined, displayCmd));

		if (isLong) {
			const showMoreBtn = append(cmdSection, $('button.terminal-show-more-btn'));
			showMoreBtn.textContent = '显示全部';
			// Toggle logic would need state management - simplified for now
		}

		// Action buttons
		const actions = append(card, $('.confirmation-actions'));
		const primaryAction = append(actions, $('.confirmation-primary-action'));

		const approveBtn = append(primaryAction, $('button.confirmation-btn.confirmation-btn-approve'));
		const approveSvg = append(approveBtn, $('svg'));
		approveSvg.setAttribute('width', '14');
		approveSvg.setAttribute('height', '14');
		approveSvg.setAttribute('viewBox', '0 0 24 24');
		approveSvg.setAttribute('fill', 'none');
		approveSvg.setAttribute('stroke', 'currentColor');
		approveSvg.setAttribute('stroke-width', '2');
		const approvePolyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		approvePolyline.setAttribute('points', '20 6 9 17 4 12');
		approveSvg.appendChild(approvePolyline);
		approveBtn.appendChild(document.createTextNode('执行'));
		this._register(addDisposableListener(approveBtn, EventType.CLICK, () => {
			this._onConfirmationAction?.(cf.id, 'allow_once');
		}));

		// Dropdown for more options
		const dropdownContainer = append(primaryAction, $('.confirmation-dropdown-container'));
		const dropdownToggle = append(dropdownContainer, $('button.confirmation-dropdown-toggle'));
		const toggleSvg = append(dropdownToggle, $('svg'));
		toggleSvg.setAttribute('width', '12');
		toggleSvg.setAttribute('height', '12');
		toggleSvg.setAttribute('viewBox', '0 0 24 24');
		toggleSvg.setAttribute('fill', 'none');
		toggleSvg.setAttribute('stroke', 'currentColor');
		toggleSvg.setAttribute('stroke-width', '2');
		const togglePolyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		togglePolyline.setAttribute('points', '6 9 12 15 18 9');
		toggleSvg.appendChild(togglePolyline);

		const dropdownMenu = append(dropdownContainer, $('.confirmation-dropdown-menu'));
		for (const opt of (cf.autoConfirmOptions || [
			{ id: 'allow_session', label: '在此会话中允许' },
			{ id: 'allow_workspace', label: '在工作区中允许' },
			{ id: 'allow_always', label: '始终允许' },
		])) {
			const item = append(dropdownMenu, $('button.confirmation-dropdown-item'));
			item.textContent = opt.label;
			this._register(addDisposableListener(item, EventType.CLICK, () => {
				this._onConfirmationAction?.(cf.id, opt.id);
			}));
		}

		// Reject button
		const rejectBtn = append(actions, $('button.confirmation-btn.confirmation-btn-reject'));
		const rejectSvg = append(rejectBtn, $('svg'));
		rejectSvg.setAttribute('width', '14');
		rejectSvg.setAttribute('height', '14');
		rejectSvg.setAttribute('viewBox', '0 0 24 24');
		rejectSvg.setAttribute('fill', 'none');
		rejectSvg.setAttribute('stroke', 'currentColor');
		rejectSvg.setAttribute('stroke-width', '2');
		const rejectLine1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		rejectLine1.setAttribute('x1', '18');
		rejectLine1.setAttribute('y1', '6');
		rejectLine1.setAttribute('x2', '6');
		rejectLine1.setAttribute('y2', '18');
		rejectSvg.appendChild(rejectLine1);
		const rejectLine2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		rejectLine2.setAttribute('x1', '6');
		rejectLine2.setAttribute('y1', '6');
		rejectLine2.setAttribute('x2', '18');
		rejectLine2.setAttribute('y2', '18');
		rejectSvg.appendChild(rejectLine2);
		rejectBtn.appendChild(document.createTextNode('取消'));
		this._register(addDisposableListener(rejectBtn, EventType.CLICK, () => {
			this._onConfirmationAction?.(cf.id, 'reject');
		}));

		return card;
	}

protected override _createAskUserCard(askUser: ILiveWorkflowAskUser): HTMLElement {
		const card = $(`.askuser-card.${askUser.status}`);
		const isPending = askUser.status === 'pending';
		const isAnswered = askUser.status === 'answered';

		// Header
		const header = append(card, $('.askuser-card-header'));
		const headerStatus = isPending
			? { icon: '❓', label: '需要输入', color: 'var(--vscode-charts-blue, #60a5fa)' }
			: isAnswered
				? { icon: '✓', label: '已回答', color: 'var(--vscode-charts-green, #34d399)' }
				: { icon: '⊘', label: askUser.status === 'cancelled' ? '已取消' : '已过期', color: 'var(--as-fg-secondary, #6c757d)' };
		append(header, $('span.askuser-card-icon', { style: `color:${headerStatus.color}` }, headerStatus.icon));
		append(header, $('span.askuser-card-title', undefined, askUser.nodeName));
		append(header, $('span.askuser-card-status', { style: `color:${headerStatus.color}` }, headerStatus.label));

		// Question
		append(card, $('div.askuser-card-question', undefined, askUser.question));

		// Options (interactive only while pending)
		if (isPending) {
			const optionsDiv = append(card, $(`.askuser-options.${askUser.multiSelect ? 'multi' : 'single'}`));
			askUser.options.forEach((opt, idx) => {
				const isSelected = askUser.selectedIndices.includes(idx);
				const optBtn = append(optionsDiv, $('button.askuser-option' + (isSelected ? '.selected' : '')));
				this._register(addDisposableListener(optBtn, EventType.CLICK, () => {
					// Toggle selection
					const current = askUser.selectedIndices.slice();
					if (askUser.multiSelect) {
						const has = current.includes(idx);
						const next = has ? current.filter(i => i !== idx) : [...current, idx].sort((a, b) => a - b);
						askUser.selectedIndices = next;
					} else {
						askUser.selectedIndices = [idx];
					}
					// Re-render this card
					const msgEl = card.closest('.chat-message') as HTMLElement;
					if (msgEl) {
						const msgId = msgEl.dataset.msgId;
						if (msgId) {
							const msg = this._messages.find(m => m.id === msgId);
							if (msg) { this._updateMessageDom(this._messages.indexOf(msg), msg); }
						}
					}
				}));
				append(optBtn, $('span.askuser-option-marker', undefined, askUser.multiSelect ? (isSelected ? '☑' : '☐') : (isSelected ? '●' : '○')));
				const body = append(optBtn, $('span.askuser-option-body'));
				append(body, $('span.askuser-option-label', undefined, opt.label));
				if (opt.description) {
					append(body, $('span.askuser-option-description', undefined, opt.description));
				}
			});

			// Submit button
			const actions = append(card, $('.askuser-actions'));
			const canSubmit = askUser.selectedIndices.length > 0;
			const submitBtn = append(actions, $('button.askuser-submit' + (canSubmit ? '' : '.disabled'))) as HTMLButtonElement;
			submitBtn.textContent = askUser.multiSelect ? `提交选择 (${askUser.selectedIndices.length})` : '提交';
			submitBtn.disabled = !canSubmit;
			this._register(addDisposableListener(submitBtn, EventType.CLICK, () => {
				if (!canSubmit) { return; }
				const selectedLabels = askUser.selectedIndices.map(i => askUser.options[i]?.label).filter(Boolean);
				// Call onAskUserSubmit callback
				this._onAskUserSubmit?.(askUser.id, askUser.executionId, askUser.nodeId, askUser.multiSelect ? selectedLabels : selectedLabels[0] ?? '');
			}));
		}

		// Answered summary (read-only)
		if (isAnswered) {
			const answerDiv = append(card, $('.askuser-answer'));
			append(answerDiv, $('div.askuser-answer-label', undefined, '已选择:'));
			const valuesDiv = append(answerDiv, $('.askuser-answer-values'));
			const selection = Array.isArray(askUser.selection) ? askUser.selection : [askUser.selection];
			selection.forEach(s => {
				if (typeof s === 'string' && s.length > 0) {
					append(valuesDiv, $('span.askuser-answer-chip', undefined, s));
				}
			});
		}

		return card;
	}

protected override _createTodoListCard(todos: ITodoItem[]): HTMLElement {
		const card = $('.todo-list-card');
		const completedCount = todos.filter(t => t.completed).length;
		const totalCount = todos.length;

		// Header
		const header = append(card, $('.todo-header'));
		append(header, $('span.todo-icon', undefined, '☑️'));
		append(header, $('span.todo-title', undefined, '任务清单'));
		append(header, $('span.todo-progress', undefined, `${completedCount}/${totalCount}`));
		const toggle = append(header, $('span.todo-toggle'));
		// Create SVG element directly (avoid TrustedHTML issues with DOMParser)
		const todoToggleSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		todoToggleSvg.setAttribute("width", "12");
		todoToggleSvg.setAttribute("height", "12");
		todoToggleSvg.setAttribute("viewBox", "0 0 24 24");
		todoToggleSvg.setAttribute("fill", "none");
		todoToggleSvg.setAttribute("stroke", "currentColor");
		todoToggleSvg.setAttribute("stroke-width", "2.5");
		const todoTogglePolyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
		todoTogglePolyline.setAttribute("points", "6 9 12 15 18 9");
		todoToggleSvg.appendChild(todoTogglePolyline);
		toggle.appendChild(todoToggleSvg);

		// Body
		const body = append(card, $('.todo-body'));
		const list = append(body, $('.todo-list'));
		todos.forEach(todo => {
			const item = append(list, $('.todo-item' + (todo.completed ? '.completed' : '')));
			const label = append(item, $('label.todo-checkbox-label'));
			const cb = append(label, $('input.todo-checkbox')) as HTMLInputElement;
			cb.type = 'checkbox';
			cb.checked = todo.completed;
			cb.disabled = true; // read-only in chat message
			append(label, $('span.todo-label', undefined, todo.label));
			if (todo.description) {
				append(item, $('span.todo-description', undefined, todo.description));
			}
			if (todo.assignee) {
				append(item, $('span.todo-assignee', undefined, `👤 ${todo.assignee}`));
			}
		});

		return card;
	}

protected override _createQuestionCarouselCard(questions: ISuggestedQuestion[]): HTMLElement {
		const card = $('.question-carousel-card');

		// Title
		const titleDiv = append(card, $('.question-carousel-title'));
		append(titleDiv, $('span.question-carousel-icon', undefined, '💬'));
		append(titleDiv, $('span', undefined, '推荐问题'));

		// Questions list
		const list = append(card, $('.question-carousel-list'));
		questions.forEach(q => {
			const btn = append(list, $('button.question-carousel-item'));
			btn.title = q.tooltip ?? '';
			this._register(addDisposableListener(btn, EventType.CLICK, () => {
				this._onQuestionClick?.(q);
			}));
			append(btn, $('span.question-label', undefined, q.label));
			// Arrow icon
			const arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			arrowSvg.setAttribute('width', '12');
			arrowSvg.setAttribute('height', '12');
			arrowSvg.setAttribute('viewBox', '0 0 24 24');
			arrowSvg.setAttribute('fill', 'none');
			arrowSvg.setAttribute('stroke', 'currentColor');
			arrowSvg.setAttribute('stroke-width', '2');
			const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', '5');
			line.setAttribute('y1', '12');
			line.setAttribute('x2', '19');
			line.setAttribute('y2', '12');
			arrowSvg.appendChild(line);
			const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			polyline.setAttribute('points', '12 5 19 12 12 19');
			arrowSvg.appendChild(polyline);
			btn.appendChild(arrowSvg);
		});

		return card;
	}

protected override _createReferencesCard(references: IReferenceItem[]): HTMLElement {
		const card = $('.references-card');
		const title = references.length > 1 ? `使用了 ${references.length} 个引用` : '使用了 1 个引用';

		// Header
		const header = append(card, $('.references-header'));
		append(header, $('span.references-icon', undefined, '📚'));
		append(header, $('span.references-title', undefined, title));
		const toggle = append(header, $('span.references-toggle.collapsed'));
		// Create SVG element directly (avoid TrustedHTML issues with DOMParser)
		const refToggleSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		refToggleSvg.setAttribute("width", "12");
		refToggleSvg.setAttribute("height", "12");
		refToggleSvg.setAttribute("viewBox", "0 0 24 24");
		refToggleSvg.setAttribute("fill", "none");
		refToggleSvg.setAttribute("stroke", "currentColor");
		refToggleSvg.setAttribute("stroke-width", "2.5");
		const refTogglePolyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
		refTogglePolyline.setAttribute("points", "6 9 12 15 18 9");
		refToggleSvg.appendChild(refTogglePolyline);
		toggle.appendChild(refToggleSvg);

		// List (collapsed by default)
		const list = append(card, $('.references-list'));
		list.style.display = 'none';
		references.forEach(ref => {
			const item = append(list, $(`.reference-item.${ref.state || ''}`));
			const iconMap: Record<string, string> = { file: '📄', code: '📝', url: '🔗', symbol: '🔧', text: '📋' };
			append(item, $('span.reference-icon', undefined, iconMap[ref.kind] || '📎'));
			append(item, $('span.reference-name', undefined, ref.name));
			if (ref.description) {
				append(item, $('span.reference-description', undefined, ref.description));
			}
			if (ref.state && ref.state !== 'not-modified') {
				const badgeLabel = ref.state === 'modified' ? '已修改' : ref.state === 'pending' ? '待处理' : '已排除';
				append(item, $('span.reference-state-badge', undefined, badgeLabel));
			}
			// Click to open
			this._register(addDisposableListener(item, EventType.CLICK, () => {
				this._onReferenceClick?.(ref);
			}));
		});

		// Toggle expand/collapse
		this._register(addDisposableListener(header, EventType.CLICK, () => {
			const expanded = list.style.display !== 'none';
			list.style.display = expanded ? 'none' : 'block';
			toggle.classList.toggle('collapsed');
		}));

		return card;
	}

protected override _createTipCard(tip: ITipMessage): HTMLElement {
		const card = $('.tip-card');
		append(card, $('span.tip-icon', undefined, tip.icon || '💡'));
		append(card, $('span.tip-content', undefined, tip.content));

		if (tip.action) {
			const actionBtn = append(card, $('button.tip-action-btn'));
			actionBtn.textContent = tip.action.label;
			actionBtn.title = tip.action.tooltip ?? '';
			this._register(addDisposableListener(actionBtn, EventType.CLICK, () => {
				this._onTipAction?.(tip.id, tip.action!.actionId);
			}));
		}

		const dismissBtn = append(card, $('button.tip-dismiss-btn'));
		dismissBtn.textContent = '×';
		dismissBtn.title = '关闭提示';
		this._register(addDisposableListener(dismissBtn, EventType.CLICK, () => {
			this._onTipDismiss?.(tip.id);
		}));

		return card;
	}

protected override _createProgressCard(progressItems: IProgressMessage[]): HTMLElement {
		const card = $('.progress-card');
		const header = append(card, $('.progress-header'));
		append(header, $('span.progress-header-icon', undefined, '⚙️'));
		append(header, $('span.progress-header-title', undefined, '执行进度'));

		const list = append(card, $('.progress-list'));
		progressItems.forEach(p => {
			const step = append(list, $(`.progress-step.${p.status}`));
			const iconMap: Record<string, string> = { spinner: '⏳', check: '✓', warning: '⚠', error: '✗' };
			append(step, $('span.progress-icon', undefined, iconMap[p.icon ?? ''] || '•'));
			append(step, $('span.progress-content', undefined, p.content));
			if (p.timestamp) {
				append(step, $('span.progress-timestamp', undefined, p.timestamp));
			}
		});

		return card;
	}

protected override _createStreamErrorCard(msg: IAgentChatMessage): HTMLElement {
		const card = $('.chat-error-card');
		const err = (msg.metadata?.['streamError'] as any);
		const msgText = typeof err === 'string' ? err : err?.message ?? '执行失败';
		const isRetryable = !!(err?.retryable);
		const isRateLimited = !!(err?.isRateLimited);
		const level: string = err?.level || 'error';

		const icon = append(card, $('span.chat-error-icon'));
		icon.textContent = level === 'warning' ? '⚠️' : '❌';

		const text = append(card, $('span.chat-error-text'));
		text.textContent = isRateLimited ? `速率限制: ${msgText}` : msgText;
		text.style.color = level === 'warning' ? '#fbbf24' : '#f87171';

		if (isRetryable) {
			const retryBtn = append(card, $('button.chat-error-retry-btn'));
			retryBtn.textContent = '重试';
			this._register(addDisposableListener(retryBtn, EventType.CLICK, () => {
				// Re-send the last user message before this error
				const msgIdx = this._messages.findIndex(m => m.id === msg.id);
				if (msgIdx > 0) {
					const prevMsg = this._messages[msgIdx - 1];
					if (prevMsg.role === 'user') {
						this._onSendMessage(prevMsg.content);
					}
				}
			}));
		}
		return card;
	}

protected override _renderUserContent(parent: HTMLElement, content: string): void {
		// Highlight @mentions
		const parts = content.split(/(@[\w\u4e00-\u9fff]+)/g);
		for (const part of parts) {
			if (part.startsWith("@") && part.length > 1) {
				const mention = append(parent, $("span.msg-mention"));
				mention.textContent = part;
			} else {
				append(parent, $("span")).textContent = part;
			}
		}
	}

protected override _appendEditToolbarBtn(
		parent: HTMLElement,
		opt: { title: string; svgPath: string; hasLabel?: boolean; label?: string; cssClass?: string; showChevron?: boolean }
	): HTMLElement {
		const btn = append(parent, $(`button.chat-user-edit-tb-btn${opt.cssClass ? '.' + opt.cssClass : ''}${opt.showChevron ? '.has-label' : ''}`));
		btn.title = opt.title;
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', '12'); svg.setAttribute('height', '12');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', opt.svgPath);
		svg.appendChild(path);
		btn.appendChild(svg);
		if (opt.hasLabel && opt.label) {
			const lbl = append(btn, $("span.chat-user-edit-tb-label"));
			lbl.textContent = opt.label;
		}
		if (opt.showChevron) {
			const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			chevron.setAttribute('width', '10'); chevron.setAttribute('height', '10');
			chevron.setAttribute('viewBox', '0 0 24 24'); chevron.setAttribute('fill', 'none');
			chevron.setAttribute('stroke', 'currentColor'); chevron.setAttribute('stroke-width', '2.5');
			const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			chevronPath.setAttribute('d', 'M6 9l6 6 6-6');
			chevron.appendChild(chevronPath);
			btn.appendChild(chevron);
		}
		return btn;
	}

protected override _svgEditIcon(): SVGElement {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
		const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		p1.setAttribute('d', 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7');
		svg.appendChild(p1);
		const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		p2.setAttribute('d', 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z');
		svg.appendChild(p2);
		return svg;
	}

protected override _svgCopyIcon(): SVGElement {
		if (!AgentChatPanelBase._svgCopyTpl) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
			svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
			svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
			const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
			rect.setAttribute('x', '9'); rect.setAttribute('y', '9'); rect.setAttribute('width', '13'); rect.setAttribute('height', '13'); rect.setAttribute('rx', '2'); rect.setAttribute('ry', '2');
			svg.appendChild(rect);
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
			svg.appendChild(path);
			AgentChatPanelBase._svgCopyTpl = svg;
		}
		return AgentChatPanelBase._svgCopyTpl.cloneNode(true) as SVGElement;
	}

protected override _svgUndoIcon(): SVGElement {
		if (!AgentChatPanelBase._svgUndoTpl) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
			svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
			svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
			const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			poly.setAttribute('points', '1 4 1 10 7 10');
			svg.appendChild(poly);
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', 'M3.51 15a9 9 0 1 0 2.13-9.36L1 10');
			svg.appendChild(path);
			AgentChatPanelBase._svgUndoTpl = svg;
		}
		return AgentChatPanelBase._svgUndoTpl.cloneNode(true) as SVGElement;
	}

protected override _svgFavoriteIcon(): SVGElement {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
		const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		polygon.setAttribute('points', '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2');
		svg.appendChild(polygon);
		return svg;
	}

protected override _svgTerminalLogo(parent: HTMLElement, className: string): SVGElement {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
		// 终端屏幕外框
		const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		rect.setAttribute('x', '2'); rect.setAttribute('y', '4');
		rect.setAttribute('width', '20'); rect.setAttribute('height', '16');
		rect.setAttribute('rx', '2');
		svg.appendChild(rect);
		// `>` 提示符
		const poly1 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		poly1.setAttribute('points', '6 9 10 12 6 15');
		svg.appendChild(poly1);
		// 下划线（光标）
		const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		line.setAttribute('x1', '12'); line.setAttribute('y1', '15');
		line.setAttribute('x2', '17'); line.setAttribute('y2', '15');
		svg.appendChild(line);
		parent.appendChild(svg);
		return svg;
	}

protected override _svgTerminalOpenIcon(parent: HTMLElement, className: string): void {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', className);
		svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
		// 终端方框
		const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		rect.setAttribute('x', '2'); rect.setAttribute('y', '4');
		rect.setAttribute('width', '20'); rect.setAttribute('height', '16');
		rect.setAttribute('rx', '2');
		svg.appendChild(rect);
		// 顶部装饰线
		const top = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		top.setAttribute('d', 'M2 8h20');
		svg.appendChild(top);
		// 播放箭头
		const play = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		play.setAttribute('points', '9.5 12 14 14 9.5 16');
		play.setAttribute('fill', 'currentColor');
		play.setAttribute('stroke', 'none');
		svg.appendChild(play);
		parent.appendChild(svg);
	}

protected override _svgImportKbIcon(): SVGElement {
		if (!AgentChatPanelBase._svgImportKbTpl) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
			svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
			svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
			// 书脊（左侧）：闭合矩形 + 顶部折痕
			const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path1.setAttribute('d', 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20');
			svg.appendChild(path1);
			const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path2.setAttribute('d', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z');
			svg.appendChild(path2);
			// 中央 + 号（添加到知识库）
			const lineV = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			lineV.setAttribute('x1', '12'); lineV.setAttribute('y1', '8'); lineV.setAttribute('x2', '12'); lineV.setAttribute('y2', '14');
			svg.appendChild(lineV);
			const lineH = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			lineH.setAttribute('x1', '9'); lineH.setAttribute('y1', '11'); lineH.setAttribute('x2', '15'); lineH.setAttribute('y2', '11');
			svg.appendChild(lineH);
			AgentChatPanelBase._svgImportKbTpl = svg;
		}
		return AgentChatPanelBase._svgImportKbTpl.cloneNode(true) as SVGElement;
	}

	protected override _svgSkillIcon(): SVGElement {
		if (!AgentChatPanelBase._svgSkillTpl) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
			svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
			svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
			// Star / sparkle icon — 沉淀技能
			const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
			poly.setAttribute('points', '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2');
			svg.appendChild(poly);
			AgentChatPanelBase._svgSkillTpl = svg;
		}
		return AgentChatPanelBase._svgSkillTpl.cloneNode(true) as SVGElement;
	}

protected override _svgCheckSmall(): SVGElement {
		if (!AgentChatPanelBase._svgCheckTpl) {
			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
			svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
			svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
			const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
			poly.setAttribute('points', '20 6 9 17 4 12');
			svg.appendChild(poly);
			AgentChatPanelBase._svgCheckTpl = svg;
		}
		return AgentChatPanelBase._svgCheckTpl.cloneNode(true) as SVGElement;
	}

protected override _createAttachmentChipNode(att: IChatAttachment): HTMLElement {
		const chip = document.createElement('span');
		chip.className = 'inline-attachment-chip';
		chip.dataset.attId = att.id;
		chip.setAttribute('contenteditable', 'false');

		const icon = document.createElement('span');
		icon.className = 'inline-attachment-chip-icon';
		icon.textContent = att.type === 'image' ? '\u{1F4F7}' : '\u{1F4C4}';
		chip.appendChild(icon);

		const label = document.createElement('span');
		label.className = 'inline-attachment-chip-label';
		label.textContent = att.name;
		chip.appendChild(label);

		const removeBtn = document.createElement('span');
		removeBtn.className = 'inline-attachment-chip-remove';
		removeBtn.textContent = '✕';
		chip.appendChild(removeBtn);
		this._register(addDisposableListener(removeBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			e.preventDefault();
		this._attachments = this._attachments.filter(a => a.id !== att.id);
		chip.remove();
		this._hideImageTooltip();
		this._updateSendButton();
		}));

		if (att.type === 'image' && att.data) {
			this._register(addDisposableListener(chip, EventType.CLICK, (e) => {
				if ((e.target as HTMLElement).classList.contains('inline-attachment-chip-remove')) { return; }
				this._showLightbox(`data:${att.mimeType};base64,${att.data}`);
			}));
			// hover 时显示图片缩略图预览
			this._register(addDisposableListener(chip, EventType.MOUSE_ENTER, () => {
				if ((chip.querySelector('.inline-attachment-chip-remove') as HTMLElement)?.matches(':hover')) { return; }
				this._showImageTooltip(att, chip);
			}));
			this._register(addDisposableListener(chip, EventType.MOUSE_LEAVE, () => this._hideImageTooltip()));
		}
		return chip;
	}
}
