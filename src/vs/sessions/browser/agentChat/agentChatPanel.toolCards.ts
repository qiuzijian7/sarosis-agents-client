import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { IAgentChatMessage, IToolCall, IChatAttachment, IPlanTaskCard } from './agentChatTypes.js';
import { AgentChatPanelBase, TOOL_BUILTIN_TITLES, TOOL_TERMINAL_TOOLS, TOOL_LIST_TOOLS, TOOL_CODEBASE_TOOLS, READ_FILE_KEYS, TOOL_PLAN_TOOLS, TOOL_DELEGATE_TOOLS, TOOL_SEARCH_TOOLS, TOOL_WEB_TOOLS, TOOL_SKILL_TOOLS, TOOL_MERMAID_TOOLS } from './agentChatPanel.base.js';

/** 解析 tc.args —— 兼容 string(JSON) / object / undefined 三种形态。 */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
	if (!raw) { return {}; }
	if (typeof raw === 'object') { return raw as Record<string, unknown>; }
	if (typeof raw === 'string') {
		try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
	}
	return {};
}

/** 判断 execute_code 的 args 是否为 anysearch CLI 调用（command 含 anysearch_cli.py）。 */
export function isAnysearchArgs(args: unknown): boolean {
	const parsed = parseToolArgs(args);
	const cmd = typeof parsed.command === 'string' ? parsed.command : '';
	return cmd.includes('anysearch_cli.py');
}

/** 纯函数 HTML 转义，避免 XSS。 */
export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}



/** 临时诊断日志（已关闭，改 noop 避免刷屏）。需要时取消注释 console.warn。 */



// ── 原生 DOM 替代 innerHTML，完全避开 TrustedTypes CSP ──

/** 用 $.SVG 创建 SVG 图标节点（替代 innerHTML SVG） */
export function createSvgIcon(d: string): SVGElement {
	const svg = $.SVG('svg', { width: '14', height: '14', viewBox: '0 0 16 16', fill: 'currentColor' });
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path') as SVGPathElement;
	path.setAttribute('d', d);
	svg.appendChild(path);
	return svg;
}

// read_file 卡片使用的两个 SVG 路径
export const FILE_ICON_D = 'M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-11zM3.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-9zM4 4h8v1H4V4zm0 2.5h8v1H4v-1zm0 2.5h6v1H4V9z';
export const ERROR_ICON_D = 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM7.25 4.5h1.5v5h-1.5v-5zm0 6.5h1.5v1.5h-1.5V11z';
export const SEARCH_ICON_D = 'M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 1 1-1.06 1.06l-3.04-3.04z';

export abstract class AgentChatPanelToolCards extends AgentChatPanelBase {



	protected override _maybeCreateClarifyCard(tc: IToolCall): HTMLElement | null {
		const key = (tc.name || '').toLowerCase();
		if (key !== 'clarify') { return null; }

		// 解析 args
		let parsed: {
			question?: string;
			options?: string[];
			questions?: Array<{ id: string; question: string; options?: string[] }>;
		} = {};
		try {
			parsed = tc.args ? JSON.parse(tc.args) : {};
		} catch {
			return null;
		}

		// 规范化问题列表：questions[] 优先 → 单 question 回退
		type ClarifyField = { id: string; question: string; options?: string[] };
		let fields: ClarifyField[] = [];
		if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
			fields = (parsed.questions as ClarifyField[]).filter(
				f => f && typeof f.question === 'string' && f.question.trim(),
			);
			for (let i = 0; i < fields.length; i++) {
				if (!fields[i].id) { fields[i] = { ...fields[i], id: `q${i}` }; }
			}
		} else if (parsed.question) {
			fields = [{ id: 'q0', question: parsed.question, options: parsed.options }];
		}
		if (fields.length === 0) { return null; }

		const isAnswered = tc.status === 'success' && tc.result && tc.result.length > 0;
		const isPending = !isAnswered;

		const card = $('.clarify-card');
		if (isAnswered) { card.classList.add('answered'); }

