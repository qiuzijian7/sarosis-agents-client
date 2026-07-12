/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── Usage 上报器（P3，对齐 cc-connect 的 usage 统计）──
// 聚合每个 Agent / 会话 / 全局的 token 用量（来自 IChatStreamDelta 的 'usage' 事件）。

import { ILogService } from "../../../../../platform/log/common/log.js";
import { IModelUsage } from "../../common/providers.js";

export interface UsageStats {
	readonly agentId: string;
	readonly sessionKey?: string;
	/** 输入 token（已含缓存命中/写入的子集） */
	promptTokens: number;
	/** 输出 token */
	completionTokens: number;
	/** 缓存命中输入 token */
	cachedTokens: number;
	/** 写入缓存输入 token */
	cacheWriteTokens: number;
	/** 总 token（缺省时由 prompt+completion 推导） */
	totalTokens: number;
	/** 计费额度 / 积分 */
	credit: number;
	/** 累计调用次数 */
	calls: number;
}

function zeroStats(agentId: string, sessionKey?: string): UsageStats {
	return {
		agentId,
		sessionKey,
		promptTokens: 0,
		completionTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		credit: 0,
		calls: 0,
	};
}

function accumulate(target: UsageStats, usage: IModelUsage): void {
	const input = usage.inputTokens ?? 0;
	const output = usage.outputTokens ?? 0;
	const cached = usage.cachedTokens ?? 0;
	const cacheWrite = usage.cacheWriteTokens ?? 0;
	target.promptTokens += input;
	target.completionTokens += output;
	target.cachedTokens += cached;
	target.cacheWriteTokens += cacheWrite;
	target.totalTokens += usage.totalTokens ?? input + output;
	target.credit += usage.credit ?? 0;
		target.calls += 1;
	}

/** 用量快照（用于持久化落盘）。 */
export interface UsageSnapshot {
	readonly byAgent: UsageStats[];
	readonly bySession: UsageStats[];
	readonly global: UsageStats;
}

/**
 * 用量持久化存储接口（同步 API，便于测试注入内存实现）。
 * 真实实现见 `bridgeUsageStore.ts`（fs 落盘）。
 */
export interface IUsageStatsStore {
	load(): UsageSnapshot | undefined;
	save(snapshot: UsageSnapshot): void;
}

export class BridgeUsageReporter {
	private readonly _log: ILogService;
	private readonly _store?: IUsageStatsStore;
	private readonly _byAgent = new Map<string, UsageStats>();
	private readonly _bySession = new Map<string, UsageStats>();
	private _global: UsageStats = zeroStats("(global)");
	private _restored = false;

	constructor(logService: ILogService, store?: IUsageStatsStore) {
		this._log = logService;
		this._store = store;
		this._restore();
	}

	/** 记录一次用量事件（来自 onDelta 的 type==='usage'）。 */
	record(sessionKey: string, agentId: string, usage: IModelUsage): void {
		let a = this._byAgent.get(agentId);
		if (!a) {
			a = zeroStats(agentId);
			this._byAgent.set(agentId, a);
		}
		accumulate(a, usage);

		let s = this._bySession.get(sessionKey);
		if (!s) {
			s = zeroStats(agentId, sessionKey);
			this._bySession.set(sessionKey, s);
		}
		accumulate(s, usage);

		accumulate(this._global, usage);

		this._log.debug(`[BridgeUsage] ${agentId} / ${sessionKey}: +${usage.inputTokens ?? 0}in +${usage.outputTokens ?? 0}out`);
		// 每次记录后落盘（store 不存在则空操作）
		this._persist();
	}

	getAgentStats(agentId: string): UsageStats | undefined {
		return this._byAgent.get(agentId);
	}

	getSessionStats(sessionKey: string): UsageStats | undefined {
		return this._bySession.get(sessionKey);
	}

	getAll(): UsageStats[] {
		return [...this._byAgent.values()];
	}

	getGlobal(): UsageStats {
		return { ...this._global };
	}

	/** 按过滤条件汇总（用于 /usage 命令）。 */
	summarize(filter?: { agentId?: string; sessionKey?: string }): UsageStats[] {
		if (filter?.agentId) {
			const a = this.getAgentStats(filter.agentId);
			return a ? [a] : [];
		}
		if (filter?.sessionKey) {
			const s = this.getSessionStats(filter.sessionKey);
			return s ? [s] : [];
		}
		return this.getAll();
	}

	reset(): void {
		this._byAgent.clear();
		this._bySession.clear();
		this._global.promptTokens = 0;
		this._global.completionTokens = 0;
		this._global.cachedTokens = 0;
		this._global.cacheWriteTokens = 0;
		this._global.totalTokens = 0;
		this._global.credit = 0;
		this._global.calls = 0;
		// 清空后同步落盘（store 不存在则空操作）
		this._persist();
	}

	/** 从持久化存储恢复历史用量（仅构造时一次）。 */
	private _restore(): void {
		if (this._restored || !this._store) {
			return;
		}
		this._restored = true;
		let snap: UsageSnapshot | undefined;
		try {
			snap = this._store.load();
		} catch (err) {
			this._log.error(`[BridgeUsage] restore load failed:`, err);
			return;
		}
		if (!snap) {
			return;
		}
		for (const s of snap.byAgent) {
			this._byAgent.set(s.agentId, { ...s });
		}
		for (const s of snap.bySession) {
			this._bySession.set(s.sessionKey ?? s.agentId, { ...s });
		}
		this._global = { ...snap.global };
		this._log.info(`[BridgeUsage] restored usage for ${this._byAgent.size} agent(s), ${this._bySession.size} session(s)`);
	}

	/** 将当前用量快照写入持久化存储（无 store 时空操作）。 */
	private _persist(): void {
		if (!this._store) {
			return;
		}
		const snap: UsageSnapshot = {
			byAgent: [...this._byAgent.values()],
			bySession: [...this._bySession.values()],
			global: { ...this._global },
		};
		try {
			this._store.save(snap);
		} catch (err) {
			this._log.error(`[BridgeUsage] persist failed:`, err);
		}
	}
}
