/**
 * ★ 2026-11-06（P1，对齐 DS Bot `ds-bot/src/host/goals.js`）：群目标 —— 分阶段、验收、打回、自动催进。
 *
 * 管理员用 `group_goal` 把用户要的事写成目标：目标、怎样算完成、要守的规则、按顺序的阶段（每个阶段有自己的
 * 完成标准和分给具体成员的任务）。之后：
 *   · 管理员按阶段 @ 成员派活；成员做完附上证据；管理员（或请评审成员）对照阶段标准检查；
 *   · 通过 ⇒ `pass`（附证据）进入下一阶段；不过 ⇒ `rework`（写明缺什么）把任务退回，再 @ 成员返工；
 *   · 全部阶段通过 ⇒ `complete`（附证据与总结）。
 *   · 群里没人在干活、目标又没完成 ⇒ 系统自动叫醒管理员做「目标检查」；连续 `GOAL_IDLE_NUDGES` 次没有进展
 *     就停下等用户（不会无限空转）。
 * 本模块全是纯函数：只改传进来的 room.goal，不碰 I/O；调度与落盘在 rooms.js。
 */

export const GOAL_LIMITS = Object.freeze({ stages: 20, tasks: 12, title: 80, text: 2000, feedback: 1200, events: 30 });
/** 没有进展时最多自动催几次（DS Bot GOAL_IDLE_NUDGES 同值）。 */
export const GOAL_IDLE_NUDGES = 2;
export const GOAL_STATUSES = Object.freeze(['active', 'paused', 'complete', 'stopped']);
const TASK_LABEL = Object.freeze({ pending: '待做', working: '进行中', reported: '已交付', done: '已完成' });

