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
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { isWeb } from '../../../../base/common/platform.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { IAgentStudioService } from '../../../common/agentStudioService.js';
import { IModelSelectorService } from '../../agentStudio/common/modelSelector.js';
// ★ 类型一律 `import type`（编译期擦除）：本文件是**扩展桥的命令实现**，
//   运行时只应依赖服务令牌（上面两个 createDecorator）——不要把 UI 层模块拖进这个进程，
//   否则命令注册所在的贡献模块可能在加载期就被牵连（那时所有 sarosPocket.* 命令会一起消失，
//   现场表现就是"会话列表空 + 聊天头降级"，很难查）。
import type { Agent, AgentBinding, Workspace } from '../../../common/agentStudioTypes.js';
import type { IModelSelectorItem } from '../../agentStudio/common/modelSelector.js';
import type { IModelSelection } from '../../agentStudio/common/providers.js';

/**
 * 输入框可选的聊天模式 id（与 `sessions/browser/agentChat/agentChatTypes.ts` 的
 * `CHAT_MODE_ORDER` 等价：craft/ask/plan；`workflow` 由工作流编辑器驱动，不作为手选项）。
 *
 * 为什么在这里内联而不是 import：见上面的注释（不要为三个常量把 UI 层模块拖进命令进程）。
 * 标签与说明由手机端按 id 映射（pocket 侧有一份同样的兜底文案），id 才是契约。
 */
const POCKET_CHAT_MODE_IDS = ['craft', 'ask', 'plan'] as const;

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

		// ★ 诊断元信息：为什么要把 providers / mode 一起返回？
		// 「会话列表为空」有两种完全不同的成因，光看 sessions.length 分不开：
		//   ① providers 为空 ⇒ 没有任何会话 provider 注册（localAgentHost 只在 desktop 入口
		//      加载、chat.agentHost.enabled / sessions.agentStudio.enabled 未开），
		//      此时用户开多少会话列表都是空的，属于配置/形态问题；
		//   ② providers 非空但 sessions 为空 ⇒ 只是还没开会话，开一个就有。
		// 让 Pocket 侧能直接区分这两者，省掉"到底是我没开会话还是坏了"的猜测。
		// 返回结构从纯数组升级为对象：Saros-agents-pocket 的 fetchRealSessions() 已做
		// 宽容解包（数组 / {sessions} 都能吃），老版扩展不会因此整列表空掉。
		const providers = accessor.get(ISessionsProvidersService).getProviders()
			.map(provider => String(provider?.id ?? ''))
			.filter(Boolean);

		return {
			sessions: list.map(toPlainSession).filter(Boolean),
			providers,
			mode: isWeb ? 'web' : 'desktop',
		};
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

/** 任一子读取失败都不该让整份上下文为空（例如没有 worktree 的仓库）。 */
async function readOr<T>(p: Promise<T>, fallback: T): Promise<T> {
	try {
		return await p;
	} catch {
		return fallback;
	}
}

/**
 * 读取「聊天上下文」——手机端聊天框据此渲染与 VsSaros 聊天框同构的头部
 * （chatmode / agent / 工作区 / worktree / provider+model）。
 *
 * 为什么走命令：聊天框是工作台进程里的 DOM 面板，扩展进程拿不到
 * `IAgentStudioService` / `IModelSelectorService`，只能跨进程取（与 listSessions 同法）。
 *
 * ⚠ 语义边界：这里返回的是**可选项列表 + 当前生效值**。
 *   · agent / workspace / worktree / model 的「当前值」是全局或 per-agent 持久化的 ✓ 可读；
 *   · chatMode 是**每个聊天面板自己的本地状态**（不落共享服务）⇒ 这里只给可选模式清单，
 *     手机端自己记住所选模式并随后续请求下发（见 setChatContext 的说明）。
 */
class SarosPocketGetChatContextAction extends Action2 {
	static readonly ID = 'sarosPocket.getChatContext';

