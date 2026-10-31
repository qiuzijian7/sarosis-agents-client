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
	description: '触发规则。kind 六选一：cron（五字段表达式）/ daily（每天，给 atMinute）/ weekly（每周，给 weekdays+atMinute）/ every（每 N 秒，给 everySeconds，下限 60）/ at（一次性，给 at.date+at.time）/ after（延迟 N 秒，给 afterSeconds）。timeZone 用 IANA，如 Asia/Shanghai。',
	properties: {
		kind: { type: 'string', enum: ['cron', 'daily', 'weekly', 'every', 'at', 'after'] },
		expression: { type: 'string', description: 'cron 五字段（分 时 日 月 周），如 "0 9 * * 1-5"。不支持 L/W/#/@。' },
		atMinute: { type: 'integer', description: 'daily/weekly：当天分钟数（0-1439），如 540 = 09:00' },
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
		description: '创建一个自动化任务（定时触发）。kind=prompt 时到点往指定会话投一句话；kind=loop 时到点触发一个无人值守循环（loopName）；kind=action 时调用某个服务的方法。规则支持 cron / 每天 / 每周 / 固定间隔 / 一次性时刻 / 延迟。',
		parameters: {
			type: 'object',
			properties: {
				title: { type: 'string', description: '任务名称' },
				kind: { type: 'string', enum: ['prompt', 'loop', 'action'], description: '默认 prompt' },
				rule: RULE_SCHEMA,
				prompt: { type: 'string', description: 'kind=prompt 必填：到点投给会话的内容' },
				sessionId: { type: 'string', description: 'kind=prompt 必填：绑定的会话 id' },
				loopName: { type: 'string', description: 'kind=loop 必填：要触发的循环名（见 loop_list）' },
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
				properties: {
					id: { type: 'string' },
					title: { type: 'string' },
					kind: { type: 'string' },
					ruleText: { type: 'string' },
					next: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `已创建 ${value.id}「${value.title}」\n${value.ruleText}\n下一次：${value.next}`,
			}],
		},
		isConcurrencySafe: () => false,
		async execute(args = {}) {
			const engine = needEngine();
			const id = `t-${randomUUID().slice(0, 8)}`;
			const task = engine.create({
				id,
				title: text(args.title) || '未命名任务',
				kind: text(args.kind) || 'prompt',
				rule: args.rule ?? {},
				...(args.prompt ? { prompt: text(args.prompt) } : {}),
				...(args.sessionId ? { sessionId: text(args.sessionId) } : {}),
				...(args.loopName ? { loopName: text(args.loopName) } : {}),
				...(args.action ? { action: args.action } : {}),
				...(args.workItem ? { workItem: args.workItem } : {}),
			});
			return {
				id: task.id,
				title: task.title,
				kind: task.kind,
				ruleText: describeRule(task.rule),
				next: Number.isFinite(task?.next?.target) ? new Date(task.next.target).toISOString() : '（无）',
			};
		},
	}));

	ctx.effect(() => ctx.tools.register({
		name: 'schedule_list',
		description: '列出全部自动化任务：类型、状态、规则、下一次运行时刻、上次结果。',
		parameters: {
			type: 'object',
			properties: { limit: { type: 'integer', description: '最多几条（默认 50）' } },
		},
		output: {
			schema: {
				type: 'object',
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
			schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, ruleText: { type: 'string' } } },
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
		description: '删除一个自动化任务（不可恢复）。',
		parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
		output: {
			schema: { type: 'object', properties: { id: { type: 'string' }, deleted: { type: 'boolean' } } },
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
		description: '查看某个自动化任务的投递历史（最近 N 次触发的时刻与序号）。',
		parameters: {
			type: 'object',
			properties: { id: { type: 'string' }, limit: { type: 'integer', description: '默认 20' } },
			required: ['id'],
		},
		output: {
			schema: { type: 'object', properties: { id: { type: 'string' }, records: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
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
