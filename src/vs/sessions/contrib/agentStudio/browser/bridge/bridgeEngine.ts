/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── BridgeEngine：平台桥接核心路由/编排（对齐 cc-connect core/engine.go）──
// 入站消息 → 会话映射/slash 命令分发 → 调用 IAgentChatService.sendMessage → 流式回传平台。

import { Emitter } from "../../../../../base/common/event.js";
import { Disposable, IDisposable } from "../../../../../base/common/lifecycle.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { IAgentChatService, IAgentStudioService, IChatStreamDelta } from "../../common/agentStudio.js";
import type { ChatMode } from "../../../../../sessions/common/agentStudioService.js";
import {
	BridgeCard,
	BridgeCommandContext,
	BridgeReplyCtx,
	BridgeSessionState,
	IBridgeEngineOps,
	IBridgePlatform,
	IBridgeUsageStats,
	InboundMessage,
	OutboundMessage,
	OutboundType,
} from "../../common/bridge/bridgeTypes.js";
import {
	BridgeCommandRegistry,
	createBuiltinCommands,
} from "../../common/bridge/bridgeCommands.js";
import {
	allowFromCheck,
	checkAllowFromConfig,
	renderCardToText,
	UnauthorizedAccessMessage,
} from "../../common/bridge/bridgeSecurity.js";
import { appendFileRefs, saveFilesToDisk } from "./bridgeAttachments.js";
import { BridgeUsageReporter, IUsageStatsStore } from "./bridgeUsage.js";
import { BridgeRelay } from "./bridgeRelay.js";
import type { IModelUsage } from "../../common/providers.js";

export interface BridgeEngineDeps {
	readonly chat: IAgentChatService;
	readonly studio: IAgentStudioService;
	readonly logService: ILogService;
	readonly commands?: BridgeCommandRegistry;
	/** 默认 Agent id；不填则取 getAgents() 的第一个。 */
	readonly defaultAgentId?: string;
	/** 附件落盘工作目录；不填则附件不落盘（仅内存引用）。 */
	readonly bridgeWorkDir?: string;
	/** 可选用量持久化存储；提供则 Usage 上报落盘，重启可恢复。 */
	readonly usageStore?: IUsageStatsStore;
	/** 可选配置服务；提供则可读取各渠道的「默认 Agent」静态绑定。 */
	readonly configurationService?: IConfigurationService;
}

export class BridgeEngine extends Disposable implements IBridgeEngineOps {
	private readonly _chat: IAgentChatService;
	private readonly _studio: IAgentStudioService;
	private readonly _log: ILogService;
	private readonly _registry: BridgeCommandRegistry;
	private readonly _defaultAgentId?: string;
	private readonly _bridgeWorkDir?: string;
	private readonly _configurationService?: IConfigurationService;

	private readonly _platforms = new Map<string, IBridgePlatform>();
	private readonly _sessions = new Map<string, BridgeSessionState>();
	private readonly _usage: BridgeUsageReporter;
	private readonly _relay: BridgeRelay;
	private _started = false;

	private readonly _onPlatformOutbound = this._register(new Emitter<OutboundMessage>());
	readonly onPlatformOutbound = this._onPlatformOutbound.event;

	constructor(deps: BridgeEngineDeps) {
		super();
		this._chat = deps.chat;
		this._studio = deps.studio;
		this._log = deps.logService;
		this._defaultAgentId = deps.defaultAgentId;
		this._bridgeWorkDir = deps.bridgeWorkDir;
		this._configurationService = deps.configurationService;
		this._registry = deps.commands ?? new BridgeCommandRegistry();
		if (!deps.commands) {
			for (const c of createBuiltinCommands()) {
				this._registry.register(c);
			}
		}
		// P3：进程内实例化 Usage 上报器与 Relay 编排器（usageStore 可选落盘）
		this._usage = new BridgeUsageReporter(this._log, deps.usageStore);
		this._relay = new BridgeRelay(this._chat, this._log);
	}

	// ─── 平台注册与生命周期 ───────────────────────────────────────

	registerPlatform(platform: IBridgePlatform): IDisposable {
		this._platforms.set(platform.id, platform);
		this._log.info(`[Bridge] registered platform: ${platform.id} (${platform.name})`);
		if (this._started) {
			// 已在运行：立即启动新平台
			Promise.resolve(platform.start(msg => this.handleInbound(msg))).catch(err =>
				this._log.error(`[Bridge] platform ${platform.id} start failed:`, err),
			);
		}
		return {
			dispose: () => {
				this._platforms.delete(platform.id);
				Promise.resolve(platform.stop()).catch(err =>
					this._log.error(`[Bridge] platform ${platform.id} stop failed:`, err),
				);
			},
		};
	}

