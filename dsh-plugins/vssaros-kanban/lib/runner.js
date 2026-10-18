// 看板自动执行 runner（重构 2.2，S2 结论落地）。
//
// ── 语义（与 legacy 对齐）──────────────────────────────────────────────────
// 触发 = 任务卡被拖到「进行中」（status='running'）。runner 拾取后：
//   · 用 `vssarosRuns` 服务驱动一条**专属会话**（sessionId = `task:<taskId>`，一卡一会话 ✓
//     重启后续跑同一条历史，prompt 幂等去重靠 controller.prompt 的 requestId ✓）；
//   · 回合跑完按结果回写看板（现有锁 + CAS，与工具/页面同一写路径 ✓）：
//       stopReason=completed → done（回执记进描述尾部）；
//       其余（超时/出错/被拒）→ blocked（原因写进 lastError 字段）；
//   · 任务被拖出「进行中」⇒ 取消该会话当前活动（尽力而为，不删历史）。
//
// ── 并发与重启 ─────────────────────────────────────────────────────────────
// · 并发上限 config.runnerConcurrency（默认 1：串行最稳，观察后再放开）；
// · Host 重启：进程内的 in-flight 集合没了 ⇒ 启动时对账一次——`running` 且**不在跑**的任务
//   重新拾取（legacy 语义：卡在 running 的任务重启后由 runner 恢复，不假装还在跑 ✗）。
//
// ── 审批 ───────────────────────────────────────────────────────────────────
// 后台回合没有人工 ⇒ 走 1.5 的审批闸：config.runnerAllowTools 白名单（默认 [] = 全拒，
// 任务需要写权限时由部署方显式放开 ✓）。
//
// 依赖全走**可选注入**（`ctx.get`）：vssarosRuns（bridge 插件提供）不在 ⇒ runner 不启动，
// 看板的读/写/页面照常 ✓。

const STATUS_RUNNING = 'running';
const STATUS_DONE = 'done';
const STATUS_BLOCKED = 'blocked';
const TERMINAL = new Set(['done', 'cancelled', 'archived']);

/** 拼执行提示词（legacy `_buildTaskPrompt` 的精简版：标题 + 描述 + 任务 id 回指）。 */
export function buildTaskPrompt(task) {
	const parts = [`# 任务：${task.title}`];
	if (task.description) {
		parts.push('', String(task.description));
	}
	parts.push('', `（看板任务 id：${task.id}。完成后不用动看板——结果由 runner 回写。）`);
	return parts.join('\n');
}

/** 回执文本：一段追加到描述尾部的话（可读、幂等——重复写前先剥掉旧回执）。 */
export function receiptText({ stopReason, finalText, elapsedMs }) {
	const head = stopReason === 'completed' ? '✅ 已完成' : `⚠️ 未完成（${stopReason ?? '未知'}）`;
	const tail = typeof finalText === 'string' && finalText.trim() ? finalText.trim() : '（无最终文本）';
	return `\n\n---\n**执行回执**（${new Date().toISOString()}，耗时 ${Math.round((elapsedMs ?? 0) / 1000)}s）：${head}\n\n${tail.length > 800 ? tail.slice(0, 800) + '…' : tail}`;
}

/** 剥掉旧回执（幂等：重复执行同一任务不该把回执叠起来）。 */
export function stripReceipt(description) {
	return String(description ?? '').replace(/\n\n---\n\*\*执行回执\*\*[\s\S]*$/, '');
}

/**
 * 创建 runner。deps:
 *   readBoard() → tasks[]（当前看板，含 running 的）
 *   mutateTaskboard(mutator)（锁 + CAS 写回）
 *   runs（vssarosRuns 服务：run/cancel）
 *   cwdOf(workspaceId) → string（工作区路径；拿不到的由调用方给 fallback）
 *   log(level, msg)
 *   config: { runnerConcurrency?, runnerAllowTools?, timeoutMs? }
 */
