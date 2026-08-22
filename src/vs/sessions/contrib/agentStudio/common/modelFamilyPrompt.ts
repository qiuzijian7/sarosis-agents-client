/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 按模型族分发提示词片段（对齐 opencode `session/system.ts::provider()` 的思路，
 * 但**刻意不照抄其实现方式**）。
 *
 * ## 为什么不照抄 opencode
 * opencode 为每个模型族准备一份**完整**系统提示词（`prompt/anthropic.txt` 8.1KB、
 * `gpt.txt` 9.2KB、`gemini.txt` 15.2KB…共 10 份），按 `model.api.id` 子串整份替换。
 * 这在本项目不可行也不必要：
 *   · 我们的 persona 来自 **Agent 配置**（用户可自定义），不存在「一份可整体替换的提示词」；
 *   · 维护 10 份 8–15KB 的提示词，任何全局规则改动都要同步 10 遍，必然漂移。
 * 因此本模块只分发**与模型族强相关的片段**（工具调用格式、工具使用强制指令），
 * persona / 全局边界 / 工具名清单 / 沙箱说明等继续共享同一份。
 *
 * ## 本模块要解决的真实问题（不是省 token，是指令精确性）
 * 改前 `buildCompactToolSection` 对**所有**模型同时下发两套互斥说明：
 *   「支持 function calling 就用原生格式；**如果不支持，就输出 JSON 对象** {...}」
 * 我们全部走 function-calling 接口下发 schema，后半句对任何在用模型都不成立，
 * 而且**有害** —— 它明确授权模型「可以把 tool call 打印成 JSON」，而打印出来的
 * JSON 不会被执行（正是反幻觉规则第 1 条在防的那类失败）。省下的 ~100 token 是副产品。
 *
 * ## 唯一真源纪律
 * 改前存在**两处独立**的模型族判断：
 *   · `agentOSService.TOOL_USE_ENFORCEMENT_MODELS`（散落子串数组，executor 用）
 *   · 无（driver 侧根本没有按族区分）
 * 现在统一为 `detectModelFamily()` + `getFamilyPromptProfile()` 两张表：
 * **族识别**与**族→行为**解耦，新增模型族只需各加一条，不必再翻散落的 if。
 *
 * ## 已知边界（诚实声明，不做过度设计）
 * driver 用 `getActiveModelSelection()` 推断族（与既有 `isKnotProvider` 判断同一前提），
 * executor 用本次请求真实的 `selection`。在极少数 fallback 场景二者可能不同，
 * 后果只是「多了或少了一段软指令」，不影响工具调用的正确性与前缀缓存的稳定性
 * （同一 agent + 同一模型下字节仍恒定）。
 *
 * 纯函数、零依赖 → 可单测、可在 common 层安全使用。
 */

/** 模型族。新增族必须同时在 `detectModelFamily` 与 `FAMILY_PROFILES` 各加一条。 */
export type ModelFamily =
	| 'anthropic'
	| 'openai'
	| 'gemini'
	| 'deepseek'
	| 'qwen'
	| 'kimi'
	| 'glm'
	| 'grok'
	| 'hunyuan'
	/** 无法识别 → 走最保守配置（保留两套格式说明，向后兼容）。 */
	| 'generic';

/**
 * 族识别表：按顺序匹配，**第一个命中胜出**。
 *
 * ⚠ 顺序敏感项已在此显式标注，改动顺序前先看单测：
 *   · `codex` 必须能落到 openai（`gpt` 之外的独立命名）；
 *   · `gemma` 与 `gemini` 同族（Google），放一起；
 *   · `moonshot` 与 `kimi` 同族。
 */
const FAMILY_MATCHERS: ReadonlyArray<{ readonly family: ModelFamily; readonly needles: ReadonlyArray<string> }> = [
	{ family: 'anthropic', needles: ['claude', 'anthropic'] },
	{ family: 'deepseek', needles: ['deepseek'] },
	{ family: 'kimi', needles: ['kimi', 'moonshot'] },
	{ family: 'qwen', needles: ['qwen', 'tongyi'] },
	{ family: 'glm', needles: ['glm', 'chatglm'] },
	{ family: 'grok', needles: ['grok'] },
	{ family: 'gemini', needles: ['gemini', 'gemma'] },
	{ family: 'hunyuan', needles: ['hunyuan', 'hy3-', 'hy-'] },
	// openai 放在最后：`gpt` 是最容易被别的厂商型号包含的子串（如某些聚合网关会
	// 拼成 `xxx-gpt-oss`），让更具体的族先匹配可减少误判。
	{ family: 'openai', needles: ['gpt', 'o1-', 'o3-', 'o4-', 'codex'] },
];

/**
 * 按模型 ID 推断模型族。大小写不敏感；识别不了返回 `generic`。
 *
 * ⚠ 与被它替代的 `TOOL_USE_ENFORCEMENT_MODELS`（`['deepseek','gpt-','gemini',
 * 'gemma','grok','glm','qwen']`）的**一处有意差异**：原实现用 `'gpt-'`（带连字符），
 * 故 `gpt4o` 这类无连字符写法会漏判、拿不到 enforcement 指令。本实现用 `'gpt'`
 * 覆盖到，属修正而非回归（单测里有专门用例记录该差异）。
 */
