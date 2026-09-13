/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 凭据脱敏 —— **零依赖纯函数**，`common/` 与 `browser/` 两侧共用。
 *
 * ## 为什么必须抽成独立模块（2026-09-13）
 *
 * 此前仓里有**三份**各自维护的脱敏实现，且**互有缺口**：
 *   1. `browser/providers/tool/searchHelpers.ts` 的 `redactSecrets`
 *      —— `file_read` / `search_code` / `search_files` / `terminal` 用；
 *   2. `browser/providers/tool/execOutputPipeline.ts` 的 `redactSecretsInOutput`
 *      —— `terminal` / `execute_code` 的命令输出管道用；
 *   3. `common/contextManager.ts` 的 `_cleanToolOutput`（P5，默认关闭）。
 *
 * 三份**存在的原因**正是本模块要解决的：`common/` 不能引用 `browser/`，而 `browser/`
 * 侧那份又挂在 `searchHelpers` 的重型依赖上 → 需要脱敏的**纯逻辑**模块
 * （`common/patchMatcher.ts`）**只能再抄一份**，于是干脆不脱敏。
 *
 * 代价是实测出来的漂移：`searchHelpers` 缺 `Bearer <不透明令牌>`、`execOutputPipeline`
 * 缺 GitLab `glpat-`、`patch` 的成功回显（改动区 ± 3 行）与失败回显（Closest match
 * 原文片段，上限 2000 字符）**完全没有脱敏** —— 而 `file_read` 对**同一批字节**是脱敏的，
 * 于是 `patch` 成了一条绕过 `file_read` 的「读文件」通道。
 *
 * 抽到零依赖的 `common/` 后，四侧共用同一份模式集，**结构上不可能再漂移**。
 *
 * ## 掩码风格
 *
 * 采用**带标签**的掩码（`<redacted:AWS>`）而非统一 `<REDACTED>` —— 保留「哪一类凭据」
 * 的信息，便于用户与模型判断影响面；`KEY=VALUE` 形态保留 key 名，便于定位泄露来源。
 *
 * ## 顺序与幂等
 *
 * 先跑**形态识别**（Bearer / JWT / PEM / AWS / …），再跑两条 `KEY=VALUE` 赋值形态。
 * 赋值形态对已掩码内容**幂等**：`PASSWORD=<redacted>` 再跑一遍结果不变。
 */

/**
 * 形态识别：`[匹配, 掩码]`。各条独立匹配（顺序无关），但整组必须在赋值形态**之前**。
 *
 * ⚠ 掩码文本刻意**不含空格** —— 赋值形态的 `[^\s'"]+` 遇空格即停，带空格的掩码
 * 会留下 `…<redacted> BEARER>` 这类残渣。
 */
const _PATTERNS_WHOLE: ReadonlyArray<readonly [RegExp, string]> = [
	// PEM 私钥块（多行，必须整块吃掉）
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted:PEM>'],
	// `Bearer <令牌>`。**必须在赋值形态之前**：赋值形态的 `[^\s'"]+` 遇空格即停，
	// 只会吃掉 `Bearer` 这一个词，真正的令牌原样留下。
	[/\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/gi, '<redacted:Bearer>'],
	// JWT（`eyJ` 是 `{"` 的 base64url 前缀，三段各自以 `eyJ` 开头是可靠特征）
	[/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted:JWT>'],
	// AWS Access Key ID
	[/\bAKIA[0-9A-Z]{16}\b/g, '<redacted:AWS>'],
	// GitHub（经典 token 与 fine-grained PAT）
	[/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '<redacted:GitHub>'],
	[/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '<redacted:GitHub>'],
	// GitLab（`{20,}` 而非 `{20}`：定长 + `\b` 会让**超过** 20 字符的令牌完全匹配不上）
	[/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '<redacted:GitLab>'],
	// Slack
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '<redacted:Slack>'],
	// OpenAI / Anthropic
	[/\bsk-(?:proj-|ant-)?[A-Za-z0-9\-_]{16,}\b/g, '<redacted:APIKey>'],
];

