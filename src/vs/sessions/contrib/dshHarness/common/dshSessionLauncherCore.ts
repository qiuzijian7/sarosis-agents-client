/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `dshSessionLauncher` 的**纯函数核心**（方案 5.15 / 7.6）。
 *
 * 为什么与宿主实现分开：`electron-browser` 的实现会拉进 browser 层依赖（node 单测环境
 * 没有 `window` ✗），而 cwd 解析、确定性会话 id、控制桥入参拼装都是纯逻辑 ——
 * 抽到 common 层后既能被宿主复用，也能在纯 node 单测里逐条钉住（见
 * `test/common/dshSessionLauncher.test.ts`）。
 */

import type { IBridgeSessionRunArgs, IBridgeSessionStartArgs } from './dshBridgeProtocol.js';
import { dshChatPresetSessionId, dshChatSessionId } from './dshChatSession.js';

export interface ILaunchSessionIdOptions {
	readonly chatId?: string;
	readonly agentPreset?: string;
	/** 显式会话 id：给定时跳过派生，走幂等接管。 */
	readonly sessionId?: string;
}

export interface ILaunchFolder {
	readonly uri: { readonly fsPath: string };
}

/** `session.start` / `session.run` 都要求 cwd：取第一个工作区根，没有就如实报错。 */
export function resolveLaunchCwd(folders: readonly ILaunchFolder[]): string {
	if (folders.length === 0) {
		throw new Error('[dshSessionLauncher] 当前没有打开的工作区，无法启动 dsh 会话（控制桥要求 cwd）');
	}
	return folders[0].uri.fsPath;
}

/** 方案 5.15.2：默认 preset 无后缀，非默认带 `--<presetId>`；显式 sessionId 优先。 */
export function deriveLaunchSessionId(options: ILaunchSessionIdOptions): string | undefined {
	if (options.sessionId) { return options.sessionId; }
	if (!options.chatId) { return undefined; }
	return options.agentPreset
		? dshChatPresetSessionId(options.chatId, options.agentPreset)
		: dshChatSessionId(options.chatId);
}

export interface ISessionStartOptions extends ILaunchSessionIdOptions {
	readonly prompt?: string;
}

export interface ISessionRunOptions extends ILaunchSessionIdOptions {
	readonly prompt: string;
	readonly timeoutMs?: number;
	/**
	 * ★ 2026-11-07：调用方可覆盖后台回合的工作目录（worktree 隔离 / 节点级 cwd）。
	 * 缺省时沿用 resolveLaunchCwd() 解析出的第一个工作区根；空串视为未指定。
	 */
	readonly cwd?: string;
	/** 无人值守审批白名单；缺省 = 全拒（runs 的 deny-by-default）。 */
	readonly approval?: { readonly allow: readonly string[] };
	/** ★ 内嵌附件；桥侧会追加为结构化 text 块（不会静默丢内容）。 */
	readonly attachments?: readonly { readonly name: string; readonly text: string }[];
}

/** 拼装桥方法 `session.start` 的入参（cwd 由调用方解析好传入）。 */
export function toSessionStartArgs(cwd: string, options: ISessionStartOptions): IBridgeSessionStartArgs {
	return {
		cwd,
		sessionId: deriveLaunchSessionId(options),
		agentPreset: options.agentPreset,
		prompt: options.prompt,
	};
}

/** 拼装桥方法 `session.run` 的入参。 */
export function toSessionRunArgs(cwd: string, options: ISessionRunOptions): IBridgeSessionRunArgs {
	return {
		// 调用方显式给的 cwd 优先（worktree 隔离等场景）；空串/空白回退到工作区根。
		cwd: options.cwd?.trim() || cwd,
		prompt: options.prompt,
		sessionId: deriveLaunchSessionId(options),
		agentPreset: options.agentPreset,
		timeoutMs: options.timeoutMs,
		approval: options.approval,
		attachments: options.attachments,
	};
}
