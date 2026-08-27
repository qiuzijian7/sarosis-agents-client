import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { IAgentChatMessage, IToolCall, IChatAttachment, IPlanTaskCard, IConfirmationData } from './agentChatTypes.js';
import { AgentChatPanelBase, TOOL_BUILTIN_TITLES, TOOL_TERMINAL_TOOLS, TOOL_LIST_TOOLS, TOOL_CODEBASE_TOOLS, READ_FILE_KEYS, TOOL_PLAN_TOOLS, TOOL_DELEGATE_TOOLS, TOOL_SEARCH_TOOLS, TOOL_WEB_TOOLS, TOOL_SKILL_TOOLS, TOOL_MERMAID_TOOLS } from './agentChatPanel.base.js';
import { parseInlineWorkflowArgs } from './agentChatPanel.workflowChip.js';
import { parseToolArgsLoose } from './toolArgsJson.js';

/**
 * 解析 tc.args —— 兼容 string(JSON) / object / undefined 三种形态。
 *
 * 2026-08-21：原实现是裸 `JSON.parse` + `catch → {}`，任何 JSON 非法转义
 * （实测模型把制表符写成 `\x09`）都会让整个参数对象退化成 `{}` → 卡片渲染
 * 空白（详见 `toolArgsJson.ts` 头部注释）。现委托到宽松修复链。
 */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
	return parseToolArgsLoose(raw);
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

		// 解析 args（首选）。clarify 工具的协议定义（coreTools.ts）输出
		// `JSON.stringify({ __clarify__: true, question, options })` 到 tool result，
		// 但部分 LLM 会把 __clarify__ JSON 直接写在 args 里或漏写 args 仅写在
		// result text 中；这里三层兜底解析：args JSON → result JSON（当 result
		// 本身就是 __clarify__ JSON）→ 直接显示 question 字段。
		let parsed: {
			question?: string;
			options?: string[];
			questions?: Array<{ id: string; question: string; options?: string[] }>;
		} = {};
		parsed = parseToolArgs(tc.args) as typeof parsed;
		// ── __clarify__ payload 提取器（2026-08-21 修复数组形态）──────────────
		// tc.result 在 UI 层的实际形态是 agentOS 协议外壳的 JSON 字符串：
		//   `[{"type":"text","text":"{\"__clarify__\":true,\"questions\":[...]}"}]`
		// 上一版只处理了「单对象 {type:'text',text:...}」和「裸对象」，**漏了数组**
		// → `parsed.text` 为 undefined、`inner` 退化成数组、`inner.__clarify__`
		// 恒为 undefined → 检测失效（日志 1787299339336 + 用户截图：卡片仍显示
		// 整段 JSON 字面量且带绿色对勾=误判 answered）。
		// 现改为先用 `_normalizeToolResultText` 剥掉协议外壳（它已覆盖
		// string / [{type:'text'}] / {content:[...]} / {__truncated__} 全部形态，
		// 见 agentChatPanel.messages.ts:1740），再解析内层 JSON。
		const extractClarifyPayload = (raw: unknown): {
			question?: string;
			options?: string[];
			questions?: Array<{ id: string; question: string; options?: string[] }>;
		} | null => {
			if (raw === undefined || raw === null || raw === '') { return null; }
			// 逐层剥壳：normalize 后可能仍是 JSON 字符串（双重 stringify），最多两轮
			let text = this._normalizeToolResultText(raw);
			for (let depth = 0; depth < 3; depth++) {
				let obj: any;
				try { obj = JSON.parse(text); } catch { return null; }
				if (obj && obj.__clarify__ === true) {
					return {
						question: typeof obj.question === 'string' ? obj.question : undefined,
						options: Array.isArray(obj.options) ? obj.options : undefined,
						questions: Array.isArray(obj.questions) ? obj.questions : undefined,
					};
				}
				// 单对象外壳 {type:'text', text:'...'}：_normalizeToolResultText 对它会走
				// JSON.stringify 分支（不解包），这里直接取 .text 再剥一层。
				if (obj && obj.type === 'text' && typeof obj.text === 'string') {
					if (obj.text === text) { return null; }
					text = obj.text;
					continue;
				}
				// 仍是外壳（数组 / {content:[...]} / {__truncated__}）→ 再剥一层
				const next = this._normalizeToolResultText(obj);
				if (next === text) { return null; }
				text = next;
			}
			return null;
		};
		// 兜底：args 解析后无 question/questions 时，从 tc.result 提取 __clarify__ payload
		if (!parsed.question && !Array.isArray(parsed.questions) && tc.result) {
			const fromResult = extractClarifyPayload(tc.result);
			if (fromResult) { parsed = fromResult; }
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

		// ── 关键修复（2026-08-21）：识别「clarify 工具自身输出」不算已回答 ──
		// `clarify` 工具 handler（coreTools.ts:472-502）返回
		// `[{type:"text", text: JSON.stringify({__clarify__:true, questions:[...]})}]`，
		// 经普通工具流水线写入 narrative 后 tc.status 也会被设为 'success'。
		// 但语义上这是「问题已渲染、等用户回答」，不是「已回答」。若按
		// `isAnswered = status==='success' && result.length>0` 判定，会走 answered
		// 分支把整段 __clarify__ JSON 当文本塞进卡片（用户截图现象）。
		// 修复：result 若能提取出 __clarify__ payload → 强制走 pending 分支渲染表单。
		// 真正「已回答」由用户提交后 _onClarifySubmit 写回的答案文本触发（不含 __clarify__）。
		const hasClarifyPayload = extractClarifyPayload(tc.result) !== null;
		const isAnswered = tc.status === 'success' && tc.result && tc.result.length > 0 && !hasClarifyPayload;
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
			// 剥掉 agentOS 协议外壳，避免答案区显示 [{"type":"text",...}] 字面量
			textEl.textContent = this._normalizeToolResultText(tc.result!);
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
		const wrapper = this._createToolCallCard(tc, this._getToolConfirmation(msg, tc.id));
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

/**
 * 工具卡片 dispatcher（对外唯一入口）。
 *
 * 在各专用卡片之上统一挂载「审批区」：任何工具（terminal / write_file / 通用…）
 * 处于 `tc.approval.status === 'pending'` 时，都在卡片底部渲染
 * 「允许本次 / 始终允许 / 拒绝 / 始终拒绝」+ 倒计时。
 * 之前审批 UI 只存在于 message.confirmation 路径且只覆盖写文件卡，
 * 于是 terminal 审批时卡片里什么按钮都没有（本次修复的直接现象）。
 */
protected override _createToolCallCard(tc: IToolCall, confirmation?: IConfirmationData): HTMLElement {
	const card = this._createToolCallCardCore(tc, confirmation);
	this._appendToolApprovalSection(card, tc);
	return card;
}

/**
 * 卡内审批区：说明 + 倒计时 + 决策按钮。
 * 决策经 `_onConfirmationAction(tc.approval.id, buttonId)` →
 * `agentStudio.confirmationAction` 命令 → agentOSService.resolveToolApproval。
 */
protected _appendToolApprovalSection(wrapper: HTMLElement, tc: IToolCall): void {
	const approval = tc.approval;
	if (!approval) { return; }

	const section = append(wrapper, $('.tool-approval-section'));
	const head = append(section, $('.tool-approval-head'));
	append(head, $('span.tool-approval-badge')).textContent =
		approval.securityLevel === 'dangerous' ? '需要授权' : '需要确认';
	append(head, $('span.tool-approval-tool')).textContent = approval.toolName || tc.name || '';

	if (approval.status !== 'pending') {
		const doneText =
			approval.status === 'approved' ? '已允许执行'
				: approval.status === 'timeout' ? '等待超时 — 已拒绝并终止本次回答'
					: approval.status === 'cancelled' ? '已取消（本轮已结束）'
						: '已拒绝执行';
		const doneEl = append(section, $('.tool-approval-result'));
		doneEl.textContent = doneText;
		if (approval.status !== 'approved') { doneEl.classList.add('tool-approval-result-deny'); }
		return;
	}

	append(section, $('p.tool-approval-message')).textContent =
		approval.reason || `工具「${approval.toolName}」需要你的授权才能执行。`;

	// ── 倒计时（由面板级单一 ticker 统一刷新，避免每卡一个 interval 泄漏）──
	if (typeof approval.deadline === 'number') {
		const cd = append(section, $('span.tool-approval-countdown'));
		cd.setAttribute('data-approval-deadline', String(approval.deadline));
		this._renderApprovalCountdownText(cd, approval.deadline);
		this._ensureApprovalCountdownTicker();
	}

	const actions = append(section, $('.tool-approval-actions'));
	const buttons: Array<{ id: string; label: string; cls: string; title: string }> = [
		{ id: 'allow_once', label: '允许本次', cls: '.primary', title: '仅允许这一次执行' },
		{ id: 'allow_always', label: '始终允许', cls: '', title: '本次会话内不再询问该工具' },
		{ id: 'deny', label: '拒绝', cls: '.danger', title: '拒绝执行（工具将返回被拒结果）' },
		{ id: 'deny_always', label: '始终拒绝', cls: '.danger', title: '本次会话内不再询问该工具，且一律拒绝' },
	];
	for (const b of buttons) {
		const el = append(actions, $(`button.tool-approval-btn${b.cls}`, undefined, b.label)) as HTMLButtonElement;
		el.title = b.title;
		this._register(addDisposableListener(el, EventType.CLICK, (e) => {
			e.stopPropagation();
			// 本地立即锁定，防重复点击（真实状态由 onDidResolveToolApproval 回写）
			for (const sibling of Array.from(actions.querySelectorAll('button'))) {
				(sibling as HTMLButtonElement).disabled = true;
			}
			el.textContent = `${b.label} ✓`;
			this._onConfirmationAction?.(approval.id, b.id);
		}));
	}
}

/** 倒计时文本（剩余秒数 / 已超时）。 */
private _renderApprovalCountdownText(el: HTMLElement, deadline: number): boolean {
	const remainMs = deadline - Date.now();
	if (remainMs <= 0) {
		el.textContent = '等待超时';
		el.classList.add('tool-approval-countdown-expired');
		return false;
	}
	const total = Math.ceil(remainMs / 1000);
	const mm = Math.floor(total / 60);
	const ss = total % 60;
	el.textContent = mm > 0 ? `剩余 ${mm}:${String(ss).padStart(2, '0')}` : `剩余 ${ss} 秒`;
	el.classList.toggle('tool-approval-countdown-urgent', total <= 20);
	return true;
}

/**
 * 面板级唯一倒计时 ticker：每秒扫描 DOM 中所有
 * `[data-approval-deadline]` 节点刷新文本；没有待审批节点时自动停表。
 * （不用每卡 setInterval —— 工具卡在流式期间会被反复重建，per-card 定时器必漏。）
 */
private _approvalCountdownTimer: ReturnType<typeof setInterval> | undefined;

private _ensureApprovalCountdownTicker(): void {
	if (this._approvalCountdownTimer !== undefined) { return; }
	this._approvalCountdownTimer = setInterval(() => {
		const nodes = this._messagesContainer?.querySelectorAll('[data-approval-deadline]');
		if (!nodes || nodes.length === 0) {
			this._stopApprovalCountdownTicker();
			return;
		}
		for (const node of Array.from(nodes)) {
			const deadline = Number(node.getAttribute('data-approval-deadline'));
			if (!Number.isFinite(deadline)) { continue; }
			this._renderApprovalCountdownText(node as HTMLElement, deadline);
		}
	}, 1000);
	// 面板销毁时必须停表（renderer 不会自己回收 interval）
	this._register({ dispose: () => this._stopApprovalCountdownTicker() });
}

private _stopApprovalCountdownTicker(): void {
	if (this._approvalCountdownTimer !== undefined) {
		clearInterval(this._approvalCountdownTimer);
		this._approvalCountdownTimer = undefined;
	}
}

private _createToolCallCardCore(tc: IToolCall, confirmation?: IConfirmationData): HTMLElement {
		const key = (tc.name || '').toLowerCase();

		// ── update_plan: 专用计划卡片 ──
		if (key === 'update_plan') {
			return this._createPlanCard(tc);
		}

		// ── 写文件/编辑文件：diff 风格专用卡片（默认折叠）──
		if (AgentChatPanelBase.WRITE_FILE_TOOL_KEYS.has(key)) {
			return this._createWriteFileToolCard(tc, key, confirmation);
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

		// 注意：approval_required 状态的审批按钮由 _appendToolApprovalSection 统一渲染
		//（_createToolCallCard → _createToolCallCardCore + _appendToolApprovalSection 两步组合）。
		// 此处不再内联渲染，避免与 _appendToolApprovalSection 出现重复按钮（2026-08-22 修复）。

		// ── 拒绝通知（rejected 状态）──
		if (isRejected) {
			const rejectedNotice = append(wrapper, $('.tool-rejected-notice'));
			rejectedNotice.textContent = '用户已拒绝此工具调用';
		}

		// ── 实时进度条（workflow 直接执行 / ComfyUI 生成等长耗时工具卡）──
		// 仅在 running 且 tc.progress 存在时渲染；由 _updateToolCardStatuses 增量更新
		// （不重建整卡），避免 100ms 级进度刷新触发全量重渲染。
		if (isRunning && typeof tc.progress === 'number') {
			const progRow = append(wrapper, $('.tool-progress-row'));
			progRow.setAttribute('data-progress', '1');
			const bar = append(progRow, $('.tool-progress-bar'));
			const fill = append(bar, $('.tool-progress-fill')) as HTMLElement;
			fill.style.width = `${Math.min(100, Math.max(0, tc.progress))}%`;
			const label = append(progRow, $('span.tool-progress-text'));
			label.textContent = tc.progressText ?? `${Math.round(tc.progress)}%`;
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
		// 2026-08-21：原实现两处裸 `JSON.parse(tc.args!)` —— 参数含非法转义时
		// ① hasArgs 判定为 false（整个「请求参数」区块消失）② buildContent 内直接
		// 抛异常（可能中断整张卡片渲染）。现统一走宽松修复链，且彻底解析失败时
		// 回退展示原始字符串（保留可排查性）。
		const parsedArgsForDisplay = parseToolArgs(tc.args);
		const hasParsedArgs = Object.keys(parsedArgsForDisplay).length > 0;
		const rawArgsText = typeof tc.args === 'string' ? tc.args.trim() : '';
		const hasArgs = hasParsedArgs || (!!rawArgsText && rawArgsText !== '{}');

		if (hasArgs) {
			this._appendToolSection(innerBox, {
				// ★ workflow 卡片的 args 是 { name, script }：脚本单独用可读代码块展示，
				//   而非整段 JSON 转储（\n 转义后不可读）；其余工具保持「请求参数」JSON。
				label: key === 'workflow' ? '工作流脚本' : '请求参数',
				icon: 'content',
				collapsed: false,
				buildContent: (container) => {
					const fallbackText = hasParsedArgs ? JSON.stringify(parsedArgsForDisplay, null, 2) : rawArgsText;
					let text: string;
					if (key === 'workflow') {
						const script = typeof parsedArgsForDisplay.script === 'string' ? parsedArgsForDisplay.script : '';
						text = script || fallbackText;
					} else {
						text = fallbackText;
					}
					const code = append(container, $('.tool-code-children'));
					const sel = append(code, $('.tool-code-children-selectable'));
					append(sel, $('pre')).textContent = text;
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
					// 2026-08-09：通用工具 result 归一化。codebaseTools/coreTools 的 `json()` helper
					// 返回 `[{type:'text', text:'...'}]` 数组，经 agentOSService 的
					// safeStringifyToolResult + JSON.parse 后 tc.result 仍是 array。
					// 通用 else 分支直接 set textContent=array 会得到 [object Object] 或空白。
					// 与 delegateCards.ts:113-119 一致地解包。
					const normalized = this._normalizeToolResultText(resultText);
					// 增强渲染
					const enhanced = this._maybeCreateEnhancedResult(key, normalized);
					if (enhanced) {
						container.appendChild(enhanced);
					} else if (TOOL_TERMINAL_TOOLS.has(key)) {
						const term = append(container, $('.tool-children-terminal'));
						const codeBox = append(term, $('.tool-terminal-code'));
						append(codeBox, $('pre')).textContent = normalized;
						if (typeof tc.exitCode === 'number') {
							const ec = append(term, $(`.tool-exit-code.${tc.exitCode === 0 ? 'tool-exit-code-zero' : 'tool-exit-code-nonzero'}`));
							ec.textContent = `exit code ${tc.exitCode}`;
						}
					} else if (TOOL_LIST_TOOLS.has(key)) {
						// 统一搜索卡片：search bar + options + results
						const items = this._parseToolListItems(normalized);
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
						append(sel, $('pre')).textContent = normalized;
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
		const p = parseToolArgs(args);
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
		if (key === 'workflow') {
			// workflow 卡片：title 已显示「正在执行工作流」，desc 展示工作流名 + 脚本规模
			//（不再是重复的 name，也避免把整段 script 塞进 60 字符 clip 造成噪音）。
			const wfName = (p.name as string | undefined) || (p.workflowName as string | undefined) || '';
			const script = (p.script as string | undefined) ?? '';
			const lines = typeof script === 'string' ? script.split('\n').length : 0;
			const stat = lines > 0 ? `${lines} 行脚本` : '';
			return [wfName, stat].filter(Boolean).join(' · ') || '';
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
	// 解析内联 skill / workflow 标记（/skill <id>、/workflow <id> --k=v）→ 只读 pill；其余文本高亮 @mentions
	const segments = content.split(/(\/skill\s+[\w-]+|\/workflow\s+wf-[\w-]+)/g);
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const wfMatch = seg.match(/^\/workflow\s+(wf-[\w-]+)$/);
		if (wfMatch) {
			const id = wfMatch[1];
			const name = this._onListWorkflows?.().find(w => w.id === id)?.name || id;
			// 消费 mark 之后紧跟的 `--k=v` 参数（序列化格式 `/workflow <id> --k=v input`）
			let params: Record<string, string> | undefined;
			if (i + 1 < segments.length) {
				const parsed = parseInlineWorkflowArgs(segments[i + 1]);
				if (Object.keys(parsed.variables).length > 0) {
					params = parsed.variables;
					segments[i + 1] = parsed.input; // 剩余文本作为 input 保留
				}
			}
			const chip = append(parent, $('span.bubble-workflow-chip'));
			const icon = append(chip, $('span.bubble-workflow-chip-icon'));
			icon.textContent = '▶';
			const label = append(chip, $('span.bubble-workflow-chip-name'));
			label.textContent = name;
			if (params && Object.keys(params).length > 0) {
				const badge = append(chip, $('span.bubble-workflow-chip-badge'));
				badge.textContent = `· ${Object.keys(params).length} 参数`;
				chip.title = `工作流: ${name} (${id})\n` + Object.entries(params).map(([k, v]) => `${k}=${v}`).join('\n');
			} else {
				chip.title = `工作流: ${name} (${id})`;
			}
			continue;
		}
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
		icon.textContent = att.type === 'image' ? '\u{1F4F7}' : att.type === 'folder' ? '\u{1F4C1}' : '\u{1F4C4}';
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

		// 点击 chip：有系统路径的资源在文件编辑器中打开；图片（含无路径的粘贴图）
		// 回退到 lightbox；文件夹除外（无对应资源可打开）。
		if (att.type !== 'folder') {
			this._register(addDisposableListener(chip, EventType.CLICK, (e) => {
				if ((e.target as HTMLElement).classList.contains('inline-attachment-chip-remove')) { return; }
				if (att.filePath && this._onOpenFile) {
					this._onOpenFile(att.filePath);
				} else if (att.type === 'image' && att.data) {
					this._showLightbox(`data:${att.mimeType};base64,${att.data}`);
				}
			}));
		}
		if (att.type === 'image' && att.data) {
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
