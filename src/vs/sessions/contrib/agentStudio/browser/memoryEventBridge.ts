/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IChatStreamDelta } from '../common/agentStudio.js';

/** 桥的宿主注入面（这两个"看世界"的能力属于服务 ✓）。 */
export interface IMemoryEventBridgeDeps {
	/** 取当前活跃 memory provider（可能为空 / 旧版不支持事件订阅 ✓）。 */
	getActiveMemoryProvider: () => any;
	/** 按 agentId(+sessionId) 路由到应接收事件的 onDelta（**并发串台防护** ✓）。 */
	getOnDeltaForAgent: (agentId: string, sessionId?: string) => ((delta: IChatStreamDelta) => void) | undefined;
}

/**
 * memory provider 的 lifecycle 事件 → `onDelta` 桥（从 `agentChatService.ts` 原样搬出 ✓，
 * 2026-09-22 阶段④-b2 ✓）。
 *
 * ## 四条不可退化约定（2026-09-22 阶段④-b2 从原实现逐字保留 ✓）
 *  ① **幂等**：只建立一次订阅 ✓（`ensure()` 可重复调用 ✓）。
 *  ② **串台防护** ✗✓：事件是**全局**的，必须按 `data.sessionId` 精确路由到 `agentId::sessionId` ✓；
 *     sessionId 缺失才退化为"同 agent 最近活跃流"✓ —— 否则同 agent 多会话并发时 A 的记忆写入会出现在 B 的聊天框 ✗。
 *  ③ **去重**：`noticeId` 集合去重（同一条写入只显示一次 ✓）；
 *     无 noticeId 的提取卡片按 `memoryType` 做 **5 秒窗口**去重 ✓（一次提取常写多条 fact ✓）。
 *  ④ **不产生假信号** ✗✓：`contentLength === 0` ⇒ 发 `remove: true` 撤掉 pending 卡片，
 *     **绝不显示"已保存"** ✓（这正是本桥替代旧 fire-and-forget 假信号的原因 ✓）。
 *
 * ⚠ dispose 必须真正消费 `_unsub` ✓（该字段曾只赋值不读取 ⇒ 泄漏 ✗）。
 */
export class MemoryEventBridge {
	private _ready = false;
	private _unsub: (() => void) | null = null;

	constructor(private readonly deps: IMemoryEventBridgeDeps) { }

	ensure(): void {
	if (this._ready) {
		return;
	}
	this._ready = true;

	// Dedup: track processed noticeIds to prevent duplicate display
	const processedNoticeIds = new Set<string>();
	// Dedup map for Episodic/Semantic/Procedural extraction cards (no noticeId)
	// Key: memoryType, Value: last shown timestamp — 5s window prevents duplicate cards
	const recentExtractedTypes = new Map<string, number>();

	const provider = this.deps.getActiveMemoryProvider();
	if (!provider?.onMemoryWritten) {
		// Provider 不支持事件订阅（旧 provider），回退：不桥接
		return;
	}

	const unsubWritten = provider.onMemoryWritten((agentId: string, data: any) => {
		// 串台防护：优先按 data.sessionId 精确路由到对应会话（agentId::sessionId）；
		// sessionId 缺失时退化为"同 agent 最近活跃流"。
		const onDelta = this.deps.getOnDeltaForAgent(agentId, data.sessionId);
		if (!onDelta) {
			return;
		}
		if (data.noticeId) {
			// Dedup: skip if this noticeId was already processed
			if (processedNoticeIds.has(data.noticeId)) {
				return;
			}
			processedNoticeIds.add(data.noticeId);

			// L0 写入完成：contentLength 为 0 时移除 pending 卡片，不显示"已保存"
			if (!data.contentLength || data.contentLength === 0) {
				onDelta({
					type: 'memory_written' as any,
					content: '',
					metadata: { noticeId: data.noticeId, memoryType: data.memoryType, remove: true },
				} as any);
				return;
			}

		// Use actual memoryType for the label instead of hardcoding "Working"
		const memTypeLabels: Record<string, string> = {
			working: 'Working', semantic: 'Semantic', procedural: 'Procedural',
			pattern: 'Pattern', preference: 'Preference', architecture: 'Architecture',
			bug: 'Bug', workflow: 'Workflow', fact: 'Fact', instruction: 'Instruction',
		};
		const memLabel = memTypeLabels[data.memoryType ?? ''] ?? data.memoryType ?? 'Working';
			onDelta({
				type: 'memory_written' as any,
				content: `${memLabel} 已保存 ${data.contentLength}字`,
				metadata: { noticeId: data.noticeId, memoryType: data.memoryType },
			} as any);
		} else {
			// Episodic/Semantic/Procedural 写入完成：直接显示 saved 卡片（无对应 pending 卡片）
			// Skip 'working' type — working memory writes always go through the noticeId path above.
			// Hook-triggered working writes (post_tool_use) are redundant with per-iteration writes.
		const memType = data.memoryType ?? 'fact';
		if (memType === 'working' || memType === 'short_term') {
			return; // Working memory without noticeId = hook-triggered duplicate, skip
		}
		// Dedup: 同一 memoryType 在 5 秒内只显示一次（一次提取可能写入多条 fact）
		const now = Date.now();
		const lastShown = recentExtractedTypes.get(memType) ?? 0;
		if (now - lastShown < 5000) {
			return; // 5 秒内已显示过同类型卡片，跳过
		}
		recentExtractedTypes.set(memType, now);

		const typeLabels: Record<string, string> = {
			working: 'Working', semantic: 'Semantic', procedural: 'Procedural',
			pattern: 'Pattern', preference: 'Preference', architecture: 'Architecture',
			bug: 'Bug', workflow: 'Workflow', fact: 'Fact', instruction: 'Instruction',
		};
		const label = typeLabels[memType] ?? memType ?? 'Fact';
			onDelta({
				type: 'memory_extracted' as any,
				content: `${label} 已提取`,
				metadata: { memoryType: memType, status: 'saved' },
			} as any);
		}
	});

	const unsubFailed = provider.onMemoryWriteFailed?.((_agentId: string, data: any) => {
		// 串台防护：按 data.sessionId 精确路由（缺失时退化为最近活跃流）。
		const onDelta = this.deps.getOnDeltaForAgent(_agentId, data.sessionId);
		if (onDelta && data.noticeId) {
			onDelta({
				type: 'memory_write_failed' as any,
				content: `Working 写入失败: ${data.error}`,
				metadata: { noticeId: data.noticeId, error: data.error },
			} as any);
		}
	}) ?? (() => { });

	// 技能提取事件桥接：sweep 中自动提取技能后通知 UI
	const providerAny = provider as any;
	const unsubSkill = providerAny?.onEvent?.('skill_extracted', (event: any) => {
		const agentId = event.agentId ?? '';
		const onDelta = this.deps.getOnDeltaForAgent(agentId);
		if (!onDelta) {
			return;
		}
		const skillId = event.data?.['skillId'] as string ?? '';
		const title = event.data?.['title'] as string ?? '未知技能';
		onDelta({
			type: 'skill_extracted' as any,
			content: `⚡ 技能已沉淀: ${title}`,
			metadata: {
				skillId,
				title,
				agentId,
				clickable: true,
			},
		} as any);
	}) ?? null;

	this._unsub = () => {
		unsubWritten();
		unsubFailed();
		if (typeof unsubSkill === 'function') { unsubSkill(); }
	};
}

	/** 释放订阅（宿主 dispose 时调用 ✓ —— 幂等 ✓）。 */
	dispose(): void {
		this._unsub?.();
		this._unsub = null;
	}
}
