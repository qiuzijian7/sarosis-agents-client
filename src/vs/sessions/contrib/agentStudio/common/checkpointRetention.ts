/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * checkpointRetention — 检查点的**保留策略**（纯函数，无 IO / 无 DI）。
 *
 * 背景（2026-09-12 调研，见 doc/checkpoint-mechanism-analysis.md）：
 * 本项目检查点此前**完全没有生命周期管理** —— 无配额、无淘汰、无 TTL，且快照是
 * **全量明文**（每次工具写盘前存一份完整文件内容）。磁盘增长是
 * `O(编辑次数 × 文件大小)`：一个 5000 行文件被 patch 20 次即产生 ~20 份近似完整
 * 的副本。对照 Claude Code 的做法（每会话保留最近 100 个 + 淘汰时删除无引用快照
 * + **每个文件的第一个快照永久保留**，后者被 VS Code 扩展用作会话 diff 的基线），
 * 这里把两条策略抽成纯函数以便单测锁定：
 *
 *   1. {@link planVersionPrune}      —— 按 **URI 的版本数**限流：每个文件保留
 *      「最早 1 个」+「最近 N 个」。最早快照必须永久保留，因为
 *      `revertAllCheckpoints`（撤销全部）依赖它还原到「本轮最初的原始内容」。
 *   2. {@link planCheckpointEviction} —— 按 **会话内检查点总数**限流：超出上限时
 *      从最老的开始淘汰，但**跳过承载了某文件最早快照的检查点**（否则会破坏撤销）。
 *   3. {@link selectUnreferencedSnapshotIds} —— 引用计数：内容寻址后多个检查点
 *      可能共享同一快照文件，删除必须只在**再无任何引用**时进行。
 *
 * 设计取舍：只做「数量」治理，不引入压缩/增量编码（那需要额外依赖与格式迁移，
 * 收益/风险比不如先把无界增长变成有界）。
 */

/** 每个文件最多保留的**历史版本数**（不含永久保留的最早快照）。 */
export const CHECKPOINT_MAX_VERSIONS_PER_FILE = 50;

/** 每个会话最多保留的**检查点数量**（超出后从最老的开始淘汰，受最早快照保护约束）。 */
export const CHECKPOINT_MAX_PER_SESSION = 200;

/** 内容寻址快照 id 取 SHA-256 的前 N 个十六进制字符（32 hex = 128 bit，碰撞概率可忽略）。 */
export const SNAPSHOT_ID_HEX_LENGTH = 32;

/**
 * 会话检查点的保留期（TTL）：最后一次写入后超过该时长即被清扫。
 * 对齐 Claude Code 的 `cleanupPeriodDays` 默认值（约 30 天）。
 */
export const CHECKPOINT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * TTL 判定：会话的最新检查点时间戳是否已过期。
 *
 * 边界刻意保守：时间戳缺失/为 0（空目录、索引损坏）→ **不判定过期**
 * （宁可漏清也不误删用户数据）。
 */
export function isSessionExpired(latestAt: number, now: number, maxAgeMs: number = CHECKPOINT_TTL_MS): boolean {
	if (!latestAt || latestAt <= 0) { return false; }
	return now - latestAt > maxAgeMs;
}

/** 单条「快照版本」引用（用于按 URI 分组限流）。 */
export interface ISnapshotVersionRef {
	readonly snapshotId: string;
	/** 快照对应文件的 URI 字符串（`URI.toString()`）。 */
	readonly uri: string;
	/** 所属检查点的 `createdAt`（ms）——同一检查点内的多个快照共享该时间。 */
	readonly createdAt: number;
}

/** 淘汰计划的输入：一个会话内的检查点（仅需保留策略关心的字段）。 */
export interface ICheckpointEvictionEntry {
	readonly id: string;
	readonly createdAt: number;
	readonly isGhost: boolean;
	readonly snapshotIds: readonly string[];
}

/**
 * 按 URI 的版本数计算需要淘汰的快照 id。
 *
 * 规则：对每个 URI，**保留最早的 1 个**（撤销基线，永不淘汰）+ **最近
 * `maxVersions` 个**；其余（中间的历史版本）淘汰。
 *
 * 排序说明：同一检查点内同一 URI 只应有一个快照，但为防御性起见按
 * `createdAt` 升序 + 稳定序号排序；`maxVersions <= 0` 时退化为「只留最早 1 个」。
 *
 * @returns 应淘汰的快照 id（已去重，可直接用于删除）；无需淘汰时返回空数组。
 */
