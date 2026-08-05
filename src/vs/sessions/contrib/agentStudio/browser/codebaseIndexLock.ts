/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase 索引跨进程文件锁（纯逻辑，可单测）。
 *
 * 背景（多开 --instance）：两个实例打开同一 workspace 时会同时触发全量/增量索引，
 * 并发写 `<root>/.codebase-memory/graph.db.zst` → 图谱损坏。
 *
 * 机制：
 * - 索引前在 `<root>/.codebase-memory/index.lock` 写锁文件（含随机 token）。
 * - 锁文件 mtime 在索引期间由心跳刷新（每 60s）；另一进程发现锁且 mtime 新鲜 → 拒绝索引。
 * - 锁过期（持有方崩溃，mtime 超过 5min 未刷新）→ 接管。
 * - 释放时仅当锁内容 token 属于自己才删除（防误删接管竞态中的新锁）。
 */

/** 锁文件名（位于 <root>/.codebase-memory/ 下）。 */
export const INDEX_LOCK_FILENAME = 'index.lock';

/** 锁过期阈值：mtime 距今超过此值视为持有方已崩溃，可接管。 */
export const INDEX_LOCK_STALE_MS = 5 * 60 * 1000;

/** 心跳间隔：索引期间刷新锁文件 mtime 的频率。 */
export const INDEX_LOCK_HEARTBEAT_MS = 60 * 1000;

export interface IIndexLockContent {
	/** 持有方随机 token（每次进程启动生成），用于释放时的归属校验。 */
	token: string;
	/** 多开实例 ID（--instance <id>），便于排查；默认实例为 undefined。 */
	instanceId?: string;
	/** 获取锁的时间戳。 */
	acquiredAt: number;
}

export function serializeIndexLock(content: IIndexLockContent): string {
	return JSON.stringify(content);
}

/** 解析锁文件内容；非法/空内容返回 undefined（视为无有效锁，可直接接管）。 */
export function parseIndexLock(text: string): IIndexLockContent | undefined {
	try {
		const obj = JSON.parse(text) as IIndexLockContent;
		if (obj && typeof obj.token === 'string' && typeof obj.acquiredAt === 'number') {
			return obj;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** 判断锁是否已过期（mtime 距今超过阈值）。 */
export function isIndexLockStale(mtime: number, now: number, staleMs: number = INDEX_LOCK_STALE_MS): boolean {
	return now - mtime > staleMs;
}

/** 生成持有方 token（进程级随机串，无需 PID——renderer 无 process.pid）。 */
export function createIndexLockToken(instanceId?: string): string {
	const rand = Math.random().toString(36).slice(2, 10);
	return `${instanceId ?? 'default'}-${Date.now().toString(36)}-${rand}`;
}
