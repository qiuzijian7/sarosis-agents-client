// @vssaros/dsh-scheduler — 调度引擎（自建）。纯逻辑 + 可注入时钟，便于单测。
//
// ★ 与官方 `@deepseek-ai/dsh-schedule` 的三点差别，正是自建的理由：
//   1. **有 `onFire` 事件**：loop / 别的插件可以订阅"某个任务到点了"，不必轮询投递历史；
//   2. **任务有三型**：`prompt`（投会话）/ `loop`（触发循环）/ `action`（调服务）——官方只有第一种；
//   3. **先落盘再派发**：`lastRun.seq` + `next.target` 落地后才通知监听者 ⇒ 崩溃不会重复投递。
//
// ⚠ 两条纪律：
//   · **不补跑**：启动时把过期的任务直接推进到下一个未来时刻（而不是"欠了几轮就跑几轮"）；
//   · **派发不阻塞**：监听者抛错只记日志，绝不让一个任务的异常停掉整个引擎。

import { HISTORY_KEEP, readTasks, writeTasks } from './store.js';
import { isDue, markFired, nextRunAtMs, normalizeTask, workItemKeyOf } from './core/task.js';

const DEFAULT_TICK_MS = 30_000;

const clone = value => (value == null ? value : JSON.parse(JSON.stringify(value)));

