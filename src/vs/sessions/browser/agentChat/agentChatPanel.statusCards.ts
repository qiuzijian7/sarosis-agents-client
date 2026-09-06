import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { IAgentChatMessage, ITodoItem, ISuggestedQuestion, IReferenceItem, ITipMessage, IProgressMessage } from './agentChatTypes.js';
import { AgentChatPanelWorkflowCards } from './agentChatPanel.workflowCards.js';

/** 自 agentChatPanel.toolCards.ts 抽离（上帝对象拆分）。继承链见继承父类。 */
export abstract class AgentChatPanelStatusCards extends AgentChatPanelWorkflowCards {
	protected override _createThinkingCard(msg: IAgentChatMessage): HTMLElement {
		// P-T2：折叠状态挂 panel Map（msgId → collapsed），rebuild 后保留用户选择。
		// 2026-07-26 对齐 void ReasoningWrapper：思考中默认展开（流式可见、
		// 滚动吸底），完成后默认折叠但卡片保留（不移除）；用户手动切换优先。
		const collapsed = this._thinkingCardState.get(msg.id) ?? !msg.isThinking;
			const card = $(`.thinking-card${msg.isThinking ? ".active" : ""}`);
			// 记录 episode id（形如 `<msgId>#tk<idx>`），供思考结束时按 id 查
			// 用户是否手动切换过折叠状态（见 _autoCollapseThinkingCard）。
			card.dataset.thinkId = msg.id;

			// Header
			const header = $(".thinking-card-header");
			append(card, header);
			const icon = append(header, $("span.thinking-card-icon"));
			this._renderThinkingCardIcon(icon, msg.isThinking);
			append(
				header,
				$(
					"span.thinking-card-title",
					undefined,
					msg.isThinking ? "思考中..." : "思考过程",
				),
			);
			const toggle = append(header, $(`span.thinking-card-toggle${collapsed ? ".collapsed" : ""}`));
			toggle.textContent = "▼";

			// Body（P-T4 懒渲染：折叠时不渲染 markdown，首次展开才渲染——
			// 流式期间 rebuild 不再为不可见内容浪费渲染）
			const body = $(".thinking-card-body");
			append(card, body);
			if (!collapsed) {
				this._renderThinkingCardBody(body, msg);
			} else {
				body.dataset.rendered = '0';
			}
			body.style.display = collapsed ? "none" : "block";

			// Toggle click
			this._register(
				addDisposableListener(header, EventType.CLICK, () => {
					// 以 body 的**实际可见性**取反，而非 Map 默认值：
					// 思考中的卡片按设计默认展开，但 Map 里并无记录，旧的
					// `_thinkingCardState.get(msg.id) ?? true` 会算出 nowCollapsed=false
					// ——首次点击折不起来，还会把「展开」误写进 _thinkingCardState，
					// 使 _autoCollapseThinkingCard 误判"用户已选择"而跳过自动折叠。
					const nowCollapsed = body.style.display !== 'none';
					this._thinkingCardState.set(msg.id, nowCollapsed);
					body.style.display = nowCollapsed ? "none" : "block";
					toggle.classList.toggle("collapsed", nowCollapsed);
					// 首次展开时按最新 msg.thinking 渲染（懒渲染补渲染）
					if (!nowCollapsed && body.dataset.rendered !== '1') {
						this._renderThinkingCardBody(body, msg);
					}
				}),
			);

			return card;
		}

