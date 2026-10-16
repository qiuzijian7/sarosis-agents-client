/**
 * allow 规则读取与匹配（Host 侧）—— 让"动作类 op 每次都要点一次"变成"用户显式写下的规则命中即免问"。
 *
 * ## 为什么需要它（2026-10-14）
 *
 * 用户反馈：抓一次小红书，`scroll` 被问了两次（截图就是那张"工具 browser 请求授权 / 允许一次"）。
 * 查下来有三层原因，**只有第三层是我们能修的**：
 *   ① 插件把 `scroll` 归进 `ACTION_OPS` ⇒ 每次调用都 `requestConsent`；
 *   ② 官方审批缝 `dsh-user-approval` 的 outcome 是**封闭集**且只有一次性放行
 *      （`allowed-once | rejected | cancelled | unavailable`，官方文档把它叫 one-shot grant），
 *      策略也只有 `ask` / `never`（而 `never` 是**自动拒绝**）⇒ **审批流表达不了"这个工具以后都同意"**；
 *   ③ IDE 侧**早有**这套"规则化白名单"（`~/.vssaros/tool-allow.json`，见
 *      `agentStudio/common/toolAllowStore.ts` / `browser/toolExecutionGuard.ts`），
 *      但它的读写者在 **renderer**，而本插件的确认发生在 **Host 进程** ⇒ 跨进程够不着 ⇒ 只剩"每次问"。
 * 本模块就是补上第 ③ 条：**同一个文件、同一套键形与匹配语义**，Host 直接读。
 *
 * ## 为什么"读用户的规则"不算自造授权
 *
 * 本插件文件头定过的纪律是"**不自造授权**"（Host 没有确认 UI ⇒ 不假装有）。读规则**不违反**它：
 *   · 规则是**用户显式写下的**（或被 IDE 的「始终允许」按钮写下的），不是模型自己记的"我刚才点过同意"；
 *   · 审批缝的一次性语义**保持不动** —— 没命中规则时，仍然逐次问；
 *   · 规则文件在 `~/.vssaros/`（**工作区之外**）⇒ 默认沙箱模式（`workspace-write`，写入边界 = 会话 cwd）
 *     下模型写不进去；`danger-full-access` 下模型本就能改任意文件，这里不多开一个口子。
 *   · 解析失败 / 文件缺失 **一律退化为"没有规则"**（→ 照旧逐次问），**绝不**把坏数据当授权 ✓（fail-closed）。
 *
 * ⚠ 与 IDE 侧的键形是**同一套**（那里 `command` 是 shell 命令，这里 `command` 是 op 名）：
 *   · `browser`            —— 该工具全部调用免问（仍受 `allowEvaluate` / `allowCookieIO` 等独立开关约束）；
 *   · `browser::click`     —— 只免 `click`；
 *   · `browser::*`         —— 同上（`*` 是 glob）；
 *   · `*::click`           —— 任意工具的 `click`（照 IDE 语义）。
 * 站点维度（`browser::click@host`）**这一版没做**：`host.status()` 不返回当前页 URL，
 * 为它加一次 CDP 往返不值得 ⇒ 宁可不承诺（少做一层就少一层误判）。
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 与 IDE 侧 `toolExecutionGuard.CMD_KEY_SEP` 逐字一致（两处若不同 → 同一份文件被两种语义读）。 */
export const CMD_KEY_SEP = '::';

/**
 * @deprecated 规则文件默认位置已改走数据根链（`config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`，
 * 见 `lib/index.js` 的 `allowRulesPath` 解析）——本函数恒拼 `~/.vssaros`，dev 下会读错文件，勿再用。
 * 与 IDE 侧 `SarosPath.toolAllow` 同一个路径（同一份文件，两个读者）。
 */
export function defaultAllowRulesPath(homeDir) {
	return join(homeDir, '.vssaros', 'tool-allow.json');
}

/** 简易 glob：`*` 匹配任意字符序列，其余按字面（照抄 IDE 侧 `globMatch`）。 */
export function globMatch(pattern, value) {
	if (pattern === '*') { return true; }
	const escaped = String(pattern).split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
	return new RegExp(`^${escaped}$`).test(String(value));
}

