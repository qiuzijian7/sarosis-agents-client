/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 会话→Agent 绑定持久化（对齐 cc-connect 的 conversation→bot 绑定）──
// fs 落盘实现（<workDir>/bindings.json）：platform → conversationId → agentId。
// 在 Electron renderer 中经 nodeRequire 安全访问 Node 内置 fs/path；不可用时返回 undefined，
// 调用方据此退化为内存态（createMemoryBindingStore）。

import { ILogService } from "../../../../../platform/log/common/log.js";
import { nodeRequire } from "../rendererNodeRequire.js";

/** 会话→Agent 绑定存储接口。 */
export interface IConversationBindingStore {
	/** 读取某平台某会话 id 绑定的 Agent（未绑定返回 undefined）。 */
	getBinding(platform: string, conversationId: string): string | undefined;
	/** 绑定某平台某会话 id 到指定 Agent（覆盖式，持久化）。 */
	setBinding(platform: string, conversationId: string, agentId: string): void;
	/** 解除某平台某会话 id 的绑定。 */
	clearBinding(platform: string, conversationId: string): void;
	/** 列出某平台所有会话→Agent 绑定。 */
	listBindings(platform: string): Array<{ conversationId: string; agentId: string }>;
}

/** 绑定持久化文件名（相对 workDir）。 */
export const BRIDGE_BINDINGS_FILE = "bindings.json";

interface BindingsFile {
	// platform -> conversationId -> agentId
	[platform: string]: { [conversationId: string]: string };
}

/**
 * 构造基于 fs 的绑定存储。fs/path 不可用或 workDir 为空时返回 undefined
 * （调用方退化为内存态）。
 */
export function createFileBindingStore(
	workDir: string | undefined,
	log: ILogService,
): IConversationBindingStore | undefined {
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
	const filePath = pathMod.join(absDir, BRIDGE_BINDINGS_FILE);

	let cache: BindingsFile = {};
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
					cache = parsed as BindingsFile;
				}
			}
		} catch (err) {
			log.error(`[BridgeBindings] load '${filePath}' failed:`, err);
		}
	};

	const save = (): void => {
		try {
			fs.mkdirSync(absDir, { recursive: true });
			fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), "utf8");
		} catch (err) {
			log.error(`[BridgeBindings] save '${filePath}' failed:`, err);
		}
	};

	return {
		getBinding(platform: string, conversationId: string): string | undefined {
			load();
			return cache[platform]?.[conversationId];
		},
		setBinding(platform: string, conversationId: string, agentId: string): void {
			load();
			if (!cache[platform]) {
				cache[platform] = {};
			}
			cache[platform][conversationId] = agentId;
			save();
		},
		clearBinding(platform: string, conversationId: string): void {
			load();
			if (cache[platform]?.[conversationId]) {
				delete cache[platform][conversationId];
				save();
			}
		},
		listBindings(platform: string): Array<{ conversationId: string; agentId: string }> {
			load();
			const m = cache[platform] ?? {};
			return Object.entries(m).map(([conversationId, agentId]) => ({ conversationId, agentId }));
		},
	};
}

/** 内存态绑定存储（无 fs 时兜底，重启即丢失）。 */
export function createMemoryBindingStore(): IConversationBindingStore {
	const data: BindingsFile = {};
	return {
		getBinding(platform, conversationId) {
			return data[platform]?.[conversationId];
		},
		setBinding(platform, conversationId, agentId) {
			if (!data[platform]) {
				data[platform] = {};
			}
			data[platform][conversationId] = agentId;
		},
		clearBinding(platform, conversationId) {
			if (data[platform]?.[conversationId]) {
				delete data[platform][conversationId];
			}
		},
		listBindings(platform) {
			const m = data[platform] ?? {};
			return Object.entries(m).map(([conversationId, agentId]) => ({ conversationId, agentId }));
		},
	};
}