export function detectModelFamily(modelId: string | undefined | null): ModelFamily {
	const id = (modelId ?? '').toLowerCase();
	if (!id) { return 'generic'; }
	for (const m of FAMILY_MATCHERS) {
		for (const needle of m.needles) {
			if (id.includes(needle)) { return m.family; }
		}
	}
	return 'generic';
}

/** 族 → 提示词决策。 */
export interface IModelFamilyProfile {
	/**
	 * 原生 function-calling 是否可靠。
	 * true → 只发原生格式指令，**不给**「打印 JSON」的退路（该退路会诱发假调用）。
	 * false → 保留双格式说明（仅 `generic` 这类未知模型）。
	 */
	readonly nativeToolCalling: boolean;
	/**
	 * 是否需要「说了要做就必须同一轮发出 tool_call」的强制指令。
	 * 覆盖被替代的 `TOOL_USE_ENFORCEMENT_MODELS` 语义。
	 */
	readonly needsToolUseEnforcement: boolean;
}

const FAMILY_PROFILES: Readonly<Record<ModelFamily, IModelFamilyProfile>> = {
	// Claude 原生 FC 最稳，且不需要额外催促（不注入 enforcement 是原实现的行为，保持）。
	anthropic: { nativeToolCalling: true, needsToolUseEnforcement: false },
	openai: { nativeToolCalling: true, needsToolUseEnforcement: true },
	gemini: { nativeToolCalling: true, needsToolUseEnforcement: true },
	deepseek: { nativeToolCalling: true, needsToolUseEnforcement: true },
	qwen: { nativeToolCalling: true, needsToolUseEnforcement: true },
	glm: { nativeToolCalling: true, needsToolUseEnforcement: true },
	grok: { nativeToolCalling: true, needsToolUseEnforcement: true },
	// kimi / hunyuan：原 TOOL_USE_ENFORCEMENT_MODELS 未列入 → 保持不注入，
	// 避免改变本项目默认模型（hy3-ioa）的既有基线。
	kimi: { nativeToolCalling: true, needsToolUseEnforcement: false },
	hunyuan: { nativeToolCalling: true, needsToolUseEnforcement: false },
	// 未知模型：保守假设可能不支持原生 FC，保留双格式说明。
	generic: { nativeToolCalling: false, needsToolUseEnforcement: false },
};

export function getFamilyPromptProfile(family: ModelFamily): IModelFamilyProfile {
	return FAMILY_PROFILES[family] ?? FAMILY_PROFILES.generic;
}

/**
 * 是否需要注入工具使用强制指令 —— **executor 与本模块共用的唯一判据**。
 * 替代 `TOOL_USE_ENFORCEMENT_MODELS.some(m => modelId.includes(m))` 的散落匹配。
 */
export function needsToolUseEnforcement(modelId: string | undefined | null): boolean {
	return getFamilyPromptProfile(detectModelFamily(modelId)).needsToolUseEnforcement;
}

/**
 * 工具调用格式指令（一行，进 stable 层的 `## General Tool Usage` 段）。
 *
 * 原生族：明确「原生 function call 才会被执行，XML/代码块/纯文本都不会」。
 * generic：保留原有双格式说明（字节与改前一致，保证未知模型行为不回归）。
 */
export function buildToolCallFormatDirective(family: ModelFamily): string {
	if (!getFamilyPromptProfile(family).nativeToolCalling) {
		// 与改前完全相同的文案 —— generic 分支即向后兼容基线。
		return 'When you need to use a tool, respond with a function call using the exact tool name and required arguments. If your model supports function calling, use the native function_call format; if NOT, output a JSON object in this exact format: {"name": "<tool_name>", "arguments": {<args>}}. DO NOT use XML tags like <tool_call> or <function_call>. Never output tool calls as plain-text explanations or code blocks.';
	}
	return 'When you need to use a tool, emit a NATIVE function call with the exact tool name and required arguments. Only native function calls are executed: a tool call written as XML tags (<tool_call>, <function_call>), inside a markdown code block, or described in prose is NOT executed and will be treated as if you did nothing.';
}

/**
 * 反幻觉规则中「输出格式」那一条（编号由调用方给定，保持规则表连续）。
 *
 * 原生族不再描述「fenced code block 作为 fallback」—— 那是 generic 才需要的退路，
 * 对原生族等于告诉它「打印出来也算」，与本规则表第 1 条自相矛盾。
 */
export function buildOutputFormatRule(family: ModelFamily, index: number): string {
	if (!getFamilyPromptProfile(family).nativeToolCalling) {
		return `${index}. **Output format priority**: PREFERRED is the native OpenAI function-call format via the \`tools\` parameter; FALLBACK (only if unavailable) is a JSON object in a fenced code block.`;
	}
	return `${index}. **Output format**: emit the call through the native function-calling interface (the \`tools\` parameter of this request). A JSON object printed into your reply is NOT a tool call and will NOT be executed.`;
}
