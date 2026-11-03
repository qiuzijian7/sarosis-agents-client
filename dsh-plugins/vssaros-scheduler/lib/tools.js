// @vssaros/dsh-scheduler — 模型侧工具（自建调度）。
//
// ★ 为什么接管官方的工具名（`schedule_create / list / update / delete`）：官方 bundle 已不再安装，
//   这些工具本来就不存在；保持同名 ⇒ 模型的既有习惯/提示词不用改，将来若恢复官方也不会有两套同名工具。
//
// ⚠ 引擎是**惰性**取的（`getEngine()`）：工具在 apply 阶段就注册，而引擎要等 foundation 就绪才建。
//   执行时还没好 ⇒ 明确报错"调度引擎未就绪"，绝不静默假装成功。

import { randomUUID } from 'node:crypto';

import { describeRule } from './core/task.js';

const RULE_SCHEMA = {
	type: 'object',
	// ★ 2026-11-03（P0-3）：明确"用 time 字符串、不必换算分钟数" —— 这是模型最易错的一步。
	description: '触发规则。kind 六选一：cron（五字段表达式）/ daily（每天）/ weekly（每周，另给 weekdays）/ every（每 N 秒，下限 60）/ at（一次性，另给 at.date）/ after（延迟 N 秒）。时刻用 time:"HH:MM" 给（如 "09:00"），不需要换算成分钟数。timeZone 用 IANA，如 Asia/Shanghai。',
	properties: {
		kind: { type: 'string', enum: ['cron', 'daily', 'weekly', 'every', 'at', 'after'] },
		expression: { type: 'string', description: 'cron 五字段（分 时 日 月 周），如 "0 9 * * 1-5"。不支持 L/W/#/@。' },
		time: { type: 'string', description: 'daily/weekly：本地时刻 "HH:MM"，如 "09:00"（推荐；与 atMinute 二选一）' },
		atMinute: { type: 'integer', description: 'daily/weekly：当天分钟数（0-1439）。**优先用 time 字符串**，只有在手头就是分钟数时才用它。' },
		weekdays: { type: 'array', items: { type: 'integer' }, description: 'weekly：0-6（0=周日）' },
		everySeconds: { type: 'integer', description: 'every：间隔秒数，≥60' },
		afterSeconds: { type: 'integer', description: 'after：延迟秒数，≥1' },
		at: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'HH:MM' } } },
		timeZone: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai' },
	},
	required: ['kind'],
};

const text = value => (typeof value === 'string' ? value.trim() : '');

/** 任务 → 一行人能读的摘要（工具 render 用）。 */
function lineOf(task) {
	const when = Number.isFinite(task?.next?.target)
		? new Date(task.next.target).toISOString().replace('T', ' ').slice(0, 16)
		: '（不再运行）';
	return `${task.id}　${task.status}　${describeRule(task.rule)}　下次 ${when}　${task.title}`;
}

