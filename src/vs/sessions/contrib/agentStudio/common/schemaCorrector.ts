/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Schema 修正 — 参考 Hermes-Agent `model_tools.py:454-510`
 *
 * Hermes 的实现只有 2 个具体修正点（不是通用机制）：
 *   1. execute_code 重建：根据 sandbox 实际可用的工具重建 schema
 *   2. browser_navigate 描述修正：当 web_search/web_extract 不可用时删除对它们的引用
 *
 * 为什么需要：LLM 看到 description 中提到的工具，但实际上不可用 → 幻觉调用。
 * 修正后避免 LLM 浪费一轮迭代尝试调用不存在的工具。
 *
 * 集成点：在 `_getEnabledTools` 返回 finalTools 之前调用。
 */

import { IToolDefinition } from './providers.js';

/** Hermes-style 描述片段 — 出现在 browser_navigate 的 description 中 */
const HERMES_BROWSER_NAVIGATE_WEB_HINT =
	' For simple information retrieval, prefer web_search or web_extract (faster, cheaper).';

/**
 * 修正工具列表中的 schema 引用。
 * 对齐 Hermes `model_tools.py:454-510` 的真实实现。
 *
 * 当前实现：
 *   - browser_navigate: 当 web_search 或 web_extract 不可用时删除 description 中的 web 引用
 *   - execute_code: 重建 sandbox 工具列表（当 sandbox 工具不可用时）
 *
 * 未来扩展点：可以添加更多 Hermes-style 修正。
 *
 * @param tools 工具列表（in-place 修改 + 返回引用）
 * @returns 修正后的工具列表（同引用）
 */
export function correctSchemaReferences<T extends IToolDefinition>(tools: T[]): T[] {
		const nonNullTools = tools.filter((t): t is T => !!t && !!t.name);
		const availableNames = new Set(nonNullTools.map(t => t.name).filter(Boolean));

		for (let i = 0; i < tools.length; i++) {
		const td = tools[i];
		if (!td || !td.name) { continue; }

		// ① browser_navigate 描述修正（对齐 Hermes `model_tools.py:500-510`）
		if (td.name === 'browser_navigate' && td.description) {
			const hasWebSearch = availableNames.has('web_search');
			const hasWebExtract = availableNames.has('web_extract');
			if (!hasWebSearch || !hasWebExtract) {
				const newDesc = td.description.replace(HERMES_BROWSER_NAVIGATE_WEB_HINT, '').trimEnd();
				if (newDesc !== td.description) {
					tools[i] = { ...td, description: newDesc };
				}
			}
		}

		// ② execute_code 重建（简化版，对齐 Hermes `_build_execute_code_schema` 思路）
		// Hermes 在 sandbox 中允许调用所有 enabled 工具，Saros 当前没有 sandbox 工具列表
		// 配置。如果未来加入，需要重建 inputSchema.properties。
		// 这里是占位实现：清理不可用工具的引用。
		if (td.name === 'execute_code' && td.inputSchema) {
			const schema = td.inputSchema as Record<string, any>;
			const props = schema.properties;
			if (props && typeof props === 'object') {
				// 检查 sandbox 工具列表（如果存在）
				const sandbox = props.sandbox;
				if (sandbox && typeof sandbox === 'object' && Array.isArray(sandbox.default)) {
					const filtered = sandbox.default.filter((toolName: unknown) =>
						typeof toolName === 'string' && availableNames.has(toolName)
					);
					if (filtered.length !== sandbox.default.length) {
						tools[i] = {
							...td,
							inputSchema: {
								...schema,
								properties: {
									...props,
									sandbox: { ...sandbox, default: filtered },
								},
							},
						};
					}
				}
			}
		}
	}

	return tools;
}
