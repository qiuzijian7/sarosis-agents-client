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
 * 「## Web Search Strategy」段的**可见性联动**版本（同一病灶的第三例，2026-10-12）。
 *
 * 前两例（`tool_search` / `tool_describe`）已由 `buildCompactToolSection` 里的
 * `bridgeVisible` 联动修掉，**但既有守卫只盯那两个名字** ⇒ 抓不到这一段：它原先**无条件**
 * 点名 `web_search` / `read_skill` / `execute_code` / `web_extract` ✗。被 focus 模式剪掉
 * 或 agent 配 `excludedTools` 时，提示词仍在教模型调一个**没下发的工具** ——
 * 与那两例同因同果（模型据此调用 ⇒ 未知工具或幻觉）✗。
 *
 * 两条设计约束：
 * · **不引入新入参**：`buildCompactToolSection` 本来就有 `toolNames`（已按 focus/toolset/
 *   hardPermission 过滤）⇒ 直接用它 ✓；
 * · **不破坏冻结前缀的字节稳定**：被 gate 的都是 **builtin** 工具（可见性由 agent 配置决定，
 *   会话内不变），且本段不点名任何 MCP 工具 ⇒ 同一会话内输出恒定 ✓。
 *
 * 返回**行数组**（含 `##` 标题）；一个检索工具都没有时返回空数组 ⇒ 整段不出现 ✓。
 * 规则**动态重新编号**：gate 掉规则 1 后，anysearch 就是第 1 条（否则模型看到的编号会跳号 ✗）。
 */
