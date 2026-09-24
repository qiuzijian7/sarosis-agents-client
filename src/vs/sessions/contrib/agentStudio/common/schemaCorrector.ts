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
 * ## 2026-09-24 重做：交叉提示改成「**可用才加**」，且那句话只此一处
 *
 * 此前是两半各持一份**同一个字符串**的字面量：
 *   · `browserTools.ts` 把它**无条件**拼进 `browser_navigate` 的描述（常量 `BROWSER_NAVIGATE_WEB_HINT`）；
 *   · 本模块在 web 工具"不可用"时**按原文字符串精确匹配**删掉它。
 * 两个毛病：**两处字面量**（漂移即静默失效 —— 那个常量的注释自己就写着"改这句必须同改 schemaCorrector"）；
 * 而且"先写进去、再删掉"是 **fail-unsafe** 的：少跑一次修正、或差一个字符，模型就会看到指向不存在工具的
 * 引用 —— 正是本模块存在的理由。
 *
 * 现在：那句话只声明在 `TOOL_REFERENCE_HINTS`；规则是**被引用的工具全部可用才加上**，否则确保它不出现
 * （`ensureMentioned` 两个方向都幂等）。于是"提到不可用工具"这个状态**构造上不可能出现** ——
 * 万一本模块没被调用，代价只是"少一句提示"，而不是"指向空气的引用"。
 *
 * ## 调用点也挪了：必须在 assembly **之前**（`agentToolAssembly.ts` 的 Step 3.9）
 *
 * 原先在 assembly **之后**（Step 7）跑，可用性取自直发列表，于是有两处缺陷：
 *   ① **deferred ≠ 不可用**。工具可用性是"在**启用集合**里"；而在 tool_search 桥接下，大量工具
 *      **不在直发列表**却仍能被 `tool_search → tool_describe → tool_call` 调到。于是"web_search
 *      只是被延后"会被误判成"不可用"，把这句提示删掉 —— 恰好在**大上下文**（延后更常见）的会话里
 *      丢掉它。
 *   ② 工具搜索目录与 `tool_describe` 返回的是 `assembly.deferredDefs`，而 dispatcher context 在
 *      Step 7 **之前**就已建好 ⇒ 那句话**不经过本模块**，桥接路径上的"指向不存在工具"无从修正。
 *
 * 挪到 assembly 之前，两件事一起解决：输入就是**启用集合**（延后也算可用），且修正后的定义同时进入
 * 直发列表与 tool_search 目录。
 *
 * ⚠ 不要把它挪回 assembly 之后（Step 7 那个位置）—— 上面两条会同时复发。
 */

import { IToolDefinition } from './providers.js';

// ─── 交叉提示：一句话的唯一来源 ───────────────────────────────────────────────

/**
 * 工具描述里对**别的工具**的引用（交叉提示）。
 *
 * 进入本表的唯一理由：这句话提到的工具**可能不可用**。任何"提到别的工具但不会单独消失"的话
 * （例如 `browser_snapshot` 提到 `browser_click` —— 它们由同一个 `available()` 同生共死）
 * 不需要进来。
 */
export interface IToolReferenceHint {
	/** 承载这句话的工具：描述属于它。 */
	readonly owner: string;
	/** 被这句话引用的工具：**全部**可用时才加上（缺一个就整句不加）。 */
	readonly referenced: readonly string[];
	/**
	 * 那句话本身 —— **全仓唯一定义**。
	 *
	 * ⚠ 不要在别的文件里再抄一份（历史教训：抄了就会漂移，漂移就静默失效）。
	 * 以空格开头：它是**直接接在描述末尾**的，调用方不再另加分隔符。
	 */
	readonly text: string;
}

export const TOOL_REFERENCE_HINTS: readonly IToolReferenceHint[] = [
	{
		owner: 'browser_navigate',
		referenced: ['web_search', 'web_extract'],
		text: ' For simple information retrieval, prefer web_search or web_extract (faster, cheaper).',
	},
];

/**
 * 幂等地让 `description` **恰好**满足"该不该提这句话"。
 *
 *   · `shouldMention = true`  → 没有就补在末尾；**已经有一份就不动**（不重复拼、也不换对象）
 *   · `shouldMention = false` → 有就删掉（连它前面那个空格一起，不留下尾随空白）
 *
 * ⚠ 幂等是硬要求：本函数每次工具装配都会跑，重复拼接会把描述越撑越长 —— 而且首轮之后没人会注意到。
 */
export function ensureMentioned(description: string, text: string, shouldMention: boolean): string {
	const mentioned = description.includes(text);
	if (mentioned === shouldMention) { return description; }
	return shouldMention
		? `${description.trimEnd()}${text}`
		: description.replace(text, '').trimEnd();
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 修正工具列表里**对其他工具的引用**。
 *
 * @param tools 工具定义列表（可用性已过滤完；改动项按 index 就地替换）
 * @returns 修正后的列表（**同一引用**）
 */
export function correctSchemaReferences<T extends IToolDefinition>(tools: T[]): T[] {
	const availableNames = new Set(tools.filter(t => !!t && !!t.name).map(t => t.name));

	for (let i = 0; i < tools.length; i++) {
		const td = tools[i];
		if (!td || !td.name) { continue; }

		// ① 交叉提示：被引用的工具全可用才加上这句话，否则确保它不出现。
		//    那句话本身只声明在 TOOL_REFERENCE_HINTS 里（见文件头）。
		const hint = TOOL_REFERENCE_HINTS.find(h => h.owner === td.name);
		if (hint && td.description) {
			const shouldMention = hint.referenced.every(name => availableNames.has(name));
			const newDesc = ensureMentioned(td.description, hint.text, shouldMention);
			if (newDesc !== td.description) {
				tools[i] = { ...td, description: newDesc };
			}
		}

		// ② execute_code 的 sandbox 工具列表（对齐 Hermes `_build_execute_code_schema` 的思路）。
		//
		// ⚠ **当前从不触发**：`execute_code` 的定义里没有 `properties.sandbox`
		// （bundledTools.ts 里它的参数只有 code / timeout）。保留它是因为 Hermes 那侧的 execute_code
		// 确实带 sandbox 列表，本仓若补上就自动生效；行为由单测用**合成定义**钉住。
		if (td.name === 'execute_code' && td.inputSchema) {
			const schema = td.inputSchema as Record<string, any>;
			const props = schema.properties;
			if (props && typeof props === 'object') {
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
