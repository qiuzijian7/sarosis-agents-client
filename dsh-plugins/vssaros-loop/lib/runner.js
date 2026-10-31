// 循环执行器：ticker → 判定 due → harvest → 挑单 → 每条 item 用**独立会话**跑 → 结算。
//
// 为什么 item 是独立会话（不是续跑主会话）：
//   1. 上下文由 `itemTurnCap` / 墙钟超时决定，而不是"这个进程活了多久"；
//   2. transcript 天然就是会话 JSONL ⇒ 审计零成本；
//   3. 一条 item 炸了不污染下一条。
// 这也是 bunnyseek 的结论（"每个 item 是一个独立 Agent"），它为此专门写了 executor。
//
// 为什么 ticker 自己算而不寄生官方 schedule：官方 schedule 只会"往会话投一条 prompt"，
// 用它当哨兵等于让内部逻辑靠**解析自己发出的 prompt** 触发，脆得没边。schedule 只负责
// 人看的那份任务列表（工作台互链），触发权留在本插件。

import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';

import { handoffContract, parseHandoff, validateHandoff } from './core/handoff.js';
import { markBlocked, markDone, markFailed, markRunning } from './core/ledger.js';
import { nextDueAtMs, outcomeOf, pickItems, quietDelayMs } from './core/plan.js';
import { describeLoop } from './core/spec.js';

/** tick 粒度。30s 足够细（最小轮间隔是 120s 起），又不至于每分钟醒十次。 */
const TICK_MS = 30_000;
/** harvest 命令的 stdout 上限：真的有人会返回上千行 JSON。 */
const HARVEST_MAX_BUFFER = 16 * 1024 * 1024;

const text = value => (typeof value === 'string' ? value.trim() : '');

/** 会话 id 必须短且稳定：同一 item 重跑复用同一条会话历史（对齐 kanban 的 `task:<id>` 口径）。 */
export function sessionIdOf(loopName, key) {
	const digest = createHash('sha1').update(key).digest('hex').slice(0, 12);
	return `loop:${loopName}:${digest}`;
}

/**
 * 拼 item 的 prompt。完成契约统一由**框架**附加，而不是让每个 loop 的作者记得写
 * ——漏写的后果是 item 永远拿不到 done，整晚在重试。
 */
export function buildItemPrompt(spec, row, key) {
	// `{field}` 替换对 taskHeader **与** prompt 都做：我们的 loop 是声明式的（没有 work 回调），
	// 不替换的话"每条 item 的 prompt 带着自己的单号"这件事就没法表达，只能写死。
	const fill = value => String(value).replace(/\{(\w+)\}/g, (_, field) => (row?.[field] ?? ''));
	const header = spec.work.taskHeader ? `${fill(spec.work.taskHeader)}\n\n` : '';
	const body = fill(text(spec.work.prompt));
	const contract = [
		'',
		'---',
		`（本条目由无人值守循环执行，账本键：${key}。`,
		'完成后**最后一行**必须是以下标记之一，否则这一条会被判为失败并重试：',
		'`[item:done]` / `[item:failed:<原因>]` / `[item:blocked:<原因>]`。',
		spec.onAsk === 'assume'
			? '没人会回答你的问题：请选择最保守、可逆的默认选项，并在结论里声明你的假设。'
			: '遇到必须由人决定的问题：不要猜，直接以 `[item:blocked:<问题>]` 收尾。',
		'⚠ 标记是你自己的陈述，不是独立验收：写 done 不等于有人复核过。',
		// ★ 结构化交接（对照官方 Ralph）：只在 loop 显式开了 `handoff.require` 时才要求
		//   —— 不加这段，模型不会自己发明格式，而未配置的 loop 行为与从前逐字一致。
		...(spec.handoff?.require ? [handoffContract(spec)] : []),
		'）',
	].join('\n');
	return `${header}${body}${contract}`;
}

function runHarvestCommand(spec, cwd, log) {
	return new Promise(resolve => {
		const command = spec.harvest.command;
		if (!command) {
			resolve({ rows: [], error: 'harvest.command 为空（这个 loop 采不到任何活）' });
			return;
		}
		exec(command, { cwd: spec.harvest.cwd || cwd, timeout: spec.harvestTimeoutS * 1000, maxBuffer: HARVEST_MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
			if (error) {
				// 超时 / 非零退出：如实报，但**不要把整轮算失败**（采集炸了不等于 item 炸了）。
				log('warn', `[loop:${spec.name}] harvest 失败：${String(error.message).slice(0, 400)}${stderr ? ` / stderr: ${String(stderr).slice(0, 400)}` : ''}`);
				resolve({ rows: [], error: `harvest 命令失败：${String(error.message).slice(0, 300)}` });
				return;
			}
			try {
				const parsed = JSON.parse(String(stdout).trim() || '[]');
				const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : null;
				if (!rows) {
					resolve({ rows: [], error: 'harvest 的 stdout 既不是数组也不是 {rows:[...]}' });
					return;
				}
				resolve({ rows, error: '' });
			} catch (parseError) {
				resolve({ rows: [], error: `harvest 的 stdout 不是合法 JSON：${String(parseError.message).slice(0, 200)}` });
			}
		});
	});
}

