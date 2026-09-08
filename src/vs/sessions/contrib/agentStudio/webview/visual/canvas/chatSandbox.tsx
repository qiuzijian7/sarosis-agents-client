/*---------------------------------------------------------------------------------------------
 *  聊天沙箱模块（chat-real / chat-ui 场景共享）
 *
 *  职责：挂载 100% 真实 AgentChatPanel 并接线全部沙箱能力——
 *    · agent 下拉（内置白名单 + ~/.vssaros/agents 用户自定义 + 演示 agent，真实切换）
 *    · provider / model 下拉（CodeBuddy 73 真实模型 + 其余演示渠道）
 *    · worktree / workspace 下拉（test-server /api/real/*：磁盘 + 真实 git 命令）
 *    · 会话（新增/恢复/消息持久化 → ~/.vssaros/chat-history/sandbox-chat-sessions.json）
 *    · 消息流（slash 解析 → runChatWorkflowHeadless → markdown 出图回贴）
 *    · 断言句柄 __chatUi.{messages,getLastImage} + __chatUiSend（Playwright / LLM 用）
 *    · 可拖拽分隔条状态（chatWidth 320–800px，pointer capture）
 *
 *  依赖注入：log（沙箱日志）、runChatWorkflowHeadless（headless 执行核，canvasHost 提供）。
 *  ★ fetch 一律绝对 URL：networkGuard 白名单按 `http://origin/api/real/` 前缀匹配，
 *    相对路径（/api/...）不匹配会被拦成假图。
 *--------------------------------------------------------------------------------------------*/
import * as React from 'react';
import { parseSlashCommands } from '../../src/utils/slashCommands.js';
import { CODEBUDDY_MODELS } from '../codebuddyModels.generated.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** chat 面板数据 API 绝对前缀（networkGuard 白名单同源）。 */
const REAL_API = (): string => `${location.origin}/api/real`;

export interface ChatSandboxDeps {
	/** 沙箱执行日志（canvasHost 的 log）。 */
	log: (msg: string, kind?: 'ok' | 'err' | 'dim' | undefined) => void;
	/** headless 工作流执行核（canvasHost 提供；不进画布 store）。 */
	runChatWorkflowHeadless: (prompt: string) => Promise<string[] | null>;
}

/** 演示 agent（IAgentInfo）：沙箱无 host 会话数据，setAgent 注入后聊天框即全功能可见。 */
const DEMO_AGENT: Any = {
	id: 'sandbox-gr-emoji',
	name: 'GR埋点专家',
	role: '表情包出图演示 · 沙箱',
	icon: '🤖',
	status: 'idle',
	model: 'claude-sonnet-4.6',
	provider: 'lm:codebuddy',
};

/**
 * chat 面板的 provider 下拉数据（IProviderInfo 契约）。
 * ★ `lm:codebuddy` = 真实 provider（extensions/codebuddy-provider 注册的 LM
 *   vendor，模型清单见 codebuddyModels.generated.ts——与 vssaros.exe 同源）。
 */
const CHAT_PROVIDERS: Any[] = [
	{ id: 'lm:codebuddy', label: 'CodeBuddy' },
	{ id: 'anthropic', label: 'Anthropic' },
	{ id: 'openai', label: 'OpenAI' },
	{ id: 'vt-imagen', label: 'VT Imagen（出图）' },
];

