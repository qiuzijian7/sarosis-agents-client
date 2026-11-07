/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「IDE 后台入口 → dsh 控制桥」的统一会话启动钩子（方案 5.15 / 7.6）。
 *
 * 分层约束：`agentStudio/browser` 不能 import `dshHarness/electron-browser`（反向依赖 ✗），
 * 所以本文件只定义接口与注册点；实现由
 * `dshHarness/electron-browser/dshSessionLauncher.ts` 在启动早期注入。
 * 与 `dshChatHost.ts` 的承载工厂是同一套中立层钩子模式。
 *
 * ⚠ 控制桥 `session.start` / `session.run` / `session.cancel` 三个方法本身**已经落地**
 *   （`dsh-plugins/vssaros-bridge/lib/index.js` + `dshHarnessChannel` +
 *   `IDshHarnessService.startSession/runSession`）。本层不新增桥协议，只补上：
 *     ① 统一入口（调用方不必各自拼 cwd / sessionId / preset）；
 *     ② 当前工作区的 cwd 解析；
 *     ③ 确定性的 `vssaros-chat-<chatId>[--<presetId>]` 会话 id 派生。
 *
 * ★ 调用方拿不到实现时**必须如实报错**，不能静默退回 IDE agent loop ——
 *   那个 loop 正在整体下线，静默回退会让「已经迁移」变成假象 ✗。
 */

/** 建/接管会话的选项（对应桥方法 `session.start`）。 */
export interface IDshSessionLaunchOptions {
	/** 页签身份；用于确定性派生会话 id（见 `dshChatSession.ts`）。 */
	readonly chatId?: string;
	readonly agentPreset?: string;
	/** 可选首条 prompt：只投递，不等回合跑完。 */
	readonly prompt?: string;
	/** 显式会话 id；给定时跳过派生、走幂等接管。 */
	readonly sessionId?: string;
}

export interface IDshSessionLaunchResult {
	readonly sessionId: string;
	readonly workspaceId?: string;
	readonly prompted?: boolean;
	readonly agentPreset?: string | null;
}

/** 后台回合选项（对应桥方法 `session.run`）：投 prompt 并等回合跑完。 */
export interface IDshBackgroundTurnOptions {
	readonly prompt: string;
	readonly chatId?: string;
	readonly agentPreset?: string;
	readonly sessionId?: string;
	readonly timeoutMs?: number;
	/** ★ 覆盖后台回合的工作目录（worktree 隔离 / 节点级 cwd）；缺省用工作区根。 */
	readonly cwd?: string;
	/** 无人值守审批白名单；缺省 = 全拒（runs 的 deny-by-default）。 */
	readonly approval?: { readonly allow: readonly string[] };
	/** ★ 内嵌附件（name + text）；桥侧追加为 text 块，避免静默丢内容。 */
	readonly attachments?: readonly { readonly name: string; readonly text: string }[];
	/**
	 * ★ 2026-11-07：abort 时经控制桥 `session.cancel` 取消当前回合。
	 * 给了 signal 却没有显式 sessionId 时，宿主会预生成确定性 id（否则桥侧分配的
	 * id 要等回合结束才拿得到，取消无从下手）。不传 signal ⇒ 行为与原来完全一致。
	 */
	readonly signal?: AbortSignal;
}

export interface IDshBackgroundTurnResult {
	readonly sessionId: string;
	/** 该回合最后一条非空 assistant 文本；被工具占满 / 被打断时为 null。 */
	readonly finalText: string | null;
	readonly stopReason: string | null;
	readonly interrupted: boolean;
	readonly elapsedMs: number;
}

export interface IDshSessionLauncher {
	/** 建/接管会话（幂等）。cwd 由实现侧从当前工作区解析，调用方不必传。 */
	start(options: IDshSessionLaunchOptions): Promise<IDshSessionLaunchResult>;
	/** 后台回合：投 prompt、等结束、回传最终文本（IDE `sendMessage` 的替代）。 */
	runTurn(options: IDshBackgroundTurnOptions): Promise<IDshBackgroundTurnResult>;
}

let launcher: IDshSessionLauncher | undefined;

/** 由 dshHarness 的 electron-browser 贡献在启动早期注册。 */
export function setDshSessionLauncher(l: IDshSessionLauncher | undefined): void {
	launcher = l;
}

export function getDshSessionLauncher(): IDshSessionLauncher | undefined {
	return launcher;
}