/** 规范化 op：去首尾空白、合并连续空白（照 IDE 侧 `normalizeCommand`，保持同一 key 形态）。 */
export function normalizeOp(op) {
	return String(op ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * 存下的 entry（`toolName` 或 `toolName::pattern`）是否作用于 (toolName, command)。
 * 语义与 IDE 侧 `toolExecutionGuard.entryMatches` **逐条同构** —— 这条不能各自演进（同一份文件两个读者）。
 */
export function entryMatches(entry, toolName, command) {
	if (typeof entry !== 'string' || !entry) { return false; }
	if (!entry.includes(CMD_KEY_SEP)) {
		return entry === toolName;                       // 工具级 blanket
	}
	const sepIdx = entry.indexOf(CMD_KEY_SEP);
	const t = entry.slice(0, sepIdx);
	const pattern = entry.slice(sepIdx + CMD_KEY_SEP.length);
	if (t !== toolName && t !== '*') { return false; }
	if (command === undefined || command === '') { return false; }
	return globMatch(pattern, command);
}

/**
 * 宽容解析（照 IDE 侧 `parseToolAllowFile` 的取向）：**绝不抛**。
 * 文件缺失 / JSON 坏 / 形态不符 ⇒ 空表 ⇒ 调用方照旧逐次问 ✓。
 *
 * ⚠ 刻意不做"猜修复"：授权表是**安全相关**状态，宁可退回"无任何授权"（多问一次）
 * 也不要把坏数据解释成授权 ✗。
 */
export function parseAllowRules(text) {
	const empty = { global: [], workspaces: {} };
	if (typeof text !== 'string' || !text.trim()) { return empty; }
	let raw;
	try { raw = JSON.parse(text); } catch { return empty; }
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return empty; }
	const strings = value => (Array.isArray(value) ? value.filter(e => typeof e === 'string' && e) : []);
	const workspaces = {};
	if (raw.workspaces && typeof raw.workspaces === 'object' && !Array.isArray(raw.workspaces)) {
		for (const [id, list] of Object.entries(raw.workspaces)) {
			const filtered = strings(list);
			if (filtered.length > 0) { workspaces[id] = filtered; }
		}
	}
	return { global: strings(raw.global), workspaces };
}

/**
 * 匹配器工厂：持有一份**按 mtime+size 失效**的缓存。
 *
 * 为什么带缓存：`requestConsent` 是**每次动作调用**都走的路径，而规则文件可能被 IDE 侧随时改写
 * （用户点「始终允许」）⇒ 既不能每次读盘，也不能只在启动时读一次。mtime+size 两个指标一起用是
 * 最低成本又能覆盖"同毫秒内改写"的判据（文件很小，两个 stat 字段一起来自同一次 `statSync`）。
 *
 * @param {string} filePath 规则文件路径
 * @returns {{ match: (toolName: string, command?: string) => string | undefined, path: () => string, loaded: () => boolean }}
 *   `match` 命中时返回**命中的那条 entry**（便于日志说清"为什么没问"），未命中返回 undefined。
 */
export function createRuleReader(filePath) {
	let cached;
	let cacheKey;

	const load = () => {
		let key;
		try {
			const st = statSync(filePath);
			key = `${st.mtimeMs}:${st.size}`;
		} catch {
			key = 'missing';                                 // 文件不在 ⇒ 空规则（不是错误）
		}
		if (cached !== undefined && cacheKey === key) { return cached; }
		let rules = { global: [], workspaces: {} };
		if (key !== 'missing') {
			try { rules = parseAllowRules(readFileSync(filePath, 'utf8')); } catch { /* 读不动 ⇒ 空规则 */ }
		}
		cached = rules;
		cacheKey = key;
		return rules;
	};

	return {
		path: () => filePath,
		loaded: () => { const r = load(); return r.global.length > 0 || Object.keys(r.workspaces).length > 0; },
		match: (toolName, command) => {
			const rules = load();
			// 只取 `global`：Host 侧没有工作区身份（`exec` 里只有 agent/session）⇒
			// `workspaces[*]` 那一段在 Host 里**无法**正确归属，宁可不读（读错=把 A 工作区的授权用在 B 上 ✗）。
			const entries = rules.global;
			const op = normalizeOp(command);
			for (const entry of entries) {
				if (entryMatches(entry, toolName, op)) { return entry; }
			}
			return undefined;
		},
	};
}
