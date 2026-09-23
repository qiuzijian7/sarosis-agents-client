/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 渠道绑定状态的**渲染层**存储：内存缓存 + 主进程文件读写（IPC）。
 *
 * ## 背景（2026-09-23 修「重启后 chat_id 绑定丢失」）
 *
 * 旧的 `createFileBindingStore()` / `createFileSessionMapStore()` 依赖
 * `nodeRequire('fs')`，而桌面端渲染进程是沙箱 Chromium ⇒ 它在生产环境里**永远**返回
 * undefined（见 `rendererNodeRequire.ts` 的说明），于是 `BridgeEngine` 静默退化为
 * 内存 store，绑定重启即丢（用户报的就是这个）。
 *
 * 这里把文件读写挪到主进程（`electron-main/bridgeStoreChannel.ts`：
 * `<userData>/bridge/<file>`，与 cwd 无关），渲染层只保留：
 *   · 与旧实现一致的**同步读**语义（读内存缓存，接口不必改成异步 —— 引擎大量同步调用）；
 *   · 启动即**异步水合**（hydrate）一次，把磁盘内容并入缓存；
 *   · 写操作更新缓存后**防抖落盘**（避免每次绑定都打一次 IPC + 写盘）。
 *
 * 主进程通道不可用时（非 Electron / preload 未注入 / 通道未注册）返回 `undefined`，
 * 引擎沿用既有兜底（内存 store），不阻断任何渠道功能。
 */

import { ILogService } from '../../../../../platform/log/common/log.js';
import { nativeIpcBridge } from '../../common/configHtmlConfig.js';
import { BRIDGE_BINDINGS_FILE, type IConversationBindingStore } from './bridgeBindings.js';
import { BRIDGE_SESSION_MAP_FILE, type IConversationSessionStore } from './bridgeSessionMap.js';