/**
 * 创建执行器。deps 全部由 index.js 注入（**不 import 任何 @deepseek-ai/**，跨版本更稳）：
 *   · getRuns() → `{ run({sessionId,cwd,prompt,timeoutMs,approval}) }`（bridge 的 vssarosRuns）
 *   · listLoops / readLedger / writeLedger / readState / writeState：store.js
 *   · log(level, msg)、now()、config
 */
export function createRunner(deps) {
	const { getRuns, listLoops, readLedger, writeLedger, readState, writeState, log, config = {}, now = () => Date.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval } = deps;
	const inFlight = new Set();
	let timer = null;
	let stopped = false;

	const cwdOf = () => text(config.cwd) || process.cwd();

	async function executeItem(loop, item, cwd) {
		const { spec } = loop;
		const runs = getRuns();
		if (!runs || typeof runs.run !== 'function') {
			return { error: 'runs 服务不可用（bridge 未装 / 版本过旧）' };
		}
		const sessionId = sessionIdOf(spec.name, item.key);
		const startedAt = now();
		const { ledger } = readLedger(config, spec.name, startedAt);
		markRunning(ledger, item.key, { sessionId }, startedAt);
		writeLedger(config, spec.name, ledger);
		inFlight.add(item.key);
		try {
			const result = await runs.run({
				sessionId,
				cwd,
				prompt: buildItemPrompt(spec, item.row, item.key),
				timeoutMs: spec.itemTimeoutS * 1000,
				// 后台回合没有人工在看着 ⇒ 工具权限必须显式放开（默认全拒，对齐 kanban runner 的取舍）。
				approval: { allow: Array.isArray(config.allowTools) ? config.allowTools : [] },
			});
			const outcome = outcomeOf({ finalText: result?.finalText ?? '', stopReason: result?.stopReason ?? '', completion: spec.completion });
			// ★ 结构化交接校验（对照官方 Ralph）：超长 / 字段矛盾 ⇒ **判失败**（不截断、不静默放过）。
			//   只在 `handoff.require` 开了、或模型**自己交了** handoff 时才生效 ⇒ 未配置的 loop 与从前一致。
			const handoff = parseHandoff(result?.finalText ?? '');
			const checked = validateHandoff(handoff, { status: outcome.status, maxChars: spec.handoff?.maxChars });
			let status = outcome.status;
			let reason = outcome.reason;
			if (!checked.ok && (spec.handoff?.require || handoff.found)) {
				status = 'failed';
				reason = `handoff 不合格：${checked.errors.join('；')}`;
			}
			const after = readLedger(config, spec.name, now()).ledger;
			const patch = {
				sessionId,
				reason,
				marker: outcome.marker,
				handoff: handoff.found
					? { chars: handoff.chars, summary: String(handoff.fields.summary ?? '').slice(0, 200) }
					: { chars: 0, summary: '' },
			};
			if (status === 'done') {
				markDone(after, item.key, patch, now());
			} else if (status === 'blocked') {
				markBlocked(after, item.key, patch, now());
			} else {
				markFailed(after, item.key, patch, now());
			}
			writeLedger(config, spec.name, after);
			log('info', `[loop:${spec.name}] ${item.key} ⇒ ${status}${reason ? `（${reason}）` : ''}`);
			return { status, sessionId, elapsedMs: now() - startedAt, handoff: patch.handoff };
		} catch (error) {
			const after = readLedger(config, spec.name, now()).ledger;
			markFailed(after, item.key, { sessionId, reason: String(error?.message ?? error) }, now());
			writeLedger(config, spec.name, after);
			log('warn', `[loop:${spec.name}] ${item.key} 执行出错：${String(error?.message ?? error)}`);
			return { status: 'failed', sessionId, error: String(error?.message ?? error) };
		} finally {
			inFlight.delete(item.key);
		}
	}

	/**
	 * 跑一轮。`dryRun` 只采集 + 挑单，不建会话、不写 ledger（唯一写的是一次性的干跑结果，
	 * 由调用方直接返回给工具，不落盘）—— "先干跑再开"这条纪律的产品化。
	 */
	async function runRoundInner(loop, { dryRun = false } = {}) {
		const { spec } = loop;
		const startedAt = now();
		const state = readState(config, spec.name).state;
		const quiet = quietDelayMs(spec, startedAt);
		if (quiet > 0 && !dryRun) {
			return { loop: spec.name, skipped: `quiet-hours（还有 ${Math.ceil(quiet / 60_000)} 分钟）` };
		}
		const harvest = config.allowCommands
			? await runHarvestCommand(spec, cwdOf(), log)
			: { rows: [], error: 'harvest 未执行：config.allowCommands=false（harvest.command = 本机执行命令）' };
		const ledger = readLedger(config, spec.name, startedAt).ledger;
		const picked = pickItems({ spec, rows: harvest.rows, ledger, nowMs: startedAt });
		const summary = {
			loop: spec.name,
			dryRun,
			harvestError: harvest.error,
			total: picked.total,
			willRun: picked.picked.map(item => item.key),
			excluded: picked.excluded,
			spec: describeLoop(spec),
		};
		if (dryRun) {
			return summary;
		}
		if (picked.picked.length === 0) {
			writeState(config, spec.name, { ...state, lastRoundStartedAt: new Date(startedAt).toISOString(), lastRoundFinishedAt: new Date(now()).toISOString(), lastResult: harvest.error ? 'harvest-failed' : 'no-work', lastError: harvest.error, totalRounds: state.totalRounds + 1 });
			return summary;
		}
		const results = [];
		for (const item of picked.picked) {
			results.push({ key: item.key, ...(await executeItem(loop, item, cwdOf())) });
			if (stopped) {
				break;
			}
		}
		const failed = results.filter(r => r.status !== 'done' && r.status !== 'blocked').length;
		const consecutive = failed > 0 ? state.consecutiveFailures + 1 : 0;
		writeState(config, spec.name, {
			lastRoundStartedAt: new Date(startedAt).toISOString(),
			lastRoundFinishedAt: new Date(now()).toISOString(),
			lastResult: failed ? 'items-failed' : 'items-done',
			lastError: results.find(r => r.error)?.error ?? '',
			totalRounds: state.totalRounds + 1,
			consecutiveFailures: consecutive,
		});
		if (consecutive >= spec.consecutiveFailureLimit) {
			log('warn', `[loop:${spec.name}] 连续 ${consecutive} 轮有失败 ⇒ 熔断（需人工 loop_run 或清 state 后恢复）`);
		}
		return { ...summary, results };
	}

	/**
	 * 一轮互斥。ticker 与 `loop_run` 工具可能同时想跑同一个 loop（人点了"立即运行"），
	 * 而 `inFlight` 只按 item key 去重 ⇒ 两个并发轮次会把同一条 item 派进两条会话。
	 * 这里用一层串行闸：忙时**明确回报 busy**，不排队（排队会让"立即运行"在半小时后突然生效）。
	 */
	let busy = false;
	async function runRound(loop, options = {}) {
		if (busy) {
			return { loop: loop?.spec?.name ?? loop?.name ?? '?', skipped: 'busy（上一轮还在执行，稍后再试）' };
		}
		busy = true;
		try {
			return await runRoundInner(loop, options);
		} finally {
			busy = false;
		}
	}

	/** 一次 tick：把所有 due 的 loop 各跑一轮。重入保护靠 `inFlight` + 单线程串行执行。 */
	async function tick() {
		if (stopped) {
			return [];
		}
		const nowMs = now();
		const { loops } = listLoops(config);
		const ran = [];
		for (const loop of loops) {
			if (!loop.spec || stopped) {
				continue;
			}
			if (inFlight.size > 0) {
				break; // 串行：一轮没跑完不开始下一轮（maxConcurrent 恒为 1）
			}
			const state = readState(config, loop.spec.name).state;
			if (state.consecutiveFailures >= loop.spec.consecutiveFailureLimit) {
				continue; // 熔断是粘性的：只能人工恢复
			}
			if (nowMs < nextDueAtMs(loop.spec, state, nowMs)) {
				continue;
			}
			ran.push(await runRound(loop));
		}
		return ran;
	}

	return {
		start() {
			if (timer) {
				return;
			}
			stopped = false;
			timer = setIntervalFn(() => {
				tick().catch(error => log('warn', `[loop] tick 失败：${String(error?.message ?? error)}`));
			}, TICK_MS);
			// Host 进程不该被一个 30s 定时器吊着不退出（对齐 Node 的 unref 约定）。
			timer?.unref?.();
			// 起手先 tick 一次：`every` 且从没跑过的 loop 应该立刻开工，而不是等 30s。
			tick().catch(error => log('warn', `[loop] 首次 tick 失败：${String(error?.message ?? error)}`));
			log('info', `[loop] runner 已启动（${TICK_MS / 1000}s 粒度，allowCommands=${!!config.allowCommands}）`);
		},
		stop() {
			stopped = true;
			if (timer) {
				clearIntervalFn(timer);
				timer = null;
			}
		},
		tick,
		runRound,
		inFlight: () => [...inFlight],
	};
}
