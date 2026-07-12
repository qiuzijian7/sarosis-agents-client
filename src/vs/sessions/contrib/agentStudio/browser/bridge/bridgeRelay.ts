/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── Relay 编排（P3，对齐 cc-connect `relay send` 的 bot↔bot 语义）──
// 进程内实现：把一条内容发给目标 Agent（独立会话，不污染源会话），取其纯文本回复返回。
// 支持串行 pipeline（relayChain：a → b → c）。

import { ILogService } from "../../../../../platform/log/common/log.js";
import { IAgentChatService } from "../../common/agentStudio.js";
import type { ChatMode } from "../../../../../sessions/common/agentStudioService.js";
import { IChatStreamDelta } from "../../common/agentStudio.js";

export interface RelayOptions {
	readonly chatMode?: string;
	readonly model?: string;
}

export class BridgeRelay {
	private readonly _chat: IAgentChatService;
	private readonly _log: ILogService;

	constructor(chat: IAgentChatService, log: ILogService) {
		this._chat = chat;
		this._log = log;
	}

	/**
	 * 把 content 发给 toAgentId（独立 relay 会话），收集纯文本回复返回。
	 * 对应 cc-connect `relay send --to <bot> --message <text>` 的响应等待。
	 */
	async relay(fromSessionKey: string, toAgentId: string, content: string, opts?: RelayOptions): Promise<string> {
		// 独立会话，避免复用用户当前活动会话造成历史污染。
		const created = await this._chat.createAgentSession(toAgentId, `relay:${fromSessionKey}`);
		let text = "";
		try {
			await this._chat.sendMessage(
				toAgentId,
				content,
				{
					agentSessionId: created.id,
					chatMode: (opts?.chatMode ?? "craft") as ChatMode,
					model: opts?.model,
					source: "user" as const,
				},
				(delta: IChatStreamDelta) => {
					if (delta.type === "text" && delta.content) {
						text += delta.content;
					}
				},
			);
		} catch (err) {
			this._log.error(`[BridgeRelay] relay to ${toAgentId} failed:`, err);
			return `（relay 到 ${toAgentId} 失败：${String(err)}）`;
		}
		return text;
	}

	/**
	 * 串行编排：把 content 依次发给 agentIds 链，上一步的回复作为下一步的输入。
	 * 对应 `relay send --to a>b>c`。返回最后一步的回复。
	 */
	async relayChain(fromSessionKey: string, agentIds: string[], content: string, opts?: RelayOptions): Promise<string> {
		let acc = content;
		for (const id of agentIds) {
			acc = await this.relay(fromSessionKey, id, acc, opts);
		}
		return acc;
	}
}