	/** 渲染 thinking 卡片图标（isThinking → spinner；否则完成态 ...）。 */
	protected _renderThinkingCardIcon(icon: HTMLElement, isThinking: boolean | undefined): void {
			icon.replaceChildren();
			if (isThinking) {
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
		}

	/** 渲染 thinking 卡片 body（markdown），并标记 rendered='1'（懒渲染完成态）。
	 *  幂等：先清空（_renderMarkdownContent 为 append 语义），可重复调用。 */
	protected _renderThinkingCardBody(body: HTMLElement, msg: IAgentChatMessage): void {
		const _tBefore = (body.textContent || '').length;
		body.textContent = '';
		if (msg.thinking) {
			this._renderMarkdownContent(body, msg.thinking);
		} else {
			body.textContent = msg.isThinking ? "正在思考..." : "";
		}
		body.dataset.rendered = '1';
		// 同步调度器基线：body 已是当前文本的渲染态——后续 schedule 跳过首次
		// renderFull（append 语义，直接调会让内容翻倍），flush 走增量路径。
		this.thinkingMdScheduler.markRendered(body, msg.thinking ?? '');
		// 2026-07-26 用户要求：thinking 过程中 body 滚动条保持吸底
		body.scrollTop = body.scrollHeight;
		// ★ 诊断埋点 #4（2026-09-06）：同步渲染执行证据——渲染前后 body 长度对比。
		const _tAfter = (body.textContent || '').length;
		const _dg = msg as any;
		if ((msg.thinking || '').length - (_dg._dgCard ?? -1) >= 400) {
			_dg._dgCard = (msg.thinking || '').length;
			this._logService.info(`[ThinkingDiag] renderCard target=${(msg.thinking || '').length} before=${_tBefore} after=${_tAfter} connected=${body.isConnected} v4`);
		}
	}

	/** P-T1：就地更新 thinking 卡片 header（active/icon/title），不重建卡片。
	 *  @param isThinking 该卡片自身是否处于「正在思考」活跃态（仅最后一个仍在流式的
	 *         episode 为 true），切勿传 message 级 isThinking，否则多卡时所有卡都会被
	 *         误标为「思考中...」。 */
	protected _updateThinkingCardHeader(card: HTMLElement, isThinking: boolean): void {
		card.classList.toggle('active', !!isThinking);
		const icon = card.querySelector('.thinking-card-icon') as HTMLElement | null;
		if (icon) { this._renderThinkingCardIcon(icon, isThinking); }
		const title = card.querySelector('.thinking-card-title');
		if (title) { title.textContent = isThinking ? '思考中...' : '思考过程'; }
		// 思考结束（isThinking: true → false）时自动折叠，见 _autoCollapseThinkingCard。
		if (!isThinking) { this._autoCollapseThinkingCard(card); }
	}

	/**
	 * 思考结束时自动折叠卡片。
	 *
	 * 卡片创建于流式期间（isThinking=true）按设计是**默认展开**的（便于滚动吸底看
	 * 实时思维链）；此前思考结束后只改 header（标题→「思考过程」、icon→...），
	 * body 仍摊开 —— 长思维链会把后续内容整体挤到视口外。
	 *
	 * 仅在用户**未手动切换过**该卡片时才自动折叠：一旦 _thinkingCardState 有记录
	 * 说明用户做过明确选择，必须尊重，否则自动折叠会覆盖用户刚展开的操作。
	 * 已渲染的 body 内容保留（仅 display:none），用户再展开无需重渲染。
	 */
	protected _autoCollapseThinkingCard(card: HTMLElement): void {
		const cardId = card.dataset.thinkId;
		if (!cardId || this._thinkingCardState.has(cardId)) { return; } // 用户已手动选择
		const body = card.querySelector('.thinking-card-body') as HTMLElement | null;
		if (!body || body.style.display === 'none') { return; } // 已经折叠
		const toggle = card.querySelector('.thinking-card-toggle') as HTMLElement | null;
		body.style.display = 'none';
		toggle?.classList.add('collapsed');
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
				// 防重入：避免用户在 400/错误卡上快速连点"重试"，或与正在进行的 send
				// 重叠，导致同一条 user 消息被重复发出（见 2026-07-23 400 重试循环）。
				// composer 的 send 按钮有 _isSending 拦截，但此重试按钮原本绕过该保护。
				let clicked = false;
				this._register(addDisposableListener(retryBtn, EventType.CLICK, () => {
					if (clicked || this._isSending) { return; }
					clicked = true;
					retryBtn.setAttribute('disabled', 'disabled');
					retryBtn.textContent = '重试中…';
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
}