	async start(): Promise<void> {
		if (this._started) {
			return;
		}
		this._started = true;
		for (const p of this._platforms.values()) {
			// 启动期安全告警：未配置 allowFrom 视为 permit-all
			checkAllowFromConfig(p.id, p.allowFrom, msg => this._log.warn(msg));
			try {
				await p.start(msg => this.handleInbound(msg));
				this._log.info(`[Bridge] platform started: ${p.id}`);
			} catch (err) {
				this._log.error(`[Bridge] platform ${p.id} start failed:`, err);
			}
		}
	}

	// ─── 入站入口 ────────────────────────────────────────────────

	/**
	 * 合成消息入口（调度器 cron/timer、外部 WS 注入、卡片按钮回调复用）。
	 * 与 handleInbound 不同：跳过 allowFrom 校验与 slash 解析，直接路由到 Agent。
	 * replyCtx 优先用调用方传入的，否则回退到会话已存 replyCtx。
	 */
	async handleSynthetic(
		sessionKey: string,
		content: string,
		opts?: { replyCtx?: unknown; platform?: string; userId?: string },
	): Promise<void> {
		try {
			const platform = opts?.platform ?? sessionKey.split(":")[0] ?? "loopback";
			const userId = opts?.userId ?? "scheduler";
			const msg: InboundMessage = {
				sessionKey,
				platform,
				messageId: `synthetic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				userId,
				userName: userId,
				content,
				replyCtx: opts?.replyCtx,
				isPermissionResponse: false,
			};
			await this._routeToAgent(msg);
		} catch (err) {
			this._log.error(`[Bridge] handleSynthetic failed for ${sessionKey}:`, err);
		}
	}

	async handleInbound(msg: InboundMessage): Promise<void> {
		try {
			// 0) 平台级 allowFrom 校验（对齐 cc-connect AllowList）
			const platform = this._platformForSession(msg.sessionKey) ?? this._platforms.get(msg.platform);
			if (platform && !allowFromCheck(platform.allowFrom, msg.userId)) {
				this._log.warn(`[Bridge] unauthorized inbound from ${msg.userId} on ${platform.id}`);
				this._emitOutbound(msg.sessionKey, msg.replyCtx, "error", UnauthorizedAccessMessage);
				return;
			}

			// 1) slash 命令优先
			const parsed = this._registry.parse(msg.content);
			if (parsed) {
				const session = await this.ensureSession(msg.sessionKey, msg.platform);
				const ctx = this._makeCommandContext(session, parsed.args, msg.content);
				this._log.info(`[Bridge] command /${parsed.cmd.name} from ${msg.sessionKey}`);
				await parsed.cmd.run(ctx);
				return;
			}

			// 2) 普通消息 → 路由到 Agent
			await this._routeToAgent(msg);
		} catch (err) {
			this._log.error(`[Bridge] handleInbound failed for ${msg.sessionKey}:`, err);
			this._emitOutbound(msg.sessionKey, msg.replyCtx, "error", `处理消息出错：${String(err)}`);
		}
	}

	private async _routeToAgent(msg: InboundMessage): Promise<void> {
		const session = await this.ensureSession(msg.sessionKey, msg.platform);

		// 附件落盘：入站文件写入工作目录，prompt 末尾追加本地路径引用。
		let content = msg.content;
		if (this._bridgeWorkDir && msg.files && msg.files.length > 0) {
			const paths = saveFilesToDisk(this._bridgeWorkDir, msg.files);
			content = appendFileRefs(msg.content, paths);
		}

		const options = {
			agentSessionId: session.agentSessionId,
			chatMode: (session.chatMode ?? "craft") as ChatMode,
			model: session.modelOverride,
			source: "user" as const,
		};

		let textBuf = "";
		let thinkingSeen = false;

		const onDelta = (delta: IChatStreamDelta): void => {
			switch (delta.type) {
				case "thinking":
					thinkingSeen = true;
					break;
				case "text":
					if (delta.content) {
						textBuf += delta.content;
					}
					break;
				case "tool_start":
					if (delta.toolName) {
						this._emitOutbound(msg.sessionKey, msg.replyCtx, "tool_use", `⚙️ ${delta.toolName}`);
					}
					break;
				case "tool_end":
					if (delta.toolName) {
						const ok = delta.success !== false;
						this._emitOutbound(
							msg.sessionKey,
							msg.replyCtx,
							"tool_result",
							`${ok ? "✅" : "⚠️"} ${delta.toolName} 完成`,
						);
					}
					break;
				case "error":
					if (delta.content) {
						this._emitOutbound(msg.sessionKey, msg.replyCtx, "error", delta.content);
					}
					break;
				case "usage":
					// P3：Usage 上报（对齐 cc-connect usage 统计）
					if (delta.usage) {
						this._usage.record(msg.sessionKey, session.agentId, delta.usage as IModelUsage);
					}
					break;
				case "done":
					if (textBuf.trim().length > 0) {
						this._emitOutbound(msg.sessionKey, msg.replyCtx, "result", textBuf);
					} else if (!thinkingSeen) {
						this._emitOutbound(msg.sessionKey, msg.replyCtx, "result", "（无文本输出）");
					}
					break;
			}
		};

		try {
			await this._chat.sendMessage(session.agentId, content, options, onDelta);
		} catch (err) {
			this._emitOutbound(msg.sessionKey, msg.replyCtx, "error", `Agent 执行失败：${String(err)}`);
		}
	}

	// ─── 命令上下文构造 ──────────────────────────────────────────

	private _makeCommandContext(
		session: BridgeSessionState,
		args: string[],
		raw: string,
	): BridgeCommandContext {
		return {
			engine: this,
			session,
			args,
			raw,
			reply: (text: string) => this._emitOutbound(session.sessionKey, session.replyCtx, "result", text),
			replyCard: (card: BridgeCard) => this._emitCard(session, card),
		};
	}

	// ─── 出站分发 ───────────────────────────────────────────────

	private _emitOutbound(
		sessionKey: string,
		replyCtx: unknown,
		type: OutboundType,
		content: string,
	): void {
		const msg: OutboundMessage = { sessionKey, type, content, replyCtx };
		this._onPlatformOutbound.fire(msg);
		const platform = this._platformForSession(sessionKey);
		if (!platform) {
			this._log.warn(`[Bridge] no platform for session ${sessionKey}, outbound dropped`);
			return;
		}
		const ctx: BridgeReplyCtx = { sessionKey, replyCtx };
		const op = replyCtx !== undefined ? platform.reply(ctx, content) : platform.send(ctx, content);
		Promise.resolve(op).catch(err => this._log.error(`[Bridge] outbound failed:`, err));
	}

	private _emitCard(session: BridgeSessionState, card: BridgeCard): void {
		const platform = this._platformForSession(session.sessionKey);
		if (!platform) {
			return;
		}
		const ctx: BridgeReplyCtx = { sessionKey: session.sessionKey, replyCtx: session.replyCtx };
		if (platform.replyCard) {
			Promise.resolve(platform.replyCard(ctx, card)).catch(err => this._log.error(`[Bridge] replyCard failed:`, err));
		} else if (platform.sendCard) {
			Promise.resolve(platform.sendCard(ctx, card)).catch(err => this._log.error(`[Bridge] sendCard failed:`, err));
		} else {
			// 降级为纯文本（对齐 cc-connect Card.RenderText）
			const text = renderCardToText(card);
			Promise.resolve(platform.send(ctx, text)).catch(err => this._log.error(`[Bridge] card fallback failed:`, err));
		}
	}

	private _platformForSession(sessionKey: string): IBridgePlatform | undefined {
		const session = this._sessions.get(sessionKey);
		const platformId = session?.platform ?? sessionKey.split(":")[0];
		return platformId ? this._platforms.get(platformId) : undefined;
	}

	// ─── IBridgeEngineOps 实现 ───────────────────────────────────

	getSession(sessionKey: string): BridgeSessionState | undefined {
		return this._sessions.get(sessionKey);
	}

	async ensureSession(sessionKey: string, platform: string): Promise<BridgeSessionState> {
		let session = this._sessions.get(sessionKey);
		if (session) {
			return session;
		}
		const agentId = await this._resolveDefaultAgent(platform);
		const created = await this._chat.getOrCreateActiveSession(agentId);
		session = {
			sessionKey,
			platform,
			agentId,
			agentSessionId: created.id,
			chatMode: "craft",
		};
		this._sessions.set(sessionKey, session);
		this._log.info(`[Bridge] new session ${sessionKey} → agent=${agentId} session=${created.id}`);
		return session;
	}

	private async _resolveDefaultAgent(platform?: string): Promise<string> {
		// 1) 渠道级静态绑定：sessions.channel.<platform>.defaultAgent
		if (platform && this._configurationService) {
			const cfgAgent = this._configurationService.getValue<string>(
				`sessions.channel.${platform}.defaultAgent`,
			);
			if (cfgAgent) {
				this._log.info(`[Bridge] channel ${platform} default agent: ${cfgAgent}`);
				return cfgAgent;
			}
		}
		// 2) 引擎级默认 Agent（构造注入）
		if (this._defaultAgentId) {
			return this._defaultAgentId;
		}
		const agents = await this.listAgents();
		if (agents.length === 0) {
			throw new Error("没有可用的 Agent，请先在 Agent Studio 中创建 Agent");
		}
		// 偏好 coding 类 Agent
		const coding = agents.find(a => /coder|coding|general/i.test(a.id) || /coder|编码|通用/i.test(a.name));
		return (coding ?? agents[0]).id;
	}

	async listAgents(): Promise<Array<{ id: string; name: string; model: string }>> {
		const agents = await this._studio.getAgents();
		return agents.map(a => ({ id: a.id, name: a.name, model: a.model }));
	}

	async createSession(sessionKey: string, agentId: string, name?: string): Promise<string> {
		const created = await this._chat.createAgentSession(agentId, name);
		return created.id;
	}

	switchSession(sessionKey: string, agentSessionId: string): void {
		const session = this._sessions.get(sessionKey);
		if (session) {
			session.agentSessionId = agentSessionId;
		}
	}

	async listSessions(agentId: string): Promise<Array<{ id: string; name: string; messageCount: number }>> {
		const sessions = await this._chat.listAgentSessions(agentId);
		return sessions.map(s => ({ id: s.id, name: s.name, messageCount: s.messageCount }));
	}

	setAgent(sessionKey: string, agentId: string): void {
		const session = this._sessions.get(sessionKey);
		if (session) {
			session.agentId = agentId;
		}
	}

	setModelOverride(sessionKey: string, model: string): void {
		const session = this._sessions.get(sessionKey);
		if (session) {
			session.modelOverride = model;
		}
	}

	setChatMode(sessionKey: string, mode: string): void {
		const session = this._sessions.get(sessionKey);
		if (session) {
			session.chatMode = mode;
		}
	}

	cancel(sessionKey: string): void {
		const session = this._sessions.get(sessionKey);
		if (session) {
			this._chat.cancelStream(session.agentId, session.agentSessionId);
		}
	}

	async clearHistory(sessionKey: string): Promise<void> {
		const session = this._sessions.get(sessionKey);
		if (session) {
			await this._chat.clearHistory(session.agentId, session.agentSessionId);
		}
	}

	// ─── P3：Relay 编排（bot↔bot）──────────────────────────────

	/**
	 * 把一条内容 relay 给另一个 Agent（独立会话），取其纯文本回复，
	 * 再以合成消息回传给源会话/平台（让用户在源会话里看到 relay 结果）。
	 * 对应 cc-connect `relay send --to <bot> --message <text>`。
	 */
	async relayToAgent(fromSessionKey: string, toAgentId: string, content: string): Promise<string> {
		const result = await this._relay.relay(fromSessionKey, toAgentId, content);
		// 把 relay 结果回传给源会话（用户可见）
		await this.handleSynthetic(fromSessionKey, `【relay→${toAgentId}】\n${result}`, {
			replyCtx: this._sessions.get(fromSessionKey)?.replyCtx,
		});
		return result;
	}

	/**
	 * 串行 relay 链（a→b→c）：每步把上一步回复作为下一步输入，
	 * 仅把最终回复回传给源会话（避免中间过程刷屏）。
	 */
	async relayChainToAgent(fromSessionKey: string, agentIds: string[], content: string): Promise<string> {
		const result = await this._relay.relayChain(fromSessionKey, agentIds, content);
		await this.handleSynthetic(
			fromSessionKey,
			`【relay chain→${agentIds.join(">")}】\n${result}`,
			{ replyCtx: this._sessions.get(fromSessionKey)?.replyCtx },
		);
		return result;
	}

	// ─── P3：Usage 上报查询 ───────────────────────────────────

	getUsageStats(filter?: { agentId?: string; sessionKey?: string }): IBridgeUsageStats[] {
		return this._usage.summarize(filter);
	}
}
