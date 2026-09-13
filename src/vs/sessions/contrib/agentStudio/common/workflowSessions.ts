/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工作流 Session（2026-09-11 用户需求）—— **数据模型与纯逻辑**。
 *
 * 目标：每个工作流可以有多个 session，**隔离不同会话生成的内容**（快照库 / 运行产物），
 * 并与聊天框 session 一一对应：
 *
 *   - 用户在聊天 sessionA 里用工作流 → 为该工作流建/复用一个 session（绑定 A）；
 *   - 切到聊天 sessionB 再用同一工作流 → 建**另一个** session（绑定 B）；
 *   - 工作流 session 也会出现在 session 列表中，点击可打开对应工作流画布。
 *
 * 存储布局（与 workflow.json 同域）：
 *   {workflowsDir}/{workflowId}/sessions.json        ← session 索引
 *   {workflowsDir}/{workflowId}/sessions/{sid}/      ← 该 session 的隔离产物目录
 *
 * 本文件是**无依赖纯模块**（可单测）：只做 id/命名/匹配决策，不触碰文件系统。
 */

/** 未绑定聊天 session 时的默认工作流 session id（旧行为兜底）。 */
export const DEFAULT_WORKFLOW_SESSION_ID = 'default';

/** 工作流 session 元数据（存于 sessions.json 的数组元素）。 */
export interface IWorkflowSessionMeta {
	/** session id（`wfs_<时间戳>_<随机>`，或默认 `default`）。 */
	id: string;
	workflowId: string;
	/** 显示名（默认「会话 1」「会话 2」…或聊天 session 标题）。 */
	name: string;
	/** 绑定的聊天 session id —— 同一聊天 session 复用同一工作流 session。 */
	chatSessionId?: string;
	createdAt: number;
	updatedAt: number;
	/** 该 session 下的执行次数（用于列表排序/展示）。 */
	runCount: number;
	/** 最近一次执行时间（ISO）。 */
	lastRunAt?: string;
}

/** 生成新的工作流 session id。 */
export function newWorkflowSessionId(now: number = Date.now()): string {
	return `wfs_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 按序号生成默认显示名（「会话 1」「会话 2」…）。 */
export function defaultSessionName(index: number): string {
	return `会话 ${Math.max(1, index)}`;
}

/**
 * 为某个**聊天 session** 挑选要复用的工作流 session。
 * 规则：优先返回已绑定该 chatSessionId 的（取最近更新的）；否则 undefined（调用方新建）。
 */
export function pickSessionForChat(
	sessions: ReadonlyArray<IWorkflowSessionMeta> | undefined,
	chatSessionId: string | undefined,
): IWorkflowSessionMeta | undefined {
	if (!chatSessionId) { return undefined; }
	const bound = (sessions ?? []).filter(s => s.chatSessionId === chatSessionId);
	if (bound.length === 0) { return undefined; }
	return bound.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
}

/** 构造一个新的工作流 session 元数据。 */
export function buildWorkflowSession(input: {
	workflowId: string;
	chatSessionId?: string;
	name?: string;
	/** 现有 session 数（用于生成默认名序号）。 */
	existingCount?: number;
	now?: number;
}): IWorkflowSessionMeta {
	const now = input.now ?? Date.now();
	return {
		id: newWorkflowSessionId(now),
		workflowId: input.workflowId,
		name: input.name?.trim() || defaultSessionName((input.existingCount ?? 0) + 1),
		...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
		createdAt: now,
		updatedAt: now,
		runCount: 0,
	};
}

/** 更新 session 的「最近使用」信息（纯函数，返回新对象）。 */
export function touchWorkflowSession(
	meta: IWorkflowSessionMeta,
	now: number = Date.now(),
): IWorkflowSessionMeta {
	return {
		...meta,
		updatedAt: now,
		runCount: (meta.runCount ?? 0) + 1,
		lastRunAt: new Date(now).toISOString(),
	};
}

/**
 * 重命名工作流 session（纯函数，返回新对象；2026-09-11 用户需求）。
 *
 * ⚠ 两条重要约束：
 *  1. **只改 `name`，绝不动 `id`** —— id 是快照库的隔离 key 前缀（`{sid}::`，
 *     见 mediaSnapshotStore 的 _scoped）与产物目录名（`sessions/{sid}/`），
 *     改 id 会让该会话已有产物全部「对不上号」而丢失。
 *  2. **不动 `updatedAt`** —— 列表顺序由 sortSessionsByRecent（updatedAt 倒序）
 *     派生；改名若顺带刷新 updatedAt，该 session 会莫名冒到列表最前，
 *     用户只是改名字、不该改变顺序。
 *
 * 空名/未变化时原样返回（调用方据此跳过写盘）。
 */
export function renameWorkflowSession(
	meta: IWorkflowSessionMeta,
	name: string,
): IWorkflowSessionMeta {
	const trimmed = (name ?? '').trim();
	if (!trimmed || trimmed === meta.name) { return meta; }
	return { ...meta, name: trimmed };
}

/** 列表显示名（附执行次数，便于区分）。 */
export function sessionDisplayName(meta: IWorkflowSessionMeta): string {
	const base = meta.name?.trim() || meta.id;
	return meta.runCount > 0 ? `${base} · ${meta.runCount} 次` : base;
}

/** 按 updatedAt 倒序排列（列表展示用，不改原数组）。 */
export function sortSessionsByRecent(
	sessions: ReadonlyArray<IWorkflowSessionMeta>,
): IWorkflowSessionMeta[] {
	return sessions.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
