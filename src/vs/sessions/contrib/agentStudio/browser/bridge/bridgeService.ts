/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── IBridgeService：平台桥接层对外服务（DI 单例）──

import { createDecorator } from "../../../../../platform/instantiation/common/instantiation.js";
import { Event } from "../../../../../base/common/event.js";
import { Disposable, IDisposable } from "../../../../../base/common/lifecycle.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import { IEnvironmentService } from "../../../../../platform/environment/common/environment.js";
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { resolveSarosPath, userDataRootFromRoamingHome } from "../../common/sarosPaths.js";
// ★ 2026-09-23：绑定/会话映射改走**主进程**文件存储（渲染进程沙箱拿不到 fs ⇒ 旧 file store
//   永远返回 undefined ⇒ 绑定退化为内存、重启即丢）。见 bridgeIpcStores.ts 头注释。
import { createIpcBindingStore, createIpcSessionMapStore, type IIpcBindingStore, type IIpcSessionMapStore } from "./bridgeIpcStores.js";
import {
	IAgentChatService,
	IAgentStudioService,
} from "../../common/agentStudio.js";
import {
	IBridgePlatform,
	IBridgePlatformFactory,
	OutboundMessage,
} from "../../common/bridge/bridgeTypes.js";
import { BridgeEngine } from "./bridgeEngine.js";
import { LoopbackPlatform } from "./loopbackPlatform.js";
import { BridgeScheduler } from "./bridgeScheduler.js";
import { createFileTaskStore } from "./bridgeSchedulerStore.js";
import { createFileUsageStore } from "./bridgeUsageStore.js";
import { createFileBindingStore } from "./bridgeBindings.js";
import { createFileSessionMapStore } from "./bridgeSessionMap.js";
import { BridgeServer } from "./bridgeServer.js";

export const IBridgeService = createDecorator<IBridgeService>("bridgeService");

export interface IBridgeService {
	readonly _serviceBrand: undefined;

	/** 所有平台的出站事件流（测试/外部订阅用）。 */
	readonly onPlatformOutbound: Event<OutboundMessage>;

	/** 注册一个平台适配器工厂（由 contribution 在启动时调用）。 */
	registerPlatform(factory: IBridgePlatformFactory): IDisposable;

	/** 按 id 取平台实例（未注册返回 undefined）。供设置页渠道状态展示用。 */
	getPlatform(id: string): IBridgePlatform | undefined;

	/** 取得核心引擎（惰性创建）。 */
	getEngine(): BridgeEngine;

	/**
	 * ★ 等待绑定表 / 会话映射从**磁盘水合**完成（2026-09-23）。
	 *
	 * 为什么需要：持久化在**主进程**（IPC 读盘必然是异步的），而引擎的读接口是同步的
	 * ⇒ UI 若在启动瞬间渲染绑定列表，会读到「尚未水合」的空表，看起来就像「重启后绑定丢了」
	 * （实测：磁盘 `<userData>/bridge/bindings.json` 里明明有数据，面板列表却是空的）。
	 * ⇒ UI 侧应在首次渲染后 `await` 本方法，然后**再渲染一次**列表。
	 * 已水合时立即 resolve（幂等）。
	 */
	ensureBindingsLoaded(): Promise<void>;

	/** 取得定时任务调度器（cron/timer，惰性创建）。 */
	getScheduler(): BridgeScheduler;

	/** 取得本地 WebSocket 调试/事件服务（惰性创建，env 门控）。 */
	getServer(): BridgeServer;

	/** 启动所有已注册平台。 */
	start(): Promise<void>;

	/** 停止所有平台并释放。 */
	stop(): Promise<void>;

	/** 演示/调试：向 Loopback 平台注入一条入站消息。 */
	postLoopback(content: string, sessionKey?: string): void;
}

export class BridgeService extends Disposable implements IBridgeService {
	readonly _serviceBrand: undefined;

	private readonly _chat: IAgentChatService;
	private readonly _studio: IAgentStudioService;
	private readonly _log: ILogService;
	private readonly _configurationService: IConfigurationService;

	private _engine?: BridgeEngine;
	/** ★ 主进程 IPC store 的引用（用于 `ensureBindingsLoaded()` 等待水合）。 */
	private _bindingsStore?: IIpcBindingStore;
	private _sessionMapStore?: IIpcSessionMapStore;
	private _scheduler?: BridgeScheduler;
	private _server?: BridgeServer;
	private readonly _platforms = new Map<string, IBridgePlatform>();
	private _started = false;

	constructor(
		@IAgentChatService chat: IAgentChatService,
		@IAgentStudioService studio: IAgentStudioService,
		@ILogService log: ILogService,
		@IConfigurationService configurationService: IConfigurationService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
	) {
		super();
		this._chat = chat;
		this._studio = studio;
		this._log = log;
		this._configurationService = configurationService;

		// 默认内置 Loopback 平台（测试/演示），真实平台由各自的 contribution 注册。
		this.registerPlatform({
			id: "loopback",
			create: () => new LoopbackPlatform(),
		});
	}

