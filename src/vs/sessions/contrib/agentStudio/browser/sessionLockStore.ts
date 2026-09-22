/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	createIndexLockToken,
	isIndexLockStale,
	parseIndexLock,
	serializeIndexLock,
} from './codebaseIndexLock.js';

/**
 * 会话锁（跨窗口互斥）—— 从 `agentChatService.ts` 拆出的独立簇 ✓（2026-09-22）。
 *
 * 语义（原注释保留 ✓）：`agents/{slug}/sessions/{sessionId}.lock`，持锁期间 30s 心跳刷新 mtime；
 * 2min 未刷新视为持有方崩溃、可接管（短于索引锁的 5min —— 会话崩溃恢复应更快 ✓）；释放仅删自己的锁 ✓。
 *
 * ⚠ 三个**不可退化**的既有约定（都是从事故里来的 ✗✓）：
 *  ① **fail-visible**：加锁异常时保留可用性（继续编辑），但必须把 `degraded: true` 显式返回 ✗✓
 *     —— 上层据此弹警告（旧实现是 fail-open + 不告诉任何人 ⇒ 两窗口同写、消息莫名回退 ✓）；
 *  ② **心跳失败也必须可见**：连续 2min 不刷新别人就有权接管，而本窗口仍在编辑 ⇒ 退化为"双方都以为持锁"
 *     ⇒ 只提示一次（不刷屏 ✓）；
 *  ③ **只删自己的锁**：释放前比对 token ✓（被接管后不要误删别人的 ✓）。
 */
export class SessionLockStore {
	/** 本实例（窗口）的锁 token —— 懒创建，跨会话复用 ✓。 */
	private _token: string | undefined;
	private _heartbeat: ReturnType<typeof setInterval> | undefined;
	/** 心跳失败只提示一次（P0-3：失败必须可见，但不能每 30s 刷屏 ✓）。 */
	private _heartbeatWarned = false;
	private _lockUri: URI | undefined;

