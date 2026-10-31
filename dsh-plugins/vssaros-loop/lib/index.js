// @vssaros/dsh-loop — host half：无人值守循环（harvest → 挑单 → 每条 item 独立会话 → 结算）。
//
// 与 siblings 同口径的取舍：
//   · 不 import 任何 `@deepseek-ai/*`：工具就是普通对象，registry 由 `ctx.tools` 提供；
//   · 可选依赖全走 `ctx.inject`（cordis 里直接读未声明的服务**一定抛**，见 reflect.ts）；
//   · 工具**不做**写入类审批闸：本插件自己没有写业务数据 —— 真正的写操作发生在 item 的
//     会话里，那里由 bridge 的 `approval.allow` 白名单统一管（config.allowTools）。
//
// 触发权不交给官方 schedule：它只会往会话投 prompt，用它当哨兵等于让内部逻辑靠解析
// 自己发出的 prompt 触发。schedule 只保留"人看的任务列表"这一职责，两者在 UI 上互链。

import { markFailed } from './core/ledger.js';
import { describeLoop } from './core/spec.js';
import { nextDueAtMs, quietDelayMs } from './core/plan.js';
import { bindFoundation } from './foundationRef.js';
import { bindWorkItems } from './workItemRef.js';
import { createRunner } from './runner.js';
import { findLoop, listLoops, loopsDirOf, readLedger, readState, writeLedger, writeState } from './store.js';

export const name = 'vssaros-loop';
// 只声明 tools：webServer/connection/runs 都只在特定 profile 里存在，写进静态 inject
// 会让插件在 headless/tui 里永久 pending（连工具一起失效，kanban 实测过）。
export const inject = ['tools'];

const EXPECTED_TOOLS = ['loop_list', 'loop_show', 'loop_dry_run', 'loop_run', 'loop_answer'];

const LOOP_NAME_SCHEMA = { type: 'string', description: 'loop 目录名（= loop 的身份，见 loop_list）' };

function validateConfig(config) {
	if (config?.allowCommands !== undefined && typeof config.allowCommands !== 'boolean') {
		throw new Error(`config.allowCommands 必须是布尔（收到 ${typeof config.allowCommands}）`);
	}
	if (config?.cwd !== undefined && typeof config.cwd !== 'string') {
		throw new Error(`config.cwd 必须是字符串（收到 ${typeof config.cwd}）`);
	}
	if (config?.allowTools !== undefined && !Array.isArray(config.allowTools)) {
		throw new Error('config.allowTools 必须是数组（item 会话里允许的工具名）');
	}
}

const text = value => (typeof value === 'string' ? value.trim() : '');

/** 面板/工具共用的单 loop 快照（state + ledger 计数 + 下一次 due）。 */
function snapshot(config, loop, nowMs) {
	const { state, warning } = readState(config, loop.name);
	const { ledger, warning: ledgerWarning, recovered } = readLedger(config, loop.name, nowMs);
	const counts = { total: 0, done: 0, failed: 0, blocked: 0, running: 0 };
	for (const entry of Object.values(ledger.items)) {
		counts.total += 1;
		if (counts[entry.status] !== undefined) {
			counts[entry.status] += 1;
		}
	}
	const dueAt = loop.spec ? nextDueAtMs(loop.spec, state, nowMs) : Infinity;
	return {
		name: loop.name,
		title: loop.spec?.title ?? loop.name,
		schedule: loop.spec?.schedule.text ?? '',
		error: loop.error,
		warnings: loop.warnings,
		state: {
			...state,
			dueAt: Number.isFinite(dueAt) ? new Date(dueAt).toISOString() : '',
			dueInS: Number.isFinite(dueAt) ? Math.max(0, Math.round((dueAt - nowMs) / 1000)) : null,
			quietForS: loop.spec ? Math.round(quietDelayMs(loop.spec, nowMs) / 1000) : 0,
			circuitOpen: !!loop.spec && state.consecutiveFailures >= loop.spec.consecutiveFailureLimit,
		},
		ledger: counts,
		notes: [warning, ledgerWarning].filter(Boolean),
		recovered,
	};
}

