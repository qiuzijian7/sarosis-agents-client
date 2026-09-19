/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 后台任务**完成通知**（2026-09-19）—— 把 `execute_code` `background:true` 启动的任务的**完成事件**
 * 推给一条订阅通道，让 driver 在**转次间隙**注入为 steering 消息（不打断当前轮 ✓，对齐 Claude Code
 * 的 `<task-notification>` ✓）。
 *
 * ## 为什么是这个形态
 * - 外部日志（`vscode-app-1789813310143.log`）的真机病根：agent 不用 `background:true`，改用前景
 *   `sleep 200` 轮询 9 轮 ⇒ 撞满 1800s 超时，一个 turn 白等 30 分钟 ✗✗。
 *   功能一直都在（`background`/`action:poll|kill` ✓）—— **缺的是"没人拉也能送达"** ✗（Claude Code
 *   之所以不需要 poll，是因为它**推**：完成时在 idle 间隙投递 ✓✓）。本模块把"推"补上 ✓。
 * - 本模块**只管"盯"和"发"**，不知道 driver / 队列 ✗（解耦 ✓）；投递是 driver 的职责（它有
 *   `enqueueSteeringMessage` ✓）。
 * - 完成判定**复用** `execute_code` 自己的 poll 语义（由调用方把 `_execCodeControl` 注入进来 ✓），
 *   **不另造协议** ✗。
 *
 * ## 三条不变量（由单测钉住 ✓）
 * ① **一次性**：同一 `taskId` 完成只发一次 ✓（`watch()` 幂等：重复登记返回 false ✓）；
 * ② **预算**：最多盯 `maxWatchMs`（默认 15 分钟）⇒ 不会永盯 ✗（到点静默放弃，**不打日志刷屏** ✗✓）；
 * ③ **瞬时失败不丢**：单次 poll 失败**重试**（IPC 抖动不该让通知永久消失 ✗），且**不抛** ✓。
 */

import { Emitter } from '../../../../../../base/common/event.js';

/** 一次后台任务完成的通知负载。 */
export interface IBackgroundTaskFinishedEvent {
	readonly taskId: string;
	readonly agentId: string;
	readonly sessionId: string | undefined;
	readonly status: 'finished' | 'killed';
	readonly exitCode: number | undefined;
	/** 截断后的 stdout 尾巴（贴给模型做上下文 ✓；只带尾巴不带全量 ✗ 防上下文膨胀 ✓）。 */
	readonly stdoutTail: string;
	readonly elapsedMs: number;
}

/** poll 控制面的形状（由 `execute_code` 把自己的 `_execCodeControl(taskId,'poll')` 注入 ✓）。 */
export interface IBackgroundTaskPollResult {
	readonly done?: boolean;
	readonly killed?: boolean;
	readonly exitCode?: number;
	readonly stdout?: string;
}

export interface IExecBackgroundNotifierOptions {
	/** 轮询间隔（ms）。默认 3000。 */
	pollMs?: number;
	/** 盯守预算（ms）。默认 15 分钟。 */
	maxWatchMs?: number;
	/** 时钟（测试注入 ✓）。 */
	now?: () => number;
	/** stdout 尾巴保留多少字符。默认 1200。 */
	tailChars?: number;
}

export class ExecBackgroundNotifier {
	private readonly _emitter = new Emitter<IBackgroundTaskFinishedEvent>();
	/** 事件：后台任务完成（driver 订阅它做投递 ✓）。 */
	readonly onDidFinishBackgroundTask = this._emitter.event;

	/** 正在盯守的 taskId 集合（防同一任务被重复盯 ✓，也防同一完成被发两次 ✓）。 */
	private readonly _watching = new Set<string>();

	private readonly _pollMs: number;
	private readonly _maxWatchMs: number;
	private readonly _now: () => number;
	private readonly _tailChars: number;

	constructor(opts: IExecBackgroundNotifierOptions = {}) {
		this._pollMs = opts.pollMs ?? 3000;
		this._maxWatchMs = opts.maxWatchMs ?? 15 * 60 * 1000;
		this._now = opts.now ?? (() => Date.now());
		this._tailChars = opts.tailChars ?? 1200;
	}

	/** 当前正在盯守的任务数（诊断/测试用 ✓）。 */
	get watchingCount(): number { return this._watching.size; }

	/**
	 * 登记盯守（**幂等**）：任务完成时发一次 `onDidFinishBackgroundTask`。
	 * @returns `true` = 新登记；`false` = 该任务已在盯 ✓。
	 */
	watch(
		taskId: string,
		agentId: string,
		sessionId: string | undefined,
		poll: (taskId: string) => Promise<IBackgroundTaskPollResult>,
	): boolean {
		if (!taskId || this._watching.has(taskId)) { return false; }
		this._watching.add(taskId);
		const startedAt = this._now();

		const tick = async (): Promise<void> => {
			try {
				const ctrl = await poll(taskId);
				if (ctrl.done || ctrl.killed) {
					this._watching.delete(taskId);
					const stdout = ctrl.stdout ?? '';
					this._emitter.fire({
						taskId,
						agentId,
						sessionId,
						status: ctrl.killed ? 'killed' : 'finished',
						exitCode: ctrl.exitCode,
						stdoutTail: stdout.length > this._tailChars ? stdout.slice(-this._tailChars) : stdout,
						elapsedMs: this._now() - startedAt,
					});
					return;
				}
			} catch {
				// 单次 poll 失败 ⇒ 重试（任务的瞬时 IPC 抖动不该让通知永久消失 ✗）；不抛、不刷屏 ✓
			}
			if (this._now() - startedAt >= this._maxWatchMs) {
				// 预算到点：不再盯（静默放弃 ✗ —— 长任务的主人多半已经走了；由 driver 决定要不要说）
				this._watching.delete(taskId);
				return;
			}
			setTimeout(() => { void tick(); }, this._pollMs);
		};
		void tick();
		return true;
	}
}

/**
 * 进程内唯一真源（工具层登记盯守 ✓，driver 订阅投递 ✓）。
 * ⚠ 测试**不要**用这个单例（状态会串 ✗）—— 用 `new ExecBackgroundNotifier(...)` ✓。
 */
export const execBackgroundNotifier = new ExecBackgroundNotifier();