export function createKanbanRunner(deps) {
	const { readBoard, mutateTaskboard, runs, cwdOf, log, config = {} } = deps;
	const concurrency = Math.max(1, Number(config.runnerConcurrency ?? 1));
	const allowTools = Array.isArray(config.runnerAllowTools) ? config.runnerAllowTools : [];
	const timeoutMs = Number(config.timeoutMs ?? 30 * 60_000);

	/** 在跑的：taskId → { sessionId, cancel } */
	const inFlight = new Map();
	let pollTimer = null;
	let stopped = false;

	async function execute(task) {
		const sessionId = `task:${task.id}`;
		const cwd = cwdOf(task.workspaceId);
		inFlight.set(task.id, { sessionId });
		log('info', `runner 拾取任务 ${task.id}「${task.title}」⇒ 会话 ${sessionId}`);
		try {
			const result = await runs.run({
				sessionId,
				cwd,
				prompt: buildTaskPrompt(task),
				timeoutMs,
				approval: { allow: allowTools },
			});
			const done = result.stopReason === 'completed';
			await mutateTaskboard(tasks => {
				const t = tasks.find(x => x.id === task.id);
				// 执行期间被归档/取消/拖走 ⇒ 不动（用户接管了 ✓）；数组原样返回（不写文件）。
				if (!t || TERMINAL.has(t.status) || t.status !== STATUS_RUNNING) {
					return { tasks, value: undefined };
				}
				const next = tasks.map(x => x.id === task.id ? {
					...x,
					status: done ? STATUS_DONE : STATUS_BLOCKED,
					description: stripReceipt(x.description) + receiptText(result),
					...(done ? {} : { lastError: `stopReason=${result.stopReason ?? 'unknown'}` }),
					updatedAt: new Date().toISOString(),
				} : x);
				return { tasks: next, value: undefined };
			});
			log('info', `runner 任务 ${task.id} 回合结束：${result.stopReason} ⇒ ${done ? 'done' : 'blocked'}`);
		} catch (e) {
			await mutateTaskboard(tasks => {
				const t = tasks.find(x => x.id === task.id);
				if (!t || TERMINAL.has(t.status) || t.status !== STATUS_RUNNING) {
					return { tasks, value: undefined };
				}
				const next = tasks.map(x => x.id === task.id ? {
					...x,
					status: STATUS_BLOCKED,
					lastError: String(e?.message ?? e),
					updatedAt: new Date().toISOString(),
				} : x);
				return { tasks: next, value: undefined };
			});
			log('warn', `runner 任务 ${task.id} 执行出错：${String(e?.message ?? e)}`);
		} finally {
			inFlight.delete(task.id);
		}
	}

	/** 对账一轮：拾取 running 且没在跑的任务；取消已不在 running 的在跑任务。 */
	async function reconcile() {
		if (stopped) { return; }
		let tasks = [];
		try {
			tasks = await readBoard();
		} catch (e) {
			log('warn', `runner 读看板失败（本轮跳过）：${String(e?.message ?? e)}`);
			return;
		}
		const runningIds = new Set(tasks.filter(t => t.status === STATUS_RUNNING).map(t => t.id));
		// 取消：在跑但已不在 running（被拖走/删除）⇒ 取消会话当前活动
		for (const [taskId, run] of inFlight) {
			if (!runningIds.has(taskId)) {
				inFlight.delete(taskId);
				runs.cancel({ sessionId: run.sessionId }).catch(() => undefined);
				log('info', `runner 取消任务 ${taskId}（已不在 running）`);
			}
		}
		// 拾取：有空位才拾
		const slots = concurrency - inFlight.size;
		if (slots <= 0) { return; }
		const fresh = tasks.filter(t => t.status === STATUS_RUNNING && !inFlight.has(t.id)).slice(0, slots);
		for (const task of fresh) {
			void execute(task);
		}
	}

	return {
		/** 启动（对账一次 + 起轮询）。幂等。 */
		start({ pollMs = 15_000 } = {}) {
			if (pollTimer) { return; }
			stopped = false;
			void reconcile();
			pollTimer = setInterval(() => void reconcile(), pollMs);
			pollTimer.unref?.();
			log('info', `看板 runner 已启动（并发 ${concurrency}，轮询 ${pollMs / 1000}s）`);
		},
		/** 停止（不动在跑的回合——会话是持久的，重启后对账会重新拾取）。 */
		stop() {
			stopped = true;
			if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
		},
		/** 立即对账一轮（任务状态变更后调用，比等轮询快）。 */
		kick() { return reconcile(); },
		/** 诊断：在跑的任务。 */
		inFlight: () => [...inFlight.entries()].map(([taskId, r]) => ({ taskId, sessionId: r.sessionId })),
	};
}
