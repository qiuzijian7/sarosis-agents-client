/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 分层系统提示词组合器（对齐 MiMo-Code / Hermes-Agent / CodeBuddy 的缓存对齐设计）。
 *
 * 背景：历史上 driver 把 persona、工具清单、技能目录、记忆指引等全部拼成一个
 * 可达 101K+ 字符的 `systemPrompt` blob，再在 executor 端用「保留头 35% + 尾 65%」
 * 的粗暴裁剪压到 15K —— 既腰斩了 persona/指令连续性，又因每次裁剪 marker 内容
 * 不同而彻底打破 provider 的 prompt 前缀缓存。
 *
 * 本模块把系统提示词拆成三层，按「可变性」排序（稳定在前、易变在后）：
 *
 *   - stable   — 字节稳定前缀：agent persona + 全局前/后缀 + 工具使用与反幻觉
 *                行为规则。会话内对同一 agent 不变。
 *   - context  — 会话稳定发现层：workspace 上下文 + 技能目录 + MCP 摘要 +
 *                记忆捕获指引。会话内稳定，但跨会话/跨工作区可变。
 *   - volatile — 易变层：Persona Memory + 本轮激活技能。每轮可变。
 *
 * 「冻结前缀」= stable + context，作为第一条 system 消息发送，保证字节稳定 →
 * provider prompt cache 命中。volatile 层作为独立 system 消息追加在前缀之后，
 * 不参与前缀指纹，其变化只影响自身位置之后的缓存，不打断前缀。
 *
 * 纯函数、无依赖 → 可单测。
 */

import { buildToolCallFormatDirective, buildOutputFormatRule, type ModelFamily } from './modelFamilyPrompt.js';

/** 三层系统提示词。 */
export interface ISystemPromptTiers {
	/** 字节稳定前缀（persona + 全局边界 + 行为规则）。 */
	readonly stable: string;
	/** 会话稳定发现层（workspace / 技能目录 / MCP / 记忆捕获指引）。 */
	readonly context: string;
	/** 易变层（Persona Memory + 本轮激活技能）。 */
	readonly volatile: string;
}

/**
 * 用空行拼接若干段落，自动跳过空白段。保证输出确定性（相同输入 → 相同字节）。
 */
export function joinSections(...parts: ReadonlyArray<string | undefined>): string {
	return parts
		.map((p) => (p ?? '').trim())
		.filter((p) => p.length > 0)
		.join('\n\n');
}

/**
 * 合成「冻结前缀」：stable + context。这是发给模型的第一条 system 消息，
 * 也是 fork 前缀缓存指纹的计算对象。保持字节稳定是缓存命中的前提。
 */
export function composeFrozenPrefix(tiers: ISystemPromptTiers): string {
	return joinSections(tiers.stable, tiers.context);
}

/**
 * 取出易变层（若有）。作为独立 system 消息追加在冻结前缀之后，不进前缀指纹。
 * 返回 undefined 表示本轮无易变内容。
 */
export function composeVolatileMessage(tiers: ISystemPromptTiers): string | undefined {
	const v = tiers.volatile.trim();
	return v.length > 0 ? v : undefined;
}

/**
 * 构建「压缩工具清单」段落（stable 层）。
 *
 * P0 关键：历史上 driver 把每个工具的「名称 + 大段描述」逐项拼成 system 文本，
 * 这是 101K blob 的主因之一。结构化 tools schema 已随 function-calling 接口单独
 * 下发（IModelOptions.tools），文本大列表纯属重复。本函数只保留：
 *   - 一行「名称清单」（供不支持 function-calling 的模型参考）
 *   - 行为规则（反幻觉 / 调用格式 / MCP 走 tool_search 桥接）
 *
 * @param toolNames 内置（非 MCP）工具名数组（顺序无关，函数内会排序保证确定性）
 * @param family 模型族（决定工具调用格式指令的措辞）。省略 → `generic`，
 *               字节与按族分发之前**完全一致**，保证未知模型/旧调用点不回归。
 * @returns 完整段落文本（含前后空行），可直接 push 到 stableParts
 */
export function buildCompactToolSection(toolNames: ReadonlyArray<string>, family: ModelFamily = 'generic'): string {
	const compactNames = [...toolNames].sort((a, b) => a.localeCompare(b)).join(', ');
	return [
		'',
		'## Available Tools',
		'',
		'You have access to tools via the function-calling interface (their names and JSON schemas are provided with this request). When a user asks you to perform an action that requires interacting with the filesystem, executing commands, searching the web, or any other external system, you MUST use the appropriate tool instead of explaining that you cannot do it.',
		'',
		`Built-in tools: ${compactNames}`,
		'MCP tools are not listed here — discover them on demand via tool_search → tool_describe → tool_call.',
		'',
		'## General Tool Usage',
		'',
		'When a specialized tool exists, use it directly. Do not simulate or manually reimplement what a tool does by chaining basic operations.',
		'Review each tool\'s description (via the function-calling schema or tool_describe) to understand its capabilities and use the most efficient one.',
	// 工具调用格式按模型族分发（真源 modelFamilyPrompt.ts）：原生 FC 可靠的族不再
	// 下发「不支持就打印 JSON」的退路 —— 那句对在用模型都不成立，且与下面反幻觉
	// 第 1 条自相矛盾（授权模型把 tool call 打印出来，而打印出来的不会被执行）。
	buildToolCallFormatDirective(family),
	'',
	'## Web Search Strategy',
	'',
	'For real-time / external web search, PREFER the **anysearch** skill (unified real-time search service) over the built-in `web_search` / `web_extract` tools. Its CLI lives in the anysearch skill directory (NOT the workspace root), so run it via `execute_code` with cwd set to that skill directory: first `read_skill("anysearch")` to get its `skillDir` (absolute path), then run `python3 scripts/anysearch_cli.py doc` (command spec) and `python3 scripts/anysearch_cli.py search "your query"` with `cwd=<skillDir>` (supports general web + vertical domains, richer results). If AnySearch fails (API error, timeout, runtime unavailable, or quota exhausted without a key), do NOT retry the same failing command — fall back to the built-in `web_search` / `web_extract` tools to complete the search, and note the fallback.',
	'',
	'## CRITICAL ANTI-HALLUCINATION RULES (MUST FOLLOW)',
		'',
		'1. **NEVER claim you have done something without actually calling a tool.** If the user asks you to create/modify/delete a file, run a command, or perform any side-effect, you MUST emit an actual tool call. Phrases like "文件已创建成功", "已完成", "I have created the file", "Done!" are STRICTLY FORBIDDEN unless they appear AFTER a real tool call returned a successful result.',
		'2. **NEVER fabricate tool execution.** Do not write narrative descriptions like "让我使用 file_write 工具" or "I will use the file_write tool" as a substitute for an actual tool call. Either emit the structured tool call, or do not claim the action was taken.',
		'3. **For ANY filesystem write / command execution / external side-effect: a tool call is MANDATORY.** No exceptions. If you cannot determine the correct tool or arguments, ask the user — do not pretend the action succeeded.',
		buildOutputFormatRule(family, 4),
		'5. **Do not narrate the tool call.** Do not write "I am calling file_write now" before emitting it. Just emit the tool call directly.',
		'6. **After a tool returns:** you may then summarize what happened in natural language, citing the actual tool result.',
		'',
	].join('\n');
}
