/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 会话**只读跟随器**（P1-5 收尾，2026-09-21）。
 *
 * ── 它补的是哪个洞 ─────────────────────────────────────────────────────────────
 * 多开 `--instance` 打开同一会话时，靠**会话锁文件**保证互斥 ✓：后来者进入
 * `_sessionReadOnly = true`（发送被拦截 ✓）。但**只读侧此前不会活更新** ✗ ——
 * 另一实例写进去的内容，要等用户手动重开/切换才可见 ✓。
 * 同为进程内的多 pane 不受影响 ✓（外部 delta 已广播 + 同 session 各 pane 独立渲染 ✓）。
 *
 * 本模块 = 把 P1-5 的**游标协议**接成"跟随" ✓：
 *   每 `pollMs` 用游标读一次事件 ⇒ 有 `message` 事件 ⇒ 通知调用方重载 ✓；
 *   `reset` 事件（历史被整段改写/日志被压缩重写 ✓）⇒ 同样重载（**快照是权威** ✓）。
 * ⇒ **没有新事件就一次回调都不发** ✓ ⇒ 天然不产生"轮询导致的闪烁" ✓✓。
 *
 * ── 四条抗脆弱设计（都有测试 ✓）────────────────────────────────────────────────
 * ① **链式 setTimeout 而非 setInterval** ✓：读取慢于轮询间隔时**绝不叠加**并发读 ✗
 *    （setInterval 会让慢读堆成 N 个在途请求 ✗）；
 * ② **读失败不退出** ✓：只 warn + 按 `pollMs × 2^k` 退避（上限 `MAX_BACKOFF_MS` ✓），
 *    下次成功即复位 —— 跟随器因一次 IO 抖动而死是最糟的失败模式 ✗✓；
 * ③ **dispose 幂等** ✓：停止后不再触碰 reader（测试断言 ✓）；
 * ④ **游标只前进** ✓：`reset` 时不重置游标（协议口径：reset 事件自身也占一个 seq ✓）。
 *
 * ⚠ 诚实边界 ✗：事件粒度是**消息级**（每次 `appendMessage`/`updateMessage` 一条 ✓），
 * 不是逐 token ✗ ⇒ 跟随方看到的是"每个 iteration 一跳"，不是逐字跟读 ✓。
 * 想要逐字共享必须另加 delta 事件（另行设计 ✓）。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';

import type { IReadSessionEventsResult, ISessionEvent, ISessionEventCursor } from '../common/sessionEventStream.js';

/** 跟随器只依赖这一个读取能力 ✓（结构化类型 ⇒ 单测可注入假实现 ✓、零服务耦合 ✓）。 */
export interface ISessionEventReader {
	readSessionEvents(agentId: string, sessionId: string, cursor?: ISessionEventCursor): Promise<IReadSessionEventsResult>;
}

/** 失败时的退避上限（10s ✓ —— 再长就跟"没跟随"没区别了 ✗）。 */
const MAX_BACKOFF_MS = 10_000;
const DEFAULT_POLL_MS = 1500;

export interface ISessionFollowerOptions {
	readonly reader: ISessionEventReader;
	readonly agentId: string;
	readonly sessionId: string;
	/** 有新消息事件（增量 ✓，不是"每次轮询" ✗）。 */
	readonly onEvent: (event: ISessionEvent) => void;
	/** 历史被整段改写 / 日志被压缩重写 ⇒ 调用方须重载（快照 ✓）。 */
	readonly onReset: () => void;
	readonly pollMs?: number;
	/** 仅用于告警（可选 ✓ —— 不传则不打扰 ✓）。 */
	readonly logService?: { warn(message: string, ...args: unknown[]): void; info?(message: string, ...args: unknown[]): void };
}

export class SessionFollower extends Disposable {

	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _disposed = false;
	private _running = false;
	private _inFlight = false;
	private _cursor: ISessionEventCursor = { seq: 0 };
	private _consecutiveFailures = 0;

	constructor(private readonly _options: ISessionFollowerOptions) {
		super();
	}

	/** 已消费到的游标（诊断 / 测试 ✓）。 */
	get cursor(): ISessionEventCursor { return this._cursor; }

	/** 是否处于跟随态（已 start 且未 stop/dispose ✓）。 */
	get running(): boolean { return this._running && !this._disposed; }

	/** 正在等 reader 返回（诊断 / 测试：用于断言**不叠加** ✓）。 */
	get inFlight(): boolean { return this._inFlight; }

	start(): void {
		if (this._disposed || this._running) { return; }
		this._running = true;
		this._scheduleNextTick(0);
	}

	stop(): void {
		this._running = false;
		if (this._timer !== undefined) { clearTimeout(this._timer); this._timer = undefined; }
	}

	override dispose(): void {
		if (this._disposed) { return; } // ★ 幂等 ✓（pane 可能重复 stop/dispose ✓）
		this._disposed = true;
		this.stop();
		super.dispose();
	}

	private _scheduleNextTick(delayMs: number): void {
		if (this._disposed) { return; }
		if (this._timer !== undefined) { clearTimeout(this._timer); }
		this._timer = setTimeout(() => { this._timer = undefined; void this._tick(); }, Math.max(0, delayMs));
	}

	private async _tick(): Promise<void> {
		if (this._disposed || !this._running) { return; }
		this._inFlight = true;
		let nextDelay = this._options.pollMs && this._options.pollMs > 0 ? this._options.pollMs : DEFAULT_POLL_MS;
		try {
			const result = await this._options.reader.readSessionEvents(
				this._options.agentId, this._options.sessionId, this._cursor,
			);
			this._consecutiveFailures = 0;
			this._cursor = result.cursor;
			for (const event of result.events) {
				if (this._disposed) { return; } // 回调期间被释放 ⇒ 立即停 ✓
				if (event.kind === 'reset') { this._options.onReset(); continue; }
				this._options.onEvent(event);
			}
		} catch (err) {
			// ★ 读失败**不退出** ✓：退避重试（上限 10s ✓），成功即复位 ✓
			this._consecutiveFailures++;
			nextDelay = Math.min(MAX_BACKOFF_MS, nextDelay * Math.pow(2, Math.min(5, this._consecutiveFailures)));
			this._options.logService?.warn(
				`[SessionFollower] read failed for ${this._options.agentId}::${this._options.sessionId} ` +
				`(attempt ${this._consecutiveFailures}, retry in ${nextDelay}ms) — ${err instanceof Error ? err.message : err}`,
			);
		} finally {
			this._inFlight = false;
			if (!this._disposed && this._running) { this._scheduleNextTick(nextDelay); }
		}
	}
}
