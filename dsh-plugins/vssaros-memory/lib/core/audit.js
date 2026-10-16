// @vssaros/dsh-memory — audit core（纯逻辑：零 I/O、零 dsh 依赖）。
//
// 为什么要有这个账本（用户 2026-10-12 拍板的 P2）：
//   `tools/pre-execute` 的 `ask` 与 `approval/request` 的裁决，按官方契约会落进**会话日志**
//   （`approval/asked` + `approval/decided`，见 `dsh-user-approval/lib/types/types.d.ts:37-51`）——
//   但那是**按会话**存的：想知道"过去一个月谁批准过哪些记忆写入、被拒过几次"，只能一个个会话翻 ✗。
//   本账本是**跨会话可查**的那一份（用户明确指定的存储位置：**插件侧 JSONL**），
//   与 `dsh-memento` 的 audit 表、`dsh-mneme` 的 receipt_chain 同类，只是落在文件而不是库上。
//
// ⚠ 两条纪律（照 memento / mneme 的口径）：
//   ① **审计写入绝不触发副作用** —— 不注册工具、不发事件、不改记忆。mneme 的原话是
//      "Like the other audit tables this is bookkeeping: **it never triggers write hooks**" ✓
//   ② **审计失败绝不影响主流程** —— 记忆写入成不成不由账本决定（I/O 层 try/catch + 一次 warn）✓
//
// ⚠ 隐私默认值（这条是刻意的，不是省事）：**默认只落 digest + 前 N 字**，全量内容要显式
//   `config.auditFullContent: true`。理由：记忆内容可能含密钥/隐私，而审计文件是**长期留存**的
//   —— "审计默认全落正文"是最像尽责、其实最危险的做法 ✗（memento / mneme 都为此单设了敏感扫描）。

import { createHash } from 'node:crypto';

/**
 * 审计行动作（三段式：请求 → 裁决 → 执行结果；外加自动沉淀的 `distill`）。
 * 为什么分三段而不是只记一条：三者会**缺段**（`ask` 之后用户没点就取消 ⇒ 没有 executed；
 * `writePolicy: off` ⇒ 只有 decision + `executed: rejected-by-policy`）—— 合成一行会把"缺段"抹掉 ✗。
 *
 * `distill`（2026-10-13 新增）：`agent/turn-stopping` 的**自动沉淀**走的不是工具闸 ⇒ 它既没有
 * `request` 也没有 `decision`，只有"某回合提了几条候选、写没写进草稿区"。**必须与三段分开记** ✓
 * —— 否则"模型写了记忆"与"插件自己提了草稿"在账本里长得一样，而它们对用户的含义完全不同 ✗。
 */
export const AUDIT_ACTIONS = ['request', 'decision', 'executed', 'distill'];

/** 内容预览默认长度（字符，不是字节）。 */
export const AUDIT_PREVIEW_CHARS = 80;

/** 账本文件默认轮转阈值（字节）。 */
export const AUDIT_MAX_BYTES_DEFAULT = 5 * 1024 * 1024;

/** 账本目录名 / 文件名（I/O 层用它拼绝对路径）。 */
export const AUDIT_DIR_NAME = 'memory-audit';
export const AUDIT_FILE_NAME = 'audit.jsonl';

/**
 * 内容指纹（sha256 前 16 位十六进制）。
 * 用途是"同一条记忆的内容变没变"（审计比对），**不是**安全用途 ⇒ 截断足够。
 * 用 `node:crypto` 而非手写哈希：本仓已有 sha 用法先例（`check-host-config.mjs` 的拷贝一致性
 * 就是比 sha），没必要为"纯逻辑"再造一个非标准哈希 ✓。
 * @param {unknown} text - 原文。
 * @returns {string} 16 位十六进制；空/非字符串返回空串（不产生"假装有指纹"的值 ✗）。
 */