/**
 * 值文法（A / B 共用）：**含定界符**的「值」。
 *
 * 三种形态：
 *   1. `"…"` / `'…'` —— 引号定界（JSON 字符串、配置里的引号值；**允许内部含空格**）
 *   2. `\"…\"`       —— **转义**引号定界（JSON 里嵌的配置行：`"MY_TOKEN=\"abc\""`）
 *   3. 裸值          —— 到空白 / 引号为止
 *
 * ⚠ 为什么定界符必须**纳入值并在替换时原样保留**（2026-09-13 修）：
 * 旧实现只吃裸值、且 replacer 会把「开引号」重新吐一遍，而**闭引号仍留在原文里**
 * → `password: "hunter2"` 被改成 `password: "<redacted>""`（**多一个引号**）。
 * 在 JSON 里这就是结构损坏：`{"TOKEN":"abc"}` → `{"TOKEN":"<redacted>""}` → **无法解析**。
 * 本函数会被用在 `JSON.stringify` **之后**（见 `toolCallUtils.safeStringifyToolResult`
 * 的统一脱敏出口），所以「只替换值、保留定界符」是硬约束。
 */
const _VALUE = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\"(?:\\.|[^"\\])*\\"|[^\s'"]+)`;

/**
 * 赋值形态 A：**小写敏感词** key（`password=` / `api_key:` / `authorization:` …）。
 *
 * 三个关键设计：
 * 1. `(["']?)` 吃掉 JSON **带引号 key** 的闭引号 —— `"TOKEN":"x"` 里关键词后紧跟 `"`，
 *    否则 `\s*[:=]\s*` 匹配不上 `":"` → **整条规则对 JSON 完全失效**（实测确认）。
 * 2. `(?:(?:Bearer|Basic|Token)\s+)?` 吃掉**方案词并原样保留** —— 不吃掉 `Basic` 的话
 *    `Authorization: Basic <b64>` 只会掩掉方案词、**把凭据留下**（与 `Bearer` 同一个坑）。
 * 3. `(?!<)` 保证对已掩码内容**幂等**：`Authorization: <redacted:Bearer>` 不被二次
 *    压平成 `<redacted>` 而丢标签。
 */
const _PATTERN_ASSIGN = new RegExp(
	String.raw`((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|auth)\b)(["']?)(\s*[:=]\s*)(?!<)((?:(?:Bearer|Basic|Token)\s+)?)(`
	+ _VALUE + ')', 'gi');

/**
 * 赋值形态 B：**大写下划线** key（`MY_API_TOKEN=` / `AWS_SECRET_ACCESS_KEY=` …）。
 *
 * 形态 A 的 `\b` 要求关键词前是词边界，而 `MY_API_TOKEN` 里 `TOKEN` 前是 `_`
 * （`_` 属于 `\w`）→ **匹配不上**。故大写下划线形态必须单独一条。保留 key 名便于定位。
 */
const _PATTERN_ENV_ASSIGN = new RegExp(
	String.raw`\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*[=:]\s*)(?!<)(`
	+ _VALUE + ')', 'g');

/** 掩码一个「值」，**保留其定界符**（见 `_VALUE` 注释：JSON 里去掉引号会破坏结构）。 */
function _maskValue(value: string): string {
	const open = value[0];
	if (open === '"' || open === "'") { return `${open}<redacted>${open}`; }
	if (value.slice(0, 2) === '\\"') { return '\\"<redacted>\\"'; }
	return '<redacted>';
}

/** 脱敏密钥（对齐 Hermes `redact_sensitive_text`）。工具输出 / 命令输出 / 回显文本共用。 */
export function redactSecrets(input: string): string {
	if (!input) { return input; }
	let out = input;
	for (const [re, mask] of _PATTERNS_WHOLE) {
		out = out.replace(re, mask);
	}
	out = out.replace(_PATTERN_ASSIGN,
		(_m, key: string, q1: string, sep: string, scheme: string, value: string) =>
			`${key}${q1}${sep}${scheme}${_maskValue(value)}`);
	out = out.replace(_PATTERN_ENV_ASSIGN,
		(_m, key: string, sep: string, value: string) => `${key}${sep}${_maskValue(value)}`);
	return out;
}
