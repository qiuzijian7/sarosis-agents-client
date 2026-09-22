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
// ★ 会话 sideview（Session History）那条链路 —— 手机端会话列表要与它**内容、顺序都一致**：
//   · IAgentChatService：sideview 用它读 `~/.vssaros/chat-history/<agentId>/sessions.json`
//     （`ISessionsManagementService.getSessions()` 里没有 Agent Studio 的会话）
//   · IFileService / IEnvironmentService / URI / sarosPaths：与 sideview 同一套 agent 目录发现
//   · IStorageService：pinned / 手动拖拽顺序存在 PROFILE storage，顺序要照它复刻
import { IAgentChatService } from '../../../common/agentStudioService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { URI } from '../../../../base/common/uri.js';
import { userDataRootFromRoamingHome } from '../../agentStudio/common/sarosPaths.js';
// ★ 类型一律 `import type`（编译期擦除）：本文件是**扩展桥的命令实现**，
//   运行时只应依赖服务令牌（上面两个 createDecorator）——不要把 UI 层模块拖进这个进程，
//   否则命令注册所在的贡献模块可能在加载期就被牵连（那时所有 sarosPocket.* 命令会一起消失，
//   现场表现就是"会话列表空 + 聊天头降级"，很难查）。
import type { Agent, AgentBinding, Workspace } from '../../../common/agentStudioTypes.js';
import type { IChatSendOptions } from '../../../common/agentStudioService.js';
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

// ─────────────────────────────────────────────────────────────────────────────
// 会话 sideview（Session History 侧栏）→ 手机端会话列表
// ─────────────────────────────────────────────────────────────────────────────
//
// 用户需求（2026-09-21）：手机端的会话列表要**与 VsSaros.exe 的会话 sideview 内容、顺序都一致**。
//
// 为什么不能只用 ISessionsManagementService.getSessions()：Agent Studio 的会话**不经过**它
// （`AgentStudioProvider.getSessions()` 目前是 `return []`），所以那台机器上 sideview 明明有 19 个
// agent、几十条会话，手机端却显示「VsSaros 里还没有会话」（现场就是这个现象）。
// sideview 的真实数据源是 `IAgentChatService.listAgentSessions()` → `~/.vssaros/chat-history/<agentId>/sessions.json`。

/** sideview 持久化 pinned / 手动拖拽顺序用的 storage 键（与 SessionHistoryViewPane 同键，改一处要一起改）。 */
const SIDEVIEW_PINNED_KEY = 'sessionHistoryView.pinnedSessions';
const SIDEVIEW_ORDER_KEY = 'sessionHistoryView.sessionOrder';

/** sideview 的会话 key：`agentId::sessionId`（与 `SessionHistoryViewPane._sessionKey` 一致）。 */
function sideviewKey(agentId: string, sessionId: string): string {
	return `${agentId}::${sessionId}`;
}

/** 从 PROFILE storage 读一个字符串数组（坏数据当空数组：不能因为一条坏记录让手机端整列表空掉）。 */
function readStringArray(storageService: IStorageService, key: string): string[] {
	try {
		const raw = storageService.get(key, StorageScope.PROFILE);
		if (!raw) { return []; }
		const arr = JSON.parse(raw);
		return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : [];
	} catch {
		return [];
	}
}

/**
 * 取 sideview 里的会话（内容与顺序都照抄 sideview）。
 *
 * 顺序**必须复刻** `SessionHistoryViewPane._compareSessions()`：
 * ① pinned 在前 → ② 手动拖拽顺序 → ③ updatedAt 倒序。
 * 只取内容不复刻顺序，用户看到的就是"内容对了、顺序不对"。
 */
