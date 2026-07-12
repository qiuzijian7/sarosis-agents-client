/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── BridgeScheduler：cron（周期）+ timer（一次性）定时任务（对齐 cc-connect cron.go/timer.go）──
// 触发时复用 BridgeEngine.handleSynthetic(sessionKey, prompt) 向 Agent 发 prompt，结果经会话 replyCtx 回传。
// 持久化：可选注入 IScheduledTaskStore（由 bridgeService 用 fs 落 <workDir>/scheduler.json 提供），
// start() 时 restore、增删/触发后 persist；无 store 时退化为内存态（重启清空）。

import { Disposable } from "../../../../../base/common/lifecycle.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import { BridgeEngine } from "./bridgeEngine.js";
import { cronMatches } from "./cronParser.js";

export interface ScheduledTask {
	readonly id: string;
	readonly kind: "cron" | "timer";
	name: string;
	sessionKey: string;
	prompt: string;
	replyCtx?: unknown;
	cronExpr?: string; // kind === 'cron'
	fireAt?: number; // epoch ms，kind === 'timer'
	enabled: boolean;
	silent?: boolean;
	readonly createdAt: number;
	lastRun?: number;
	lastError?: string;
	/** cron 去重：已触发过的「分钟桶」，避免同分钟内重复点火。 */
	_firedMinute?: number;
}

export interface AddCronOpts {
	sessionKey: string;
	cronExpr: string;
	prompt: string;
	name?: string;
	replyCtx?: unknown;
	silent?: boolean;
}

export interface AddTimerOpts {
	sessionKey: string;
	prompt: string;
	/** 相对延迟，如 "30m" / "2h" / "1h30m"；与 atTime 二选一。 */
	delay?: string;
	/** 绝对时间 ISO（本地时区），如 "2026-07-16T09:00"。 */
	atTime?: string;
	name?: string;
	replyCtx?: unknown;
	mute?: boolean;
}

/**
 * 任务持久化存储接口（同步 API，便于测试注入内存实现）。
 * 真实实现见 `bridgeSchedulerStore.ts`（fs 落盘）。
 */
export interface IScheduledTaskStore {
	load(): ScheduledTask[];
	save(tasks: ScheduledTask[]): void;
}

export interface BridgeSchedulerDeps {
	readonly engine: BridgeEngine;
	readonly logService: ILogService;
	/** 轮询刻度（ms），默认 30s。 */
	readonly tickMs?: number;
	/** 可选持久化存储；提供则 start() 时 restore、变更后 persist。 */
	readonly store?: IScheduledTaskStore;
}

function parseDelay(s: string): number | undefined {
	const m = s.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
	if (!m) {
		return undefined;
	}
	const h = parseInt(m[1] ?? "0", 10);
	const min = parseInt(m[2] ?? "0", 10);
	const sec = parseInt(m[3] ?? "0", 10);
	if (h === 0 && min === 0 && sec === 0) {
		return undefined;
	}
	return (h * 3600 + min * 60 + sec) * 1000;
}

