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
import { BridgeServer } from "./bridgeServer.js";

export const IBridgeService = createDecorator<IBridgeService>("bridgeService");

export interface IBridgeService {
	readonly _serviceBrand: undefined;

	/** 所有平台的出站事件流（测试/外部订阅用）。 */
	readonly onPlatformOutbound: Event<OutboundMessage>;

	/** 注册一个平台适配器工厂（由 contribution 在启动时调用）。 */
	registerPlatform(factory: IBridgePlatformFactory): IDisposable;

	/** 取得核心引擎（惰性创建）。 */
	getEngine(): BridgeEngine;

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
				// 会话→Agent 绑定持久化（<workDir>/bindings.json）
				bindingsStore: createFileBindingStore(this._resolveBridgeWorkDir(), this._log),
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