export function registerScheduleTools(ctx, { getEngine }) {
	const needEngine = () => {
		const engine = getEngine();
		if (!engine) {
			throw new Error('调度引擎未就绪（foundation 服务还没注入，或组合里已有别的 schedule 服务）⇒ 任务操作暂不可用');
		}
		return engine;
	};

	ctx.effect(() => ctx.tools.register({
		name: 'schedule_create',
		/**
		 * 工具卡片（对齐官方 dsh-tool-schedule）：聊天里这条调用显示为
		 * 「创建自动化任务」+ 摘要，而不是一坨 JSON。
		 * 取值 card/kind 与官方同款（generic + other/read）。
		 */
		presentCall: (args) => ({
			card: 'generic',
			title: '创建自动化任务',
			kind: 'other',
			rawInput: String(args?.prompt ?? '').slice(0, 200),
		}),
		description: '创建一个自动化任务（定时触发）。kind=prompt 时到点往指定会话投一句话；kind=action 时调用某个服务的方法。规则支持 cron / 每天 / 每周 / 固定间隔 / 一次性时刻 / 延迟。',
		parameters: {
			type: 'object',
			properties: {
				title: { type: 'string', description: '任务名称' },
				kind: { type: 'string', enum: ['prompt', 'action'], description: '默认 prompt' },
				rule: RULE_SCHEMA,
				prompt: { type: 'string', description: 'kind=prompt 必填：到点投给会话的内容' },
				sessionId: { type: 'string', description: 'kind=prompt：投递目标会话。默认 = 当前会话（不需要传）；只在要投到别的会话时才显式给。' },
				action: {
					type: 'object',
					description: 'kind=action 必填',
					properties: {
						service: { type: 'string' },
						method: { type: 'string' },
						args: { type: 'object', additionalProperties: true },
					},
					required: ['service', 'method'],
				},
				workItem: {
					type: 'object',
					description: '可选：把每次触发映射成一条 work item（复用 workitem 内核做去重/退避）',
					properties: {
						dedupe: { type: 'string', enum: ['forever', 'per-day', 'off'] },
						keyTemplate: { type: 'string', description: '可用 {id} {date} {seq} 占位符' },
					},
				},
			},
			required: ['title', 'rule'],
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					id: { type: 'string' },
					title: { type: 'string' },
					kind: { type: 'string' },
					ruleText: { type: 'string' },
					next: { type: 'string' },
					sessionId: { type: 'string' },
					warn: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: [
					`已创建 ${value.id}「${value.title}」`,
					value.ruleText,
					`下一次：${value.next}`,
					// ★ 2026-11-03：把"投到哪"说清楚（没绑会话就不会投递，别让用户以为已经生效）。
					value.kind === 'prompt'
						? (value.sessionId ? `投递到会话：${value.sessionId}` : '⚠ 没有绑定会话 ⇒ 到点只记历史、不会投递')
						: `触发类型：${value.kind}（到点由对应通道执行）`,
					// 拿不到会话时的告警与诊断（只在失败路径出现）——让模型如实转述、也方便下次定位。
					value.warn || null,
					// ★ P0-2：给出"去哪看/怎么跳" —— 不贴裸 URL（聊天里多半不可点），
					//   而是告诉用户入口与可用的跳转函数（前端已暴露 `__vssarosSchedulerFocus`）。
					`查看/编辑：侧栏工作台「自动化任务」（或 window.__vssarosSchedulerFocus('${value.id}') 直接定位）`,
				].filter(Boolean).join('\n'),
			}],
		},
		isConcurrencySafe: () => false,
		/**
		 * ★★ 2026-11-03（P0-2，对齐官方 `dsh-tool-schedule`）：**当前会话由执行上下文给**。
		 *
		 * 官方是 `ctx.schedule.create(agent.session.id, args, signal)` —— 模型从头到尾不需要、
		 * 也不应该知道 sessionId。我们此前把 `sessionId` 做成必填参数 ⇒ 模型在聊天里要么编一个
		 * 假 id（建出来的任务永远不会投递），要么干脆不敢建。这是"聊天框里创建不了自动化任务"
		 * 的头号原因，比时间换算更致命。
		 *
		 * 现在的取值顺序：`args.sessionId`（显式覆盖，跨会话投递）→ `exec.agent.session.id`。
		 */
		async execute(args = {}, exec) {
			const engine = needEngine();
			const callerSessionId = String(exec?.agent?.session?.id ?? exec?.sessionId ?? '').trim();
			const sessionId = text(args.sessionId) || callerSessionId;
			const kind = text(args.kind) || 'prompt';
			// ★★ 2026-11-03 真机修正：**不再因为拿不到会话就整体失败**。
			//   产物版 runtime（rc.2）里 `exec.agent` 是**可选**的（dsh-tools 有 `exec.agent === void 0` 的专门分支），
			//   真机上这一版确实取不到 ⇒ 旧写法直接抛错 ⇒ 模型判定"创建失败"并**反复重试**（聊天里连调两次，很吵）。
			//   现在的取舍：拿不到会话也**把任务建出来**（sessionId 留空、不猜），并在结果里明确告警 +
			//   附带一条诊断（exec 的实际形状），让模型能如实转述，也让我们下次能据此定位。
			const noSession = kind === 'prompt' && !sessionId;
			const diag = noSession
				? (exec === undefined
					? 'exec=undefined（框架没传执行上下文）'
					: `exec=${Object.keys(exec).join('/') || '(空)'}；agent=${exec.agent === undefined ? 'undefined' : Object.keys(exec.agent ?? {}).join('/')}`)
				: '';
			const id = `t-${randomUUID().slice(0, 8)}`;
			const task = engine.create({
				id,
				title: text(args.title) || '未命名任务',
				kind,
				rule: args.rule ?? {},
				...(args.prompt ? { prompt: text(args.prompt) } : {}),
				...(sessionId ? { sessionId } : {}),
				...(args.action ? { action: args.action } : {}),
				...(args.workItem ? { workItem: args.workItem } : {}),
			});
			return {
				id: task.id,
				title: task.title,
				kind: task.kind,
				...(noSession
					? { warn: `⚠ 这个回合拿不到会话上下文（${diag}）⇒ 任务已创建但**未绑定会话，到点不会投递**。请让用户到「自动化任务」工作台打开这条任务、点「用当前会话」补上。` }
					: {}),
				ruleText: describeRule(task.rule),
				next: Number.isFinite(task?.next?.target) ? new Date(task.next.target).toISOString() : '（无）',
				// 明确告诉模型"投到哪"——它随后可以据此对用户解释（而不是含糊地说"建好了"）。
				sessionId: task.sessionId ?? '',
			};
		},
	}));

	ctx.effect(() => ctx.tools.register({
		name: 'schedule_list',
		/**
		 * 工具卡片（对齐官方 dsh-tool-schedule）：聊天里这条调用显示为
		 * 「查看自动化任务」+ 摘要，而不是一坨 JSON。
		 * 取值 card/kind 与官方同款（generic + other/read）。
		 */
		presentCall: (args) => ({
			card: 'generic',
			title: '查看自动化任务',
			kind: 'read',
			rawInput: '',
		}),
		description: '列出全部自动化任务：类型、状态、规则、下一次运行时刻、上次结果。',
		parameters: {
			type: 'object',
			properties: { limit: { type: 'integer', description: '最多几条（默认 50）' } },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					count: { type: 'integer' },
					tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.count === 0
					? '还没有自动化任务。'
					: `${value.count} 个任务：\n${(value.tasks ?? []).map(lineOf).join('\n')}`,
			}],
		},
		isConcurrencySafe: () => true,
		async execute(args = {}) {
			const engine = needEngine();
			const limit = Math.min(200, Math.max(1, Number.isInteger(args.limit) ? args.limit : 50));
			const tasks = engine.catalog({ limit });
			return { count: tasks.length, tasks };
		},
	}));

	ctx.effect(() => ctx.tools.register({
		name: 'schedule_update',
		/**
		 * 工具卡片（对齐官方 dsh-tool-schedule）：聊天里这条调用显示为
		 * 「修改自动化任务」+ 摘要，而不是一坨 JSON。
		 * 取值 card/kind 与官方同款（generic + other/read）。
		 */
		presentCall: (args) => ({
			card: 'generic',
			title: '修改自动化任务',
			kind: 'other',
			rawInput: String(args?.title ?? args?.id ?? ''),
		}),
		description: '改一个自动化任务：暂停/恢复（status）、改名称、改规则。改规则会重算下一次运行时刻。',
		parameters: {
			type: 'object',
			properties: {
				id: { type: 'string' },
				status: { type: 'string', enum: ['active', 'paused', 'ended'] },
				title: { type: 'string' },
				rule: RULE_SCHEMA,
			},
			required: ['id'],
		},
		output: {
			schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, status: { type: 'string' }, ruleText: { type: 'string' } } },
			render: (_args, value) => [{ type: 'text', text: `${value.id}　${value.status}　${value.ruleText}` }],
		},
		isConcurrencySafe: () => false,
		async execute(args = {}) {
			const engine = needEngine();
			const patch = {};
			if (args.status) { patch.status = text(args.status); }
			if (args.title) { patch.title = text(args.title); }
			if (args.rule) { patch.rule = args.rule; }
			const task = engine.update(text(args.id), patch);
			if (!task) { throw new Error(`找不到任务：${text(args.id)}`); }
			return { id: task.id, status: task.status, ruleText: describeRule(task.rule) };
		},
	}));

	ctx.effect(() => ctx.tools.register({
		name: 'schedule_delete',
		/**
		 * 工具卡片（对齐官方 dsh-tool-schedule）：聊天里这条调用显示为
		 * 「删除自动化任务」+ 摘要，而不是一坨 JSON。
		 * 取值 card/kind 与官方同款（generic + other/read）。
		 */
		presentCall: (args) => ({
			card: 'generic',
			title: '删除自动化任务',
			kind: 'other',
			rawInput: String(args?.id ?? ''),
		}),
		description: '删除一个自动化任务（不可恢复）。',
		parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
		output: {
			schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, deleted: { type: 'boolean' } } },
			render: (_args, value) => [{ type: 'text', text: value.deleted ? `已删除 ${value.id}` : `没找到 ${value.id}` }],
		},
		isConcurrencySafe: () => false,
		async execute(args = {}) {
			const engine = needEngine();
			const deleted = engine.remove(text(args.id));
			return { id: text(args.id), deleted };
		},
	}));

	ctx.effect(() => ctx.tools.register({
		name: 'schedule_history',
		/**
		 * 工具卡片（对齐官方 dsh-tool-schedule）：聊天里这条调用显示为
		 * 「查看运行记录」+ 摘要，而不是一坨 JSON。
		 * 取值 card/kind 与官方同款（generic + other/read）。
		 */
		presentCall: (args) => ({
			card: 'generic',
			title: '查看运行记录',
			kind: 'read',
			rawInput: String(args?.id ?? ''),
		}),
		description: '查看某个自动化任务的投递历史（最近 N 次触发的时刻与序号）。',
		parameters: {
			type: 'object',
			properties: { id: { type: 'string' }, limit: { type: 'integer', description: '默认 20' } },
			required: ['id'],
		},
		output: {
			schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, records: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
			render: (_args, value) => [{
				type: 'text',
				text: (value.records ?? []).length === 0
					? `${value.id} 还没有投递记录。`
					: `${value.id} 最近 ${value.records.length} 次：\n${value.records.map(r => `  #${r.seq}　${new Date(r.at).toISOString().replace('T', ' ').slice(0, 19)}${r.manual ? '　（手动）' : ''}`).join('\n')}`,
			}],
		},
		isConcurrencySafe: () => true,
		async execute(args = {}) {
			const engine = needEngine();
			const limit = Math.min(100, Math.max(1, Number.isInteger(args.limit) ? args.limit : 20));
			const records = engine.history({ id: text(args.id), limit });
			return { id: text(args.id), records };
		},
	}));
}