function genId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class BridgeScheduler extends Disposable {
	private readonly _engine: BridgeEngine;
	private readonly _log: ILogService;
	private readonly _tickMs: number;
	private readonly _taskStore?: IScheduledTaskStore;
	private readonly _tasks = new Map<string, ScheduledTask>();
	private _timer?: ReturnType<typeof setInterval>;
	private _restored = false;

	constructor(deps: BridgeSchedulerDeps) {
		super();
		this._engine = deps.engine;
		this._log = deps.logService;
		this._tickMs = deps.tickMs ?? 30_000;
		this._taskStore = deps.store;
	}

	start(): void {
		if (this._timer) {
			return;
		}
		this._restore();
		this._timer = setInterval(() => this._tick(), this._tickMs);
		this._log.info(`[BridgeScheduler] started, tick=${this._tickMs}ms, tasks=${this._tasks.size}`);
	}

	/** 从持久化存储恢复任务（仅一次；转瞬字段 _firedMinute 重置，已完成的 timer 跳过）。 */
	private _restore(): void {
		if (this._restored || !this._taskStore) {
			return;
		}
		this._restored = true;
		let loaded: ScheduledTask[];
		try {
			loaded = this._taskStore.load();
		} catch (err) {
			this._log.error(`[BridgeScheduler] restore load failed:`, err);
			return;
		}
		for (const t of loaded) {
			if (!t || typeof t.id !== "string") {
				continue;
			}
			// 已触发完成的一次性 timer 不恢复（避免重复点火）
			if (t.kind === "timer" && t.enabled === false) {
				continue;
			}
			t._firedMinute = undefined; // 转瞬去重字段不跨重启保留
			this._tasks.set(t.id, t);
		}
		if (this._tasks.size > 0) {
			this._log.info(`[BridgeScheduler] restored ${this._tasks.size} task(s) from store`);
		}
	}

	/** 将当前任务集写入持久化存储（无 store 时空操作）。 */
	private _persist(): void {
		if (!this._taskStore) {
			return;
		}
		try {
			this._taskStore.save([...this._tasks.values()]);
		} catch (err) {
			this._log.error(`[BridgeScheduler] persist failed:`, err);
		}
	}

	stop(): void {
		if (this._timer) {
			clearInterval(this._timer);
			this._timer = undefined;
		}
	}

	addCron(opts: AddCronOpts): ScheduledTask {
		// 立即校验表达式合法性
		cronMatches(opts.cronExpr, new Date());
		const task: ScheduledTask = {
			id: genId("cron"),
			kind: "cron",
			name: opts.name ?? opts.prompt.slice(0, 40),
			sessionKey: opts.sessionKey,
			prompt: opts.prompt,
			replyCtx: opts.replyCtx,
			cronExpr: opts.cronExpr,
			enabled: true,
			silent: opts.silent,
			createdAt: Date.now(),
		};
		this._tasks.set(task.id, task);
		this._persist();
		this._log.info(`[BridgeScheduler] cron added ${task.id} '${task.cronExpr}'`);
		return task;
	}

	addTimer(opts: AddTimerOpts): ScheduledTask {
		let fireAt: number | undefined;
		if (opts.atTime) {
			const d = new Date(opts.atTime);
			if (isNaN(d.getTime())) {
				throw new Error(`[BridgeScheduler] 非法 atTime：${opts.atTime}`);
			}
			fireAt = d.getTime();
		} else if (opts.delay) {
			const ms = parseDelay(opts.delay);
			if (ms === undefined) {
				throw new Error(`[BridgeScheduler] 非法 delay：${opts.delay}`);
			}
			fireAt = Date.now() + ms;
		}
		if (fireAt === undefined) {
			throw new Error("[BridgeScheduler] 必须提供 delay 或 atTime");
		}
		const task: ScheduledTask = {
			id: genId("timer"),
			kind: "timer",
			name: opts.name ?? opts.prompt.slice(0, 40),
			sessionKey: opts.sessionKey,
			prompt: opts.prompt,
			replyCtx: opts.replyCtx,
			fireAt,
			enabled: true,
			silent: opts.mute,
			createdAt: Date.now(),
		};
		this._tasks.set(task.id, task);
		this._persist();
		this._log.info(`[BridgeScheduler] timer added ${task.id} fireAt=${new Date(fireAt).toISOString()}`);
		return task;
	}

	remove(id: string): boolean {
		const ok = this._tasks.delete(id);
		if (ok) {
			this._persist();
		}
		return ok;
	}

	list(): ScheduledTask[] {
		return [...this._tasks.values()];
	}

	/** 立即触发一次（对齐 cc-connect cron exec）。 */
	async triggerNow(id: string): Promise<void> {
		const task = this._tasks.get(id);
		if (!task) {
			throw new Error(`[BridgeScheduler] 未找到任务：${id}`);
		}
		await this._fire(task);
	}

	private _tick(): void {
		const now = new Date();
		const minuteBucket = now.getHours() * 60 + now.getMinutes();
		for (const task of this._tasks.values()) {
			if (!task.enabled) {
				continue;
			}
			if (task.kind === "cron") {
				if (!task.cronExpr) {
					continue;
				}
				try {
					if (cronMatches(task.cronExpr, now) && task._firedMinute !== minuteBucket) {
						task._firedMinute = minuteBucket;
						this._fire(task).catch(err => this._log.error(`[BridgeScheduler] fire failed:`, err));
					}
				} catch (err) {
					this._log.error(`[BridgeScheduler] cron match error for ${task.id}:`, err);
				}
			} else {
				// timer：到点即触发一次后移除
				if (task.fireAt !== undefined && now.getTime() >= task.fireAt) {
					task.enabled = false;
					this._fire(task).catch(err => this._log.error(`[BridgeScheduler] timer fire failed:`, err));
					this._tasks.delete(task.id);
					this._persist();
				}
			}
		}
	}

	private async _fire(task: ScheduledTask): Promise<void> {
		task.lastRun = Date.now();
		task.lastError = undefined;
		try {
			if (!task.silent) {
				this._log.info(`[BridgeScheduler] firing ${task.id} → ${task.sessionKey}: ${task.prompt.slice(0, 60)}`);
			}
			await this._engine.handleSynthetic(task.sessionKey, task.prompt, {
				replyCtx: task.replyCtx,
				userId: task.silent ? "scheduler-silent" : "scheduler",
			});
		} catch (err) {
			task.lastError = String(err);
			this._log.error(`[BridgeScheduler] task ${task.id} error:`, err);
		}
		// 触发后 lastRun/lastError 变化，落盘保留运行状态
		this._persist();
	}
}
