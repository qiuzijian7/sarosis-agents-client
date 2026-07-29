import { $, append, clearNode, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { IToolCall, ISubAgentData } from './agentChatTypes.js';
import { formatSubAgentTask, cleanTracePreview, filterChildSubAgents } from './subAgentCardUtils.js';
import { AgentChatPanelFileCards } from './agentChatPanel.fileCards.js';

/** 自 agentChatPanel.toolCards.ts 抽离（上帝对象拆分）。继承链见继承父类。 */
export abstract class AgentChatPanelDelegateCards extends AgentChatPanelFileCards {

	/**
	 * _createPlanCard 抽象方法实现（AgentChatPanelBase 声明）。
	 * update_plan 工具卡与 plan_explore/plan_enter/plan_exit 共用 _createPlanWorkflowCard。
	 */
	protected override _createPlanCard(tc: IToolCall): HTMLElement {
		return this._createPlanWorkflowCard(tc, 'update_plan');
	}

	/**
	 * 计划/编排类工具卡片：plan_explore / plan_enter / plan_exit / update_plan。
	 * 使用 VS Code 原生 DOM 构建（$ / append / textContent），零 innerHTML。
	 */
	/**
	 * 计划/编排类工具卡片：plan_explore / plan_enter / plan_exit / update_plan。
	 * 使用 Void 统一壳（.tool-header-wrapper，与 void-tool-card.css 对齐）+ 原生 DOM 构建。
	 */
	protected override _createPlanWorkflowCard(tc: IToolCall, key: string): HTMLElement {
		const isRunning = tc.status === 'running';
		const isErr = tc.status === 'error';
		const isDone = tc.status === 'success';

		// 状态驱动外壳类（与 void-tool-card.css 对齐）
		let statusClass = 'tool-card-success';
		if (isErr) { statusClass = 'tool-card-error'; }
		else if (isRunning) { statusClass = 'tool-card-running'; }

		// Void 统一壳
		const wrapper = $(`.tool-header-wrapper.${statusClass}.tool-card-plan`);
		// data-tool-id 用于增量更新查重（与 _appendToolCard 一致）
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }
		// 默认展开（计划卡内容应直接可见）
		wrapper.classList.add('expanded');

		const header = append(wrapper, $('.tool-header'));
		const row = append(header, $('.tool-header-row'));

		// ── 左侧：chevron + 图标 + 标题 ──
		const left = append(row, $('.tool-header-left'));
		const titleContainer = append(left, $('.tool-header-title-container.tool-header-title-clickable'));
		this._svgChevron(titleContainer, 'tool-header-chevron', 14);

		const iconEl = append(titleContainer, $('span.tool-header-icon'));
		const iconMap: Record<string, string> = {
			plan_explore: isRunning ? '🔍' : (isErr ? '🔍❌' : '🔍✅'),
			plan_enter: '📋',
			plan_exit: '✅',
			update_plan: '📝',
		};
		iconEl.textContent = iconMap[key] || '📋';

		const titleEl = append(titleContainer, $('span.tool-header-title'));
		const stageMap: Record<string, string> = {
			plan_explore: '任务分析',
			plan_enter: '进入计划模式',
			plan_exit: '退出计划模式',
			update_plan: '更新计划',
		};
		titleEl.textContent = stageMap[key] || '计划编排';
		if (isRunning) { titleEl.classList.add('shimmer'); }

		// ── 右侧：状态 pill / 进度计数 ──
		const right = append(row, $('span.tool-header-right'));

		// ── 参数 + 结果解析 ──
		let args: any = {};
		try { if (tc.args) { args = JSON.parse(tc.args); } } catch { /* ignore */ }

		// ── body（dropdown）──
		const body = append(header, $('.tool-header-children'));

		if (key === 'plan_explore') {
			// ── 任务分析卡片：显示目标 + 探索方向 + 产出 ──
			if (args.goal) {
				const goalEl = append(body, $('.plan-goal'));
				goalEl.textContent = `🎯 目标: ${String(args.goal).slice(0, 200)}`;
			}
			if (Array.isArray(args.areas) && args.areas.length > 0) {
				const areasEl = append(body, $('.plan-areas'));
				areasEl.textContent = `探索方向 (${args.areas.length}):`;
				const list = append(areasEl, $('ul.plan-area-list'));
				for (const area of args.areas.slice(0, 5)) {
					const li = append(list, $('li'));
					// area 是对象 {title, focus, files} —— String(obj) 会变成 "[object Object]"，
					// 必须显式取可读字段；缺失时退回 focus/JSON，保留信息可读。
					const areaText =
						(area && typeof area === 'object')
							? (area.title || area.focus || (() => { try { return JSON.stringify(area); } catch { return '(invalid area)'; } })())
							: String(area);
					li.textContent = `• ${String(areaText).slice(0, 80)}`;
				}
			}
			// 结果区：子代理执行详情内嵌到 plan_explore 卡片内（路径 A：tool.subAgents 下挂），
			// 与 delegate_task 一致；此处仅保留 result 摘要文本（剥 JSON 包装）。
			if (tc.result && !isRunning) {
				// 回退：原 result 摘要，剥 JSON 包装 [{type:"text",text:"..."}]
				const resultText = (() => {
					const raw = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result);
					try {
						const arr = JSON.parse(raw);
						if (Array.isArray(arr) && arr[0]?.type === 'text' && typeof arr[0].text === 'string') {
							return arr[0].text;
						}
					} catch { /* not JSON, keep raw */ }
					return raw;
				})();
				const summary = append(body, $('.plan-result-summary'));
				const lines = resultText.split('\n').filter((l: string) => l.trim()).slice(0, 4);
				summary.textContent = lines.join(' | ').slice(0, 300);
			} else if (isRunning) {
				const progress = append(body, $('.plan-progress'));
				progress.textContent = '⏳ 正在分析任务并探索代码库...';
			}
			// 内嵌子代理执行详情（路径 A），与 delegate_task 一致。
			this._renderSubAgentsInside(body, tc);
			right.textContent = isRunning ? '分析中…' : '已分析';
		} else if (key === 'plan_enter') {
			// ── 进入计划模式 ──
			if (isDone) {
				const info = append(body, $('.plan-mode-info'));
				info.textContent = '已进入计划模式 — Agent 将先制定计划再执行';
			} else if (isRunning) {
				const progress = append(body, $('.plan-progress'));
				progress.textContent = '⏳ 正在切换到计划模式...';
			}
			right.textContent = isRunning ? '切换中…' : (isDone ? '已进入' : '');
		} else if (key === 'plan_exit') {
			// ── 退出计划模式：显示计划摘要 ──
			if (isDone && args.plan) {
				const planEl = append(body, $('.plan-exit-summary'));
				const planText = typeof args.plan === 'string' ? args.plan : JSON.stringify(args.plan, null, 2);
				planEl.textContent = planText.slice(0, 500);
			} else if (isDone) {
				const info = append(body, $('.plan-mode-info'));
				info.textContent = '计划已确认 — 开始执行';
			} else if (isRunning) {
				const progress = append(body, $('.plan-progress'));
				progress.textContent = '⏳ 等待计划确认...';
			}
			right.textContent = isRunning ? '等待确认…' : (isDone ? '已确认' : '');
		} else if (key === 'update_plan') {
			// ── 更新计划（Void 风格）：进度条 + 步骤列表（.plan-card-* 样式）──
			const plan = Array.isArray(args.plan) ? args.plan : [];
			const doneN = plan.filter((s: any) => s?.status === 'completed').length;
			const total = plan.length;

			// 右侧状态：N/M 已完成 / 更新中…
			if (total > 0) {
				right.textContent = `${doneN}/${total} 已完成`;
			} else if (isRunning) {
				right.textContent = '更新中…';
			} else {
				right.textContent = '已更新';
			}

			// 进度条（Void .plan-card-progress）
			if (total > 0) {
				const pct = Math.round((doneN / total) * 100);
				const progress = append(body, $('.plan-card-progress'));
				const bar = append(progress, $('.plan-card-progress-bar'));
				bar.style.width = `${pct}%`;
			}

			// 步骤列表（Void .plan-card-step）
			const planSource = total > 0 ? plan
				: (() => { try { const ro = typeof tc.result === 'string' ? JSON.parse(tc.result) : tc.result; return ro?.details?.plan || []; } catch { return []; } })();
			if (planSource.length > 0) {
				const steps = append(body, $('.plan-card-steps'));
				for (const s of planSource.slice(0, 20)) {
					const status = s?.status || 'pending';
					const stepEl = append(steps, $(`.plan-card-step.step-${status}`));
					const dot = append(stepEl, $('span.plan-card-step-dot'));
					dot.textContent = status === 'completed' ? '✓' : (status === 'in_progress' ? '●' : '○');
					if (status === 'in_progress') { dot.classList.add('pulse'); }
					append(stepEl, $('span.plan-card-step-text')).textContent = String(s?.step || '').slice(0, 200);
				}
			} else if (isRunning) {
				const ph = append(body, $('.plan-card-progress-placeholder'));
				ph.textContent = '⏳ 正在更新计划...';
			}

			// explanation（footer）
			const expl = args.explanation
				|| (() => { try { const ro = typeof tc.result === 'string' ? JSON.parse(tc.result) : tc.result; return ro?.details?.explanation; } catch { return undefined; } })();
			if (expl) {
				const footer = append(body, $('.plan-card-footer'));
				append(footer, $('span.plan-card-footer-icon')).textContent = 'ℹ';
				append(footer, $('span.plan-card-footer-text')).textContent = String(expl).slice(0, 400);
			}
		}

		// 时长（可选，右侧）
		if (typeof tc.duration === 'number') {
			const dur = append(right, $('span.tool-header-duration'));
			dur.textContent = this._formatDuration(tc.duration);
		}

		// 点击标题折叠/展开（与 searchCard 一致）
		titleContainer.addEventListener('click', () => {
			const isExpanded = wrapper.classList.toggle('expanded');
			const chev = titleContainer.querySelector('.tool-header-chevron');
			if (chev) { chev.classList.toggle('expanded', isExpanded); }
		});

		return wrapper;
	}

	/**
	 * 委派/子Agent 工具卡片：delegate_task / transfer_to_agent / new_agent。
	 * 仅显示一行标题（图标 + 标题 + 子Agent名 + 状态），无展开/无 body。
	 */
	protected override _createDelegateTaskCard(tc: IToolCall, key: string): HTMLElement {
	let isRunning = tc.status === 'running';
	const isErr = tc.status === 'error';
	let isDone = tc.status === 'success' || (!isRunning && !isErr && tc.status !== 'approval_required' && tc.status !== 'rejected' && tc.status !== 'canceled');

	// 若子代理仍有 running，强制 delegate 状态为「执行中」（父 tc.status 可能滞后）
	if (!isRunning && !isErr) {
		const subs = filterChildSubAgents(tc.subAgents, tc.id);
		if (subs.some((s: any) => s.status === 'running')) {
			isRunning = true;
			isDone = false;
		}
	}

		// 解析参数：子Agent名 / 任务指令 / 任务名
		let args: any = {};
		try { if (tc.args) { args = JSON.parse(tc.args); } } catch { /* ignore */ }

		const subAgentName = args.role || args.agent || args.agent_name || args.type || '';
		const instruction = args.task || args.instruction || args.goal || args.description || args.prompt || args.message || '';
		const parsedName = (args.title || args.task_title || (instruction ? String(instruction).split('\n')[0].trim().slice(0, 80) : '')) as string;

		const titleMap: Record<string, string> = {
			delegate_task: '委派任务',
			transfer_to_agent: '转移任务',
			new_agent: '子代理',
		};
		const baseLabel = titleMap[key] || (tc.displayName || key);
		// 格式：委派任务：{agentname}：{任务名称}
		const titleParts = [baseLabel];
		if (subAgentName) { titleParts.push(subAgentName); }
		if (parsedName) { titleParts.push(parsedName); }
		const titleText = titleParts.join('：');

		const statusClass = isErr ? 'tool-card-error'
			: tc.status === 'approval_required' ? 'tool-card-approval'
				: tc.status === 'rejected' ? 'tool-card-rejected'
				: tc.status === 'canceled' ? 'tool-card-canceled'
					: 'tool-card-success';

		const wrapper = $(`.tool-header-wrapper.${statusClass}.tool-card-delegate`);
		if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }

		// ── Header（图标顶头 + 标题 + 子Agent + 状态）──
		const header = append(wrapper, $('.tool-header'));
		const row = append(header, $('.tool-header-row'));
		const left = append(row, $('.tool-header-left'));

		const chevron = this._svgChevron(left, 'tool-header-chevron', 14);

		const iconEl = append(left, $('span.tool-header-icon'));
		iconEl.textContent = '🤖';

		const titleContainer = append(left, $('.tool-header-title-container.tool-header-title-clickable'));
		const titleEl = append(titleContainer, $('span.tool-header-title'));
		titleEl.textContent = titleText;
		if (isRunning) { titleEl.classList.add('shimmer'); }

		// desc1 仅在 subAgentName 未嵌入主标题时补充（当前 titleParts 已含 subAgentName，故默认不重复）
		// 若需额外信息（如 agent type），可在此处扩展

		const right = append(row, $('.tool-header-right'));
		// 并行聚合计数（静态，非状态）：仅 fan-out（>1 子代理）时展示，
		// 逐子代理状态 UI 已下移到独立 subagent 卡片（2026-07-27 重构）。
		const subsForAgg = tc.subAgents ?? [];
		if (subsForAgg.length > 1) {
			const count = append(right, $('span.dlg-parallel-count'));
			count.textContent = `并行 ×${subsForAgg.length}`;
		}
		// 状态 pill（运行/完成/失败/待确认/已拒绝/已取消）
		let pillClass = 'done';
		let pillText = '完成';
		if (isRunning) { pillClass = 'running'; pillText = '执行中'; }
		else if (isErr) { pillClass = 'error'; pillText = '失败'; }
		else if (tc.status === 'approval_required') { pillClass = 'approval'; pillText = '待确认'; }
		else if (tc.status === 'rejected') { pillClass = 'rejected'; pillText = '已拒绝'; }
		else if (tc.status === 'canceled') { pillClass = 'canceled'; pillText = '已取消'; }
		else if (isDone) { pillClass = 'done'; pillText = '完成'; }
		const pill = append(right, $(`.status-pill.status-pill-${pillClass}`));
		if (pillClass === 'running') { append(pill, $('span.status-pill-dot')); }
		append(pill, $('span')).textContent = pillText;
		if (typeof tc.duration === 'number') {
			append(right, $('span.tool-header-duration')).textContent = this._formatDuration(tc.duration);
		}


		// 展开体：单个可滚动列表（任务指令 / 执行列表 / 执行结果）
		const body = append(wrapper, $('.tool-header-children'));
		const scroll = append(body, $('div.delegate-scroll'));

		// ① 任务指令
		if (instruction) {
			const sec = append(scroll, $('div.du-sec'));
			const label = append(sec, $('div.du-sec-label'));
			append(label, $('span.du-tick'));
			append(label, $('span')).textContent = '任务指令';
			const instr = append(sec, $('div.du-instr'));
			this._renderMarkdownContent(instr, String(instruction).slice(0, 4000), false);
		}

		// ② 执行列表（扁平工具步骤，跨所有子代理）
		const childSubs = filterChildSubAgents(tc.subAgents, tc.id);
		const allTraces: any[] = [];
		for (const sa of childSubs) {
			const tr = sa.toolTraces;
			if (tr) { for (const t of tr) { allTraces.push(t); } }
		}
		const listSec = append(scroll, $('div.du-sec'));
		const listLabel = append(listSec, $('div.du-sec-label'));
		append(listLabel, $('span.du-tick'));
		append(listLabel, $('span')).textContent = '执行列表';
		if (allTraces.length > 0) {
			const list = append(listSec, $('ul.du-steps'));
			for (const t of allTraces) {
				const cls = t.status === 'error' ? 'fail' : t.status === 'running' ? 'running' : 'ok';
				const li = append(list, $(`.du-step.${cls}`));
				append(li, $('span.du-step-name')).textContent = this._getToolTitle(t.name, undefined, t.name, false);
				const raw = t.args ?? t.result;
				if (raw != null) {
					append(li, $('span.du-step-detail')).textContent = cleanTracePreview(
						typeof raw === 'string' ? raw : JSON.stringify(raw), 120);
				}
			}
		} else if (isRunning) {
			const hint = append(listSec, $('div.du-hint'));
			append(hint, $('span.delegate-spinner-dot'));
			append(hint, $('span.delegate-spinner-dot'));
			append(hint, $('span.delegate-spinner-dot'));
			append(hint, $('span')).textContent = '子 Agent 正在执行任务…';
		}

		// ③ 执行结果（子代理实际 output）
		const resSec = append(scroll, $('div.du-sec'));
		const resLabel = append(resSec, $('div.du-sec-label'));
		append(resLabel, $('span.du-tick'));
		append(resLabel, $('span')).textContent = '执行结果';
		const resWrap = append(resSec, $('div.du-results'));
		if (childSubs.length > 0) {
			// 仍有子代理在执行中：暂不展示任何执行结果（避免未完成子代理的片段/占位误导用户）。
			// 待所有子代理进入终态（done/error/cancelled）后再渲染结果，符合「未执行完毕不显示结果」。
			const anySubRunning = childSubs.some((s: any) => s.status === 'running');
			if (anySubRunning) {
				append(resWrap, $('div.du-output-empty')).textContent = '（子 Agent 执行中，完成后展示执行结果…）';
			} else {
				for (const sa of childSubs) {
					const r = append(resWrap, $('div.du-result'));
					const rhead = append(r, $('div.du-result-head'));
					const badgeLetter = sa.type === 'explore' ? 'E' : sa.type === 'scout' ? 'S' : 'G';
					const badge = append(rhead, $('span.du-result-badge'));
					badge.textContent = badgeLetter;
					if (sa.type) { badge.classList.add(`du-badge-${sa.type}`); }
					append(rhead, $('span.du-result-role')).textContent = sa.type || 'agent';
					append(rhead, $('span.du-result-task')).textContent = formatSubAgentTask(sa.task, '');
					const stText = sa.status === 'running' ? '执行中' : sa.status === 'done' ? '完成'
						: sa.status === 'error' ? '失败' : sa.status === 'cancelled' ? '已取消' : '等待';
					const stCount = sa.toolTraces?.length ? ` · ${sa.toolTraces.length} 步` : '';
					append(rhead, $('span.du-result-st')).textContent = stText + stCount;
					const out = append(r, $('div.du-output'));
					if (sa.output) {
						out.textContent = sa.output.slice(0, 4000);
					} else if (sa.error) {
						out.classList.add('error');
						out.textContent = `错误：${sa.error.slice(0, 2000)}`;
					} else if (sa.status === 'running') {
						out.classList.add('du-output-empty');
						out.textContent = '（执行中 · 暂无可输出结果）';
					} else {
						out.classList.add('du-output-empty');
						out.textContent = '（无输出）';
					}
				}
			}
		} else {
			// 无子代理：回退 result / error / running
			if (isErr && tc.error) {
				append(resWrap, $('div.du-output.error')).textContent = tc.error.slice(0, 4000);
			} else if (tc.result) {
				append(resWrap, $('div.du-output')).textContent = cleanTracePreview(String(tc.result), 4000);
			} else if (isRunning) {
				append(resWrap, $('div.du-output-empty')).textContent = '（执行中…）';
			}
		}

		// ── 点击展开/折叠（并记忆状态，跨流式重建保持）──
		const toggle = () => {
			const nowExpanded = body.classList.toggle('tool-header-children-expanded');
			chevron.classList.toggle('tool-header-chevron-expanded', nowExpanded);
			if (tc.id) { this._toolCallExpandState.set(tc.id, nowExpanded); }
		};
		this._register(addDisposableListener(titleContainer, EventType.CLICK, (e) => {
			if ((e.target as HTMLElement)?.closest?.('button')) { return; }
			e.stopPropagation();
			toggle();
		}));
		this._register(addDisposableListener(chevron, EventType.CLICK, (e) => {
			e.stopPropagation();
			toggle();
		}));

		// 委派/子Agent 卡片默认展开（用户可手动折叠，选择记入 _toolCallExpandState 持久）；
		// 将解析出的展开态写回记忆表，使流式重建/运行结束后续渲染保持一致，不会自动折叠。
		const expanded = this._toolCallExpandState.get(tc.id) ?? true;
		if (tc.id && !this._toolCallExpandState.has(tc.id)) {
			this._toolCallExpandState.set(tc.id, expanded);
		}
		if (expanded) {
			body.classList.add('tool-header-children-expanded');
			chevron.classList.add('tool-header-chevron-expanded');
		}

		return wrapper;
	}

	/**
	 * 路径 A：将子代理执行详情内嵌渲染到工具卡 body（delegate_task / plan_explore 共用）。
	 * 子代理数据来自 tool.subAgents（已按 parentToolCallId 关联）；并按 groupId 分组
	 * （fan-out 并行批次）渲染，每个子代理用 _createSubAgentCard 生成独立子卡。
	 */
	protected _renderSubAgentsInside(container: HTMLElement, tc: IToolCall): void {
		const childSubs = filterChildSubAgents(tc.subAgents, tc.id);
		if (!childSubs || childSubs.length === 0) { return; }

		// 按 groupId 分组（fan-out 并行多批次）
		const groups = new Map<string, ISubAgentData[]>();
		for (const sa of childSubs) {
			const gk = sa.groupId || 'default';
			if (!groups.has(gk)) { groups.set(gk, []); }
			groups.get(gk)!.push(sa);
		}

		for (const [groupId, agents] of groups) {
			if (groups.size > 1) {
				const groupLabel = append(container, $('div.subagent-group-label'));
				groupLabel.textContent = groupId === 'default' ? 'SubAgents' : `批次 ${groupId} (${agents.length} 个任务)`;
			}
			for (const sa of agents) {
				container.appendChild(this._createSubAgentCard(sa));
			}
		}
	}


	/**
	 * C：委派卡片 — 追加单个子代理区（已废弃，2026-07-27 解耦后不再使用）。
	 * 子代理执行详情现由消息流中的独立 subagent 卡片渲染（见 _createSubAgentCard）。
	 * 本方法保留签名以兼容潜在的外部调用，但不再被任何代码路径调用。
	 */
		protected override _createSkillToolCard(tc: IToolCall, key: string): HTMLElement {
			const isRunning = tc.status === 'running';
			const isErr = tc.status === 'error';
			const isDone = tc.status === 'success' || (!isRunning && !isErr && tc.status !== 'approval_required' && tc.status !== 'rejected' && tc.status !== 'canceled');

			const titleMap: Record<string, string> = {
				read_skill: '读取技能',
			list_skills: '列出技能',
			skill_manage: '管理技能',
			};

			const statusClass = isErr ? 'tool-card-error'
				: tc.status === 'approval_required' ? 'tool-card-approval'
					: tc.status === 'rejected' ? 'tool-card-rejected'
						: tc.status === 'canceled' ? 'tool-card-canceled'
							: 'tool-card-success';

			// 解析读取的技能名（兼容多种字段命名）
			let skillName = '';
			try {
				if (tc.args) {
					const args = JSON.parse(tc.args);
					skillName = args.skill || args.name || args.skill_name || args.skillName
						|| args.skillId || args.skill_id || args.id
						|| args.skill_path || args.path
						|| '';
				}
			} catch { /* ignore */ }

			const wrapper = $(`.tool-header-wrapper.${statusClass}.tool-card-skill`);
			if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }

			const header = append(wrapper, $('.tool-header'));
			const row = append(header, $('.tool-header-row'));

			const left = append(row, $('.tool-header-left'));
			/* 无展开箭头：不渲染 chevron（visibility:hidden 会占位导致图标不左对齐） */

			const iconEl = append(left, $('span.tool-header-icon'));
			iconEl.textContent = '🧩';

			const titleContainer = append(left, $('.tool-header-title-container'));
			const titleEl = append(titleContainer, $('span.tool-header-title'));
			const baseLabel = titleMap[key] || (tc.displayName || key);
			titleEl.textContent = skillName ? `${baseLabel} · ${skillName}` : baseLabel;
			if (isRunning) { titleEl.classList.add('shimmer'); }

			const right = append(row, $('.tool-header-right'));
			if (isDone) {
				const check = append(right, $('span.tool-status.tool-status.done'));
				check.textContent = '✓';
			} else if (isErr) {
				const errBadge = append(right, $('span.tool-status.tool-status.error'));
				errBadge.textContent = '✗';
			} else if (isRunning) {
				append(right, $('span.tool-header-loading-dots'));
			}

			return wrapper;
		}

	/**
	 * 计算子代理执行时长（用于独立卡片的「时长」chip）。
	 * 基于 startedAt/completedAt；running 时以当前时间近似。
	 */
	protected _computeSubAgentElapsed(sa: ISubAgentData): string | null {
		if (typeof sa.startedAt !== 'number') { return null; }
		const end = typeof sa.completedAt === 'number' ? sa.completedAt : Date.now();
		const ms = Math.max(0, end - sa.startedAt);
		return this._formatDuration(ms);
	}

	protected override _createSubAgentCard(sa: ISubAgentData): HTMLElement {
		const isRunning = sa.status === 'running';
		const isDone = sa.status === 'done';
		const isError = sa.status === 'error' || sa.status === 'cancelled';

		// Type badge config
		const typeBadge: { letter: string; cls: string } =
			sa.type === 'explore' ? { letter: 'E', cls: 'explore' } :
			sa.type === 'scout'   ? { letter: 'S', cls: 'scout' }   :
			                        { letter: 'G', cls: 'general' };

		// ── Card container ──
		const saCard = $(`.subagent-card${isRunning ? '.running' : ''}${isError ? '.error' : ''}${isDone || isError ? '.collapsed' : '.expanded'}`);
		// data-sa-id：供流式整卡重建时 _preserveStableSubagentNodes / _snapshotSubAgentSections
		// 按 id 精确匹配新旧子代理卡，移栽 title 节点、恢复 trace 滚动，避免闪烁/跳动。
		if (sa.id != null) { saCard.setAttribute('data-sa-id', String(sa.id)); }

		// ── Header ──
		const saHeader = append(saCard, $('.subagent-card-header'));

		// Badge
		const badge = append(saHeader, $('.subagent-card-badge'));
		badge.textContent = typeBadge.letter;

		// Title: {agentName}：{task} — 单行，agent name 小灰 + task 粗体
		const saMeta = append(saHeader, $('.subagent-card-meta'));
		const agentNameEl = append(saMeta, $('span.subagent-card-agent-name'));
		agentNameEl.textContent = (sa.type || 'agent');
		const saTitle = append(saMeta, $(`span.subagent-card-title${isRunning ? '.shimmer' : ''}`));
		saTitle.textContent = `：${formatSubAgentTask(sa.task, '')}`;

		// Status pill
		const statusPill = append(saHeader, $('span.subagent-card-status'));
		statusPill.textContent = isRunning ? '运行中' : isDone ? '完成' : isError ? '失败' : '未知';

		// Chevron
		const chevron = append(saHeader, $('span.subagent-card-chevron'));
		chevron.textContent = '▶';

		// ── 状态相关 UI（2026-07-27 重构：从 delegate_task 卡片下移）──
		const total = sa.toolTraces?.length ?? 0;
		const doneT = sa.toolTraces?.filter(t => t.status === 'done').length ?? 0;

		// 进度条（按自身 done/total 着色，状态无关）
		const bar = append(saCard, $('.subagent-card-progressbar'));
		const fill = append(bar, $('.subagent-card-progressbar-fill'));
		const pct = total > 0 ? Math.round((doneT / total) * 100) : (isDone ? 100 : 0);
		fill.style.width = `${pct}%`;

		// live 进度行（running 常驻，步骤 N/M + 当前动作；CSS 控制显隐）
		const live = append(saCard, $('.subagent-card-live'));
		append(live, $('span.subagent-card-spinner'));
		const liveCounter = append(live, $('span.subagent-card-live-counter'));
		liveCounter.textContent = `步骤 ${doneT}/${total}`;
		const liveText = append(live, $('span.subagent-card-live-text'));
		liveText.textContent = (sa.progress || sa.streamingOutput || '').slice(0, 240) || '执行中…';

		// chip 行（步骤数 + 时长）
		const chips = append(saCard, $('.subagent-card-chips'));
		if (total > 0) {
			append(chips, $('span.chip.steps')).textContent = `${total} 步`;
		}
		const elapsed = this._computeSubAgentElapsed(sa);
		if (elapsed != null) {
			append(chips, $('span.chip.time')).textContent = elapsed;
		}

		// ── Body ──
		const saBody = append(saCard, $('.subagent-card-body'));

		// Thinking (running 时实时显示)
		if (sa.thinking && isRunning) {
			const thinkingEl = append(saBody, $('.subagent-card-thinking'));
			const thinkingLabel = append(thinkingEl, $('span.subagent-card-thinking-label'));
			thinkingLabel.textContent = '🧠 ';
			const thinkingText = append(thinkingEl, $('span.subagent-card-thinking-text'));
			thinkingText.textContent = sa.thinking.slice(-2000);
		}

		// Tool trace
		if (sa.toolTraces && sa.toolTraces.length > 0) {
			const traceSection = append(saBody, $('.subagent-card-trace'));
			const traceHeader = append(traceSection, $('.subagent-card-trace-header'));
			traceHeader.textContent = `🛠 执行过程 · ${sa.toolTraces.length} 步`;

			const traceList = append(traceSection, $('.subagent-card-trace-list'));
			const renderTraceList = () => {
				clearNode(traceList);
				for (const t of sa.toolTraces!) {
					const item = append(traceList, $('.subagent-card-trace-item'));
					const icon = append(item, $('span.subagent-card-trace-icon'));
					icon.textContent = t.status === 'error' ? '✗' : t.status === 'running' ? '⏳' : '✓';
					const nameEl = append(item, $('span.subagent-card-trace-name'));
					nameEl.textContent = this._getToolTitle(t.name, undefined, t.name, false);
			if (t.args || t.result) {
				const detail = append(item, $('span.subagent-card-trace-detail'));
				const raw = t.args ?? t.result;
				// 2026-07-27：统一走 cleanTracePreview（解包 [{"type":"text"}] 协议包装、
				// results/files 数组提取文件路径摘要）——原直接 slice 会显示
				// `[{"type":"text","text":"{\"res` 包装残骸或 results=[…] 折叠态。
				const rawStr = typeof raw === 'string' ? raw
					: raw === null || raw === undefined ? ''
					: JSON.stringify(raw);
				detail.textContent = cleanTracePreview(rawStr, 120);
			}
				}
			};
			renderTraceList();
			// 默认置底（2026-07-27 需求）：新建 trace 列表在挂载后滚到底，展示最新步骤。
			// 重建时此 rAF 先于 _restoreScrollPositionsDeferred 触发，后者会以捕获的用户滚动
			// 位置覆盖——故仅在首次渲染（无捕获）时生效为置底，不干扰「上滚后保持原位」。
			requestAnimationFrame(() => {
				if (traceList.isConnected) { traceList.scrollTop = traceList.scrollHeight; }
			});
		}

		// Output
		if (isDone && sa.output) {
			const outputEl = append(saBody, $('.subagent-card-output'));
			outputEl.textContent = sa.output.slice(0, 4000);
		} else if (isError && sa.error) {
			const errEl = append(saBody, $('.subagent-card-output.error'));
			errEl.textContent = `错误：${sa.error.slice(0, 2000)}`;
		}

		// Progress / streaming
		if (isRunning && sa.progress) {
			append(saBody, $('.subagent-card-progress')).textContent = sa.progress;
		}
		if (isRunning && sa.streamingOutput) {
			append(saBody, $('.subagent-card-streaming')).textContent = sa.streamingOutput.slice(-4000);
		}

		// ── Footer ──
		const saFooter = append(saCard, $('.subagent-card-footer'));
		const traceCount = sa.toolTraces?.length ?? 0;
		const doneCount = sa.toolTraces?.filter(t => t.status === 'done').length ?? 0;
		const runningCount = sa.toolTraces?.filter(t => t.status === 'running').length ?? 0;
		const errCount = sa.toolTraces?.filter(t => t.status === 'error').length ?? 0;

		if (traceCount > 0) {
			const stats = append(saFooter, $('span.subagent-card-stats'));
			if (doneCount > 0) { append(stats, $('span.sa-stat.ok')).textContent = `✓ ${doneCount} 完成`; }
			if (runningCount > 0) { append(stats, $('span.sa-stat.running')).textContent = `⏳ ${runningCount} 运行`; }
			if (errCount > 0) { append(stats, $('span.sa-stat.error')).textContent = `✗ ${errCount} 失败`; }
		}

		// ── Interactions ──
		this._register(addDisposableListener(saHeader, EventType.CLICK, () => {
			saCard.classList.toggle('expanded');
			saCard.classList.toggle('collapsed');
		}));

		return saCard;
	}

}
