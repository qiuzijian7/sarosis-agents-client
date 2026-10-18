/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE 能力的**授权**：反向通道 `ide.request` 的第一道闸（协议 v2）。
 *
 * 为什么单独成模块：反向通道是"Host 里的插件驱动 IDE"的通道——放行面决定了它能做什么，所以判定必须
 * **纯函数 + 可单测**，而不是散在通道实现的 `if` 里。规则（全部默认拒绝）：
 *
 * 1. `capability` 必须是清单白名单里的名字（`VSSAROS_IDE_CAPABILITIES`，与 `vssaros.ideCapabilities` 同一份）；
 * 2. 请求必须带 `pluginId`，且**该插件已安装在 profile 里**；
 * 3. 该插件的清单里必须**声明过**这个能力（逐插件授权，不是"某个插件声明过就全局放行"）。
 *
 * 第 3 条是这套设计的意义所在：能力声明写在**插件自己的** `vssaros.ideCapabilities` 里，
 * 于是"这个插件能驱动 IDE 到什么程度"在安装那一刻就是可见、可审的。
 */

import { DshBridgeErrorCode, isVssarosIdeCapability } from './dshBridgeProtocol.js';
import { isBuiltinPluginName, tryParseVssarosManifest, VssarosIdeCapability } from './vssarosPluginManifest.js';

/** 一个插件声明的 IDE 能力。 */
export interface IIdeCapabilityDeclaration {
	readonly pluginId: string;
	readonly capabilities: readonly VssarosIdeCapability[];
}

/** 授权判定结果。 */
export type IIdeAuthorization =
	| { readonly allowed: true; readonly declaration: IIdeCapabilityDeclaration }
	| { readonly allowed: false; readonly code: number; readonly reason: string };

/** {@link readCapabilityDeclarations} 的可选参数。 */
export interface IReadCapabilityDeclarationsOptions {
	/**
	 * 判定某个包名是不是 **VsSaros 自己的内置模块插件**（缺省 {@link isBuiltinPluginName}）。
	 *
	 * ★ 2026-10-17 真机事故：这里原先**不带任何 options** 解析，于是内置模块插件被按
	 *   **第三方**规则校验 —— `activityBar.order` 90/80/60/5 全部越界、`containerId`
	 *   `vssaros.dsh.*` 命中"常驻命名空间"禁令 ⇒ 整份清单判废 ⇒ **该插件零 IDE 能力** ⇒
	 *   所有「在 IDE 打开」类反向调用被主进程拒绝（`插件未安装或没有可读清单：@vssaros/dsh-workflow`），
	 *   而工作流页面只会在**页尾那一行小红字**里报出来（用户看到的就是"点了没反应"）。
	 *   同一个文件的 `_readPluginManifest` 一直传 `builtin`，只有这条授权读取漏了。
	 */
	readonly isBuiltin?: (pluginId: string) => boolean;
}

/**
 * 从"插件名 → `package.json` 内容"抽出各家声明的 IDE 能力。
 * 读不了/坏清单 ⇒ 该插件**零能力**（同时留一条 note 给日志），绝不因此放行。
 */
export function readCapabilityDeclarations(manifests: ReadonlyMap<string, unknown>, options: IReadCapabilityDeclarationsOptions = {}): { declarations: Map<string, IIdeCapabilityDeclaration>; notes: string[] } {
	const declarations = new Map<string, IIdeCapabilityDeclaration>();
	const notes: string[] = [];
	const isBuiltin = options.isBuiltin ?? isBuiltinPluginName;
	for (const [pluginId, json] of manifests) {
		const parsed = tryParseVssarosManifest((json as { vssaros?: unknown } | undefined)?.vssaros, { pluginName: pluginId, builtin: isBuiltin(pluginId) });
		if (parsed.manifest === undefined) {
			// 没有 `vssaros` 清单 = 不是模块插件（如伴生插件）：零能力，不是错误
			if (/清单必须是对象/.test(parsed.error) && (json as { vssaros?: unknown } | undefined)?.vssaros === undefined) {
				continue;
			}
			notes.push(`${pluginId} 的清单读不了（${parsed.error}）⇒ 视为零 IDE 能力`);
			continue;
		}
		declarations.set(pluginId, { pluginId, capabilities: parsed.manifest.ideCapabilities ?? [] });
	}
	return { declarations, notes };
}

/**
 * 判定一次 `ide.request` 是否放行。**默认拒绝**：任何一条规则不满足都给出可读原因。
 */
export function authorizeIdeRequest(request: { readonly capability?: unknown; readonly pluginId?: unknown }, declarations: ReadonlyMap<string, IIdeCapabilityDeclaration>): IIdeAuthorization {
	if (!isVssarosIdeCapability(request.capability)) {
		return { allowed: false, code: DshBridgeErrorCode.MethodNotFound, reason: `未知的 IDE 能力：${String(request.capability)}` };
	}
	const pluginId = typeof request.pluginId === 'string' ? request.pluginId.trim() : '';
	if (!pluginId) {
		// 逐插件授权的前提是知道"谁在问"——缺它就无从查声明，只能拒。
		return { allowed: false, code: DshBridgeErrorCode.Internal, reason: 'ide.request 必须带 pluginId（逐插件授权需要知道调用方）' };
	}
	const declaration = declarations.get(pluginId);
	if (!declaration) {
		return { allowed: false, code: DshBridgeErrorCode.Internal, reason: `插件未安装或没有可读清单：${pluginId}` };
	}
	if (!declaration.capabilities.includes(request.capability)) {
		return {
			allowed: false,
			code: DshBridgeErrorCode.Internal,
			reason: `插件 ${pluginId} 未声明能力 ${request.capability}（清单 vssaros.ideCapabilities 里没有；已声明：${declaration.capabilities.join(', ') || '无'}）`,
		};
	}
	return { allowed: true, declaration };
}
