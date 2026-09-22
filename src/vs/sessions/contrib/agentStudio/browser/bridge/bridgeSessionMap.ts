/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 会话→专属 Agent 会话映射持久化 ───────────────────────────────
// 解决「渠道群消息复用 agent 最近活跃会话」的串台问题：
// 每个 platform+conversationId（群 chat_id）固定映射到一条**专属** Agent 会话，
// 群消息永远进这条会话（不存在则新建），不再随 getOrCreateActiveSession 漂移。
// fs 落盘实现（<workDir>/sessionMap.json）；不可用时退化为内存态。

import { ILogService } from "../../../../../platform/log/common/log.js";
import { nodeRequire } from "../rendererNodeRequire.js";

/** 会话→专属 Agent 会话映射存储接口。 */
export interface IConversationSessionStore {
	/** 读取某平台某会话 id 映射的专属 Agent 会话（未映射返回 undefined）。 */
	get(platform: string, conversationId: string): { agentId: string; agentSessionId: string } | undefined;
	/** 写入映射（覆盖式，持久化）。 */
	set(platform: string, conversationId: string, agentId: string, agentSessionId: string): void;
	/** 删除映射（换绑/解绑/会话被删时调用）。 */
	clear(platform: string, conversationId: string): void;
	/** 列出某平台全部映射（UI 绑定列表/标识用）。 */
	list(platform: string): Array<{ conversationId: string; agentId: string; agentSessionId: string }>;
}

/** 映射持久化文件名（相对 workDir）。 */
export const BRIDGE_SESSION_MAP_FILE = "sessionMap.json";

interface SessionMapFile {
	// platform -> conversationId -> { agentId, agentSessionId }
	[platform: string]: { [conversationId: string]: { agentId: string; agentSessionId: string } };
}

/**
 * 构造基于 fs 的映射存储。fs/path 不可用或 workDir 为空时返回 undefined
 * （调用方退化为内存态）。
 */
export function createFileSessionMapStore(
	workDir: string | undefined,
	log: ILogService,
): IConversationSessionStore | undefined {
	const fs = nodeRequire("fs");
	const pathMod = nodeRequire("path");
	if (!fs || !pathMod || !workDir) {
		return undefined;
	}

	let absDir: string;
	try {
		absDir = pathMod.resolve(workDir);
	} catch {
		absDir = workDir;
	}
	const filePath = pathMod.join(absDir, BRIDGE_SESSION_MAP_FILE);

	let cache: SessionMapFile = {};
	let loaded = false;

	const load = (): void => {
		if (loaded) {
			return;
		}
		loaded = true;
		try {
			if (fs.existsSync(filePath)) {
				const raw = fs.readFileSync(filePath, "utf8");
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === "object") {
					cache = parsed as SessionMapFile;
				}
			}
		} catch (err) {
			log.error(`[BridgeSessionMap] load '${filePath}' failed:`, err);
		}
	};

	const save = (): void => {
		try {
			fs.mkdirSync(absDir, { recursive: true });
			fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), "utf8");
		} catch (err) {
			log.error(`[BridgeSessionMap] save '${filePath}' failed:`, err);
		}
	};

	return {
		get(platform: string, conversationId: string) {
			load();
			return cache[platform]?.[conversationId];
		},
		set(platform: string, conversationId: string, agentId: string, agentSessionId: string) {
			load();
			if (!cache[platform]) {
				cache[platform] = {};
			}
			cache[platform][conversationId] = { agentId, agentSessionId };
			save();
		},
		clear(platform: string, conversationId: string) {
			load();
			if (cache[platform]?.[conversationId]) {
				delete cache[platform][conversationId];
				save();
			}
		},
		list(platform: string) {
			load();
			const m = cache[platform] ?? {};
			return Object.entries(m).map(([conversationId, v]) => ({ conversationId, agentId: v.agentId, agentSessionId: v.agentSessionId }));
		},
	};
}

/** 内存态映射存储（无 fs 时兜底，重启即丢失）。 */
export function createMemorySessionMapStore(): IConversationSessionStore {
	const data: SessionMapFile = {};
	return {
		get(platform, conversationId) {
			return data[platform]?.[conversationId];
		},
		set(platform, conversationId, agentId, agentSessionId) {
			if (!data[platform]) {
				data[platform] = {};
			}
			data[platform][conversationId] = { agentId, agentSessionId };
		},
		clear(platform, conversationId) {
			if (data[platform]?.[conversationId]) {
				delete data[platform][conversationId];
			}
		},
		list(platform) {
			const m = data[platform] ?? {};
			return Object.entries(m).map(([conversationId, v]) => ({ conversationId, agentId: v.agentId, agentSessionId: v.agentSessionId }));
		},
	};
}
