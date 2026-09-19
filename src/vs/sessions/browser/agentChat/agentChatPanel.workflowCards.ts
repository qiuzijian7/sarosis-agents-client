import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { renderMarkdown } from '../../../base/browser/markdownRenderer.js';
import type { IMarkdownString } from '../../../base/common/htmlContent.js';
import { ILiveWorkflowExecution, ILiveWorkflowEvent, ILiveCollectVariable, ILiveWorkflowSubAgent, ILiveWorkflowAskUser, ILiveWorkflowPickerSelect, ILiveWorkflowNodeInteraction, type IAgentChatMessage } from './agentChatTypes.js';
import { AgentChatPanelDelegateCards } from './agentChatPanel.delegateCards.js';
import { mediaDownloadFilename } from './mediaDownload.js';
import { ANIMATED_EMOJI_STAGES, computeAnimatedEmojiStageState, isAnimatedEmojiCard } from './subAgentCardUtils.js';
import {
	collectPendingInteractions,
	pendingInteractionsSignature,
	pendingNoticeDesc,
	pendingNoticeTitle,
	type IPendingInteraction,
} from './agentChatPanel.pendingNotice.js';

/**
 * 工作流实时执行可视化：trace 视图 / 变量收集卡 / 节点卡 / 时间线。
 * 自 agentChatPanel.delegateCards.ts 抽离（上帝对象拆分 P5c）。
 */
export abstract class AgentChatPanelWorkflowCards extends AgentChatPanelDelegateCards {

	// ── 右下角「需要你操作」通知条（2026-09-12 用户需求）────────────────────────
	/** 通知条 DOM（懒建；见 `_ensureInteractionToast`）。 */
	private _interactionToast: HTMLElement | undefined;
	/** 当前通知条对应的待办集合签名（`id` 排序拼接）——变化时才重建内容 ✓。 */
	private _interactionToastSig = '';
	/** 被用户**手动关闭**的待办集合签名 —— 同一批不再重复弹出 ✓。 */
	private _interactionToastDismissedSig = '';
	/** 「去选择」闪烁高亮的清理定时器（重复点击先清旧 ✓）。 */
	private _interactionFlashTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * 消息列表整体替换（历史加载 / 工作流结束 / 切会话）后也要同步通知条 ——
	 * 仅靠工作流卡重渲染（`_createLiveWorkflowTraceView`）覆盖不到「卡已不存在但
	 * 通知条还挂着」的路径 ✗（例如待办随消息被清掉）。
	 */
	override setMessages(messages: IAgentChatMessage[]): void {
		super.setMessages(messages);
		this._syncInteractionToast();
	}

