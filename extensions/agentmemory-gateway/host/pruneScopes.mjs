/*---------------------------------------------------------------------------------------------
 *  pruneScopes.mjs — 一次性子代理（subagent）的 scope 覆盖面（2026-11-02）
 *
 * 背景：`host.mjs` 的 orphan 剪枝原来只覆盖三族
 *   `mem:semantic:subagent-%` / `mem:obs:subagent-%` / `mem:memories:subagent-%`
 * ⇒ 其余族**永久滞留**。实测 dev 库：`mem:slots:subagent-*` 672 行里 557 行是空槽位
 *   （每个子代理固定种 8 个槽，用完没人清）；`mem:profiles:` / `mem:lessons:` /
 *   `mem:access:` / `mem:retention:` 同理。
 *
 * 判据：`subagent-` 是**子代理专用前缀**（`core/memory.js` 的
 * `WORKSPACE_PARTITION_PREFIX` 刻意不以它开头，就是为了"工作区不会撞上子代理判据"）
 * ⇒ 用一条更宽的族通配即可，不需要逐族枚举（逐族枚举正是这次漏掉的原因）。
 *
 * 本文件是**纯逻辑**（无 fs / 无 sqlite），所以能直接被 `node --test` 覆盖。
 *--------------------------------------------------------------------------------------------*/

/**
 * SQL `LIKE` 模式：`mem:<族>:subagent-<id>[:<sessionId>]`。
 *
 * `%` 贪婪覆盖中间所有段 ⇒ 单条即可命中 memories / semantic / obs / slots / profiles /
 * lessons / access / retention / graph / procedural / summaries / core-memory 等全部族。
 */
export const SUBAGENT_SCOPE_LIKE = 'mem:%:subagent-%';

/**
 * 把 SQL `LIKE` 模式转成正则（只支持 `%` 与 `_`，本仓用法足够）。
 * 用途：让单测能**行为级**验证覆盖面，而不必连数据库。
 * @param {string} like LIKE 模式
 * @returns {RegExp} 等价正则（整串匹配）
 */
export function likeToRegExp(like) {
	const escaped = String(like).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`^${escaped.replace(/%/g, '[\\s\\S]*').replace(/_/g, '[\\s\\S]')}$`);
}

/** 该 scope 是否属于"一次性子代理"（⇒ 可被 TTL 剪枝）。 */
export function isSubagentScope(scope) {
	if (typeof scope !== 'string' || scope.length === 0) { return false; }
	return likeToRegExp(SUBAGENT_SCOPE_LIKE).test(scope);
}
