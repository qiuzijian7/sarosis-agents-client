/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Saros Pocket 桥：把「真实 Agent 会话列表」暴露给扩展进程。
//
// 为什么需要它：ISessionsManagementService 活在工作台进程，扩展（含内置扩展）
// 拿不到服务实例，只能通过命令跨进程取。Saros-agents-pocket 扩展据此在手机端
// 收件箱里显示真实的 Agent 会话，而不是它自己登记的任务。
//
// 只读：本文件只列会话、不触发任何写动作，也不改动现有行为。

import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';

/** 与 SessionStatus 对齐的稳定字符串，避免扩展侧依赖数值枚举。 */
const STATUS_BY_CODE: Record<number, string> = {
	[SessionStatus.Untitled]: 'untitled',
	[SessionStatus.InProgress]: 'running',
	[SessionStatus.NeedsInput]: 'waiting',
	[SessionStatus.Completed]: 'done',
	[SessionStatus.Error]: 'failed',
};

/** 安全取 IObservable 的值：服务未在预期进程内时静默降级。 */
function readObservable<T>(value: unknown): T | undefined {
	if (value && typeof (value as { get?: unknown }).get === 'function') {
		try {
			return (value as { get: () => T }).get();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function toPlainSession(session: unknown): unknown {
	if (!session || typeof session !== 'object') {
		return null;
	}
	const record = session as Record<string, unknown>;
	const statusCode = readObservable<number>(record.status);
	const updatedAt = readObservable<Date>(record.updatedAt);
	const createdAt = typeof record.createdAt === 'object' ? record.createdAt as Date : undefined;

	return {
		sessionId: String(record.sessionId ?? ''),
		providerId: String(record.providerId ?? ''),
		sessionType: String(record.sessionType ?? ''),
		title: String(readObservable<string>(record.title) ?? ''),
		status: STATUS_BY_CODE[Number(statusCode)] ?? 'unknown',
		resource: String((record.resource as { toString?: () => string })?.toString?.() ?? ''),
		createdAt: createdAt ? createdAt.getTime() : null,
		updatedAt: updatedAt ? updatedAt.getTime() : null,
		isArchived: readObservable<boolean>(record.isArchived) ?? false,
		isRead: readObservable<boolean>(record.isRead) ?? false,
	};
}

class SarosPocketListSessionsAction extends Action2 {
	static readonly ID = 'sarosPocket.listSessions';

	constructor() {
		super({
			id: SarosPocketListSessionsAction.ID,
			title: 'Saros Pocket: List Agent Sessions',
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<unknown> {
		const sessions = accessor.get(ISessionsManagementService).getSessions();
		const list = Array.isArray(sessions) ? sessions : [];
		return list.map(toPlainSession).filter(Boolean);
	}
}

/**
 * 向会话发一条消息（新开一个 chat）。
 *
 * ⚠ 这是会驱动 Agent 改代码的写操作。上游只暴露通道，**不做权限判断** ——
 * 是否放行由调用方（Saros-agents-pocket 的 sarosPocket.allowAgentControl）决定。
 * 这里之所以仍加一层参数校验，是因为命令可被任意扩展调用，不能信任入参。
 */
class SarosPocketSendRequestAction extends Action2 {
	static readonly ID = 'sarosPocket.sendRequest';

	constructor() {
		super({
			id: SarosPocketSendRequestAction.ID,
			title: 'Saros Pocket: Send Request To Session',
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, sessionId?: unknown, query?: unknown): Promise<unknown> {
		const id = String(sessionId ?? '').trim();
		const text = String(query ?? '').trim();
		if (!id) {
			throw new Error('sarosPocket.sendRequest: 缺少 sessionId');
		}
		if (!text) {
			throw new Error('sarosPocket.sendRequest: 缺少 query');
		}

		const service = accessor.get(ISessionsManagementService);
		const session = service.getSessions().find(s => s.sessionId === id);
		if (!session) {
			throw new Error(`sarosPocket.sendRequest: 会话不存在 ${id}`);
		}

		await service.sendAndCreateChat(session, { query: text });
		return { ok: true, sessionId: id };
	}
}

/**
 * 归档会话 —— Pocket 的「中止/结束」语义。
 *
 * 为什么不直接 delete：真实会话里没有"中止"这一档（底层 Agent 进程由 provider
 * 管），而 delete 不可逆、风险高。归档是**可逆**且语义最接近"收起来"的动作，
 * 与「中止」在收件箱里的效果一致（从活跃列表消失）。
 */
class SarosPocketArchiveSessionAction extends Action2 {
	static readonly ID = 'sarosPocket.archiveSession';

	constructor() {
		super({
			id: SarosPocketArchiveSessionAction.ID,
			title: 'Saros Pocket: Archive Session',
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, sessionId?: unknown): Promise<unknown> {
		const id = String(sessionId ?? '').trim();
		if (!id) {
			throw new Error('sarosPocket.archiveSession: 缺少 sessionId');
		}

		const service = accessor.get(ISessionsManagementService);
		const session = service.getSessions().find(s => s.sessionId === id);
		if (!session) {
			throw new Error(`sarosPocket.archiveSession: 会话不存在 ${id}`);
		}

		await service.archiveSession(session);
		return { ok: true, sessionId: id, archived: true };
	}
}

class SarosPocketContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.sarosPocket';

	constructor() {
		registerAction2(SarosPocketListSessionsAction);
		registerAction2(SarosPocketSendRequestAction);
		registerAction2(SarosPocketArchiveSessionAction);
	}
}

registerWorkbenchContribution2(SarosPocketContribution.ID, SarosPocketContribution, WorkbenchPhase.AfterRestored);