export function buildRetrievalStrategyLines(visibleToolNames: ReadonlyArray<string>): string[] {
	const has = (name: string) => visibleToolNames.includes(name);
	const webSearch = has('web_search');
	const webExtract = has('web_extract');
	const anysearch = has('read_skill') && has('execute_code');
	// 规则 4 自带条件措辞（"if one is available to you"）且**不点名具体工具** ⇒ 不 gate：
	// 它不可能让模型去调一个不存在的工具名 ✓。
	const bodies: string[] = [];
	if (webSearch) {
		bodies.push('**Latest/current facts, news, or an ordinary question** → call the built-in `web_search` directly. One call, no extra runtime dependency.');
	}
	if (anysearch) {
		bodies.push('**Structured identifiers or domain-specific data** (stock quotes, papers, laws, weather, flights/hotels, code docs, social posts) → use the **anysearch** skill, which covers 17 vertical domains plus parallel batch search. Its CLI lives in the anysearch skill directory (NOT the workspace root), so run it via `execute_code` with cwd set to that skill directory: first `read_skill("anysearch")` to get its `skillDir` (absolute path), then run `python3 scripts/anysearch_cli.py doc` (command spec) and `python3 scripts/anysearch_cli.py search "your query"` with `cwd=<skillDir>`.');
	}
	if (webExtract) {
		bodies.push('**A specific URL is already known** → `web_extract` to read that page.');
	}
	bodies.push('**Login-gated page, JS-rendered SPA, or page interaction is required** → a browser tool, if one is available to you.');
	// 规则 5 说"切换到**另一个**工具"⇒ 至少要有两条路径，否则这句话自相矛盾 ✗
	const paths = [webSearch, anysearch, webExtract].filter(Boolean).length;
	if (paths >= 2) {
		bodies.push('**Fallback**: if the chosen path fails (API error, timeout, runtime unavailable for anysearch; network failure for `web_search`), do NOT retry the same failing command. Switch to the other tool **once** to complete the search, and note the fallback in your answer.');
	}
	if (paths === 0) {
		return [];   // 一个检索工具都没有 ⇒ 整段不出现（连标题也不出现）✓
	}
	const lines: string[] = [
		'## Web Search Strategy',
		'',
		'Choose the retrieval path by the FIRST rule that matches. Do NOT default to the heaviest one:',
		'',
		...bodies.map((b, i) => `${i + 1}. ${b}`),
	];
	// 这段对比只在**两条路径都在**时成立（少一条就是自相矛盾：让模型"别跳到规则 2"，而规则 2 不存在 ✗）
	if (webSearch && anysearch) {
		lines.push('', 'Do not skip rule 1 to reach rule 2 for an ordinary query: anysearch costs an extra `read_skill` round-trip plus an `execute_code` subprocess, which only pays off in the vertical-domain and batch cases above.');
	}
	return lines;
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

/** {@link buildCompactToolSection} 的可选配置。 */
export interface ICompactToolSectionOptions {
	/**
	 * 工具检索桥接（`tool_search` / `tool_describe` / `tool_call`）是否在本轮**下发集**里。
	 *
	 * 缺省 **true** ⇒ 字节与加本参数之前完全一致（缓存对齐 + 老调用点/既有单测不回归 ✓）。
	 *
	 * 为什么要这个开关：`assembleToolDefs` 在 `allDeferrable.length === 0` 时**提前返回
	 * 且不附桥接工具**（`toolSearchAssembler.ts:395-404`）—— 只开 core / Always 工具集的
	 * 会话里根本没有这三个工具，而本段此前**无条件**教模型"用 tool_search 发现 MCP 工具"
	 * ⇒ 指向一个不存在的工具（正是本段反幻觉规则在防的那类失败 ✗）。
	 * 对齐官方做法：工具相关指引按**该工具是否可见**生成。
	 */
	readonly bridgeVisible?: boolean;
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
 * @param options 见 {@link ICompactToolSectionOptions}；省略 ⇒ 与历史字节一致。
 * @returns 完整段落文本（含前后空行），可直接 push 到 stableParts
 */
export function buildCompactToolSection(
	toolNames: ReadonlyArray<string>,
	family: ModelFamily = 'generic',
	options: ICompactToolSectionOptions = {},
): string {
	const compactNames = [...toolNames].sort((a, b) => a.localeCompare(b)).join(', ');
	const bridgeVisible = options.bridgeVisible ?? true;
	return [
		'',
		'## Available Tools',
		'',
		'You have access to tools via the function-calling interface (their names and JSON schemas are provided with this request). When a user asks you to perform an action that requires interacting with the filesystem, executing commands, searching the web, or any other external system, you MUST use the appropriate tool instead of explaining that you cannot do it.',
		'',
		`Built-in tools: ${compactNames}`,
		// 可见性联动（2026-10-12）：桥接不在下发集里时**不得**再教它怎么用（也不点名，
		// 否则模型仍会照着历史/提示词去调一个不存在的工具）。用词刻意避开
		// `tool_search`，好让守卫能断言"不可见时整段不含该名字"。
		bridgeVisible
			? 'MCP tools are not listed here — discover them on demand via tool_search → tool_describe → tool_call.'
			: 'MCP tools are not listed here. This session has NO tool-discovery bridge, so ONLY the built-in tools listed above are available — do not attempt to call tools that are not listed.',
		'',
		'## General Tool Usage',
		'',
		'When a specialized tool exists, use it directly. Do not simulate or manually reimplement what a tool does by chaining basic operations.',
		// ★ 同一处病灶的第二例（由上文那条守卫当场抓出 ✗→✓）：这里也**无条件**提了
		// `tool_describe`。桥接不可见时它同样指向一个没下发的工具 ⇒ 一并按可见性联动。
		bridgeVisible
			? 'Review each tool\'s description (via the function-calling schema or tool_describe) to understand its capabilities and use the most efficient one.'
			: 'Review each tool\'s description (via the function-calling schema) to understand its capabilities and use the most efficient one.',
	// 工具调用格式按模型族分发（真源 modelFamilyPrompt.ts）：原生 FC 可靠的族不再
	// 下发「不支持就打印 JSON」的退路 —— 那句对在用模型都不成立，且与下面反幻觉
	// 第 1 条自相矛盾（授权模型把 tool call 打印出来，而打印出来的不会被执行）。
	buildToolCallFormatDirective(family),
	'',
	// ★ 2026-09-24：从「无条件 PREFER anysearch」改为「按序短路的检索决策规则」。
	// 旧措辞的实测代价：任何 agent 想搜一次网都必须走 read_skill → execute_code 起
	// python 子进程（路径长、依赖少一个运行时即失败），而 anysearch 的增量收益
	// （17 个垂直域、batch_search 并行）只体现在长尾查询上 —— 属于「用最重路径覆盖
	// 最常见场景」。规则化后默认路径回到 1 次工具调用，anysearch 只在其真正更强的
	// 场景（结构化标识符 / 垂直域）介入，且每一步都保留一次性降级 + 留痕纪律。
	// ★ 2026-10-12（同一病灶的第三例）：本段原先**无条件**点名 web_search / read_skill /
	//   execute_code / web_extract ⇒ 工具被 focus 剪掉、或 agent 配了 excludedTools 时，
	//   提示词仍在教模型调一个**没下发的工具** ✗（前两例 tool_search / tool_describe 已修，
	//   但那条守卫只盯那两个名字，抓不到这一段）。现按**入参里已有的** `toolNames`（已按
	//   focus / toolset / hardPermission 过滤 ✓ 无需新增穿线）逐条 gate + 动态重编号，
	//   一个检索工具都没有时整段不出现 ✓（详见 `buildRetrievalStrategyLines` 的注释）。
	...buildRetrievalStrategyLines(toolNames),
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