		// Header
		const header = append(card, $('.clarify-card-header'));
		const icon = append(header, $('span.codicon.codicon-question'));
		icon.style.color = 'var(--vscode-charts-blue, #60a5fa)';
		icon.style.fontSize = '16px';
		const plural = fields.length > 1;
		const title = append(header, $('span.clarify-card-title', undefined, plural ? '需要澄清' : '需要澄清'));
		title.style.fontWeight = '600';
		title.style.fontSize = '13px';

		// ── Pending: 渲染表单 ─────────────────────────────────
		if (isPending) {
			const selectedIdxs = fields.map(() => -1);
			const customTexts = fields.map(() => '');
			const container = append(card, $('.clarify-fields'));

			// 每个问题渲染为一道 field
			for (let fi = 0; fi < fields.length; fi++) {
				const f = fields[fi];
				const hasOpts = Array.isArray(f.options) && f.options!.length > 0;

				const fieldDiv = append(container, $('.clarify-field'));
				if (fi > 0) { fieldDiv.style.borderTopWidth = '1px'; }

				// 问题标签
				const labelEl = append(fieldDiv, $('.clarify-field-label'));
				if (plural) {
					append(labelEl, $('span.clarify-field-index', undefined, `Q${fi + 1}.`));
				}
				append(labelEl, $('span.clarify-field-question', undefined, f.question));

				// 预设选项
				const optionsDiv = append(fieldDiv, $('.clarify-field-options'));
				const customInputDiv = append(fieldDiv, $('.clarify-custom-input'));

				if (hasOpts) {
					f.options!.forEach((opt, oi) => {
						const optBtn = append(optionsDiv, $('button.clarify-option')) as HTMLButtonElement;
						append(optBtn, $('span.clarify-option-marker.codicon.codicon-circle-outline'));
						append(optBtn, $('span.clarify-option-body'));
						append(optBtn.querySelector('.clarify-option-body')!, $('span.clarify-option-label', undefined, opt));
						this._register(addDisposableListener(optBtn, EventType.CLICK, () => {
							selectedIdxs[fi] = oi;
							customTexts[fi] = '';
							if (customInputDiv) { customInputDiv.style.display = 'none'; }
							const ta = customInputDiv.querySelector('textarea');
							if (ta) { ta.value = ''; }
							_updateFieldSelection(fieldDiv, fi, oi, hasOpts ? f.options!.length : 0);
							_updateSubmitState();
						}));
					});

					// 「其他」
					const customBtn = append(optionsDiv, $('button.clarify-option.clarify-custom-trigger')) as HTMLButtonElement;
					append(customBtn, $('span.clarify-option-marker.codicon.codicon-edit'));
					append(customBtn, $('span.clarify-option-body'));
					append(customBtn.querySelector('.clarify-option-body')!, $('span.clarify-option-label', undefined, '其他（自定义输入）'));
					this._register(addDisposableListener(customBtn, EventType.CLICK, () => {
						selectedIdxs[fi] = -1;
						_updateFieldSelection(fieldDiv, fi, -1, hasOpts ? f.options!.length : 0);
						customInputDiv.style.display = 'flex';
						const ta = customInputDiv.querySelector('textarea') as HTMLTextAreaElement;
						if (ta) { ta.focus(); }
						_updateSubmitState();
					}));
				} else {
					// 无选项 → 直接显示 textarea
					customInputDiv.style.display = 'flex';
				}

				// textarea
				const ta = append(customInputDiv, $('textarea.clarify-textarea')) as HTMLTextAreaElement;
				ta.placeholder = '请输入你的回答…';
				ta.rows = 2;
				this._register(addDisposableListener(ta, EventType.INPUT, () => {
					customTexts[fi] = ta.value.trim();
					_updateSubmitState();
				}));
				this._register(addDisposableListener(ta, EventType.KEY_DOWN, (e: KeyboardEvent) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						if (customTexts[fi].length > 0) { submitBtn.click(); }
					}
				}));
			}

			// ── Actions ───────────────────────────────────
			const actions = append(card, $('.clarify-actions'));
			const hintEl = append(actions, $('span.clarify-hint', undefined,
				fields.length > 1 ? '请回答所有问题' : '请先选择一个选项或输入自定义回答',
			));

			const submitBtn = append(actions, $('button.monaco-button.monaco-text-button.clarify-submit')) as HTMLButtonElement;
			submitBtn.textContent = plural ? '提交全部回答' : '完成';
			submitBtn.disabled = true;

			// ── Helpers ──────────────────────────────────
			function _updateFieldSelection(fieldDiv: HTMLElement, _fi: number, selIdx: number, optCount: number) {
				const opts = fieldDiv.querySelectorAll('.clarify-option');
				opts.forEach((el, j) => {
					el.classList.toggle('selected', j === selIdx);
					const m = el.querySelector('.clarify-option-marker');
					if (m) {
						m.className = 'clarify-option-marker codicon ' +
							(j === selIdx ? 'codicon-check' :
							 j >= optCount ? 'codicon-edit' : 'codicon-circle-outline');
					}
				});
			}
			function _updateSubmitState() {
				const allAnswered = fields.every((_f, i) =>
					selectedIdxs[i] >= 0 || customTexts[i].length > 0,
				);
				submitBtn.disabled = !allAnswered;
				if (allAnswered && hintEl) { hintEl.style.display = 'none'; }
				else if (hintEl) { hintEl.style.display = ''; }
			}

			this._register(addDisposableListener(submitBtn, EventType.CLICK, () => {
				// 构建结果文本
				let result: string;
				if (plural) {
					const parts = fields.map((_f, i) => {
						const ans = selectedIdxs[i] >= 0
							? (Array.isArray(fields[i].options) ? fields[i].options![selectedIdxs[i]] : customTexts[i])
							: customTexts[i];
						return `- Q${i + 1}: ${ans}`;
					});
					result = parts.join('\n');
				} else {
					result = selectedIdxs[0] >= 0
						? (Array.isArray(fields[0].options) ? fields[0].options![selectedIdxs[0]] : customTexts[0])
						: customTexts[0];
				}
				submitBtn.disabled = true;
				submitBtn.textContent = '已完成';
				// 禁用所有交互
				container.querySelectorAll('.clarify-option').forEach(el => {
					(el as HTMLButtonElement).disabled = true;
				});
				container.querySelectorAll('.clarify-textarea').forEach(el => {
					(el as HTMLTextAreaElement).disabled = true;
				});
				if (hintEl) { hintEl.style.display = 'none'; }
				this._onClarifySubmit?.(tc.id, result);
			}));
		}

		// Answered summary
		if (isAnswered) {
			const answerDiv = append(card, $('.clarify-answer'));
			append(answerDiv, $('span.codicon.codicon-check'));
			const textEl = append(answerDiv, $('span.clarify-answer-text'));
			textEl.textContent = tc.result!;
			textEl.style.whiteSpace = 'pre-wrap';
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
			if (tc.id) { clarifyCard.setAttribute('data-tool-id', tc.id); }
			container.appendChild(clarifyCard);
			return;
		}
		const wrapper = this._createToolCallCard(tc);
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }
		container.appendChild(wrapper);
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