export function planVersionPrune(
	versions: readonly ISnapshotVersionRef[],
	maxVersions: number = CHECKPOINT_MAX_VERSIONS_PER_FILE,
): string[] {
	const keepRecent = Math.max(0, maxVersions);
	/** uri → 该 uri 的全部版本（保持输入顺序，便于稳定排序）。 */
	const byUri = new Map<string, { ref: ISnapshotVersionRef; seq: number }[]>();
	let seq = 0;
	for (const ref of versions) {
		const list = byUri.get(ref.uri) ?? [];
		list.push({ ref, seq: seq++ });
		byUri.set(ref.uri, list);
	}

	const evicted = new Set<string>();
	for (const list of byUri.values()) {
		// 需要保留的总数 = 最早 1 + 最近 N
		if (list.length <= keepRecent + 1) {
			continue;
		}
		list.sort((a, b) => (a.ref.createdAt - b.ref.createdAt) || (a.seq - b.seq));
		// 保留 [0]（最早）与末尾 keepRecent 个 → 中间的全部淘汰。
		const keepFrom = list.length - keepRecent;
		for (let i = 1; i < keepFrom; i++) {
			evicted.add(list[i].ref.snapshotId);
		}
	}
	return [...evicted];
}

/**
 * 计算应**整体移除**的检查点（会话内数量超限时）。
 *
 * 从最老的开始淘汰，但**跳过**满足任一条件的检查点：
 *   · 已 ghost（本就不可达，不占活跃配额）；
 *   · 其快照中包含任一「某文件最早快照」（`protectedSnapshotIds`）—— 删除它会让
 *     `revertAllCheckpoints` 失去还原基线。
 *
 * @returns 应移除的检查点 id（按淘汰顺序）。
 */
export function planCheckpointEviction(
	checkpoints: readonly ICheckpointEvictionEntry[],
	protectedSnapshotIds: ReadonlySet<string>,
	maxCheckpoints: number = CHECKPOINT_MAX_PER_SESSION,
): string[] {
	const live = checkpoints.filter(cp => !cp.isGhost);
	if (live.length <= maxCheckpoints) {
		return [];
	}
	const ordered = live.slice().sort((a, b) => a.createdAt - b.createdAt);
	const toRemove: string[] = [];
	let remaining = live.length;
	for (const cp of ordered) {
		if (remaining <= maxCheckpoints) {
			break;
		}
		const carriesBaseline = cp.snapshotIds.some(id => protectedSnapshotIds.has(id));
		if (carriesBaseline) {
			// 保护：含最早快照的检查点不可整体移除（数量上限让位于撤销正确性）。
			continue;
		}
		toRemove.push(cp.id);
		remaining--;
	}
	return toRemove;
}

/**
 * 引用计数：从候选集合中筛出**不再被任何检查点引用**的快照 id。
 *
 * 内容寻址（快照 id = 内容哈希）后，多个检查点可能引用同一快照文件；
 * 删除任何一个检查点都不能直接删文件，必须先确认全局无引用。
 *
 * @param candidateIds 本次希望删除的快照 id（例如某检查点释放出来的）。
 * @param stillReferenced 删除后**仍然存在**的引用集合（所有存活检查点的并集）。
 */
export function selectUnreferencedSnapshotIds(
	candidateIds: readonly string[],
	stillReferenced: ReadonlySet<string>,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of candidateIds) {
		if (seen.has(id) || stillReferenced.has(id)) {
			continue;
		}
		seen.add(id);
		out.push(id);
	}
	return out;
}

/**
 * 收集「每个 URI 的最早快照 id」集合 —— 即受保护、永不可淘汰的基线快照。
 * 输入顺序无关（内部按 `createdAt` 取最小；同一检查点的快照并列时取先出现者）。
 */
export function collectProtectedSnapshotIds(
	versions: readonly ISnapshotVersionRef[],
): Set<string> {
	const earliest = new Map<string, ISnapshotVersionRef>();
	for (const ref of versions) {
		const cur = earliest.get(ref.uri);
		if (!cur || ref.createdAt < cur.createdAt) {
			earliest.set(ref.uri, ref);
		}
	}
	return new Set([...earliest.values()].map(r => r.snapshotId));
}