	protected override _createLiveWorkflowTraceView(
			workflowExecutions: Record<string, ILiveWorkflowExecution>,
			workflowEvents?: ILiveWorkflowEvent[],
			collectVariables?: Record<string, ILiveCollectVariable>,
			askUsers?: ILiveWorkflowAskUser[],
			pickerSelects?: ILiveWorkflowPickerSelect[],
			nodeInteractions?: ILiveWorkflowNodeInteraction[]
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
				// ★ P2-2 修复（2026-09-13）：真实耗时 + 节点计数（仅终态显示）。
				//   此前卡片的耗时由 controller 用 `Date.now()` 现场取（起止同一时刻）
				//   → **恒显示 0.0s** ✗；成功/失败节点数完全缺失。数据现由 host 的
				//   `execution_end` 携带（真实 startTime/endTime + nodeStates 统计）。
				const st = exec.stats;
				if (st && exec.status !== 'running') {
					const parts: string[] = [];
					if (typeof st.durationMs === 'number') { parts.push(`${(st.durationMs / 1000).toFixed(1)}s`); }
					if (typeof st.doneCount === 'number' && st.doneCount > 0) { parts.push(`${st.doneCount} 成功`); }
					if (typeof st.errorCount === 'number' && st.errorCount > 0) { parts.push(`${st.errorCount} 失败`); }
					if (typeof st.cancelledCount === 'number' && st.cancelledCount > 0) { parts.push(`${st.cancelledCount} 取消`); }
					if (typeof st.skippedCount === 'number' && st.skippedCount > 0) { parts.push(`${st.skippedCount} 跳过`); }
					if (parts.length > 0) {
						const statsEl = append(header, $('span.wf-card-stats', undefined, parts.join(' · ')));
						statsEl.title = '本次执行的耗时与节点统计（成功 / 失败 / 取消 / 跳过）';
					}
				}
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

				// ── Node Cards + AskUser 卡按**时间序**交错渲染 ──
				// ★ 位置修正（2026-09-10 用户反馈）：AskUser 卡此前统一排在节点卡之后，
				//   但实际执行顺序常是「先提问再出图」（AskUser pause → 回答 → 媒体节点）
				//   → 卡上顺序与流程顺序相反。改为按 createdAt/startTime 交错插入。
				//   ★ 2026-09-11：ImagePicker 多选卡并入同一交错队列（两者都是
				//   「暂停等待用户交互」的卡，按 createdAt 与节点卡统一排序）。
				// ★ 节点配置表单归属（2026-09-11 用户需求：「配置 UI 转移到对应的节点卡片内部」）：
				//   此前交互表单卡与节点卡**并列**按时间交错渲染 —— 配置与它所属的节点在视觉上
				//   是两张卡，容易被误读成两个节点。现按 `interaction.nodeId === subAgent.id`
				//   归属，把表单**嵌进对应节点卡**（见 _createNodeCard 的 nodeBody 末尾）。
				const interactionsByNode = new Map<string, ILiveWorkflowNodeInteraction[]>();
				for (const n of (nodeInteractions ?? [])) {
					if (n.executionId !== execId) { continue; }
					const arr = interactionsByNode.get(n.nodeId);
					if (arr) { arr.push(n); } else { interactionsByNode.set(n.nodeId, [n]); }
				}
				const interCards: Array<{ at: number; render: () => HTMLElement }> = [
					...(askUsers ?? [])
						.filter(a => a.executionId === execId)
						.map(a => ({ at: a.createdAt ?? 0, render: () => this._createAskUserCard(a) })),
					...(pickerSelects ?? [])
						.filter(p => p.executionId === execId)
						.map(p => ({ at: p.createdAt ?? 0, render: () => this._createPickerSelectCard(p) })),
				].sort((a, b) => a.at - b.at);
				let interIdx = 0;
				for (const sa of exec.subAgents) {
					if (sa.id === '__workflow__') { continue; } // skip synthetic root
					while (interIdx < interCards.length && interCards[interIdx].at < (sa.startTime ?? 0)) {
						body.appendChild(interCards[interIdx].render());
						interIdx++;
					}
					body.appendChild(this._createNodeCard(sa, interactionsByNode.get(sa.id)));
				}
				while (interIdx < interCards.length) {
					body.appendChild(interCards[interIdx].render());
					interIdx++;
				}
				// 兜底：没有对应节点卡的交互（节点卡尚未出现/已被清理）仍并列渲染，**绝不丢卡**。
				for (const [nodeId, list] of interactionsByNode) {
					if (exec.subAgents.some(sa => sa.id === nodeId)) { continue; }
					for (const it of list) { body.appendChild(this._createNodeInteractionCard(it)); }
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

			// ★ 右下角「需要你操作」通知条（2026-09-12 用户需求）：本方法在**每次工作流卡
			//   重渲染**时被调用（trace 刷新 → `updateMessage` → 重建消息 DOM），因此
			//   通知条的**弹出与收起**都收敛在这里 —— 有待交互项则弹出、全部处理完自动
			//   收起 ✓（无需额外的定时器/订阅）。
			this._syncInteractionToast();

			return container;
		}

	/**
	 * 同步右下角通知条（2026-09-12 用户需求「需要用户交互的卡片…右下角弹出通知栏」）。
	 *
	 * 语义：
	 *  · 有待交互项 → 常驻显示（**不自动消失**：它是一条「待办」而非一次性提示，
	 *    自动消失会让用户错过 ✗），且不随消息滚动移出视野（CSS `absolute` 定在
	 *    聊天面板右下角 ✓）；
	 *  · 待交互项集合变化（新的待办出现）→ 更新文案并重新弹出（即使之前手动关过 ✓）；
	 *  · 集合不变且用户手动关闭过 → 不再打扰 ✓；
	 *  · 全部处理完 → 自动收起 ✓。
	 */
	private _syncInteractionToast(): void {
		const pending = collectPendingInteractions(this._messages);
		const sig = pendingInteractionsSignature(pending);

		if (pending.length === 0) {
			this._interactionToast?.classList.remove('visible');
			this._interactionToastSig = '';
			this._interactionToastDismissedSig = '';
			return;
		}
		// 用户已手动关掉**这一批**待办 → 保持收起（新的待办会换 sig → 重新弹出 ✓）
		if (sig === this._interactionToastDismissedSig) { return; }

		const toast = this._ensureInteractionToast();
		if (sig !== this._interactionToastSig) {
			this._interactionToastSig = sig;
			this._renderInteractionToastContent(toast, pending);
		}
		toast.classList.add('visible');
	}

	/**
	 * 懒建通知条 DOM。
	 *
	 * 挂在 `.chat-container`（`position: relative`）下 → 由 CSS 的 `absolute` 定位到
	 * **聊天面板**右下角 ✓（不是整个窗口右下角 —— 面板不在那个角落时用户看不到 ✗）。
	 */
	private _ensureInteractionToast(): HTMLElement {
		if (this._interactionToast) { return this._interactionToast; }
		const toast = $('.chat-interaction-toast');
		toast.setAttribute('role', 'alert');
		this._container.appendChild(toast);
		this._interactionToast = toast;
		this._register({ dispose: () => { toast.remove(); } });
		return toast;
	}

	/** 重建通知条内容（待办集合变化时调用）。 */
	private _renderInteractionToastContent(
		toast: HTMLElement,
		pending: ReadonlyArray<IPendingInteraction>,
	): void {
		toast.textContent = '';
		append(toast, $('span.cit-icon', undefined, '👉'));
		const body = append(toast, $('.cit-body'));
		append(body, $('.cit-title', undefined, pendingNoticeTitle(pending.length)));
		// 描述行：去重后的类型清单（同一节点多次待办只列一次类型名 ✓）
		append(body, $('.cit-desc', undefined, pendingNoticeDesc(pending)));

		const action = append(toast, $('button.cit-action', undefined, '去选择')) as HTMLButtonElement;
		action.type = 'button';
		this._register(addDisposableListener(action, EventType.CLICK, () => {
			this._scrollToFirstPending();
		}));

		const close = append(toast, $('button.cit-close', undefined, '✕')) as HTMLButtonElement;
		close.type = 'button';
		close.title = '关闭提示（处理完当前待办前不再弹出）';
		this._register(addDisposableListener(close, EventType.CLICK, () => {
			// 记住「这一批待办已被手动关闭」→ 不再重复弹出；新待办会换 sig 重新弹出 ✓
			this._interactionToastDismissedSig = this._interactionToastSig;
			toast.classList.remove('visible');
		}));
	}

	/** 滚动到第一张待交互卡并闪一下（通知条「去选择」）。 */
	private _scrollToFirstPending(): void {
		const pending = collectPendingInteractions(this._messages);
		for (const p of pending) {
			const el = this._messagesContainer?.querySelector(p.selector) as HTMLElement | null;
			if (!el) { continue; }
			// ★ 目标卡可能在**被折叠**的工作流卡里（卡头 ▼/▶ 手动收起）——此时
			//   `scrollIntoView` 对 `display:none` 元素无效，用户点「去选择」像没反应 ✗。
			//   沿祖先链把工作流 body 展开并复位卡头箭头（节点卡自身有「有待交互则
			//   不自动折叠」的保护，见 _createSubAgentCard）✓。
			const wfBody = el.closest('.wf-body') as HTMLElement | null;
			if (wfBody && wfBody.style.display === 'none') {
				wfBody.style.display = '';
				const wfToggle = wfBody.parentElement?.querySelector('.wf-header .wf-toggle');
				if (wfToggle) {
					wfToggle.textContent = '▼';
					wfToggle.classList.remove('collapsed');
				}
			}
			el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			// 闪一下：滚动后目标卡在长列表里仍可能被忽略 ✗（class 由 CSS 动画消费，
			// 结束后自行移除 —— 用一次性定时器，重复点击时先清旧定时器 ✓）。
			el.classList.remove('chat-interaction-flash');
			// 强制重排以重启动画（同元素连续加同一个 class 不会重放 ✗）
			void el.offsetWidth;
			el.classList.add('chat-interaction-flash');
			if (this._interactionFlashTimer !== undefined) { clearTimeout(this._interactionFlashTimer); }
			this._interactionFlashTimer = setTimeout(() => {
				this._interactionFlashTimer = undefined;
				el.classList.remove('chat-interaction-flash');
			}, 2000);
			return;
		}
	}

	protected override _createCollectVarsCard(execId: string, cv: ILiveCollectVariable): HTMLElement {
		// ★ `pending` 类（2026-09-12）：变量收集卡是「工作流开始前必须填」的交互卡，
		//   渲染即待交互 → 参与统一的高亮呼吸边框（见 agentChat.css）。
		const card = $('.collect-vars-card.pending');
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

	/**
	 * 节点交互表单卡（2026-09-11 框架）—— 按 schema 动态渲染。
	 *
	 * 支持字段：number / text / textarea / boolean / select / grid-size(m×n) /
	 * list（元素由 itemFields 声明，可 countFrom 跟随网格尺寸自动增删行）。
	 * 提交后值经 JSON 序列化回传执行侧，节点带着用户配置执行，随后继续下游。
	 */
	protected override _createNodeInteractionCard(interaction: ILiveWorkflowNodeInteraction): HTMLElement {
		const isDone = interaction.status !== 'pending';

		// ★ 选择型节点（schema 声明 `apply:'snapshot'`，2026-09-11 框架完善）：host 会把
		//   上游候选媒体放进 initialValues.__candidates → 复用 ImagePicker 卡的候选
		//   缩略图网格渲染（含多选/全选/确认），提交时回传选中 refs（执行侧按 snapshot
		//   模式直接作为节点输出、不执行节点）。**新增选择型节点无需改本文件**。
		const initial = (interaction.initialValues ?? {}) as Record<string, unknown>;
		const candidates = Array.isArray(initial['__candidates'])
			? (initial['__candidates'] as Array<{ port: string; kind: 'image' | 'video' | 'audio' | 'text' | 'unknown'; ref: string; meta?: Record<string, unknown> }>)
			: undefined;
		if (candidates && candidates.length > 0) {
			return this._createPickerSelectCard({
				id: interaction.id,
				executionId: interaction.executionId,
				nodeId: interaction.nodeId,
				nodeName: interaction.nodeName,
				candidates,
				multiSelect: initial['__multiSelect'] !== false,
				selectedRefs: Array.isArray(interaction.submittedValues?.['__refs'])
					? (interaction.submittedValues!['__refs'] as string[])
					: [],
				status: interaction.status === 'submitted' ? 'answered'
					: interaction.status === 'skipped' ? 'cancelled' : 'pending',
				createdAt: interaction.createdAt,
			});
		}

		const card = $('.ni-card');
		card.classList.add(isDone ? 'submitted' : 'pending');

		const header = append(card, $('.ni-header'));
		append(header, $('span.ni-icon', undefined, '⚙️'));
		append(header, $('span.ni-title', undefined, `${interaction.title} — ${interaction.nodeName}`));
		const badge = append(header, $('span.ni-badge', undefined, isDone ? '已配置' : '待配置'));
		badge.classList.add(isDone ? 'submitted' : 'pending');
		if (interaction.description) {
			append(card, $('.ni-desc', undefined, interaction.description));
		}

		const form = append(card, $('.ni-form'));
		const values: Record<string, unknown> = { ...interaction.initialValues };
		const readers: Array<{ key: string; read: () => unknown }> = [];
		const submittedValues = interaction.submittedValues;

		/** 渲染单个字段，返回读取器（提交时收集）。 */
		const renderField = (f: Record<string, unknown>, container: HTMLElement, readOnly: boolean): void => {
			const kind = String(f['kind'] ?? 'text');
			const key = String(f['key'] ?? '');
			const label = String(f['label'] ?? key);
			const cur = (submittedValues && key in submittedValues) ? submittedValues[key] : values[key];

			if (kind === 'grid-size') {
				const row = append(container, $('.ni-field.ni-grid'));
				append(row, $('span.ni-label', undefined, label));
				const wrap = append(row, $('.ni-grid-inputs'));
				// 注：rowsKey/colsKey 的展开由执行侧 applyInteractionValues 处理，
				//     卡片只需返回 { rows, cols }。
				const g = (cur && typeof cur === 'object') ? cur as { rows?: number; cols?: number } : {};
				const mkNum = (lbl: string, v: number, min: number, max: number, onChange: (n: number) => void): HTMLInputElement => {
					const box = append(wrap, $('span.ni-num-box'));
					append(box, $('span.ni-num-label', undefined, lbl));
					const inp = append(box, $('input.ni-input.ni-number')) as HTMLInputElement;
					inp.type = 'number';
					inp.min = String(min); inp.max = String(max);
					inp.value = String(v);
					inp.disabled = readOnly;
					if (!readOnly) {
						this._register(addDisposableListener(inp, EventType.INPUT, () => {
							const n = Math.max(min, Math.min(max, Math.round(Number(inp.value) || min)));
							onChange(n);
							refreshLists();
						}));
					}
					return inp;
				};
				const gridState = { rows: Number(g.rows) || Number(f['defaultRows']) || 3, cols: Number(g.cols) || Number(f['defaultCols']) || 3 };
				mkNum('行', gridState.rows, Number(f['min'] ?? 1), Number(f['max'] ?? 8), n => { gridState.rows = n; });
				mkNum('列', gridState.cols, Number(f['min'] ?? 1), Number(f['max'] ?? 8), n => { gridState.cols = n; });
				readers.push({ key, read: () => ({ rows: gridState.rows, cols: gridState.cols }) });
				// ★ 共享同一对象引用（2026-09-11 用户反馈「改行列后提示词列表数量不同步」）：
				//   此前赋的是快照 `{rows, cols}`，onChange 只改 gridState → values 里的旧值
				//   不变 → list 的 countFrom 读到的仍是初始值（1×1 却显示 7 行）。
				values[key] = gridState;
				return;
			}

			if (kind === 'list') {
				const row = append(container, $('.ni-field.ni-list-field'));
				append(row, $('span.ni-label', undefined, label));
				const listWrap = append(row, $('.ni-list'));
				const itemFields = Array.isArray(f['itemFields']) ? f['itemFields'] as Array<Record<string, unknown>> : [];
				const countFrom = typeof f['countFrom'] === 'string' ? f['countFrom'] as string : '';
				// ★ 默认提示词预设（2026-09-11 用户需求）：空格子用预设占位（placeholder），
				//   提交时仍为空则按序套用 —— 用户不填也能生成一组有意义的表情。
				const preset = Array.isArray(f['preset']) ? (f['preset'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
				const items: Array<Record<string, unknown>> = Array.isArray(cur) ? (cur as Array<Record<string, unknown>>) : [];
				/** 当前应显示的行数（跟随 m×n）。 */
				const wantRows = (): number => {
					const grid = values[countFrom] as { rows?: number; cols?: number } | undefined;
					return grid
						? Math.max(1, Math.min(64, (Number(grid.rows) || 1) * (Number(grid.cols) || 1)))
						: Math.max(items.length, 1);
				};
				(listWrap as HTMLElement & { _render?: () => void })._render = () => {
					const want = wantRows();
					listWrap.textContent = '';
					for (let i = 0; i < want; i++) {
						const line = append(listWrap, $('.ni-list-row'));
						append(line, $('span.ni-list-index', undefined, `#${i + 1}`));
						const item = (items[i] ?? {}) as Record<string, unknown>;
						for (const sf of itemFields) {
							const sKey = String(sf['key'] ?? 'prompt');
							const inp = append(line, $('input.ni-input.ni-list-input')) as HTMLInputElement;
							inp.type = 'text';
							const presetHint = preset.length > 0 ? preset[i % preset.length] : '';
							inp.placeholder = presetHint || String(sf['placeholder'] ?? sf['label'] ?? sKey);
							inp.value = typeof item[sKey] === 'string' ? item[sKey] as string : '';
							inp.disabled = readOnly;
							if (!readOnly) {
								this._register(addDisposableListener(inp, EventType.INPUT, () => {
									const arr = (values[key] as Array<Record<string, unknown>>) ?? [];
									while (arr.length <= i) { arr.push({}); }
									arr[i] = { ...(arr[i] ?? {}), [sKey]: inp.value };
									values[key] = arr;
								}));
							}
						}
					}
				};
				(listWrap as HTMLElement & { _render?: () => void })._render?.();
				readers.push({
					key,
					read: () => {
						const arr = (values[key] as Array<Record<string, unknown>>) ?? [];
						const want = wantRows();
						const out: Array<Record<string, unknown>> = [];
						for (let i = 0; i < want; i++) {
							const item: Record<string, unknown> = { ...(arr[i] ?? {}) };
							for (const sf of itemFields) {
								const sKey = String(sf['key'] ?? 'prompt');
								const v = item[sKey];
								// 空 → 套用预设（按序），保证生成时有可用的提示词
								if ((v === undefined || v === null || v === '') && preset.length > 0) {
									item[sKey] = preset[i % preset.length];
								}
							}
							out.push(item);
						}
						return out;
					},
				});
				return;
			}

			if (kind === 'image-ref') {
				// ★ 参考图像（2026-09-11 用户需求）：**有默认值（上游节点输入）→ 直接显示**；
				//   没有 → 提供「选择图像」按钮，点开为上游候选缩略图网格。
				//   值 = AssetRef[]（写入节点 values.comfytv_image_refs，执行侧据此做
				//   img2img 参考并覆盖同 slot 的上游连线）；候选由 host 放进
				//   initialValues.__assetCandidates（上游图像快照）。
				const row = append(container, $('.ni-field.ni-image-ref'));
				append(row, $('span.ni-label', undefined, label));
				if (typeof f['description'] === 'string' && f['description']) {
					append(row, $('span.ni-hint', undefined, f['description']));
				}
				const slot = Number(f['slot'] ?? 0) || 0;
				const candidates = Array.isArray(initial['__assetCandidates'])
					? (initial['__assetCandidates'] as Array<{ ref?: string; label?: string }>)
						.filter(c => typeof c?.ref === 'string' && c.ref)
					: [];
				const curRefs = Array.isArray(cur) ? (cur as Array<{ ref?: string }>) : [];
				let chosenRef = curRefs.find(r => typeof r?.ref === 'string' && r.ref)?.ref ?? '';
				// 候选网格重建定时器：单击后延迟重建，给「双击打开编辑器」留出窗口
				// （重建会移除 tile，元素被移除后浏览器不再派发 dblclick）。卡片重渲染/
				// 面板销毁时清理，避免定时器打到已脱离的 DOM 上。
				let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
				this._register({ dispose: () => { if (rebuildTimer !== undefined) { clearTimeout(rebuildTimer); rebuildTimer = undefined; } } });
				// 候选网格展开态：**提升到 render 之外**，否则每次 renderPicker() 都重置为收起
				//（用户选完一张就被自动收起，且「点图展开」也留不住状态）。
				let pickerOpen = false;

				const preview = append(row, $('.ni-image-ref-preview'));
				const picker = append(row, $('.ni-image-ref-picker'));
				const renderPreview = (): void => {
					preview.textContent = '';
					const src = this._mediaSrc(chosenRef);
					if (src) {
						const img = append(preview, $('img.ni-image-ref-thumb')) as HTMLImageElement;
						img.src = src;
						img.alt = '参考图';
						this._bindOpenInEditor(img, src, 'image', '参考图');
						this._decorateMediaActions(img, src, 'image', '参考图');
						// ★ 单击参考图 = 展开/收起候选（2026-09-11 用户报障「无法进行选择」：
						//   此前点这张图**毫无反应**，而候选按钮又因无候选不渲染 → 完全无从下手）。
						if (!readOnly) {
							img.style.cursor = 'pointer';
							img.title = '单击选择 / 双击在编辑器中打开';
							this._register(addDisposableListener(img, EventType.CLICK, (e: MouseEvent) => {
								if (e.detail > 1) { return; }   // 双击打开编辑器：忽略第 2 击
								pickerOpen = !pickerOpen;
								renderPicker();
							}));
						}
					} else {
						const empty = append(preview, $('span.ni-image-ref-empty', undefined, '未选择参考图（将直接文生图）'));
						// ★ 空态也可点（2026-09-12）：没有缩略图可点时，用户至少要有个
						//   入口打开候选网格 —— 否则只能靠下面那个按钮（此前按钮也没监听 ✗）。
						if (!readOnly) {
							empty.style.cursor = 'pointer';
							empty.title = '点击选择参考图';
							this._register(addDisposableListener(empty, EventType.CLICK, () => {
								pickerOpen = !pickerOpen;
								renderPicker();
							}));
						}
					}
				};
				const renderPicker = (): void => {
					picker.textContent = '';
					// 已提交的卡片整表只读（`isDone`）→ 不渲染交互件。
					if (readOnly) { return; }
					// ★ 候选为空也**照常渲染按钮**（2026-09-11 修）：此前 `candidates.length === 0`
					//   直接 return → 上游无图的节点（如表情包，上游只有 start）连按钮都没有，
					//   用户根本无法指定参考图 ✗。现在网格里恒有「上传」一项，永远可选 ✓。
					const btnRow = append(picker, $('.ni-image-ref-btnrow'));
					const btn = append(btnRow, $('button.ni-image-ref-btn')) as HTMLButtonElement;
					btn.type = 'button';
					btn.textContent = pickerOpen ? '收起候选' : (chosenRef ? '更换参考图' : '选择图像');
					// ★★ 点击按钮 = 展开/收起候选（2026-09-12 用户报障「点击『更换参考图』
					//   按钮没反应」）：此前只有**缩略图**挂了 click 切换 pickerOpen ✗，
					//   按钮自身**没有监听器** → 点它毫无反应 ✗（「未选择参考图」时更是
					//   完全没有可点的东西 ✗）。
					this._register(addDisposableListener(btn, EventType.CLICK, () => {
						pickerOpen = !pickerOpen;
						renderPicker();
					}));
					// ★ 「移除」按钮（2026-09-12 用户需求「缺少移除按钮」）：清空已选参考图
					//   → 预览回到「未选择参考图（将直接文生图）」，`read()` 随之返回 []，
					//   提交时该 slot 即被清空 ✓（与选图同一条提交路径，无需额外协议）。
					//   仅在**已选**时出现（未选时无可移除 ✗）；候选网格保持展开，方便换选。
					if (chosenRef) {
						const rm = append(btnRow, $('button.ni-image-ref-btn.ni-image-ref-remove')) as HTMLButtonElement;
						rm.type = 'button';
						rm.textContent = '✕ 移除';
						rm.title = '清除已选参考图（回到直接文生图）';
						this._register(addDisposableListener(rm, EventType.CLICK, () => {
							chosenRef = '';
							renderPreview();
							renderPicker();
						}));
					}
					const grid = append(picker, $('.ni-image-ref-grid')) as HTMLElement;
					grid.style.display = pickerOpen ? '' : 'none';
					if (!pickerOpen) { return; }
					grid.textContent = '';

					// ── 上传本地图片（恒有；上游无候选时的唯一来源）──
					const upTile = append(grid, $('.ni-image-ref-tile.upload')) as HTMLElement;
					upTile.title = '上传本地图片作为参考图';
					append(upTile, $('span.ni-image-ref-upload-icon', undefined, '＋'));
					append(upTile, $('span.ni-image-ref-upload-text', undefined, '上传'));
					const file = append(upTile, $('input.ni-image-ref-file')) as HTMLInputElement;
					file.type = 'file';
					file.accept = 'image/*';
					file.style.display = 'none';
					this._register(addDisposableListener(upTile, EventType.CLICK, () => file.click()));
					this._register(addDisposableListener(file, EventType.CHANGE, () => {
						const picked = file.files?.[0];
						if (!picked) { return; }
						const reader = new FileReader();
						reader.onload = () => {
							const url = typeof reader.result === 'string' ? reader.result : '';
							if (!url) { return; }
							// 与画布产出的参考图同形态（data URL）→ 执行侧无需特殊处理 ✓
							chosenRef = url;
							renderPreview();
							renderPicker();
						};
						reader.readAsDataURL(picked);
					}));

					for (const c of candidates) {
						const tile = append(grid, $('.ni-image-ref-tile')) as HTMLElement;
						if (c.ref === chosenRef) { tile.classList.add('selected'); }
						if (c.label) { tile.title = c.label; }
						const ti = append(tile, $('img.ni-image-ref-tile-img')) as HTMLImageElement;
						ti.src = this._mediaSrc(c.ref);
						ti.alt = c.label ?? '候选图';
						this._bindOpenInEditor(ti, ti.src, 'image', c.label);
						this._decorateMediaActions(ti, ti.src, 'image', c.label);
						this._register(addDisposableListener(tile, EventType.CLICK, (e: MouseEvent) => {
							// ★ 双击打开编辑器（2026-09-11）：忽略第 2 次 click，且**延迟**重建候选网格。
							//   原因：renderPicker() 会 `grid.textContent=''` 重建所有 tile → 元素被移除后
							//   浏览器**不会再派发 dblclick**（第二击落在新元素上）✗。延迟重建给双击留出窗口。
							if (e.detail > 1) { return; }
							chosenRef = c.ref!;
							renderPreview();
							if (rebuildTimer !== undefined) { clearTimeout(rebuildTimer); }
							rebuildTimer = setTimeout(() => { rebuildTimer = undefined; renderPicker(); }, 250);
						}));
					}
				};
				renderPreview();
				renderPicker();
				readers.push({ key, read: () => (chosenRef ? [{ ref: chosenRef, slot }] : []) });
				return;
			}

			const row = append(container, $('.ni-field'));
			append(row, $('span.ni-label', undefined, label));
			if (kind === 'select') {
				const sel = append(row, $('select.ni-input.ni-select')) as HTMLSelectElement;
				const opts = Array.isArray(f['options']) ? f['options'] as Array<{ label?: string; value?: string }> : [];
				for (const o of opts) {
					const op = append(sel, $('option')) as HTMLOptionElement;
					op.value = String(o.value ?? o.label ?? '');
					op.textContent = String(o.label ?? o.value ?? '');
				}
				sel.value = typeof cur === 'string' ? cur : '';
				sel.disabled = readOnly;
				if (!readOnly) { this._register(addDisposableListener(sel, EventType.CHANGE, () => { values[key] = sel.value; })); }
				readers.push({ key, read: () => values[key] ?? sel.value });
				return;
			}
			if (kind === 'boolean') {
				const inp = append(row, $('input.ni-input.ni-checkbox')) as HTMLInputElement;
				inp.type = 'checkbox';
				inp.checked = !!cur;
				inp.disabled = readOnly;
				if (!readOnly) { this._register(addDisposableListener(inp, EventType.CHANGE, () => { values[key] = inp.checked; })); }
				readers.push({ key, read: () => !!inp.checked });
				return;
			}
			if (kind === 'textarea') {
				const ta = append(row, $('textarea.ni-input.ni-textarea')) as HTMLTextAreaElement;
				ta.rows = Number(f['rows'] ?? 3);
				if (typeof f['placeholder'] === 'string') { ta.placeholder = f['placeholder']; }
				ta.value = typeof cur === 'string' ? cur : '';
				ta.disabled = readOnly;
				if (!readOnly) { this._register(addDisposableListener(ta, EventType.INPUT, () => { values[key] = ta.value; })); }
				readers.push({ key, read: () => ta.value });
				return;
			}
			// number / text
			const inp = append(row, $('input.ni-input')) as HTMLInputElement;
			inp.type = kind === 'number' ? 'number' : 'text';
			if (kind === 'number') {
				if (f['min'] !== undefined) { inp.min = String(f['min']); }
				if (f['max'] !== undefined) { inp.max = String(f['max']); }
			}
			if (typeof f['placeholder'] === 'string') { inp.placeholder = f['placeholder']; }
			inp.value = cur !== undefined && cur !== null ? String(cur) : '';
			inp.disabled = readOnly;
			if (!readOnly) {
				this._register(addDisposableListener(inp, EventType.INPUT, () => {
					values[key] = kind === 'number' ? Number(inp.value) : inp.value;
				}));
			}
			readers.push({ key, read: () => kind === 'number' ? Number(inp.value) : inp.value });
		};

		/** 网格尺寸变化 → 重渲染所有 list 字段（行数跟随 m×n）。 */
		const refreshLists = (): void => {
			for (const el of Array.from(form.querySelectorAll('.ni-list')) as Array<HTMLElement & { _render?: () => void }>) {
				el._render?.();
			}
		};

		for (const f of interaction.fields) { renderField(f, form, isDone); }

		if (!isDone) {
			const actions = append(card, $('.ni-actions'));
			const submit = append(actions, $('button.ni-submit')) as HTMLButtonElement;
			submit.textContent = interaction.submitLabel ?? '确认并执行';
			this._register(addDisposableListener(submit, EventType.CLICK, () => {
				const out: Record<string, unknown> = {};
				for (const r of readers) { out[r.key] = r.read(); }
				submit.disabled = true;
				submit.classList.add('disabled');
				submit.textContent = '已提交…';
				this._onNodeInteractionSubmit?.(interaction.id, interaction.executionId, interaction.nodeId, out);
			}));
		} else {
			const sv = interaction.submittedValues;
			const summary = interaction.status === 'submitted'
				? `已提交配置${sv ? `：${Object.entries(sv).map(([k, v]) => `${k}=${Array.isArray(v) ? `${v.length} 项` : typeof v === 'object' ? '…' : String(v)}`).join('，')}` : ''}`
				: '已跳过配置，使用节点现有设置';
			append(card, $('.ni-answer', undefined, summary));
		}

		return card;
	}

	/**
	 * ImagePicker 多选卡（2026-09-11 用户需求）。
	 *
	 * 执行到 picker 阶段时工作流**暂停**：卡片展示上游候选图（缩略图网格 + 勾选），
	 * 用户点「确认选择」→ 选中的 refs 作为该节点输出（snapshot）交给下游 → resume
	 * 执行。未确认前下游不推进（复用 AskUser 的 pause/resume 机制）。
	 */
	protected override _createPickerSelectCard(pickerSelect: ILiveWorkflowPickerSelect): HTMLElement {
		const isAnswered = pickerSelect.status !== 'pending';
		const card = $('.picker-card');
		card.classList.add(isAnswered ? 'answered' : 'pending');

		// ── Header ──
		const header = append(card, $('.picker-header'));
		append(header, $('span.picker-icon', undefined, '🖼️'));
		append(header, $('span.picker-title', undefined, `选择图像 — ${pickerSelect.nodeName}`));
		const badge = append(header, $('span.picker-badge', undefined, isAnswered ? '已选择' : '待选择'));
		badge.classList.add(isAnswered ? 'answered' : 'pending');

		// ── Hint ──
		const total = pickerSelect.candidates.length;
		append(card, $('.picker-hint', undefined,
			isAnswered
				? `已选择 ${pickerSelect.selectedRefs.length}/${total} 张，下游继续执行`
				: `共 ${total} 张候选图，勾选后点击「确认选择」，选中的图才会输出给下游`,
		));

		// ── Candidate grid ──
		// ★ submitBtn 提前声明（actions 在 grid 之后构建，但勾选回调需要更新按钮文案）。
		let submitBtn: HTMLButtonElement | undefined;
		const grid = append(card, $('.picker-grid'));
		const selected = new Set(pickerSelect.selectedRefs ?? []);
		for (const m of pickerSelect.candidates) {
			const src = this._mediaSrc(m.ref);
			if (!src) { continue; }
			const item = append(grid, $('.picker-item'));
			if (selected.has(m.ref)) { item.classList.add('selected'); }
			if (isAnswered) { item.classList.add('readonly'); }

			let media: HTMLElement;
			if (m.kind === 'video') {
				media = append(item, $('video.picker-thumb')) as HTMLVideoElement;
				(media as HTMLVideoElement).src = src;
				(media as HTMLVideoElement).muted = true;
			} else if (m.kind === 'audio') {
				media = append(item, $('audio.picker-audio')) as HTMLAudioElement;
				(media as HTMLAudioElement).src = src;
				(media as HTMLAudioElement).controls = true;
			} else {
				media = append(item, $('img.picker-thumb')) as HTMLImageElement;
				(media as HTMLImageElement).src = src;
				(media as HTMLImageElement).alt = m.port || 'candidate';
				(media as HTMLImageElement).loading = 'lazy';
			}

			this._bindOpenInEditor(media, src, m.kind, m.port);
			// ★ 候选媒体：右上角放大 / 右下角下载（2026-09-11 用户需求；图·视频·音频均有）
			this._decorateMediaActions(media, src, m.kind, m.port);

			if (!isAnswered && m.kind === 'image') {
				const mark = append(item, $('span.picker-check', undefined, selected.has(m.ref) ? '✓' : ''));
				this._register(addDisposableListener(item, EventType.CLICK, (e: MouseEvent) => {
					// ★ 双击打开编辑器时忽略第 2 次 click（2026-09-11）：本卡单击是**切换**选中，
					//   若放行第 2 次 click，双击会变成「选中 → 取消选中 → 打开编辑器」——
					//   用户看到的选中态被自己的双击抹掉 ✗。`detail > 1` 即「双击的第 2 击」。
					if (e.detail > 1) { return; }
					if (selected.has(m.ref)) {
						selected.delete(m.ref);
						item.classList.remove('selected');
						mark.textContent = '';
					} else {
						selected.add(m.ref);
						item.classList.add('selected');
						mark.textContent = '✓';
					}
					// 更新按钮文案与可用态
					const n = selected.size;
					if (submitBtn) {
						submitBtn.textContent = `确认选择 (${n})`;
						submitBtn.disabled = n === 0;
						submitBtn.classList.toggle('disabled', n === 0);
					}
				}));
			}
		}

		// ── Actions（仅待选态显示） ──
		if (!isAnswered) {
			const actions = append(card, $('.picker-actions'));
			// ★ 提交按钮（供 grid 勾选回调与全选/清空闭包更新文案）。
			submitBtn = append(actions, $('button.picker-submit')) as HTMLButtonElement;
			submitBtn.textContent = `确认选择 (${selected.size})`;
			submitBtn.disabled = selected.size === 0;
			if (selected.size === 0) { submitBtn.classList.add('disabled'); }
			const sb = submitBtn;
			this._register(addDisposableListener(sb, EventType.CLICK, () => {
				const refs = Array.from(selected);
				if (refs.length === 0) { return; }
				sb.disabled = true;
				sb.classList.add('disabled');
				sb.textContent = '已提交…';
				this._onPickerSelectSubmit?.(pickerSelect.id, pickerSelect.executionId, pickerSelect.nodeId, refs);
			}));

			const selectAll = append(actions, $('button.picker-select-all', undefined, '全选')) as HTMLButtonElement;
			this._register(addDisposableListener(selectAll, EventType.CLICK, () => {
				for (const m of pickerSelect.candidates) { selected.add(m.ref); }
				for (const el of Array.from(grid.querySelectorAll('.picker-item'))) {
					el.classList.add('selected');
					const mk = el.querySelector('.picker-check');
					if (mk) { (mk as HTMLElement).textContent = '✓'; }
				}
				sb.textContent = `确认选择 (${selected.size})`;
				sb.disabled = false;
				sb.classList.remove('disabled');
			}));
			const clearAll = append(actions, $('button.picker-clear-all', undefined, '清空')) as HTMLButtonElement;
			this._register(addDisposableListener(clearAll, EventType.CLICK, () => {
				selected.clear();
				for (const el of Array.from(grid.querySelectorAll('.picker-item'))) {
					el.classList.remove('selected');
					const mk = el.querySelector('.picker-check');
					if (mk) { (mk as HTMLElement).textContent = ''; }
				}
				sb.textContent = '确认选择 (0)';
				sb.disabled = true;
				sb.classList.add('disabled');
			}));
		} else {
			// 只读回显：已选择的图加边框标记
			append(card, $('.picker-answer', undefined,
				`已选择：${pickerSelect.selectedRefs.length} 张（${pickerSelect.selectedRefs.length}/${total}）`));
		}

		return card;
	}

	/**
	 * 媒体引用 → 可直接用于 DOM 的 URL（2026-09-10）。
	 *
	 * snapshot.ref 来自画布快照库（`e.media.ref`），可能是四种形态：
	 *   - data URL（`data:image/png;base64,…`）→ 直接可用；
	 *   - http(s)/blob/vscode-file → 直接可用；
	 *   - Windows 绝对路径（`C:\…\x.png`）或 POSIX 路径（`/…/x.png`）
	 *     → 转 `vscode-file://vscode-app/<path>`（native DOM 可加载的本地文件协议）。
	 * 无法识别时返回空串（调用方跳过该条，避免渲染出碎图）。
	 */
	private _mediaSrc(ref: string | undefined): string {
		if (!ref) { return ''; }
		if (/^(data:|https?:|blob:|vscode-file:|vscode-remote:)/i.test(ref)) { return ref; }
		const normalized = ref.replace(/\\/g, '/');
		if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')) {
			return `vscode-file://vscode-app/${normalized}`;
		}
		if (normalized.startsWith('/')) {
			return `vscode-file://vscode-app${normalized}`;
		}
		return '';
	}

	/**
	 * 绑定「双击在中间栏编辑器独立 pane 打开」（2026-09-11 用户需求）。
	 *
	 * 传入的 `src` 必须是**已转换**的可加载 URL（`_mediaSrc` 的输出）—— data URL 亦可，
	 * 由 AgentMediaEditorPane 直接赋给 img/video/audio 的 src。
	 * 未接 `onOpenMedia`（如某些独立使用面板的场景）时**不绑定**，避免出现
	 * 「可点却无反应」的假交互。
	 */
	protected _bindOpenInEditor(el: HTMLElement, src: string, kind: string, title?: string): void {
		if (!this._onOpenMedia || !src) { return; }
		el.style.cursor = 'zoom-in';
		el.title = '双击在编辑器中打开';
		this._register(addDisposableListener(el, EventType.DBLCLICK, (e: MouseEvent) => {
			// 阻止冒泡：候选缩略图上单击是「选中」，双击打开不应连带触发两次选中/提交。
			e.preventDefault();
			e.stopPropagation();
			this._onOpenMedia!({ src, kind, title });
		}));
	}

	/**
	 * 给卡片里的**图片**加悬浮按钮：右上角「放大」、右下角「下载」（2026-09-11 用户需求）。
	 *
	 * 放大 → 在**中间栏**编辑器打开本仓库自己的 `AgentMediaEditorPane`（媒体预览）。
	 *   ★ 刻意不走「资源型 input」：媒体 ref 多为 data URL（画布生成结果的主流形态，
	 *   无文件资源可依附）——交给 VS Code 的资源打开流程会落到**别的**编辑器上
	 *   （用户实测：点开后是外部扩展的 `instantToolsEditor` 且内容空白 ✗）。
	 *   本路径由 `nativeChatEditorPane._openInMainColumn` 保证落到中间栏 ✓。
	 * 下载 → `<a download>`（data: / blob: / vscode-file: / 同源 http 均适用）。
	 *
	 * 实现：把 mediaEl 移进 `.chat-media-wrap`（position:relative）后再叠按钮 —— 不改动
	 * mediaEl 自身的尺寸规则（如 `.node-media-thumb` 的 120×120 + flex:0 0 auto）。
	 * 返回 wrapper（调用方若需保留父级引用可忽略）。
	 */
	protected _decorateMediaActions(mediaEl: HTMLElement, src: string, kind: string, title?: string): HTMLElement {
		const wrap = $('span.chat-media-wrap');
		// ★ 视频/音频有**原生控制条**（视频在底部、音频整条都是控制条）→ 按钮位置按类型调整
		//   （见 CSS `.chat-media-wrap.video/.audio`）：视频的下载按钮上移避开控制条；
		//   音频两个按钮都放右上角。图片维持「右上放大 + 右下下载」。
		if (kind === 'video' || kind === 'audio') { wrap.classList.add(kind); }
		mediaEl.parentElement?.insertBefore(wrap, mediaEl);
		wrap.appendChild(mediaEl);

		const actions = append(wrap, $('.chat-media-actions'));

		// 右上角：放大（在中间栏编辑器打开）
		const zoomBtn = append(actions, $('button.chat-media-btn.zoom')) as HTMLButtonElement;
		zoomBtn.type = 'button';
		zoomBtn.title = '在编辑器中打开';
		zoomBtn.textContent = '⤢';
		this._register(addDisposableListener(zoomBtn, EventType.CLICK, (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (!this._onOpenMedia) { return; }
			this._onOpenMedia({ src, kind, title });
		}));

		// 右下角：下载
		const dlBtn = append(actions, $('button.chat-media-btn.download')) as HTMLButtonElement;
		dlBtn.type = 'button';
		dlBtn.title = '下载';
		dlBtn.textContent = '⭳';
		this._register(addDisposableListener(dlBtn, EventType.CLICK, (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			this._downloadMedia(src, this._mediaFilename(src, kind));
		}));

		return wrap;
	}

	/** 触发下载（a[download]）。需挂到文档内 —— 部分环境下脱离 DOM 的 click() 不生效。 */
	private _downloadMedia(src: string, filename: string): void {
		const a = document.createElement('a');
		a.href = src;
		a.download = filename;
		a.rel = 'noopener';
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	/** 从 src 推断下载文件名（实现见模块级 `mediaDownloadFilename`，便于单测）。 */
	private _mediaFilename(src: string, kind: string): string {
		return mediaDownloadFilename(src, kind);
	}

	protected override _createNodeCard(
			sa: ILiveWorkflowSubAgent,
			interactions?: ILiveWorkflowNodeInteraction[],
		): HTMLElement {
			const isRunning = sa.status === 'running';
			const isDone = sa.status === 'done';
			const isError = sa.status === 'error';

			// ★ 动态表情包三阶段（2026-09-12 用户需求「同步完善工作流工具卡片中动态
			//   表情包阶段的卡片 UI」）：阶段链状态由「快照 port + 进度文案」推断
			//   （纯函数见 subAgentCardUtils）——执行器逐格归档 video/matte/output，
			//   卡片据此显示 ①②③ 各阶段是否已有产物 + 当前跑到哪一阶段。
			const aeSnap = (sa as { snapshot?: Array<{ port?: unknown }> }).snapshot;
			const aeStage = isAnimatedEmojiCard((sa as { type?: string }).type, sa.name)
				? computeAnimatedEmojiStageState(aeSnap, sa.progressMessage)
				: undefined;

			const card = $('.node-card');
			card.classList.add(sa.status); // running | done | error | pending | cancelled

			// ── Collapse state (persists across re-renders) ──
			// ★ 待配置表单不可被折叠隐藏（2026-09-11）：表单内嵌进本卡后，若用户此前折叠过
			//   该节点卡，待办表单会被 nodeBody 的 display:none 一起隐藏 → 工作流看起来「卡住」
			//   而用户找不到要填的东西。故存在待办交互时**强制展开**（用户仍可在提交后折叠）。
			const hasPendingInteraction = (interactions ?? []).some(i => i.status === 'pending');
			const userCollapsed = this._nodeCollapsedState.get(sa.id) === true && !hasPendingInteraction;
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
			// ★ P0 修复（2026-09-13）：优先用 host 按**节点描述符**推导的图标
			//   （stage kind → 产物语义，与画布卡片一致）；缺省回退上面的 4 项表
			//   —— 该表按 nodeType 索引，除 agent/prompt/skill/tool 外一律 🤖，
			//   是「同一节点在画布与聊天卡显示不同」的一个根因。历史消息无 icon 字段。
			iconEl.textContent = (sa as any).icon ?? tInfo.icon;

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
			// ★ 生成进度（2026-09-11 用户需求：画布生成进度实时同步到对应阶段卡）：
			//   由 `node_progress` trace 驱动（画布 direct stage run 的进度经 host 回流）。
			//   仅**运行中**显示百分比与进度条 —— 完成后隐藏，避免「100%」残留误导。
			const progressPct = isRunning && typeof sa.progress === 'number' && Number.isFinite(sa.progress)
				? Math.max(0, Math.min(100, Math.round(sa.progress)))
				: null;
			if (progressPct !== null) {
				append(statusEl, $('span.node-progress', undefined, `${progressPct}%`));
			}
			// ★ 两阶段进度文案（2026-09-11）：画布执行器随进度上报「阶段① 视频抠像 ·
			//   格 3/9」/「阶段② GIF 输出 · 格 3/9」——卡片头直接显示，用户能分辨当前
			//   跑的是哪个阶段（此前只有百分比，分不清「在生成视频」还是「在转 GIF」）。
			const stageMsg = isRunning && typeof sa.progressMessage === 'string' && sa.progressMessage
				? sa.progressMessage
				: '';
			if (stageMsg) {
				const msgEl = append(statusEl, $('span.node-progress-msg', undefined, stageMsg));
				msgEl.title = stageMsg;
			}
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

			// ── 进度条（运行中，位于 header 之下）──
			//   放在 nodeBody **之外**：节点卡折叠时进度仍可见（用户正是想「随时看到生成到哪了」）。
			if (progressPct !== null) {
				const bar = append(card, $('.node-progress-bar'));
				const fill = append(bar, $('.node-progress-bar-fill'));
				fill.style.width = `${progressPct}%`;
				if (sa.progressMessage) { bar.title = sa.progressMessage; }
			}

			// ── 动态表情包阶段链（2026-09-12）──
			//   同样放在 nodeBody 之外：折叠时也能看到「① 生成视频 / ② 视频抠像 /
			//   ③ GIF 输出」各自是否已有产物，以及当前跑到哪一步。
			if (aeStage) {
				const row = append(card, $('.ae-stages'));
				for (const st of ANIMATED_EMOJI_STAGES) {
					const done = aeStage.done[st.id];
					const cur = aeStage.current === st.id;
					const chip = append(row, $('span.ae-stage-chip'));
					chip.classList.add(done ? 'done' : 'pending');
					if (cur) { chip.classList.add('current'); }
					chip.textContent = `${st.num} ${st.label}${done ? ` · ${aeStage.counts[st.id]}` : ''}`;
					chip.title = cur
						? `当前阶段：${st.num} ${st.label}`
						: done
							? `${st.num} ${st.label} 已完成（${aeStage.counts[st.id]} 条产物，port=${st.port}）`
							: `${st.num} ${st.label} 尚未执行`;
				}
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
				// ★ 2026-09-19（DOM 密度）：原来传 `undefined` ⇒ 走 `renderMarkdown` 的**默认**代码块渲染器，
				// 它会用 Monaco tokenizer 把代码块拆成**成千个 span**（子代理输出的 JSON/代码动辄上百行 ⇒
				// 单张卡数千节点，是「≈5592 节点/条」的候选主因之一 ✗）。
				// 统一改用面板自己的廉价渲染器（`codeBlockRendererSync`：整块**一个文本节点** ✓），
				// 与主消息路径口径一致；`true` = 流式语义（未闭合围栏自动补全，否则会漏出裸文本 ✗）。
				this._markdownDisposables.set(out, renderMarkdown(md, this._getMarkdownOptions(true), out));
			} else if (isDone && (sa.output || sa.streamedText)) {
				const out = append(nodeBody, $('.node-output.done'));
				const text = sa.output || sa.streamedText || '';
				const md: IMarkdownString = { value: text, isTrusted: true, supportHtml: true };
				const prevDisposable = this._markdownDisposables.get(out);
				if (prevDisposable) { prevDisposable.dispose(); }
				// 同上一处：默认渲染器会 tokenize（节点爆炸）⇒ 用面板的廉价渲染器（已完成 ⇒ 非流式语义 ✓）。
				this._markdownDisposables.set(out, renderMarkdown(md, this._getMarkdownOptions(false), out));
			} else if (isError && sa.error) {
				const out = append(nodeBody, $('.node-output.error'));
				out.textContent = sa.error;
			}

			// ★ 媒体生成结果（2026-09-10；2026-09-12 三阶段分区）：
			//   媒体节点的 output 是引用文本（无预览价值），真正结果在 snapshot
			//   （port/kind/ref）——按 kind 渲染缩略图（image→img、video→video、
			//   audio→audio 标签），ref 统一经 _mediaSrc 转成可用 URL。
			//   分区优先级（**存在更高阶段产物时只显示它**，避免中间产物顶掉最终结果）：
			//     ③ output（GIF）→ ② matte（抠像结果）→ 其余（排除 video）。
			//   ★ **始终排除 port='video'**：绿幕 mp4 的 data URL 常达数 MB，聊天卡
			//     直喂 <video> 会卡顿/黑屏（历史症状「一堆黑屏视频 + 输出计数虚高」）——
			//     需要看原片请到画布阶段① 预览（那里走 blob URL）。
			const mediaSnapAll = (sa as { snapshot?: Array<{ port: string; kind: string; ref: string }> }).snapshot;
			const gifEntries = (mediaSnapAll ?? []).filter(m => m.port === 'output');
			const matteEntries = (mediaSnapAll ?? []).filter(m => m.port === 'matte');
			// ★ P1-3 修复（2026-09-13）：被过滤掉的绿幕原片数量 —— 用于给用户一行说明。
			//   此前是**完全静默**：产物明明存在（画布可见），聊天卡却什么都不显示，
			//   用户会以为「没产出」。排除本身有充分理由（见上），但应告知而非隐藏。
			const hiddenVideoCount = (mediaSnapAll ?? []).filter(m => m.port === 'video').length;
			const mediaSnap = gifEntries.length > 0
				? gifEntries
				: matteEntries.length > 0
					? matteEntries
					: (mediaSnapAll ?? []).filter(m => m.port !== 'video');
			const mediaLabel = gifEntries.length > 0
				? `③ GIF 输出 · ${gifEntries.length} 张`
				: matteEntries.length > 0
					? `② 抠像结果 · ${matteEntries.length} 格（阶段③ 未执行）`
					: '';
			// ★ P1-3（2026-09-13）：被过滤的绿幕原片 → 给一行说明（此前完全静默）。
			//   独立于 mediaSnap 判断 —— 即使**只**有 video 条目（mediaSnap 为空）也要提示，
			//   否则用户看到「什么产物都没有」，而实际产物在画布上是有的。
			if (hiddenVideoCount > 0) {
				append(nodeBody, $('.node-media-label', undefined,
					`已隐藏 ${hiddenVideoCount} 个绿幕原片（体积过大，请在画布阶段① 预览）`));
			}
			if (mediaSnap.length > 0) {
				if (mediaLabel) {
					append(nodeBody, $('.node-media-label', undefined, mediaLabel));
				}
				const mediaWrap = append(nodeBody, $('.node-media'));
				for (const m of mediaSnap) {
					const src = this._mediaSrc(m.ref);
					if (!src) { continue; }
					if (m.kind === 'image') {
						const img = append(mediaWrap, $('img.node-media-thumb')) as HTMLImageElement;
						img.src = src;
						img.alt = m.port || 'output';
						img.loading = 'lazy';
						this._bindOpenInEditor(img, src, m.kind, m.port);
						// ★ 右上角放大 / 右下角下载（2026-09-11 用户需求）
						this._decorateMediaActions(img, src, m.kind, m.port);
					} else if (m.kind === 'video') {
						const video = append(mediaWrap, $('video.node-media-video')) as HTMLVideoElement;
						video.src = src;
						video.controls = true;
						video.muted = true;
						this._bindOpenInEditor(video, src, m.kind, m.port);
						// ★ 视频同样加「放大 / 下载」（2026-09-11 用户需求；下载按钮上移避开控制条）
						this._decorateMediaActions(video, src, m.kind, m.port);
					} else if (m.kind === 'audio') {
						const audio = append(mediaWrap, $('audio.node-media-audio')) as HTMLAudioElement;
						audio.src = src;
						audio.controls = true;
						this._bindOpenInEditor(audio, src, m.kind, m.port);
						// ★ 音频同样加（两个按钮都放右上角，避免压住控制条）
						this._decorateMediaActions(audio, src, m.kind, m.port);
					}
				}
			}
			// 阶段① 只有绿幕原片时：给一行文字提示（视频不内嵌，见上「始终排除 video」）
			if (aeStage && aeStage.counts.video > 0 && mediaSnap.length === 0) {
				append(nodeBody, $('.node-media-label', undefined,
					`① 绿幕原片 · ${aeStage.counts.video} 格（画布阶段① 可预览；阶段②/③ 未执行）`));
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

			// ★ 节点配置 UI 内嵌（2026-09-11 用户需求：「配置 UI 转移到对应的节点卡片内部」）：
			//   放在 nodeBody 末尾（输出之后）—— 待配置时节点还没产出，表单就在卡内直接可填；
			//   已配置时作为该节点的配置历史保留。样式上由 CSS 降级为「卡内分区」
			//   （见 agentChat.css `.node-body .ni-card`），不再是卡中卡。
			for (const it of (interactions ?? [])) {
				nodeBody.appendChild(this._createNodeInteractionCard(it));
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
}