	/** 会话锁过期阈值：2min 未心跳视为持有方崩溃，可接管（短于索引锁的 5min）。 */
	private static readonly STALE_MS = 2 * 60 * 1000;
	/** 心跳周期（刷新锁文件 mtime ✓）。 */
	private static readonly HEARTBEAT_MS = 30_000;

	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
		/** 取当前窗口实例 ID（用于锁文件里记录持有者 ✓）；缺失时为空串 ✓。 */
		private readonly getInstanceId: () => string | undefined,
		/** 解析该 agent 的 sessions 目录（由宿主注入 ⇒ 本模块不含路径学 ✓）。 */
		private readonly resolveSessionsDir: (agentId: string) => Promise<URI>,
	) { }

	/**
	 * 尝试获取会话锁。返回 acquired=false 时表示另一实例正在编辑（含持锁实例 ID）。
	 * 锁过期（持有方崩溃 2min）自动接管。
	 */
	async tryAcquire(agentId: string, sessionId: string): Promise<{ acquired: boolean; holderInstanceId?: string; degraded?: boolean }> {
		try {
			// ★ 2026-09-22（D-5 单测实测抓出的修复 ✓）：**先停掉上一次的心跳** ✗✓。
			//   原实现直接 `this._heartbeat = setInterval(...)` 覆盖 ⇒ ① 每次**切会话**泄漏一个 interval ✓；
			//   ② 旧 interval 的闭包捕获的是**旧 lockUri** ⇒ 它会把**已经释放的**会话锁文件**重新写出来** ✓✗
			//   （别的窗口看到那个会话"被本窗口持锁" ⇒ 无谓阻塞 ✓）；③ `release()` 只清最新那个 ⇒
			//   **孤儿心跳仍存活** ✓（宿主销毁后还在写锁文件 ✗）。
			//   实测（修复前）：两次获取后存活心跳 = 2 ✓、`release()` 后仍剩 1 ✓。
			//   ⚠ 用 `!== undefined` 而非真值判断 ✓：定时器 id 在浏览器里是数字 ⇒ 理论上可为 0（0 为假 ⇒ 漏清 ✗）。
			if (this._heartbeat !== undefined) {
				clearInterval(this._heartbeat);
				this._heartbeat = undefined;
			}
			const sessionsDirUri = await this.resolveSessionsDir(agentId);
			const lockUri = URI.joinPath(sessionsDirUri, `${sessionId}.lock`);
			if (!this._token) {
				this._token = createIndexLockToken(this.getInstanceId());
			}
			const token = this._token;

			// 已有锁且新鲜且属他人 → 拒绝
			try {
				const existing = await this.fileService.readFile(lockUri);
				const mtime = (await this.fileService.stat(lockUri)).mtime;
				const content = parseIndexLock(existing.value.toString());
				if (content && content.token !== token
					&& !isIndexLockStale(mtime, Date.now(), SessionLockStore.STALE_MS)) {
					return { acquired: false, holderInstanceId: content.instanceId };
				}
			} catch { /* 无锁文件 → 可获取 */ }

			// 释放旧锁（切换会话）
			await this._releaseFile();

			const writeLock = async () => {
				await this.fileService.writeFile(lockUri, VSBuffer.fromString(serializeIndexLock({
					token, instanceId: this.getInstanceId(), acquiredAt: Date.now(),
				})));
			};
			await writeLock();
			this._lockUri = lockUri;
			this._heartbeatWarned = false;
			this._heartbeat = setInterval(() => {
				void writeLock().catch(err => {
					// ★★★ P0-3（2026-09-15）：**心跳失败也不能静默**。
					// 锁的「新鲜度」由 mtime 决定：连续 2min 没刷新，别的窗口就有权接管 —— 而本窗口
					// **仍在编辑** ⇒ 退化为「双方都以为持有锁」，正是这把锁要防的局面。只提示一次，避免刷屏。
					if (!this._heartbeatWarned) {
						this._heartbeatWarned = true;
						this.logService.warn(`[SessionLockStore] session lock heartbeat failed (another window may take over after 2min): ${err}`);
					}
				});
			}, SessionLockStore.HEARTBEAT_MS);
			return { acquired: true };
		} catch (err) {
			// ★★★ 2026-09-15（P0-3）：**fail-open → fail-visible**。
			//
			// 原实现是 `warn('…(fail-open)')` + `return { acquired: true }` —— 即
			// 「加锁失败就当作拿到了锁，且**不告诉任何人**」✗。后果：用户以为会话受互斥保护，
			// 实际两个窗口可能同时写同一份对话历史（表现为「消息莫名少了 / 被回退」，且无从归因）。
			//
			// 现在：**保留可用性**（文件系统抖动不该把用户锁死在只读里），但把「未加锁」这个事实
			// 显式返回给上层 ⇒ pane 会弹警告 + 记日志（见 `nativeChatEditorPane._updateSessionLock`）。
			//
			// 为什么不是「直接降级只读」：① 此处失败多为瞬时/权限类抖动，而若连锁目录都写不进去、
			// 会话文件大概率也写不进去（保存时会报错，用户能看到）；② 会话写入已走原子写（P0-2）
			// ⇒ 最坏结果是「丢更新」，不再是「文件损坏」。**要点是"可见"，不是"禁止"。**
			this.logService.warn(`[SessionLockStore] tryAcquire failed — continuing WITHOUT lock (fail-visible): ${err}`);
			return { acquired: true, degraded: true };
		}
	}

	/** 释放当前持有的会话锁（仅删自己的锁 ✓）。 */
	async release(): Promise<void> {
		// ⚠ 同 `tryAcquire` ✓：用 `!== undefined` 判空（定时器 id 可为 0 ✗）
		if (this._heartbeat !== undefined) {
			clearInterval(this._heartbeat);
			this._heartbeat = undefined;
		}
		await this._releaseFile();
	}

	private async _releaseFile(): Promise<void> {
		const lockUri = this._lockUri;
		this._lockUri = undefined;
		if (!lockUri || !this._token) { return; }
		try {
			const cur = await this.fileService.readFile(lockUri);
			const content = parseIndexLock(cur.value.toString());
			if (content?.token === this._token) {
				await this.fileService.del(lockUri);
			}
		} catch { /* 锁已被删/被接管，忽略 */ }
	}
}