	/**
	 * ★ 等待绑定/会话映射水合完成（幂等）。见接口处的说明：
	 * 主进程读盘是异步的，UI 首次渲染可能读到空表 ⇒ 需要「渲染 → await → 再渲染一次」。
	 */
	async ensureBindingsLoaded(): Promise<void> {
		this._ensureEngine();   // 惰性创建：两个 store 是在引擎构造时建立的
		await Promise.all([this._bindingsStore?.hydrate(), this._sessionMapStore?.hydrate()]);
	}

	private _ensureEngine(): BridgeEngine {
		if (!this._engine) {
			this._engine = 			new BridgeEngine({
				chat: this._chat,
				studio: this._studio,
				logService: this._log,
				bridgeWorkDir: this._resolveBridgeWorkDir(),
				// 用量落盘到 <workDir>/usage.json；fs 不可用时退化为内存态
				usageStore: createFileUsageStore(this._resolveBridgeWorkDir(), this._log),
				// 读取各渠道「默认 Agent」静态绑定
				configurationService: this._configurationService,
				// ★ 会话→Agent 绑定持久化：**主进程** `<userData>/bridge/bindings.json`
				//   （2026-09-23 修「重启后 chat_id 绑定丢失」：渲染进程沙箱里
				//    createFileBindingStore 永远返回 undefined ⇒ 绑定只活在内存里。
				//    IPC 优先；file store 仅作为 node 宿主/单测的兜底，顺序不能反。）
				bindingsStore: (this._bindingsStore = createIpcBindingStore(this._log)) ?? createFileBindingStore(this._resolveBridgeWorkDir(), this._log),
				// ★ 会话→专属 Agent 会话映射持久化：同上，`<userData>/bridge/sessionMap.json`
				sessionMapStore: (this._sessionMapStore = createIpcSessionMapStore(this._log)) ?? createFileSessionMapStore(this._resolveBridgeWorkDir(), this._log),
			});
		}
		return this._engine;
	}

	/**
	 * 解析附件落盘工作目录。优先进程 cwd，回退到 VS Code 用户数据目录下的 bridge/。
	 * 渲染进程无 Node require 时返回 undefined（附件不落盘，仅内存引用）。
	 */
	private _resolveBridgeWorkDir(): string | undefined {
		const req: any =
			typeof globalThis !== "undefined" && typeof (globalThis as any).require === "function"
				? (globalThis as any).require
				: undefined;
		if (!req) {
			return undefined;
		}
		try {
			const nodePath = req("path") as typeof import('path');
			const cwd = (globalThis as any).process?.cwd?.();
			if (cwd) {
				return nodePath.join(cwd, ".saros", "bridge");
			}
			return resolveSarosPath(
				userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome),
				'bridge'
			).fsPath;
		} catch {
			return undefined;
		}
	}

	get onPlatformOutbound(): Event<OutboundMessage> {
		return this._ensureEngine().onPlatformOutbound;
	}

	registerPlatform(factory: IBridgePlatformFactory): IDisposable {
		const engine = this._ensureEngine();
		const platform = factory.create({});
		this._platforms.set(platform.id, platform);
		const disp = engine.registerPlatform(platform);
		return {
			dispose: () => {
				disp.dispose();
				this._platforms.delete(platform.id);
			},
		};
	}

	getPlatform(id: string): IBridgePlatform | undefined {
		return this._platforms.get(id);
	}

	async start(): Promise<void> {
		this._ensureEngine();
		if (this._started) {
			return;
		}
		this._started = true;
		await this._engine!.start();
		this._log.info(`[Bridge] service started with ${this._platforms.size} platform(s)`);
		// P2：调度器常驻；WS 服务按 env 门控（无配置则跳过）。
		this.getScheduler().start();
		this.getServer().start();
	}

	async stop(): Promise<void> {
		for (const p of this._platforms.values()) {
			await Promise.resolve(p.stop()).catch(() => {});
		}
		this._started = false;
	}

	getEngine(): BridgeEngine {
		return this._ensureEngine();
	}

	getScheduler(): BridgeScheduler {
		if (!this._scheduler) {
			this._scheduler = new BridgeScheduler({
				engine: this._ensureEngine(),
				logService: this._log,
				// 持久化到 <workDir>/scheduler.json；fs 不可用时退化为内存态
				store: createFileTaskStore(this._resolveBridgeWorkDir(), this._log),
			});
		}
		return this._scheduler;
	}

	getServer(): BridgeServer {
		if (!this._server) {
			this._server = new BridgeServer({
				engine: this._ensureEngine(),
				logService: this._log,
			});
		}
		return this._server;
	}

	postLoopback(content: string, sessionKey?: string): void {
		this._ensureEngine();
		if (!this._started) {
			// 自动启动以便演示
			void this.start();
		}
		const lb = this._platforms.get("loopback");
		if (!lb) {
			this._log.warn("[Bridge] loopback platform 未注册，postLoopback 无效");
			return;
		}
		(lb as unknown as { postInbound(content: string, sessionKey?: string): void }).postInbound(
			content,
			sessionKey,
		);
	}
}