/** chat 面板的 model 下拉数据（按 provider 过滤显示）。 */
const CHAT_MODELS: Any[] = [
	...CODEBUDDY_MODELS.map(m => ({
		id: m.id,
		label: m.name,
		provider: 'lm:codebuddy',
		supportsImages: m.supportsImages,
		maxInputTokens: m.maxInputTokens,
	})),
	{ id: 'claude-sonnet-4-20250514', label: 'claude-sonnet-4', provider: 'anthropic' },
	{ id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' },
	{ id: 'vt-image-1', label: 'VT Image 1（表情包出图）', provider: 'vt-imagen', supportsImages: true },
];

export interface ChatSandbox {
	/** 真实面板挂载宿主（布局区 <div ref>）。 */
	chatRealHostRef: React.RefObject<HTMLDivElement | null>;
	/** 可拖拽聊天框宽度（320–800px，初始 480）。 */
	chatWidth: number;
	/** 分隔条 pointer handlers（展开到布局区 <div> 上）。 */
	splitterHandlers: {
		onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
		onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
		onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
		onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
	};
	/** auto=1 自动发送（等 __chatUiSend 就绪后投递，最多 10s）。 */
	autoSend: (text: string, logOnce?: () => void) => void;
}

/**
 * 聊天沙箱 hook。挂载 effect / 断言句柄 effect / 会话与下拉状态全部内聚在此，
 * canvasHost 只消费返回值做布局接线。
 */
export function useChatSandbox(deps: ChatSandboxDeps): ChatSandbox {
	const { log, runChatWorkflowHeadless } = deps;
	const chatRealHostRef = React.useRef<HTMLDivElement | null>(null);
	const chatRealPanelRef = React.useRef<Any>(null);
	/** 下拉注入的完整 agent 列表（onSelectAgent 切换时查表 setAgent）。 */
	const chatAgentListRef = React.useRef<Any[]>([]);
	// 聊天框宽度（可拖拽分隔条调整，320–800px）
	const [chatWidth, setChatWidth] = React.useState(480);
	const splitterDragRef = React.useRef<{ startX: number; startW: number } | null>(null);
	// 断言消息日志：chatRealHandle 的 add() 同步落账，供 __chatUi 断言句柄读取。
	const chatMsgLogRef = React.useRef<Array<{ role: 'user' | 'assistant'; text?: string; imageUrl?: string }>>([]);
	// 会话 / provider / model 沙箱状态（下拉点选即时生效）
	const chatSessionsRef = React.useRef<Map<string, Array<{ role: 'user' | 'assistant'; text?: string; imageUrl?: string }>>>(new Map());
	const chatCurrentSessionIdRef = React.useRef<string>('');
	const chatCurrentProviderRef = React.useRef<string>('lm:codebuddy');
	const chatCurrentModelRef = React.useRef<string>('claude-sonnet-4.6');

	const chatRealHandle = async (text: string): Promise<void> => {
		const panel = chatRealPanelRef.current;
		const mid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
		const add = (role: 'user' | 'assistant', content: string) => {
			// markdown 图片回贴 → 提取 url 记入日志（断言 getLastImage 用）
			const imgMatch = /!\[[^\]]*\]\(([^)]+)\)/.exec(content);
			const entry: Any = { role, text: imgMatch ? undefined : content, imageUrl: imgMatch?.[1] };
			chatMsgLogRef.current.push(entry);
			// ★ 持久化（fire-and-forget）：消息落 ~/.vssaros/chat-history/，刷新不丢
			void fetch(`${REAL_API()}/chat-sessions/${chatCurrentSessionIdRef.current}/messages`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ role, text: entry.text, imageUrl: entry.imageUrl }),
			}).catch(() => { /* 持久化失败不影响消息流 */ });
			try { panel?.addMessage?.({ id: mid(), role, content, timestamp: Date.now() } as Any); } catch { /* ignore */ }
		};
		add('user', text);
		const trigger = parseSlashCommands(text).workflowTrigger;
		if (!trigger) {
			add('assistant', '出图需要显式触发工作流（与真实聊天框一致）：\n/workflow wf-emoji <描述>\n/wf wf-emoji <描述>\n/wf-emoji <描述>（整行）');
			return;
		}
		const promptText = trigger.input?.trim() || '帮我做一个戴圣诞帽的橘猫表情包，Q版，厚描边，透明背景，孤立贴纸';
		const images = await runChatWorkflowHeadless(promptText);
		if (!images) { add('assistant', '出图失败（详见画布执行日志）'); return; }
		for (const u of images) { add('assistant', `![出图](${u})`); }
	};

	// ── 挂载 effect：动态 import 真实 AgentChatPanel（host 组件族）+ 全量接线 ──
	React.useEffect(() => {
		if (!chatRealHostRef.current || chatRealPanelRef.current) { return; }
		let disposed = false;
		void (async () => {
			try {
				const [mod, builtinAgentsMod]: Any[] = await Promise.all([
					import('../../../../../browser/agentChat/agentChatPanel.js'),
					// ★ agent 下拉的完整列表与 vssaros.exe 同源：内置白名单 agents
					//（saros-claw 主助理 + knowledge-base-expert，见 builtinAgents.ts）。
					import('../../../common/builtinAgents.js'),
				]);
				if (disposed) { return; }
				const noop = () => {};
				const logService: Any = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, dispose: noop };
				// ★ 100% 真实组件：AgentChatPanel 组合根（与 nativeChatEditorPane 同类），
				//   仅必填回调 onSendMessage / onCancelExecution 驱动；发消息 → 执行核 → addMessage 回贴。
				const panel = new (mod as Any).AgentChatPanel({
					onSendMessage: (text: string) => { void chatRealHandle(text); },
					onCancelExecution: noop,
					onToggleCollapse: noop,
					// agent 下拉点选 → 真实切换面板 agent（头部/角色/状态随之更新）
					onSelectAgent: (id: string) => {
						const a = chatAgentListRef.current.find(x => x.id === id);
						if (a) { panel.setAgent(a); }
					},
					// ★ 新增会话：POST 创建（持久化到 ~/.vssaros/chat-history/）→ 面板切空会话
					onNewSession: () => {
						void (async () => {
							try {
								const r = await (await fetch(`${REAL_API()}/chat-sessions`, {
									method: 'POST', headers: { 'content-type': 'application/json' },
									body: JSON.stringify({ name: '新会话' }),
								})).json() as Any;
								const msgs: Any[] = [];
								chatSessionsRef.current.set(r.id, msgs);
								chatCurrentSessionIdRef.current = r.id;
								chatMsgLogRef.current = msgs;
								panel.setMessages([]);
								panel.setSessionId(r.id, r.name);
								log('🆕 新会话已创建（' + r.id + '，已持久化）', 'ok');
							} catch (err) {
								log('✗ 新建会话失败：' + (err instanceof Error ? err.message : String(err)), 'err');
							}
						})();
					},
					// ★ provider/model 下拉点选：面板内部已自更新 chip（真实组件行为），
					//   沙箱侧仅记录当前选择（供后续把执行链与所选 provider/model 打通）。
					onSelectProvider: (providerId: string) => { chatCurrentProviderRef.current = providerId; },
					onSelectModel: (modelId: string) => { chatCurrentModelRef.current = modelId; },
					// ★ 工作区/worktree 下拉：**真实数据** —— test-server Node 侧读
					//   ~/.vssaros/workspaces.json + 执行真实 git 命令（worktree list /
					//   status / rev-list），与 vssaros.exe 的 WorktreeService 同语义。
					//   ★ 面板契约：worktrees 数组 = **主仓库之外**的其他 worktree
					//  （主仓库独立渲染首项）——逐个 workspace 尝试直到取到非空列表
					//  （当前项目 sarosis-agents-client 优先）。
					onLoadWorktrees: async () => {
						try {
							const wsList: Any[] = await (await fetch(`${REAL_API()}/workspaces`)).json();
							const ordered = [
								...wsList.filter(w => (w.name ?? '').includes('sarosis-agents-client')),
								...wsList.filter(w => !(w.name ?? '').includes('sarosis-agents-client')),
							];
							for (const ws of ordered) {
								const list = await (await fetch(`${REAL_API()}/worktrees?path=${encodeURIComponent(ws.path ?? '')}`)).json() as Any[];
								if (list.length) { return list; }
							}
							return [];
						} catch { return []; }
					},
					onSelectWorktree: () => { /* 单 worktree：切换无意义，保留主仓库 */ },
					onClearWorktree: () => { /* 同上 */ },
					onLoadWorkspaces: async () => {
						try { return await (await fetch(`${REAL_API()}/workspaces`)).json() as Any[]; } catch { return []; }
					},
					onSelectWorkspace: () => { /* 沙箱单面板：workspace 选择仅记录 */ },
					onListSkills: () => [],
					onListWorkflows: () => [{ id: 'wf-emoji', name: '表情包', description: '静态表情包（图集）' }],
					onListMcpServers: () => [],
					logService,
				} as Any);
				chatRealHostRef.current!.appendChild(panel.element);
				chatRealPanelRef.current = panel;
				// 注入完整 agent 列表：内置白名单 agents（与 vssaros.exe 同源）
				//   + 用户自定义（~/.vssaros/agents/，test-server 真实读取）+ 演示 agent。
				try {
					let customAgents: Any[] = [];
					try { customAgents = await (await fetch(`${REAL_API()}/agents`)).json() as Any[]; } catch { /* 无 API 时跳过 */ }
					const builtin: Any[] = (builtinAgentsMod as Any).filterUserFacingAgents(
						(builtinAgentsMod as Any).getBuiltinAgents(),
					) ?? [];
					const agentList: Any[] = [
						...builtin.map((a: Any) => ({
							id: a.id,
							name: a.name,
							role: a.role || a.description || '',
							icon: a.icon || '🤖',
							status: 'idle',
							model: a.model,
							provider: a.providerId,
						})),
						...customAgents.map((a: Any) => ({
							id: a.id, name: a.name, role: a.role || '', icon: a.icon || '🤖',
							status: 'idle', model: a.model, provider: a.provider,
						})),
						DEMO_AGENT,
					];
					chatAgentListRef.current = agentList;
					panel.setAvailableAgents?.(agentList as Any);
					panel.setAgent?.(DEMO_AGENT as Any);
					// provider / model 下拉数据 + 当前选中（chips 即时生效）
					panel.setProviders?.(CHAT_PROVIDERS as Any);
					panel.setModels?.(CHAT_MODELS as Any);
					panel.setCurrentProvider?.(chatCurrentProviderRef.current);
					panel.setCurrentModel?.(chatCurrentModelRef.current);
					// ★ 真实会话（持久化到 ~/.vssaros/chat-history/sandbox-chat-sessions.json）：
					//   恢复最近会话；无会话则创建「会话 1」。刷新不丢、跨场景共享。
					const sessions: Any[] = await (await fetch(`${REAL_API()}/chat-sessions`)).json();
					let sid = sessions[sessions.length - 1]?.id;
					if (!sid) {
						sid = (await (await fetch(`${REAL_API()}/chat-sessions`, {
							method: 'POST', headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ name: '会话 1' }),
						})).json()).id;
					}
					chatCurrentSessionIdRef.current = sid;
					const msgs: Any[] = await (await fetch(`${REAL_API()}/chat-sessions/${sid}/messages`)).json();
					chatSessionsRef.current.set(sid, msgs);
					chatMsgLogRef.current = msgs;
					if (msgs.length) {
						panel.setMessages?.(msgs.map((m: Any, i: number) => ({
							id: 'm' + i, role: m.role,
							content: m.imageUrl ? `![出图](${m.imageUrl})` : (m.text ?? ''),
							timestamp: m.ts ?? Date.now(),
						})) as Any);
					}
					panel.setSessionId?.(sid, sessions.find((s: Any) => s.id === sid)?.name ?? '会话 1');
				} catch { /* 空态也不影响测试链路 */ }
				log('✓ 已挂载真实 AgentChatPanel（100% 真组件）', 'ok');
			} catch (err) {
				log('✗ AgentChatPanel 挂载失败：' + (err instanceof Error ? err.message : String(err)), 'err');
			}
		})();
		return () => { disposed = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 断言句柄：messages() = 消息流快照；getLastImage() = 最后一张出图；__chatUiSend = 程序化发送。
	React.useEffect(() => {
		(window as Any).__chatUi = {
			messages: () => chatMsgLogRef.current.map(m => ({ role: m.role, text: m.text ?? null, hasImage: !!m.imageUrl })),
			getLastImage: () => [...chatMsgLogRef.current].reverse().find(m => m.imageUrl)?.imageUrl ?? null,
		};
		(window as Any).__chatUiSend = (text: string) => { void chatRealHandle(text); };
	});

	/** auto=1 自动发送：等面板挂载（__chatUiSend 就绪）后投递，最多 10s。 */
	const autoSend = React.useCallback((text: string, logOnce?: () => void) => {
		logOnce?.();
		const trySend = (n: number): void => {
			if ((window as Any).__chatUiSend) { (window as Any).__chatUiSend(text); return; }
			if (n <= 0) { log('✗ 聊天面板挂载超时，auto 发送中止', 'err'); return; }
			setTimeout(() => trySend(n - 1), 500);
		};
		trySend(20);
	}, [log]);

	// chatWidth 的同步镜像：pointerdown 回调经由 useMemo 缓存，直接读 state 会闭包过期
	const chatWidthRef = React.useRef(chatWidth);
	chatWidthRef.current = chatWidth;

	/** 分隔条 pointer handlers（布局区 <div> 直接展开；pointer capture 保证拖出区域仍跟踪）。 */
	const splitterHandlers = React.useMemo(() => ({
		onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
			splitterDragRef.current = { startX: e.clientX, startW: chatWidthRef.current };
		},
		onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
			const st = splitterDragRef.current;
			if (!st) { return; }
			// 向左拖 → 聊天框变宽
			setChatWidth(Math.min(800, Math.max(320, st.startW + (st.startX - e.clientX))));
		},
		onPointerUp: () => { splitterDragRef.current = null; },
		onPointerCancel: () => { splitterDragRef.current = null; },
	}), []);

	return { chatRealHostRef, chatWidth, splitterHandlers, autoSend };
}