protected _createReadFileCard(tc: IToolCall, key: string): HTMLElement {
	throw new Error('[moved-to-feature] _createReadFileCard');
}

protected _createPlanWorkflowCard(tc: IToolCall, key: string): HTMLElement {
	throw new Error('[moved-to-feature] _createPlanWorkflowCard');
}

protected _createDelegateTaskCard(tc: IToolCall, key: string): HTMLElement {
	throw new Error('[moved-to-feature] _createDelegateTaskCard');
}





/**
 * 搜索/查询专用卡片 — 已抽取到 agentChatPanel.searchCard.ts（AgentChatPanelSearchCard）。
 * 保留 stub 供 dispatcher `_createToolCallCard` 调用；运行时由子类 override 提供实现。
 */
protected _createSearchToolCard(tc: IToolCall, key: string): HTMLElement {
	throw new Error('[moved-to-feature] _createSearchToolCard');
}

/**
 * Web 族专用卡片（web_search / web_extract / anysearch）— 已抽取到
 * agentChatPanel.webCard.ts（AgentChatPanelWebCard）。
 * 保留 stub 供 dispatcher `_createToolCallCard` 调用；运行时由子类 override 提供实现。
 */
protected _createWebToolCard(tc: IToolCall, key: string): HTMLElement {
	throw new Error('[moved-to-feature] _createWebToolCard');
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
			// anysearch CLI（execute_code 运行 anysearch_cli.py）→ Web 族卡片
			if (key === 'execute_code' && isAnysearchArgs(tc.args)) {
				return this._createWebToolCard(tc, 'anysearch');
			}
			return this._createTerminalToolCard(tc, key);
		}

		// ── 读取文件：紧凑折叠卡片（单击在编辑器中打开并跳转到指定行）──
		if (READ_FILE_KEYS.has(key)) {
			return this._createReadFileCard(tc, key);
		}

		// ── 计划编排：探索/进入/退出 ──
		if (TOOL_PLAN_TOOLS.has(key)) {
			return this._createPlanWorkflowCard(tc, key);
		}

		// ── 委派/子Agent ──
		if (TOOL_DELEGATE_TOOLS.has(key)) {
			return this._createDelegateTaskCard(tc, key);
		}

		// ── Web 族（web_search 联网搜索 / web_extract 整页抓取：专用 Web 卡片）──
		if (TOOL_WEB_TOOLS.has(key)) {
			return this._createWebToolCard(tc, key);
		}

		// ── 搜索/查询（专用搜索卡片：查询词 + 匹配数 + 结果列表）──
		if (TOOL_SEARCH_TOOLS.has(key)) {
			return this._createSearchToolCard(tc, key);
		}

		// ── 技能族（read_skill / list_skills 等，专用技能卡片）──
		if (TOOL_SKILL_TOOLS.has(key)) {
			return this._createSkillToolCard(tc, key);
		}

		// ── Mermaid 图示（renderMermaidDiagram）──
		if (TOOL_MERMAID_TOOLS.has(key)) {
			return this._createMermaidCard(tc, key);
		}

		// fallback - 通用工具卡片

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
		// 写回记忆表：流式重建/运行结束后续渲染都按此恢复，避免被自动折叠
		if (tc.id && !this._toolCallExpandState.has(tc.id)) {
			this._toolCallExpandState.set(tc.id, expanded);
		}
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
						// 统一搜索卡片：search bar + options + results
						const items = this._parseToolListItems(resultText);
						const isSearch = key.includes('search') || key === 'grep' ||
							key.includes('query') || key.includes('trace') || key.includes('architecture') ||
							key.includes('schema') || key.includes('snippet') || key.includes('index') ||
							key.includes('code');

						// ── Search bar（搜索类）──
						if (isSearch) {
							const searchBar = append(container, $('.chat-search-bar'));
							const iconSpan = append(searchBar, $('span.chat-search-bar-icon'));
							iconSpan.appendChild(createSvgIcon(SEARCH_ICON_D));
							const querySpan = append(searchBar, $('span.chat-search-query'));
							querySpan.textContent = escapeHtml(tc.args ? this._extractSearchQuery(tc.args) : '') || '…';
							const optsRow = append(container, $('.chat-search-options'));
							optsRow.textContent = tc.args ? this._extractSearchOptions(tc.args) : '';
						}

						const MAX_RESULT_ITEMS = 200;
						if (items && items.length > 0) {
							const list = append(container, $('.chat-search-results'));

							// 事件委托：仅绑定一次到 list 容器
							this._register(addDisposableListener(list, EventType.CLICK, (e: MouseEvent) => {
								const row = (e.target as HTMLElement).closest('.chat-search-result-item') as HTMLElement | null;
								if (row?.dataset['fp']) {
									e.stopPropagation();
									this._onOpenFile?.(row.dataset['fp']);
								}
							}));

							// 批量构建 HTML，一次性插入（用 createElement + appendChild，避免 innerHTML 重建整棵树）
							const fragment = document.createDocumentFragment();
							let count = 0;
							for (const it of items) {
								if (count++ >= MAX_RESULT_ITEMS) { break; }
								const row = document.createElement('div');
								row.className = 'chat-search-result-item';

								if (isSearch) {
									if (it.line) {
										const lineSpan = append(row, $('span.chat-search-result-line'));
										lineSpan.textContent = `L${it.line}`;
									}
									const contentSpan = append(row, $('span.chat-search-result-content'));
									contentSpan.textContent = it.name ?? '';
								} else {
									const isDir = it.name.endsWith('/') || it.type === 'dir' || it.type === 'directory';
									const contentSpan = append(row, $('span.chat-search-result-content'));
									contentSpan.textContent = (isDir ? '📁 ' : '📄 ') + (it.name ?? '');
								}
								if (it.path) {
									row.dataset['fp'] = String(it.path);
									const fileEl = document.createElement('span');
									fileEl.className = 'chat-search-result-file';
									fileEl.textContent = it.path;
									row.appendChild(fileEl);
								}
								fragment.appendChild(row);
							}
							list.appendChild(fragment);

							// Footer
							const footer = append(container, $('.chat-search-result-footer'));
							const total = items.length;
							const shown = Math.min(count, MAX_RESULT_ITEMS);
							footer.textContent = `${shown}${shown < total ? ` / ${total}` : ''} 命中`;
							if (tc.args) {
								const patSpan = document.createElement('span');
								patSpan.style.cssText = 'font-family:var(--monaco-monospace-font);font-size:10px;opacity:0.7;';
								patSpan.textContent = this._extractSearchQuery(tc.args);
								footer.appendChild(patSpan);
							}
						} else {
							const empty = append(container, $('.chat-search-empty'));
							empty.textContent = '∅ 没有找到匹配项';
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



	protected _createSkillToolCard(tc: IToolCall, key: string): HTMLElement {
	throw new Error('[moved-to-feature] _createSkillToolCard');
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

/**
 * Mermaid 图示工具卡片 — 已抽取到 agentChatPanel.mermaidCard.ts（AgentChatPanelMermaidCard）。
 * 保留 stub 供 dispatcher `_createToolCallCard` 调用；运行时由子类 override 提供实现。
 */
protected _createMermaidCard(tc: IToolCall, key: string): HTMLElement {
	throw new Error('[moved-to-feature] _createMermaidCard');
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

protected override _parseToolListItems(resultText: string): Array<{ name: string; path?: string; line?: number | string; type?: string }> | null {
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
			const mapped: Array<{ name: string; path?: string; line?: number | string; type?: string }> = [];
			for (const it of arr) {
				if (typeof it === 'string') { mapped.push({ name: basename(it), path: it }); continue; }
				if (!it || typeof it !== 'object') { continue; }
				const anyIt = it as Record<string, unknown>;
				const path = (anyIt.path || anyIt.uri || anyIt.fsPath || anyIt.file || '') as string;
				const line = (anyIt.line ?? anyIt.line_number ?? anyIt.lineNumber) as (string | number | undefined);
				const type = anyIt.type as string | undefined;
				const nameRaw = (anyIt.name || anyIt.content || anyIt.text) as string | undefined;
				if (!path && !nameRaw) { continue; }
				const name = (nameRaw || basename(path)) as string;
				if (!name) { continue; }
				const isDir = anyIt.isDirectory === true || anyIt.item_type === 'directory' || type === 'directory' || type === 'dir';
				mapped.push({
					name: `${name}${isDir && !String(name).endsWith('/') ? '/' : ''}`,
					path: path || undefined,
					line: line,
					type: type,
				});
			}
			return mapped.length > 0 ? mapped : null;
		} catch {
			const lines = resultText.split('\n').map(l => l.trim()).filter(Boolean);
			return lines.length > 0 ? lines.map(l => ({ name: l })) : null;
		}
	}

	/** 从工具参数中提取搜索查询字符串（用于 search bar 显示） */
	private _extractSearchQuery(args: string): string {
		try {
			const p = JSON.parse(args);
			return (p.query || p.pattern || p.search || p.search_query || '').toString();
		} catch {
			return '';
		}
	}

	/** 从工具参数中提取搜索选项文本 */
	private _extractSearchOptions(args: string): string {
		try {
			const p = JSON.parse(args);
			const parts: string[] = [];
			if (p.regex || p.use_regex) { parts.push('regex ON'); }
			if (p.glob || p.pattern_glob || p.file_pattern) { parts.push(`glob ${p.glob || p.pattern_glob || p.file_pattern}`); }
			if (p.caseSensitive || p.case_sensitive) { parts.push('case sensitive'); }
			if (p.context !== undefined) { parts.push(`context ${p.context}`); }
			return parts.join(' · ') || '';
		} catch {
			return '';
		}
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



















protected _createPlanTasksCard(planTasks: IPlanTaskCard): HTMLElement {
		const card = $('.plan-tasks-card');
		const tasks = planTasks.tasks || [];

		// Header
		const header = append(card, $('.plan-tasks-header'));
		append(header, $('span.plan-tasks-icon', undefined, '📋'));
		append(header, $('span.plan-tasks-title', undefined, '执行计划'));
		append(header, $('span.plan-tasks-count', undefined, `${tasks.length} 个任务`));

		// Summary
		if (planTasks.summary) {
			append(card, $('.plan-tasks-summary', undefined, planTasks.summary));
		}

		// Task list
		const list = append(card, $('.plan-tasks-list'));
		tasks.forEach((task, idx) => {
			const item = append(list, $('.plan-tasks-item'));

			const titleRow = append(item, $('.plan-tasks-item-title-row'));
			append(titleRow, $('span.plan-tasks-item-index', undefined, `${idx + 1}`));
			append(titleRow, $('span.plan-tasks-item-title', undefined, task.title));
			if (task.complexity) {
				append(titleRow, $(`span.plan-tasks-badge.complexity-${task.complexity}`, undefined, task.complexity));
			}

			if (task.description) {
				append(item, $('.plan-tasks-item-desc', undefined, task.description));
			}

			const metaRow = append(item, $('.plan-tasks-item-meta'));
			if (task.deliverable) {
				append(metaRow, $('span.plan-tasks-meta-chip', undefined, `🎯 ${task.deliverable}`));
			}
			if (task.files && task.files.length > 0) {
				append(metaRow, $('span.plan-tasks-meta-chip', undefined, `📁 ${task.files.join(', ')}`));
			}
			if (task.dependencies && task.dependencies.length > 0) {
				append(metaRow, $('span.plan-tasks-meta-chip', undefined, `⛓ 依赖: ${task.dependencies.join(', ')}`));
			} else {
				append(metaRow, $('span.plan-tasks-meta-chip.parallel', undefined, '⚡ 可并行'));
			}
		});

		return card;
	}

	









protected override _renderUserContent(parent: HTMLElement, content: string): void {
		// 解析内联 skill 标记（/skill <id>）→ 只读 pill；其余文本高亮 @mentions
		const segments = content.split(/(\/skill\s+[\w-]+)/g);
		for (const seg of segments) {
			const skillMatch = seg.match(/^\/skill\s+([\w-]+)$/);
			if (skillMatch) {
				const id = skillMatch[1];
				const name = this._onListSkills().find(s => s.id === id)?.name || id;
				const chip = append(parent, $('span.bubble-skill-chip'));
				const icon = append(chip, $('span.bubble-skill-chip-icon'));
				icon.textContent = '⚡';
				const label = append(chip, $('span.bubble-skill-chip-name'));
				label.textContent = name;
				chip.title = `技能: ${name} (${id})`;
				continue;
			}
			const parts = seg.split(/(@[\w\u4e00-\u9fff]+)/g);
			for (const part of parts) {
				if (part.startsWith("@") && part.length > 1) {
					const mention = append(parent, $("span.msg-mention"));
					mention.textContent = part;
				} else {
					append(parent, $("span")).textContent = part;
				}
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
		// mousedown 时阻止默认选中：chip 现为 user-select:all，避免点 ✕ 先触发整片选中
		this._register(addDisposableListener(removeBtn, EventType.MOUSE_DOWN, (e) => {
			e.preventDefault();
			e.stopPropagation();
		}));
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

// ── 纯函数工具（由 subAgentCardUtils.ts 导入 + 重新导出）────────────────
// 避免在 toolCards.ts 中定义纯函数导致的浏览器端依赖泄露（window / dom），
// 使单测可直接 import subAgentCardUtils.ts 而无需 browser global。
// 注意：export { } from 会 re-export 但不创建 local binding → 类内引用
// 仍需明确的 import 语句。
import { formatSubAgentId, formatSubAgentTask, filterChildSubAgents, countSubAgentStatuses, cleanTracePreview } from './subAgentCardUtils.js';
export { formatSubAgentId, formatSubAgentTask, filterChildSubAgents, countSubAgentStatuses, cleanTracePreview };