export function auditDigestOf(text) {
	if (typeof text !== 'string' || text.length === 0) { return ''; }
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 内容的审计形态（**默认不落全文**，见文件头的隐私说明）。
 * @param {unknown} content - 原文。
 * @param {{full?: boolean, previewChars?: number}} [options] - {full, previewChars}。
 * @returns {{digest: string, preview: string, chars: number, truncated: boolean, full?: string}} 审计可落字段。
 */
export function shapeAuditContent(content, options = {}) {
	const text = typeof content === 'string' ? content : '';
	const limit = Number.isInteger(options.previewChars) && options.previewChars > 0 ? options.previewChars : AUDIT_PREVIEW_CHARS;
	const truncated = text.length > limit;
	const shaped = {
		digest: auditDigestOf(text),
		preview: truncated ? text.slice(0, limit) : text,
		chars: text.length,
		truncated,
	};
	// 全量只在显式 `full === true` 时出现（其它真值一律不落 ✓）
	return options.full === true ? { ...shaped, full: text } : shaped;
}

/**
 * 组装一条审计行。
 *
 * 字段**白名单**：调用方传进来的东西不直接展开（否则一个 args 对象被整个塞进账本，
 * 隐私与体积都失控 ✗）。未知键一律丢弃 ✓。
 *
 * @param {{action: string, tool?: string, agentId?: string, sessionId?: string, workspaceId?: string,
 *   target?: string, memoryType?: string, policy?: string, policyKey?: string, outcome?: string,
 *   content?: unknown, error?: unknown, full?: boolean, now?: number}} input - 审计输入。
 * @returns {object} 可 `JSON.stringify` 的行（不含换行）。
 */
export function buildAuditRow(input) {
	const action = typeof input?.action === 'string' && AUDIT_ACTIONS.includes(input.action) ? input.action : null;
	if (action === null) {
		throw new Error(`audit action 非法：${JSON.stringify(input?.action)}（应取 ${AUDIT_ACTIONS.join('|')}）`);
	}
	const row = {
		ts: Number.isFinite(input.now) ? input.now : Date.now(),
		action,
		...(typeof input.tool === 'string' && input.tool ? { tool: input.tool } : {}),
		...(typeof input.agentId === 'string' && input.agentId ? { agentId: input.agentId } : {}),
		...(typeof input.sessionId === 'string' && input.sessionId ? { sessionId: input.sessionId } : {}),
		...(typeof input.workspaceId === 'string' && input.workspaceId ? { workspaceId: input.workspaceId } : {}),
		...(typeof input.target === 'string' && input.target ? { target: input.target } : {}),
		...(typeof input.memoryType === 'string' && input.memoryType ? { memoryType: input.memoryType } : {}),
		...(typeof input.policy === 'string' && input.policy ? { policy: input.policy } : {}),
		...(typeof input.policyKey === 'string' && input.policyKey ? { policyKey: input.policyKey } : {}),
		...(typeof input.outcome === 'string' && input.outcome ? { outcome: input.outcome } : {}),
	};
	if (input.content !== undefined) {
		Object.assign(row, shapeAuditContent(input.content, { full: input.full }));
	}
	if (input.error !== undefined && input.error !== null) {
		// 错误信息截 200 字：够定位，不至于把一整个堆栈塞进账本
		row.error = String(input.error instanceof Error ? input.error.message : input.error).slice(0, 200);
	}
	return row;
}

/**
 * 轮转判据（纯函数）：超过阈值就该把当前文件改名归档。
 * 为什么需要：审计是**只增**的，不管它会长到几百 MB（本机网关的 `gateway.log` 已 5 MB、
 * `state_store.db` 183 MB ⇒ "没人管就会长"的先例在这个项目里是有的 ✗）。
 * @param {{bytes?: number, maxBytes?: number}} input - {bytes, maxBytes}。
 * @returns {boolean} 是否轮转。
 */
export function shouldRotate(input) {
	const bytes = Number.isFinite(input?.bytes) ? input.bytes : 0;
	const maxBytes = Number.isFinite(input?.maxBytes) && input.maxBytes > 0 ? input.maxBytes : AUDIT_MAX_BYTES_DEFAULT;
	return bytes >= maxBytes;
}

/**
 * 轮转后的归档后缀（只给后缀，绝对路径由 I/O 层拼）。
 * 形如 `20261012T203045`（可排序、无非法字符：Windows 文件名不许有 `:` ✓）。
 * @param {number} stamp - 毫秒时间戳。
 * @returns {string} 归档后缀。
 */
export function rotationSuffixOf(stamp) {
	const d = new Date(Number.isFinite(stamp) ? stamp : Date.now());
	const p = (n, w = 2) => String(n).padStart(w, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