export function apply(ctx, config = {}) {
	validateConfig(config);
	// 绑定 foundation（dataRoot 的唯一真源）。同步直读在前：有插件会在 apply 的**同步段**
	// 就调 store（inject 回调是异步的，来不及）。
	{
		let ready = null;
		try {
			ready = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation ?? null;
		} catch {
			// 探针的假 ctx（Proxy）对未知属性抛错 ⇒ 当不存在
		}
		if (ready) {
			bindFoundation(ready);
		}
		ctx.inject(['vssarosFoundation'], child => {
			let svc = null;
			try {
				svc = child.vssarosFoundation ?? null;
			} catch {
				// 同上
			}
			if (svc) {
				bindFoundation(svc);
			}
		});
	}
	// 绑定 work item 内核（去重/退避/完成契约的**唯一真源**，与群聊共用）。
	// 与 foundation 同款两条路：同步直读（有插件在 apply 的同步段就用）+ 可选注入。
	// ⚠ 没绑上时**不降级**：调用会抛"组合里缺 @vssaros/dsh-workitem"—— 静默回退本地实现
	//   正是"两份判定"复活的入口（loop 说做过了、群聊说没有）。
	{
		let ready = null;
		try {
			ready = ctx.get?.('vssarosWorkItems') ?? ctx.vssarosWorkItems ?? null;
		} catch {
			// 探针的假 ctx 对未知属性抛错 ⇒ 当不存在
		}
		if (ready) {
			bindWorkItems(ready);
		}
		ctx.inject(['vssarosWorkItems'], child => {
			let svc = null;
			try {
				svc = child.vssarosWorkItems ?? null;
			} catch {
				// 同上
			}
			if (svc) {
				bindWorkItems(svc);
			}
		});
	}
	const log = typeof ctx.logger === 'function' ? ctx.logger('vssaros-loop') : console;
	const now = () => Date.now();

	let runs = null;
	const runner = createRunner({
		config,
		now,
		log,
		getRuns: () => runs,
		listLoops: cfg => listLoops(cfg),
		readLedger,
		writeLedger,
		readState,
		writeState,
	});

	// runs 服务来自 bridge 插件（`vssarosRuns.run({sessionId,cwd,prompt,timeoutMs,approval})`）。
	// 不在 ⇒ ticker 不启动（我们不假装能跑），但 list/show/dry_run 照常可用。
	ctx.inject(['vssarosRuns'], scope => {
		let svc = null;
		try {
			svc = scope.vssarosRuns ?? null;
		} catch {
			// 探针的假 ctx 对未知属性抛错 ⇒ 当不存在
		}
		if (!svc || typeof svc.run !== 'function') {
			log.warn('[loop] runs 服务不可用 ⇒ ticker 不启动（循环只能干跑/手动看）');
			return undefined;
		}
		runs = svc;
		runner.start();
		return () => {
			runs = null;
			runner.stop();
		};
	});

	// ── 写类工具的**审批闸**（2026-10-31）──────────────────────────────────────
	//   与 kb / kanban / workflow / marketplace 同一把：官方派发前决策钩子 `tools/pre-execute`
	//   （waterfall），返回 `{ kind: 'ask' }` ⇒ 只有审批服务回 `allowed-once` 才执行；
	//   没有审批支持的部署 degrade 成 deny（fail-closed ✓，正是想要的）。
	//   闸这两个：`loop_run`（真的按调度起来跑，会写账本 + 可能触发下游动作）与 `loop_answer`
	//   （把一次问答写进账本）。`loop_list` / `loop_show` / `loop_dry_run` 纯只读 ⇒ 放行
	//   （dry-run 只出计划、不落盘，弹窗只会造成审批疲劳）。
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		const toolName = exec && typeof exec.name === 'string' ? exec.name : '';
		if (toolName !== 'loop_run' && toolName !== 'loop_answer') {
			return next();
		}
		const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
		const loop = String(args.name ?? args.loop ?? '').trim() || '(未指定)';
		return {
			kind: 'ask',
			reason: toolName === 'loop_run'
				? `loop_run 会按「${loop}」的调度真的跑起来并写账本（<数据根>/loops/<名字>/ledger.json）`
				: `loop_answer 会把这次作答写进「${loop}」的账本`,
			displayReason: toolName === 'loop_run'
				? { zh: `允许运行循环「${loop}」？`, en: `Allow running loop "${loop}"?` }
				: { zh: `允许把这次作答写入循环「${loop}」？`, en: `Allow writing this answer to loop "${loop}"?` },
		};
	}), 'vssaros-loop: write-tool approval gate');

	ctx.effect(() => ctx.tools.register({
		name: 'loop_list',
		description: '列出本机的无人值守循环（loop）：调度、账本计数、下一次到期时间、是否熔断、以及每个循环的配置错误。循环定义在数据根的 loops/<名字>/loop.json，账本在同目录 ledger.json。',
		parameters: { type: 'object', properties: { verbose: { type: 'boolean', description: '附带每条 loop 的护栏参数' } } },
		output: {
			schema: {
				type: 'object',
				properties: {
					dir: { type: 'string' },
					count: { type: 'integer' },
					loops: { type: 'array', items: { type: 'object', additionalProperties: true } },
					runnerActive: { type: 'boolean' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.count === 0
					? `还没有循环。定义放这里：${value.dir}/<名字>/loop.json`
					: value.loops.map(l => `${l.error ? '✗' : l.state.circuitOpen ? '⛔' : '·'} ${l.name}　${l.schedule || '(无)'}　待做 ${l.ledger.failed + l.ledger.blocked}　done ${l.ledger.done}${l.state.dueInS !== null ? `　${l.state.dueInS}s 后到期` : ''}${l.error ? `　[${l.error}]` : ''}`).join('\n'),
			}],
		},
		isConcurrencySafe: () => true,
		async execute(args = {}) {
			const dir = loopsDirOf(config);
			const { loops } = listLoops(config);
			const nowMs = now();
			const rows = loops.map(loop => {
				const snap = snapshot(config, loop, nowMs);
				return args.verbose ? { ...snap, spec: loop.spec ? describeLoop(loop.spec) : null } : snap;
			});
			return { dir, count: rows.length, loops: rows, runnerActive: !!runs };
		},
	}));

	ctx.effect(() => ctx.tools.register({
		name: 'loop_show',
		description: '查看一个循环的完整定义与账本明细：护栏参数、最近处理的条目（done/failed/blocked/running 与原因）。用于回答"这个循环为什么没跑 / 某条为什么被跳过"。',
		parameters: { type: 'object', properties: { name: LOOP_NAME_SCHEMA, limit: { type: 'integer', description: '返回的账本条目上限（默认 20，最大 100）' } }, required: ['name'] },
		output: {
			schema: { type: 'object', properties: { name: { type: 'string' }, spec: { type: 'object', additionalProperties: true }, entries: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
			render: (_args, value) => [{ type: 'text', text: `${value.name}　${value.spec?.schedule ?? ''}\n账本条目 ${value.entries.length} 条` }],
		},
		isConcurrencySafe: () => true,
		async execute(args = {}) {
			const loop = findLoop(config, text(args.name));
			if (!loop) {
				throw new Error(`找不到循环：${text(args.name)}（定义在 ${loopsDirOf(config)}/<名字>/loop.json）`);
			}
			const limit = Math.min(100, Math.max(1, Number.isInteger(args.limit) ? args.limit : 20));
			const { ledger, warning, recovered } = readLedger(config, loop.name, now());
			const entries = Object.entries(ledger.items)
				.sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)))
				.slice(0, limit)
				.map(([key, entry]) => ({ key, ...entry }));
			return {
				name: loop.name,
				spec: loop.spec ? describeLoop(loop.spec) : null,
				error: loop.error,
				warnings: loop.warnings,
				notes: [warning].filter(Boolean),
				recovered,
				entries,
			};
		},
	}));

	ctx.effect(() => ctx.tools.register({
		name: 'loop_dry_run',
		description: '对一个循环做干跑：真的执行 harvest（采集）并按账本判定会做哪些、其余每条为什么被排除，但**不建会话、不花 token**。开循环前必须先干跑确认（这是 bunnyseek 的做法，也是最省钱的保险）。需要 config.allowCommands=true 才会真的执行采集命令。',
		parameters: { type: 'object', properties: { name: LOOP_NAME_SCHEMA }, required: ['name'] },
		output: {
			schema: { type: 'object', properties: { loop: { type: 'string' }, total: { type: 'integer' }, willRun: { type: 'array', items: { type: 'string' } }, excluded: { type: 'array', items: { type: 'object', additionalProperties: true } }, harvestError: { type: 'string' } } },
			render: (_args, value) => [{
				type: 'text',
				text: `干跑 ${value.loop}：候选 ${value.total} 条，会做 ${value.willRun.length} 条\n${value.willRun.map(k => `  ✓ ${k}`).join('\n')}${value.excluded.map(e => `\n  ✗ ${e.key}　${e.reason}`).join('')}${value.harvestError ? `\n采集问题：${value.harvestError}` : ''}`,
			}],
		},
		async execute(args = {}) {
			const loop = findLoop(config, text(args.name));
			if (!loop) {
				throw new Error(`找不到循环：${text(args.name)}`);
			}
			if (!loop.spec) {
				throw new Error(`循环 ${loop.name} 的定义有问题：${loop.error}`);
			}
			return runner.runRound(loop, { dryRun: true });
		},
	}));

	ctx.effect(() => ctx.tools.register({
		name: 'loop_run',
		description: '立刻跑一轮某个循环（不等 schedule）。会建独立会话执行挑中的条目、写账本。若 ticker 没起来（runs 服务不可用）会明确报错而不是假装跑了。',
		parameters: { type: 'object', properties: { name: LOOP_NAME_SCHEMA }, required: ['name'] },
		output: {
			schema: { type: 'object', properties: { loop: { type: 'string' }, willRun: { type: 'array', items: { type: 'string' } }, results: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
			render: (_args, value) => [{ type: 'text', text: `${value.loop}：本轮 ${value.willRun?.length ?? 0} 条\n${(value.results ?? []).map(r => `  ${r.status ?? '?'} ${r.key}${r.error ? `（${r.error}）` : ''}`).join('\n')}` }],
		},
		async execute(args = {}) {
			if (!runs) {
				throw new Error('runs 服务不可用（bridge 未装或版本过旧）⇒ 不能建会话执行 item。先装 / 升级 @vssaros/dsh-bridge。');
			}
			const loop = findLoop(config, text(args.name));
			if (!loop?.spec) {
				throw new Error(`找不到可用的循环：${text(args.name)}${loop?.error ? `（${loop.error}）` : ''}`);
			}
			return runner.runRound(loop);
		},
	}));

	ctx.effect(() => ctx.tools.register({
		name: 'loop_answer',
		description: '回答一个被阻塞（blocked）的条目，把它放回队列：下一轮会带着你给的信息重跑。用于 onAsk=block 的循环里模型主动停下来等人决策的场景。传 key 只放一条，不传则放开该循环全部 blocked。',
		parameters: {
			type: 'object',
			properties: { name: LOOP_NAME_SCHEMA, key: { type: 'string', description: '账本键（见 loop_show 的 entries[].key）' }, answer: { type: 'string', description: '给人看的回答（写进 lastError 供下一轮参考）' } },
			required: ['name'],
		},
		output: {
			schema: { type: 'object', properties: { name: { type: 'string' }, released: { type: 'array', items: { type: 'string' } } } },
			render: (_args, value) => [{ type: 'text', text: `${value.name}：放回 ${value.released.length} 条\n${value.released.join('\n')}` }],
		},
		async execute(args = {}) {
			const loop = findLoop(config, text(args.name));
			if (!loop) {
				throw new Error(`找不到循环：${text(args.name)}`);
			}
			const nowMs = now();
			const { ledger } = readLedger(config, loop.name, nowMs);
			const wanted = text(args.key);
			const released = [];
			for (const [key, entry] of Object.entries(ledger.items)) {
				if (entry.status !== 'blocked' || (wanted && key !== wanted)) {
					continue;
				}
				// blocked → failed：保留 attempts（别用"回答过"来洗白重试次数），
				// 但把退避起点重置到现在，让下一轮就能重跑。
				markFailed(ledger, key, { sessionId: entry.sessionId, reason: `answer: ${text(args.answer) || '(empty)'} / was: ${entry.lastError}` }, nowMs);
				released.push(key);
			}
			if (released.length === 0) {
				throw new Error(wanted ? `没有处于 blocked 的条目：${wanted}` : `循环 ${loop.name} 没有 blocked 的条目`);
			}
			writeLedger(config, loop.name, ledger);
			return { name: loop.name, released };
		},
	}));

	ctx.effect(() => {
		const missing = EXPECTED_TOOLS.filter(tool => !ctx.tools.get(tool));
		if (missing.length) {
			log.warn(`[loop] 有工具没注册上：${missing.join(', ')}`);
		}
		return undefined;
	});
}