export function createScheduleEngine(options = {}) {
	const {
		config = {},
		log = () => undefined,
		now = () => Date.now(),
		setIntervalFn,
		clearIntervalFn,
		tickMs = DEFAULT_TICK_MS,
		timeZone = 'UTC',
		// ★ 2026-10-31：企微推送 webhook（Host config.notifyWebhook）。没配 ⇒ notify 任务只落
		//   「推送被跳过」的日志，不假装推送。
		notifyWebhook = '',
	} = options;

	/** notify 任务的企微推送（fireNow 与 tick 都走这里；失败只记日志，不影响派发）。 */
	const notifyOf = async (task, atMs) => {
		if (!task?.notify) { return; }
		if (!notifyWebhook) {
			log(`任务 ${task.id} 开了推送但 config.notifyWebhook 未配置 ⇒ 跳过（不假装推送）`);
			return;
		}
		try {
			const res = await fetch(notifyWebhook, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					msgtype: 'text',
					text: { content: `[自动化任务] ${task.title}\n${task.prompt || ''}\n（${new Date(atMs).toLocaleString()}）` },
				}),
			});
			if (!res.ok) { log(`任务 ${task.id} 的企微推送失败：HTTP ${res.status}`); }
		} catch (error) {
			log(`任务 ${task.id} 的企微推送失败：${String(error?.message ?? error)}`);
		}
	};

	const loaded = readTasks(config);
	let store = loaded.tasks;
	if (loaded.note) {
		log(`任务库读取异常：${loaded.note}`);
	}

	let timer = null;
	const listeners = new Set();

	const save = () => writeTasks(config, store);
	const findIndex = id => store.tasks.findIndex(t => t?.id === id);

	/** 派发（先落盘后通知，见文件头）。 */
	function emit(task, atMs) {
		const payload = {
			taskId: task.id,
			task: clone(task),
			atMs,
			seq: task.lastRun?.seq ?? 0,
			workItemKey: workItemKeyOf(task, { atMs }),
		};
		for (const cb of [...listeners]) {
			try {
				cb(payload);
			} catch (error) {
				// 一个监听者炸了，其余照常；引擎不停。
				log(`任务 ${task.id} 的 onFire 监听者抛错（已忽略）：${String(error?.message ?? error)}`);
			}
		}
	}

	/**
	 * 启动追赶：把**已经过期**的任务直接推进到下一个未来时刻。
	 * 为什么不补跑：机器睡了一夜 / Host 停了一天，补跑会一次性放出 N 轮 —— 比漏一轮严重得多。
	 */
	function catchUp(atMs) {
		let dirty = false;
		store.tasks = store.tasks.map(task => {
			if (task.status !== 'active') { return task; }
			const target = Number(task?.next?.target);
			if (Number.isFinite(target) && target > atMs) { return task; }
			dirty = true;
			return { ...task, next: { target: nextRunAtMs(task.rule, atMs, task.rule.timeZone || timeZone) } };
		});
		if (dirty) { save(); }
		return dirty;
	}

	/** 一次 tick：先处理到期停用（有效期），再对所有到点的任务各触发一次。 */
	function tick() {
		const atMs = now();
		let dirty = false;
		// ★ 有效期：到点自动停用（任务保留可查看，不再触发）。
		for (let i = 0; i < store.tasks.length; i += 1) {
			const task = store.tasks[i];
			if (task?.status === 'active' && task.expiresAt && Date.parse(task.expiresAt) <= atMs) {
				store.tasks[i] = { ...task, status: 'inactive' };
				dirty = true;
				log(`任务 ${task.id} 已过有效期（${task.expiresAt}）⇒ 自动停用`);
			}
		}
		if (dirty) { save(); }
		for (let i = 0; i < store.tasks.length; i += 1) {
			const task = store.tasks[i];
			if (!isDue(task, atMs)) { continue; }
			const fired = markFired(task, { atMs });
			store.tasks[i] = fired;
			store.history = [
				...(Array.isArray(store.history) ? store.history : []),
				{ taskId: fired.id, at: atMs, ok: true, seq: fired.lastRun?.seq ?? 0 },
			].slice(-HISTORY_KEEP);
			dirty = true;
			// 落盘**先于**派发：进程此刻死掉也不会重复投（seq 与 next 都已推进）。
			save();
			emit(fired, atMs);
			// 企微推送（notify=true 且配置了 webhook 才真的发）。
			notifyOf(fired, atMs);
		}
		// ⚠ 循环内已经逐条 `save()`（且**先于** emit）⇒ 这里**不要**再补一次。
		//   补一次看着"更保险"，实则掩盖了"派发前是否落盘"这件事 —— 反向突变验证时
		//   "把循环内的 save 删掉"竟然测不出来（末尾那次救了它）。
		return dirty;
	}

	const service = {
		/** 全部任务（副本，防止外部改内存）。 */
		list: () => store.tasks.map(clone),
		get: id => {
			const task = store.tasks[findIndex(id)];
			return task ? clone(task) : null;
		},
		/** 新建（校验走 `normalizeTask`，越界直接抛）。 */
		create: raw => {
			const task = normalizeTask(raw, { nowMs: now(), timeZone: timeZone });
			if (findIndex(task.id) >= 0) {
				throw new Error(`任务 id 已存在：${task.id}`);
			}
			store.tasks.push(task);
			save();
			return clone(task);
		},
		update: (id, patch) => {
			const index = findIndex(id);
			if (index < 0) { return null; }
			const merged = normalizeTask({ ...store.tasks[index], ...patch, id }, { nowMs: now(), timeZone: timeZone });
			store.tasks[index] = merged;
			save();
			return clone(merged);
		},
		remove: id => {
			const index = findIndex(id);
			if (index < 0) { return false; }
			store.tasks.splice(index, 1);
			save();
			return true;
		},
		/** UI 用的分页清单（按下次运行升序）。 */
		catalog: ({ limit = 50 } = {}) => store.tasks
			.slice()
			.sort((a, b) => Number(a?.next?.target ?? Infinity) - Number(b?.next?.target ?? Infinity))
			.slice(0, limit)
			.map(clone),
		/** 投递历史（新在前）。 */
		history: ({ id, limit = 20 } = {}) => (Array.isArray(store.history) ? store.history : [])
			.filter(h => !id || h?.taskId === id)
			.slice(-limit)
			.reverse()
			.map(clone),
		nextRunAtOf: task => nextRunAtMs(task.rule, now(), task.rule.timeZone || timeZone),
		/** ★ 官方没有的：订阅"到点"事件。返回 dispose。 */
		onFire: cb => {
			if (typeof cb !== 'function') { return () => undefined; }
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		/**
		 * 手动触发一次（调试/UI「立即运行」用）。
		 * ⚠ 必须走与 `tick` **同一条记账路径**（记 history、推进 seq、落盘）—— 否则
		 *   "手动跑过"在投递历史里查不到，排查时会以为引擎漏了。
		 */
		fireNow: id => {
			const index = findIndex(id);
			if (index < 0) { return false; }
			const atMs = now();
			const fired = markFired(store.tasks[index], { atMs });
			store.tasks[index] = fired;
			store.history = [
				...(Array.isArray(store.history) ? store.history : []),
				{ taskId: fired.id, at: atMs, ok: true, seq: fired.lastRun?.seq ?? 0, manual: true },
			].slice(-HISTORY_KEEP);
			save();
			emit(fired, atMs);
			// 手动触发的企微推送（notify=true 且配置了 webhook 才真的发）。
			notifyOf(fired, atMs);
			return true;
		},
		start: () => {
			if (timer) { return false; }
			catchUp(now());
			timer = setIntervalFn ? setIntervalFn(() => tick(), tickMs) : null;
			return true;
		},
		stop: () => {
			if (!timer) { return false; }
			if (clearIntervalFn) { clearIntervalFn(timer); }
			timer = null;
			return true;
		},
		/** 单测/探针用：跑一次 tick、不做定时。 */
		_tick: tick,
		_catchUp: catchUp,
		_store: () => store,
	};

	return service;
}

/**
 * 决定要不要占用 `schedule` 服务键。
 *
 * ★ 撞键保护：若组合里**已经有人**提供了 `schedule`（例如将来又把官方
 *   `dsh-experimental-schedule-bundle` 装上了）⇒ 我们**不注册**，只记日志。
 *   宁可没有自建调度，也不能让两个 provider 抢同一个键（那会让调用方随机拿到其中一个）。
 */
export function shouldProvideSchedule(ctx) {
	try {
		const existing = ctx.get?.('schedule') ?? ctx.schedule ?? null;
		return { ok: !existing, existing: !!existing };
	} catch {
		// 探针的假 ctx 对未声明服务抛错 ⇒ 视为"没人提供"
		return { ok: true, existing: false };
	}
}