/** 主进程 IPC 桥（测试可注入假实现）。 */
export interface IIpcStoreBridge {
	invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

/** 取默认桥（`globalThis.vscode` / `vscodeBridge`）；`invoke` 不可用时返回 undefined。 */
export function defaultIpcStoreBridge(): IIpcStoreBridge | undefined {
	const ipc = nativeIpcBridge()?.ipcRenderer;
	return ipc?.invoke ? (ipc as IIpcStoreBridge) : undefined;
}

/** 写盘防抖窗口（毫秒）。 */
export const BRIDGE_STORE_WRITE_DEBOUNCE_MS = 150;

/** 两层 Record（platform → conversationId → V）——两个 store 的文件结构都是这个形状。 */
export type TwoLevelRecord<V> = { [platform: string]: { [conversationId: string]: V } };

/**
 * 合并两层 Record。冲突（同一 platform+conversationId）时的优先级由 `policy` 决定：
 *
 *   · `'overlay'`（默认）—— 内存中刚发生的改动优先。
 *     适用**用户显式操作**：水合期间用户刚把某群绑到某 Agent，不能被磁盘旧值翻回去。
 *   · `'base'` —— 磁盘内容优先。
 *     适用**引擎自动写入**：会话映射（sessionMap）在启动瞬间可能因「还不知道已有映射」
 *     而给同一个群新建一条会话；若让内存优先，就会把已持久化的映射顶掉 ——
 *     这正是该映射本身要防的「串台」。磁盘上的那条才是用户此前的意图。
 */
export function mergeTwoLevel<V>(
	base: TwoLevelRecord<V>,
	overlay: TwoLevelRecord<V>,
	policy: 'overlay' | 'base' = 'overlay',
): TwoLevelRecord<V> {
	const out: TwoLevelRecord<V> = {};
	for (const platform of new Set([...Object.keys(base), ...Object.keys(overlay)])) {
		out[platform] = policy === 'base'
			? { ...(overlay[platform] ?? {}), ...(base[platform] ?? {}) }
			: { ...(base[platform] ?? {}), ...(overlay[platform] ?? {}) };
	}
	return out;
}

/** 水合冲突策略（见 mergeTwoLevel 注释）：用户显式操作 vs 引擎自动写入。 */
export type HydrateMergePolicy = 'overlay' | 'base';

interface IJsonFileStore<V> {
	readData(): TwoLevelRecord<V>;
	hydrate(): Promise<void>;
	scheduleSave(): void;
	saveNow(): Promise<void>;
}

/**
 * 通用 JSON 文件 store（主进程读写）：同步读缓存 + 异步水合 + 防抖落盘。
 * 桥不可用时返回 undefined。
 */
function createJsonFileStore<V>(
	fileName: string,
	log: ILogService,
	bridge: IIpcStoreBridge | undefined,
	hydratePolicy: HydrateMergePolicy = 'overlay',
): IJsonFileStore<V> | undefined {
	if (!bridge) { return undefined; }

	let data: TwoLevelRecord<V> = {};
	let hydrating: Promise<void> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;

	const saveNow = async (): Promise<void> => {
		// 立即落盘时取消待触发的防抖定时器：避免紧随其后多写一次（也让测试/关窗时机可预期）
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		dirty = false;
		try {
			const r = await bridge.invoke('vscode:bridgeStoreWrite', { file: fileName, json: JSON.stringify(data, null, 2) }) as { ok?: boolean; error?: string } | undefined;
			if (r && !r.ok) {
				log.error(`[BridgeStore] write ${fileName} failed: ${r.error ?? 'unknown'}`);
			}
		} catch (err) {
			// 主进程不可用：本次改动留在内存（与旧行为一致，不打断绑定操作）
			log.error(`[BridgeStore] write ${fileName} invoke failed:`, err);
		}
	};

	const hydrate = (): Promise<void> => {
		if (hydrating) { return hydrating; }
		hydrating = (async () => {
			try {
				const r = await bridge.invoke('vscode:bridgeStoreRead', { file: fileName }) as { ok?: boolean; json?: string; error?: string } | undefined;
				if (r?.ok && typeof r.json === 'string' && r.json) {
					const parsed = JSON.parse(r.json) as TwoLevelRecord<V>;
					if (parsed && typeof parsed === 'object') {
						// ★ 冲突策略见 mergeTwoLevel 注释（绑定=内存优先；会话映射=磁盘优先）
						data = mergeTwoLevel<V>(parsed, data, hydratePolicy);
					}
				} else if (r && !r.ok) {
					log.error(`[BridgeStore] read ${fileName} failed: ${r.error ?? 'unknown'}`);
				}
			} catch (err) {
				log.error(`[BridgeStore] read ${fileName} invoke failed:`, err);
			}
			// 水合前发生的改动（dirty）此时才真正落盘，避免被磁盘内容覆盖后丢失
			if (dirty) { await saveNow(); }
		})();
		return hydrating;
	};

	const scheduleSave = (): void => {
		dirty = true;
		if (timer) { clearTimeout(timer); }
		timer = setTimeout(() => {
			timer = undefined;
			void saveNow();
		}, BRIDGE_STORE_WRITE_DEBOUNCE_MS);
	};

	// 构造即水合（引擎在启动期构造，用户打开设置页时早已就绪）
	void hydrate();

	return {
		readData: () => data,
		hydrate,
		scheduleSave,
		saveNow,
	};
}

/** 带「等待水合 / 立即落盘」扩展的 store（启动时序与单测需要）。 */
export interface IIpcBindingStore extends IConversationBindingStore {
	hydrate(): Promise<void>;
	flushNow(): Promise<void>;
}

export interface IIpcSessionMapStore extends IConversationSessionStore {
	hydrate(): Promise<void>;
	flushNow(): Promise<void>;
}

/**
 * 会话→Agent 绑定存储（`<userData>/bridge/bindings.json`）。
 * 桥不可用时返回 undefined（引擎退化为内存 store）。
 */
export function createIpcBindingStore(
	log: ILogService,
	bridge: IIpcStoreBridge | undefined = defaultIpcStoreBridge(),
): IIpcBindingStore | undefined {
	const file = createJsonFileStore<string>(BRIDGE_BINDINGS_FILE, log, bridge);
	if (!file) { return undefined; }
	return {
		hydrate: () => file.hydrate(),
		flushNow: () => file.saveNow(),
		getBinding: (platform, conversationId) => file.readData()[platform]?.[conversationId],
		setBinding: (platform, conversationId, agentId) => {
			const data = file.readData();
			(data[platform] ??= {})[conversationId] = agentId;
			file.scheduleSave();
		},
		clearBinding: (platform, conversationId) => {
			const data = file.readData();
			if (data[platform]?.[conversationId] !== undefined) {
				delete data[platform][conversationId];
				file.scheduleSave();
			}
		},
		listBindings: (platform) => Object.entries(file.readData()[platform] ?? {})
			.map(([conversationId, agentId]) => ({ conversationId, agentId })),
	};
}

/**
 * 会话→专属 Agent 会话映射存储（`<userData>/bridge/sessionMap.json`）。
 * 桥不可用时返回 undefined（引擎退化为内存 store）。
 */
export function createIpcSessionMapStore(
	log: ILogService,
	bridge: IIpcStoreBridge | undefined = defaultIpcStoreBridge(),
): IIpcSessionMapStore | undefined {
	// ★ 会话映射用**磁盘优先**：引擎可能在启动瞬间给某群新建会话（尚不知已有映射），
	//   不能让这条新记录顶掉已持久化的映射（那正是「串台」）。
	const file = createJsonFileStore<{ agentId: string; agentSessionId: string }>(BRIDGE_SESSION_MAP_FILE, log, bridge, 'base');
	if (!file) { return undefined; }
	return {
		hydrate: () => file.hydrate(),
		flushNow: () => file.saveNow(),
		get: (platform, conversationId) => file.readData()[platform]?.[conversationId],
		set: (platform, conversationId, agentId, agentSessionId) => {
			const data = file.readData();
			(data[platform] ??= {})[conversationId] = { agentId, agentSessionId };
			file.scheduleSave();
		},
		clear: (platform, conversationId) => {
			const data = file.readData();
			if (data[platform]?.[conversationId]) {
				delete data[platform][conversationId];
				file.scheduleSave();
			}
		},
		list: (platform) => Object.entries(file.readData()[platform] ?? {})
			.map(([conversationId, v]) => ({ conversationId, agentId: v.agentId, agentSessionId: v.agentSessionId })),
	};
}