	constructor() {
		super({
			id: SarosPocketGetChatContextAction.ID,
			title: 'Saros Pocket: Get Chat Context',
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<unknown> {
		const studio = accessor.get(IAgentStudioService);
		const selector = accessor.get(IModelSelectorService);

		const agents = await readOr<Agent[]>(studio.getAgents(), []);
		const workspaces = await readOr<Workspace[]>(studio.getWorkspaces(), []);
		const workspaceId = studio.getActiveWorkspaceId() ?? null;
		const worktrees = workspaceId ? await readOr(studio.getWorktrees(workspaceId), []) : [];
		const models = await readOr<IModelSelectorItem[]>(selector.getAvailableModels(), []);
		const selection = selector.getSelection() as IModelSelection | undefined;
		const selected = selection as unknown as { providerId?: string; modelId?: string } | undefined;

		return {
			// 输入框可选的 3 档：只给 id（标签由客户端映射，见 POCKET_CHAT_MODE_IDS 的注释）
			chatModes: POCKET_CHAT_MODE_IDS.map(id => ({ id })),
			agents: agents.map(a => ({
				id: String(a.id ?? ''),
				name: String(a.name ?? ''),
				icon: typeof a.icon === 'string' ? a.icon : '',
				description: String(a.description ?? ''),
				role: String(a.role ?? ''),
			})),
			workspaces: workspaces.map(w => ({
				id: String(w.id ?? ''),
				name: String(w.name ?? ''),
				path: String(w.path ?? ''),
				worktreePath: w.worktreePath ?? null,
				worktreeBranch: w.worktreeBranch ?? null,
			})),
			workspaceId,
			// 契约：worktrees 是**主仓库之外**的其他 worktree（主仓库由 workspace 本身表示）
			worktrees: worktrees.map(t => ({
				path: String(t.path ?? ''),
				branch: String(t.branch ?? ''),
				uncommitted: Number(t.uncommittedChanges ?? 0),
			})),
			models: models.map(m => ({
				providerId: String(m.provider?.id ?? ''),
				providerName: String(m.provider?.name ?? ''),
				modelId: String(m.model?.id ?? ''),
				modelName: String(m.model?.name ?? ''),
			})),
			selection: selected?.providerId && selected?.modelId
				? { providerId: selected.providerId, modelId: selected.modelId }
				: null,
		};
	}
}

/**
 * 写「聊天上下文」——把手机端聊天框的选择**真的落到 VsSaros**：
 *   · workspaceId  → 切活动工作区（`setActiveWorkspace`）
 *   · worktreePath → 写进该 (workspace × agent) 的 AgentBinding（与桌面端选择 worktree 同一存储）
 *   · providerId/modelId → 全局或 per-agent 的模型选择
 *
 * chatMode 不在此列：它是聊天面板的本地状态，没有可写的共享服务；
 * 手机端把它随每条消息下发（`chat.send` 的 `context.chatMode`），由发送方决定语义。
 */
class SarosPocketSetChatContextAction extends Action2 {
	static readonly ID = 'sarosPocket.setChatContext';

	constructor() {
		super({
			id: SarosPocketSetChatContextAction.ID,
			title: 'Saros Pocket: Set Chat Context',
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, patch?: unknown): Promise<unknown> {
		const p = (patch ?? {}) as {
			workspaceId?: string;
			worktreePath?: string | null;
			agentId?: string;
			providerId?: string;
			modelId?: string;
		};
		const studio = accessor.get(IAgentStudioService);
		const selector = accessor.get(IModelSelectorService);
		const applied: string[] = [];

		if (typeof p.workspaceId === 'string' && p.workspaceId) {
			await studio.setActiveWorkspace(p.workspaceId);
			applied.push('workspace');
		}

		if (p.worktreePath !== undefined) {
			const wsId = (typeof p.workspaceId === 'string' && p.workspaceId) || studio.getActiveWorkspaceId();
			const agentId = String(p.agentId ?? '').trim();
			if (wsId && agentId) {
				const patchBinding: Partial<AgentBinding> = { worktreePath: p.worktreePath ?? undefined };
				await studio.upsertAgentBinding(wsId, agentId, patchBinding);
				applied.push('worktree');
			}
		}

		if (typeof p.providerId === 'string' && typeof p.modelId === 'string' && p.providerId && p.modelId) {
			const sel = { providerId: p.providerId, modelId: p.modelId } as unknown as IModelSelection;
			const agentId = String(p.agentId ?? '').trim();
			if (agentId) {
				selector.setSelectionForAgent(agentId, sel);
				applied.push('model:agent');
			} else {
				selector.setSelection(sel);
				applied.push('model');
			}
		}

		return { ok: true, applied };
	}
}

class SarosPocketContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.sarosPocket';

	constructor() {
		registerAction2(SarosPocketListSessionsAction);
		registerAction2(SarosPocketSendRequestAction);
		registerAction2(SarosPocketArchiveSessionAction);
		registerAction2(SarosPocketGetChatContextAction);
		registerAction2(SarosPocketSetChatContextAction);
	}
}

registerWorkbenchContribution2(SarosPocketContribution.ID, SarosPocketContribution, WorkbenchPhase.AfterRestored);
