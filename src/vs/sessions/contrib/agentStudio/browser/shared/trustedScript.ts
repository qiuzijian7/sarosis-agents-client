/*---------------------------------------------------------------------------------------------
 *  shared/trustedScript.ts — 主窗口内求值脚本文本的统一入口。
 *
 *  解决的问题（2026-10-20 实测）：
 *  工作窗口的 CSP 同时有 `script-src 'unsafe-eval'` 与 `require-trusted-types-for 'script'`。
 *  前者只放行 `eval` / `Function` 这一「动作」，后者额外要求**实参是 TrustedScript**
 *  —— 直接喂普通字符串会抛：
 *      Evaluating a string as JavaScript violates this document's Trusted Type assignment requirements.
 *  这个错误文案不提"eval"、也不提调用方模块名，很容易被误读成被测内容的语法错误
 *  （实例：知识库笔记里 mermaid 全部显示"渲染失败"，其实图源码一行都没被解析 —— 挂在
 *   加载 pele 引擎那一步）。
 *
 *  ⚠ **不能用 `new Function(trustedScript)` 绕**：Chromium 把 Function 构造器当成 eval sink，
 *    却**不认** TrustedScript 标记 —— 实测（Edge/Chromium 150）`eval(TrustedScript)` 通过、
 *    `new Function(TrustedScript)` 仍抛同一条错。故这里统一走**间接 eval**
 *    （`(0, eval)(...)`：在全局作用域求值，访问不到本模块局部变量，隔离性与 new Function 相当）。
 *
 *  策略本身只做恒等转换（标为可信，不改内容）。策略名必须登记在 CSP 的 `trusted-types`
 *  白名单，且**四份入口页都要**：`sessions.html` / `sessions-dev.html` /
 *  `workbench.html` / `workbench-dev.html` —— 漏登记的页面里 `createPolicy` 被 CSP 直接拒，
 *  拿不到策略就仍会抛上面那条 TT 错。
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings, no-eval, @typescript-eslint/no-implied-eval */

import { createTrustedTypesPolicy } from '../../../../../base/browser/trustedTypes.js';

/** 自有脚本策略名（四份入口页的 CSP `trusted-types` 名单里都有）。 */
export const AGENT_STUDIO_SCRIPT_POLICY = 'agentStudioScript';

/** 恒等策略：只负责"标为可信"，不改变内容。无 Trusted Types 的环境（Node 单测）为 undefined。 */
const _scriptPolicy = createTrustedTypesPolicy(AGENT_STUDIO_SCRIPT_POLICY, { createScript: (script: string) => script });

/**
 * 把脚本文本包成 TrustedScript。
 *
 * 返回类型是 `string`：`TrustedScript` 是 branded 类型，`eval` 的签名只收 `string` —— 运行期
 * 是同一个值，这里只做类型擦除，不做任何字符串处理。拿不到策略时原样返回（无 TT 的环境本就不需要）。
 */
export function trustedScriptOf(source: string): string {
	if (!_scriptPolicy) {
		return source;
	}
	try {
		return _scriptPolicy.createScript(source) as unknown as string;
	} catch {
		return source;
	}
}

/**
 * 编译一个函数（`new Function(...params, body)` 的 TT 安全替代）。
 *
 * 用间接 eval 求值一个**函数表达式**：在全局作用域解析，函数体访问不到本模块的局部变量
 * —— 与 `new Function` 的隔离性等价，但能过 Chromium 的 TT 校验。
 */
export function compileFunction(paramNames: string[], body: string): (...args: unknown[]) => unknown {
	const expression = `(function(${paramNames.join(', ')}) {\n${body}\n})`;
	// (0, eval) = 间接 eval ⇒ 全局作用域求值
	return (0, eval)(trustedScriptOf(expression)) as (...args: unknown[]) => unknown;
}

/**
 * 求值一段"函数体"并把返回值交回（`compileFunction([], body)()` 的简写）。
 *
 * 例：`evaluateScriptBody(bundleJs + '\nreturn pele;')` —— 拿到 iife bundle 暴露的 global。
 */
export function evaluateScriptBody(body: string): unknown {
	return compileFunction([], body)();
}

/**
 * 判断一条错误信息是不是 Trusted Types 拦截（而非被测内容本身的语法错误）。
 *
 * 调用点用它把"引擎/脚本被 CSP 拦"和"用户内容写错了"两类失败分开报 —— 否则用户会对着
 * 完全正确的源码找语法错。
 */
export function isTrustedTypesBlock(message: string): boolean {
	return /trusted\s*types?|TrustedScript/i.test(message);
}

/** TT 拦截时的统一提示（带策略名与修复指引）。 */
export function trustedTypesHint(message: string): string {
	return `脚本求值被 Trusted Types 拒绝（策略 "${AGENT_STUDIO_SCRIPT_POLICY}" 未生效）：${message}`
		+ ' —— 检查 sessions.html / sessions-dev.html / workbench.html / workbench-dev.html 的 CSP trusted-types 白名单是否含该策略名。';
}