const str = (value) => String(value ?? '').trim();
const clip = (value, max) => { const text = str(value); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
class GoalError extends Error {}

/**
 * 用户可读的目标视图（给 UI / 工具结果）：不含内部计数。
 * @param goal room.goal
 * @param nameOf `botId => 名字`
 */
export function goalView(goal, nameOf = (id) => id) {
	if (!goal) { return undefined; }
	const stage = goal.stages[goal.current];
	return {
		title: goal.title, status: goal.status, idle: goal.idle === true,
		stage: stage ? goal.current + 1 : goal.stages.length, stages: goal.stages.length,
		stageTitle: stage?.title ?? '', reworks: stage?.reworks ?? 0,
		tasks: (stage?.tasks ?? []).map(task => ({ bot: nameOf(task.botId), task: task.task, status: task.status })),
		updatedAt: goal.updatedAt,
	};
}

function touch(goal, event, now) {
	goal.updatedAt = now;
	goal.revision = (goal.revision ?? 0) + 1;
	goal.events = [...(goal.events ?? []), { at: now, ...event }].slice(-GOAL_LIMITS.events);
}

/**
 * `group_goal` 的一次调用（只有管理员能调；rooms.js 已经核过身份）。
 * @param room 群（会改 room.goal）
 * @param input 工具参数 `{ action, … }`
 * @param ctx `{ by: 管理员 botId, memberOf(ref) => botId | undefined, nameOf(id), now }`
 * @returns `{ reply }` 给模型的结果；参数不对 ⇒ `{ error }`
 */
export function applyGoal(room, input, ctx) {
	try { return { reply: run(room, input ?? {}, ctx) }; } catch (error) {
		if (error instanceof GoalError) { return { error: error.message }; }
		throw error;
	}
}

function run(room, input, { by, memberOf, nameOf = (id) => id, now = Date.now() }) {
	const action = str(input.action);
	const goal = room.goal;
	const need = (what) => { if (!goal) { throw new GoalError('这个群还没有目标：先用 action=start 设定。'); } return what; };
	const active = () => {
		need();
		if (goal.status === 'paused') { throw new GoalError('目标已暂停：用户恢复之前不派新活、不过阶段；用户的修正用 action=revise 写进目标。'); }
		if (goal.status !== 'active') { throw new GoalError(`目标已经${goal.status === 'complete' ? '完成' : '停止'}了。`); }
	};
	switch (action) {
		case 'status': {
			need();
			return { event: 'status', ledger: ledgerLines(goal, nameOf).join('\n') };
		}
		case 'start': {
			if (goal && (goal.status === 'active' || goal.status === 'paused')) { throw new GoalError('已经有一个进行中的目标：要改内容用 action=revise，要换目标先 action=stop。'); }
			const stages = parseStages(input.stages, memberOf);
			const acceptance = clip(input.acceptance, GOAL_LIMITS.text);
			const objective = clip(input.objective, GOAL_LIMITS.text);
			if (!objective) { throw new GoalError('start 需要 objective（要达成什么）。'); }
			if (!acceptance) { throw new GoalError('start 需要 acceptance（怎样算完成：命令、测试、文件、证据）。'); }
			stages[0].status = 'active';
			room.goal = {
				title: clip(input.title, GOAL_LIMITS.title) || clip(objective, GOAL_LIMITS.title), objective, acceptance,
				rules: (Array.isArray(input.rules) ? input.rules : []).map(rule => clip(rule, 300)).filter(Boolean).slice(0, 12),
				stages, current: 0, status: 'active', nudges: 0, createdAt: now, updatedAt: now, revision: 0, events: [], by,
			};
			touch(room.goal, { kind: 'start', by }, now);
			return { event: 'start', title: room.goal.title, stage: 1, stages: stages.length, next: stages[0].title,
				note: '现在就在同一条回复里 @ 第一阶段的成员派活。' };
		}
		case 'pass': {
			active();
			const stage = goal.stages[goal.current];
			if (!stage) { throw new GoalError('所有阶段都通过了：用 action=complete 收尾。'); }
			const evidence = clip(input.evidence, GOAL_LIMITS.text);
			if (!evidence) { throw new GoalError('pass 需要 evidence：对照本阶段完成标准的证据（改了哪些文件、跑了什么、看到了什么）。'); }
			Object.assign(stage, { status: 'passed', evidence, passedAt: now });
			for (const task of stage.tasks) { task.status = 'done'; }
			goal.current += 1;
			const next = goal.stages[goal.current];
			if (next) { next.status = 'active'; }
			goal.nudges = 0; delete goal.idle;
			touch(goal, { kind: 'pass', by, stage: goal.current, text: clip(evidence, 200) }, now);
			return next
				? { event: 'pass', stage: goal.current + 1, stages: goal.stages.length, next: next.title, note: '在同一条回复里 @ 下一阶段的成员派活。' }
				: { event: 'pass', stage: goal.stages.length, stages: goal.stages.length, note: '所有阶段都通过了：对照总的完成标准检查后用 action=complete 收尾。' };
		}
		case 'rework': {
			active();
			const stage = goal.stages[goal.current];
			if (!stage) { throw new GoalError('所有阶段都通过了，没有可以打回的阶段。'); }
			const reason = clip(input.reason, GOAL_LIMITS.feedback);
			if (!reason) { throw new GoalError('rework 需要 reason：缺什么、错在哪、怎样复现。'); }
			let only;
			if (str(input.bot)) {
				only = memberOf(input.bot);
				if (!only) { throw new GoalError(`${str(input.bot)} 不是这个群的成员。`); }
			}
			for (const task of stage.tasks) { if (!only || task.botId === only) { task.status = 'pending'; } }
			stage.reworks = (stage.reworks ?? 0) + 1;
			stage.feedback = reason;
			goal.nudges = 0; delete goal.idle;
			touch(goal, { kind: 'rework', by, stage: goal.current + 1, text: clip(reason, 200) }, now);
			return { event: 'rework', stage: goal.current + 1, reworks: stage.reworks, note: '在同一条回复里 @ 要返工的成员，写清问题和复现步骤。' };
		}
		case 'revise': {
			need();
			if (goal.status === 'complete' || goal.status === 'stopped') { throw new GoalError('目标已经结束了，不能再改。'); }
			if (input.objective !== undefined) { goal.objective = clip(input.objective, GOAL_LIMITS.text) || goal.objective; }
			if (input.acceptance !== undefined) { goal.acceptance = clip(input.acceptance, GOAL_LIMITS.text) || goal.acceptance; }
			if (Array.isArray(input.rules)) { goal.rules = input.rules.map(rule => clip(rule, 300)).filter(Boolean).slice(0, 12); }
			if (input.stages !== undefined) {
				// 只改还没通过的阶段：已通过的保留
				const passed = goal.stages.slice(0, goal.current);
				const rest = parseStages(input.stages, memberOf);
				rest[0].status = goal.status === 'active' ? 'active' : 'pending';
				goal.stages = [...passed, ...rest];
			}
			touch(goal, { kind: 'revise', by, text: clip(input.note ?? '', 200) }, now);
			return { event: 'revise', stage: Math.min(goal.current + 1, goal.stages.length), stages: goal.stages.length };
		}
		case 'complete': {
			active();
			const open = goal.stages.findIndex(stage => stage.status !== 'passed');
			if (open >= 0) { throw new GoalError(`第 ${open + 1} 阶段「${goal.stages[open].title}」还没通过：每个阶段都 pass 之后才能 complete。`); }
			const evidence = clip(input.evidence, GOAL_LIMITS.text);
			if (!evidence) { throw new GoalError('complete 需要 evidence：对照总的完成标准的证据。'); }
			Object.assign(goal, { status: 'complete', evidence, summary: clip(input.summary, GOAL_LIMITS.text), completedAt: now });
			touch(goal, { kind: 'complete', by, text: clip(input.summary ?? evidence, 200) }, now);
			return { event: 'complete', title: goal.title, note: '在群里向用户汇报：做成了什么、证据在哪。' };
		}
		case 'stop': {
			need();
			goal.status = 'stopped';
			touch(goal, { kind: 'stop', by }, now);
			return { event: 'stop', title: goal.title };
		}
		default:
			throw new GoalError('action 只能是 start / status / pass / rework / revise / complete / stop。');
	}
}

function parseStages(raw, memberOf) {
	const list = Array.isArray(raw) ? raw : [];
	if (!list.length) { throw new GoalError('至少要有一个阶段（stages）。'); }
	if (list.length > GOAL_LIMITS.stages) { throw new GoalError(`阶段最多 ${GOAL_LIMITS.stages} 个。`); }
	return list.map((stage, index) => {
		const title = clip(stage?.title, GOAL_LIMITS.title);
		const acceptance = clip(stage?.acceptance, GOAL_LIMITS.text);
		if (!title || !acceptance) { throw new GoalError(`第 ${index + 1} 个阶段要有 title 和 acceptance（本阶段怎样算完成）。`); }
		const tasks = (Array.isArray(stage?.tasks) ? stage.tasks : []).slice(0, GOAL_LIMITS.tasks).map(task => {
			const botId = memberOf(task?.bot);
			if (!botId) { throw new GoalError(`第 ${index + 1} 个阶段的任务指派给了「${str(task?.bot)}」，它不是这个群的成员。`); }
			const text = clip(task?.task, 600);
			if (!text) { throw new GoalError(`第 ${index + 1} 个阶段有一项任务没写内容。`); }
			return { botId, task: text, status: 'pending' };
		});
		if (!tasks.length) { throw new GoalError(`第 ${index + 1} 个阶段「${title}」没有任务：至少给一位成员派一项。`); }
		return { title, acceptance, tasks, status: 'pending', reworks: 0 };
	});
}

/** 成员任务状态的推进（管理员 @ 它 ⇒ 进行中；它交回结果 ⇒ 已交付）。只动当前阶段。 @returns 有没有变化 */
export function markTask(goal, botId, from, to) {
	const stage = goal?.status === 'active' ? goal.stages[goal.current] : undefined;
	let changed = false;
	for (const task of stage?.tasks ?? []) {
		if (task.botId === botId && from.includes(task.status)) { task.status = to; changed = true; }
	}
	if (changed) { goal.nudges = 0; delete goal.idle; }
	return changed;
}

/** 管理员的账本（整份目标）。 */
export function ledgerLines(goal, nameOf = (id) => id) {
	const lines = [`目标：${goal.title}`, `要达成：${goal.objective}`, `怎样算完成：${goal.acceptance}`];
	if (goal.rules?.length) { lines.push('规则：', ...goal.rules.map(rule => `- ${rule}`)); }
	lines.push('阶段：');
	goal.stages.forEach((stage, index) => {
		const n = index + 1;
		if (stage.status === 'passed') { lines.push(`[已通过] ${n}. ${stage.title}`); return; }
		if (index === goal.current) {
			lines.push(`[当前] ${n}. ${stage.title} —— 完成标准：${stage.acceptance}`);
			for (const task of stage.tasks) { lines.push(`  - ${nameOf(task.botId)}：${task.task}【${TASK_LABEL[task.status] ?? task.status}】`); }
			if (stage.reworks) { lines.push(`  已打回 ${stage.reworks} 次，最近一次：${stage.feedback ?? ''}`); }
			return;
		}
		lines.push(`[之后] ${n}. ${stage.title}：${[...new Set(stage.tasks.map(task => nameOf(task.botId)))].join('、')}`);
	});
	return lines;
}

const DUTY_ACTIVE = '你负责推进这个目标：按当前阶段把每项任务 @ 给对应成员（同一条里 @ 的人同时开始）。他们交回结果后，'
	+ '你自己或请评审成员对照本阶段的完成标准检查；通过就调用 group_goal（action=pass，附证据），并在同一条回复里 @ 下一阶段的成员；'
	+ '不通过就调用 group_goal（action=rework，写明缺什么），再 @ 成员返工。所有工作都不超出目标与规则；用户纠正方向时先用 action=revise 写进目标。'
	+ '只有你做不了的决定才问用户。';
const DUTY_PASSED = '所有阶段都通过了：对照总的完成标准检查，再调用 group_goal（action=complete，附证据和给用户的总结）。';
const DUTY_PAUSED = '用户暂停了这个目标：不派阶段任务、不过阶段。和用户沟通，把用户的修正用 action=revise 写进目标；由用户恢复。';
/** 系统自动催进时给管理员的那句话。 */
export const GOAL_NUDGE_TEXT = '【目标检查】群里现在没有人在干活，目标还没完成。现在就推进下一步：把当前阶段没完成的任务 @ 给成员，'
	+ '或者检查已交回结果的阶段，或者在所有阶段都通过时收尾。如果你在等用户，就只回 [PASS]。';

/**
 * 群提示词里的目标段落：管理员看整份账本与职责，成员只看自己在当前阶段的任务。没有进行中的目标 ⇒ 空串。
 */
export function goalPromptBlock(goal, memberId, isAdmin, nameOf = (id) => id) {
	if (!goal || goal.status === 'complete' || goal.status === 'stopped') { return ''; }
	if (isAdmin) {
		const duty = goal.status === 'paused' ? DUTY_PAUSED : goal.stages[goal.current] ? DUTY_ACTIVE : DUTY_PASSED;
		return [`【群目标】`, ...ledgerLines(goal, nameOf), '', duty].join('\n');
	}
	const stage = goal.stages[goal.current];
	const lines = [`【群目标】${goal.title} —— ${clip(goal.objective, 600)}`];
	if (goal.rules?.length) { lines.push(`规则：${goal.rules.join('；')}`); }
	if (!stage) { lines.push('所有阶段都通过了，管理员正在做最后检查。'); } else {
		lines.push(`当前第 ${goal.current + 1}/${goal.stages.length} 阶段「${stage.title}」，完成标准：${stage.acceptance}`);
		const mine = stage.tasks.filter(task => task.botId === memberId);
		if (!mine.length) { lines.push('这一阶段没有你的任务。'); }
		for (const task of mine) { lines.push(`你在这一阶段的任务：${task.task}（${TASK_LABEL[task.status] ?? task.status}）`); }
		if (stage.reworks && stage.feedback) { lines.push(`本阶段被打回过 ${stage.reworks} 次，最近的问题：${stage.feedback}`); }
	}
	lines.push('只做目标范围内的事。做完你的任务时，回复结尾附上证据：改了哪些文件、跑了什么命令、输出是什么。');
	if (goal.status === 'paused') { lines.push('目标已暂停：只把手上的事做完，不开始新的阶段任务。'); }
	return lines.join('\n');
}

/** `group_goal` 工具的参数 schema（JSON Schema；工具定义在 rooms.js）。 */
export const GOAL_TOOL_PARAMETERS = Object.freeze({
	type: 'object',
	properties: {
		action: { type: 'string', enum: ['start', 'status', 'pass', 'rework', 'revise', 'complete', 'stop'] },
		title: { type: 'string', description: 'start：目标的短标题' },
		objective: { type: 'string', description: 'start / revise：要达成什么' },
		acceptance: { type: 'string', description: 'start / revise：怎样算完成（命令、测试、文件、证据）' },
		rules: { type: 'array', items: { type: 'string' }, description: 'start / revise：要守的规则' },
		stages: { type: 'array', description: 'start / revise：按顺序的阶段', items: { type: 'object', properties: {
			title: { type: 'string' }, acceptance: { type: 'string', description: '本阶段怎样算完成' },
			tasks: { type: 'array', items: { type: 'object', properties: { bot: { type: 'string', description: '成员名字' }, task: { type: 'string' } }, required: ['bot', 'task'] } },
		}, required: ['title', 'acceptance', 'tasks'] } },
		evidence: { type: 'string', description: 'pass / complete：对照完成标准的证据' },
		reason: { type: 'string', description: 'rework：缺什么、错在哪、怎样复现' },
		bot: { type: 'string', description: 'rework：只退回这位成员的任务（不给 = 本阶段全部）' },
		summary: { type: 'string', description: 'complete：给用户的总结' },
		note: { type: 'string', description: 'revise：改了什么（一句话）' },
	},
	required: ['action'],
});