async function listSideviewSessions(accessor: ServicesAccessor): Promise<unknown[]> {
	const chatService = accessor.get(IAgentChatService);
	const fileService = accessor.get(IFileService);
	const environmentService = accessor.get(IEnvironmentService);
	const storageService = accessor.get(IStorageService);

	// ① agent 目录发现：~/.vssaros/chat-history/<agentId>/sessions.json（与 sideview 同一套约定，
	//    只认"目录里真的有索引文件"的 agent —— 否则会凭空多出空 agent）。
	const chatHistoryRoot = URI.joinPath(userDataRootFromRoamingHome(environmentService.userRoamingDataHome), 'chat-history');
	if (!(await fileService.exists(chatHistoryRoot))) {
		return [];
	}
	const root = await fileService.resolve(chatHistoryRoot);
	const agentIds: string[] = [];
	for (const child of root.children ?? []) {
		if (!child.isDirectory) { continue; }
		try {
			if (await fileService.exists(URI.joinPath(child.resource, 'sessions.json'))) {
				agentIds.push(child.name);
			}
		} catch { /* 目录在但读不到索引 ⇒ 跳过（与 sideview 一致） */ }
	}

	// ② 拉会话索引（只读索引、不读历史：与 sideview 一样，几十条也不慢），
	//    并**带上每个会话自己的配置** —— 手机端「点会话 → 跳到当前会话」时，上下文要立刻切成
	//    这个会话的 agent / provider+model / 工作区 / 工作树（用户 2026-09-21 需求）。
	const agentStudio = accessor.get(IAgentStudioService);
	const rows: Array<{
		agentId: string; id: string; name: string; updatedAt: number; messageCount: number;
		workspaceId: string; worktreePath: string; agentModelId: string; agentProviderId: string;
	}> = [];
	for (const agentId of agentIds) {
		try {
			// agent 定义只查一次/agent：默认模型与 provider 写在 .agent.md（Agent.model / Agent.providerId）
			const agent = await agentStudio.getAgent(agentId).catch(() => undefined);
			const agentModelId = String(agent?.model ?? '');
			const agentProviderId = String(agent?.providerId ?? '');
			const sessions = await chatService.listAgentSessions(agentId);
			for (const s of sessions ?? []) {
				const id = String(s?.id ?? '');
				// 工作区/工作树：`会话 → 工作区 → 该 agent 在这个工作区的 binding`（AgentBinding 的
				// 注释写明了这条解析路径：getSession(sessionId).workspaceId + getAgentBinding()）。
				// 取不到一律留空：手机端据此**保持当前上下文**，而不是把一个错的值写进 VsSaros。
				let workspaceId = '';
				let worktreePath = '';
				try {
					if (id) {
						const info = await agentStudio.getSession(id);
						workspaceId = String(info?.workspaceId ?? '');
						if (workspaceId) {
							const binding = await agentStudio.getAgentBinding(workspaceId, agentId);
							worktreePath = String(binding?.worktreePath ?? '');
						}
					}
				} catch { /* 忽略：配置拿不到不影响列表本身 */ }
				rows.push({
					agentId,
					id,
					name: String(s?.name ?? ''),
					updatedAt: typeof s?.updatedAt === 'string' ? new Date(s.updatedAt).getTime() : Date.now(),
					messageCount: Number(s?.messageCount ?? 0),
					workspaceId,
					worktreePath,
					agentModelId,
					agentProviderId,
				});
			}
		} catch { /* 单个 agent 失败不影响其它 agent（与 sideview 一致） */ }
	}

	// ③ 排序 = sideview 的 _compareSessions()
	const pinned = new Set(readStringArray(storageService, SIDEVIEW_PINNED_KEY));
	const order = readStringArray(storageService, SIDEVIEW_ORDER_KEY);
	rows.sort((a, b) => {
		const aPinned = pinned.has(sideviewKey(a.agentId, a.id));
		const bPinned = pinned.has(sideviewKey(b.agentId, b.id));
		if (aPinned !== bPinned) { return aPinned ? -1 : 1; }
		const ai = order.indexOf(sideviewKey(a.agentId, a.id));
		const bi = order.indexOf(sideviewKey(b.agentId, b.id));
		if (ai !== -1 || bi !== -1) {
			return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
		}
		return b.updatedAt - a.updatedAt;
	});

	// ④ 转成 Pocket 侧稳定的会话形态（字段与 toPlainSession 对齐，手机端无需分支）
	return rows
		.filter(r => !!r.id)
		.map(r => ({
			sessionId: r.id,
			providerId: 'agent-studio',
			sessionType: 'sideview',
			title: r.name,
			// sideview 的运行态（running/awaiting/done/error）是**内存态**（由流式 delta 推导、不落盘），
			// 这里拿不到 ⇒ 统一给 `done`。手机端因此不会把这些历史会话谎报成"运行中"。
			status: 'done',
			resource: '',
			createdAt: null,
			updatedAt: r.updatedAt,
			isArchived: false,       // sideview 没有归档概念（只有 pinned 与手动顺序）
			isRead: true,
			agentId: r.agentId,      // 手机端可显示"哪个 agent 的会话"（sideview 第二行就是它）
			messageCount: r.messageCount,
			pinned: pinned.has(sideviewKey(r.agentId, r.id)),
			// 该会话的配置：手机端点进会话时用它把上下文（agent/工作区/worktree/模型）切成一致的。
			// 空字符串 = 这项拿不到 ⇒ 手机端不覆盖当前值（宁可不动，也不写错）。
			workspaceId: r.workspaceId,
			worktreePath: r.worktreePath,
			agentModelId: r.agentModelId,
			agentProviderId: r.agentProviderId,
		}));
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

		// sideview（Session History）的会话：手机端列表的**主体**（用户看到的 VsSaros 会话都在这里），
		// 且只有它自带 pinned/手动顺序 —— 手机端的顺序一致性就靠这段。
		// 取不到（老版本没有该服务 / 读盘失败）不能影响老链路 ⇒ 失败即空数组。
		const sideview = await listSideviewSessions(accessor).catch(() => []);

		// sideview 排前面：ISessionsManagementService 的会话（agent-host / copilot）保留在后面，
		// 既有场景不丢；两者同源重复的情况由手机端按标题去重。
		return {
			sessions: [...sideview, ...list.map(toPlainSession).filter(Boolean)],
			providers,
			mode: isWeb ? 'web' : 'desktop',
			sideview: { count: sideview.length },
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
 * 往**指定 Agent Studio 会话**发一条消息（sideview 里那些 `sess_*` 会话）。
 *
 * ★ 用户需求（2026-09-21）：手机端发的消息，VsSaros 里必须同步 ——
 *   ① **sideview 的 item**（消息数 / 时间 / 标题）要更新；
 *   ② **聊天框 UI** 要能看到这条消息与随后的回复。
 *
 * 只有走 `IAgentChatService.sendMessage()` 才能同时满足这两条：
 *   · 消息写进 `chat-history` 的会话文件 ⇒ 服务自己 fire `onDidChangeAgentSessions`
 *     ⇒ sideview 的 debounce 刷新（它订阅的就是这个事件）；
 *   · 先 `fireUserMessageAdded()` 广播 user 气泡（经 `onDidStreamDelta` 的 `user_message` delta）
 *     ⇒ **已打开的面板立刻显示这条 user 消息**；随后的 assistant 流式 delta 也走同一通道
 *     ⇒ 面板里能看到完整回复。
 *
 * 反面（现场问题）：手机端过去用 `vscode.lm` 直跑 —— 只产生一个手机侧的回复，
 * VsSaros 侧没有任何痕迹，用户看到的就是"手机上发了，桌面端没反应"。
 */
class SarosPocketSendToSessionAction extends Action2 {
	static readonly ID = 'sarosPocket.sendToSession';

	constructor() {
		super({
			id: SarosPocketSendToSessionAction.ID,
			title: 'Saros Pocket: Send To Agent Studio Session',
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, payload?: unknown): Promise<unknown> {
		const p = (payload ?? {}) as Record<string, unknown>;
		const agentId = String(p.agentId ?? '').trim();
		const sessionId = String(p.sessionId ?? '').trim();
		const text = String(p.text ?? '').trim();
		if (!agentId) { throw new Error('sarosPocket.sendToSession: 缺少 agentId'); }
		if (!sessionId) { throw new Error('sarosPocket.sendToSession: 缺少 sessionId'); }
		if (!text) { throw new Error('sarosPocket.sendToSession: 缺少 text'); }

		const chatService = accessor.get(IAgentChatService);
		// 与面板自己发消息时**同一套 options**（见 agentStudioWebviewController 的调用）：
		// 会话用 agentSessionId 指定；模型/工作区随会话配置一起带上，保证执行环境与桌面一致。
		const options: IChatSendOptions = {
			agentId,
			agentSessionId: sessionId,
			...(typeof p.workspaceId === 'string' && p.workspaceId ? { workspaceId: p.workspaceId } : {}),
			...(typeof p.modelId === 'string' && p.modelId ? { model: p.modelId } : {}),
			...(typeof p.providerId === 'string' && p.providerId ? { providerId: p.providerId } : {}),
			...(p.chatMode === 'craft' || p.chatMode === 'ask' || p.chatMode === 'plan' ? { chatMode: p.chatMode } : {}),
		};

		// ① 先广播 user 气泡：面板（若已打开）必须**立刻**看到手机发的这条
		try {
			chatService.fireUserMessageAdded(agentId, sessionId, {
				id: `pocket-${Date.now()}`,
				role: 'user',
				content: text,
				agentId,
				agentSessionId: sessionId,
				timestamp: new Date().toISOString(),
			});
		} catch { /* 广播失败不影响发送 */ }

		// ② 真发：写盘 + 流式（面板消费流）；手机端拿最终文本显示
		const reply = await chatService.sendMessage(agentId, text, options, () => { /* 流式由面板消费 */ });
		const replyText = String((reply as { content?: unknown })?.content ?? '');
		return { ok: true, agentId, sessionId, reply: replyText.slice(0, 20000) };
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
		registerAction2(SarosPocketSendToSessionAction);
		registerAction2(SarosPocketArchiveSessionAction);
		registerAction2(SarosPocketGetChatContextAction);
		registerAction2(SarosPocketSetChatContextAction);
	}
}

registerWorkbenchContribution2(SarosPocketContribution.ID, SarosPocketContribution, WorkbenchPhase.AfterRestored);
