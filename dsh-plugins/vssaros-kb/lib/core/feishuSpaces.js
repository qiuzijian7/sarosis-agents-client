// @vssaros/dsh-kb — `kb_feishu_spaces` 的**纯逻辑**：CLI 参数 + 输出解析 + 名称净化。
//
// 为什么有这个文件（2026-10-12，报告 §R.7 第 ④ 项）：`kb_feishu_sync` 只解决"把笔记推上去" ✓，
// 而用户的需求形态是「把某个笔记目录关联到飞书知识库，**没有则新建**」✗ —— 缺的是"查远端真实列表 /
// 新建知识库"这一步 ✓。IDE 侧有 `kb_feishu_spaces`（`kbFeishuSyncTools.ts` ✓，底座是
// `browser/knowledge/feishuSyncCore.ts` 的 `listWikiSpaces` / `createWikiSpace` / `sanitizeSpaceName` ✓）。
// 本文件按**同一份契约**移植（方案 6.9 方案 C：契约共享、实现各自一份 ✓）。
//
// ⚠ 为什么**不**复用随包脚本（`feishu-sync.mjs`）✗：那个脚本只管同步 ✓，实测**不含** space 相关子命令
//   （2026-10-12 核查：插件目录里 `*.mjs` 搜 `space|wiki` **零命中** ✗）⇒ 只能像 IDE 那样**直调 lark-cli** ✓。
//
// ⚠ 纯函数：**不 import `node:child_process`** ✓ —— 真正的 spawn 放在 `lib/index.js`（那里已有 spawn 用法 ✓），
//   这样解析器可以在进程内直测 ✓（`p3-05` ✓），也与 `core/kb.js` 的分工一致 ✓。

/** lark-cli 的默认可执行名（照 IDE 真源 `DEFAULT_LARK_CLI` ✓）。 */
export const DEFAULT_LARK_CLI = 'lark-cli';

/** 列表命令（照真源逐字 ✓：`--page-all` 取全量、`--format json` 可解析 ✓）。 */
export const SPACE_LIST_ARGS = ['wiki', '+space-list', '--page-all', '--format', 'json'];
/** 新建命令（照真源逐字 ✓：`--as user` = 以**用户**身份建，不是 bot ✓）。 */
export function spaceCreateArgs(cleanName) {
	return ['wiki', '+space-create', '--name', String(cleanName), '--as user'];
}

/**
 * 规范化知识库名称（照真源 ✓）：去掉会破坏命令行的 `"` 与 CR/LF 并裁剪空白。
 * ⚠ dsh 侧用 `spawn(exe, args[])`（**不经 shell** ✓）⇒ 本来不怕引号 ✗；
 *   但这里仍照真源净化 ✓ —— 因为**同一个名称还会被写进映射文件**（`.feishu-space-map.json` ✓），
 *   那里多一个引号/换行就是坏 JSON ✓（且"两边规则不同"最难解释 ✓）。
 */
export function sanitizeSpaceName(name) {
	return (name ?? '').replace(/["\r\n]/g, '').trim();
}

/** 剥 ANSI 颜色码（真源也是先剥再解析 ✓：`lark-cli` 在 tty 下会带色）。 */
const stripAnsi = text => String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');

/** 从任意文本里抠出第一个 JSON 值（真源同款兜底：CLI 可能混着日志行 ✓）。 */
function extractFirstJson(text) {
	const s = stripAnsi(text);
	for (const [open, close] of [['{', '}'], ['[', ']']]) {
		const start = s.indexOf(open);
		if (start < 0) { continue; }
		let depth = 0;
		for (let i = start; i < s.length; i++) {
			if (s[i] === open) { depth++; }
			else if (s[i] === close) {
				depth--;
				if (depth === 0) {
					try { return JSON.parse(s.slice(start, i + 1)); } catch { return undefined; }
				}
			}
		}
	}
	return undefined;
}

/** 解析根：先整段 JSON，失败再抠第一个 JSON（照真源 ✓）。 */
function parseLoose(raw) {
	const text = stripAnsi(raw).trim();
	if (!text) { return undefined; }
	try { return JSON.parse(text); } catch { return extractFirstJson(text); }
}

/**
 * 解析 `wiki +space-list` 的输出 ⇒ `[{ spaceId, name }]`（照真源 ✓）。
 * 容忍：顶层数组 / `{ data: { items: [...] } }` / 任意嵌套；字段 `space_id` 或 `spaceId` ✓；按 spaceId 去重 ✓。
 */
export function parseSpaceList(raw) {
	const root = parseLoose(raw);
	const out = [];
	const seen = new Set();
	const walk = (node, depth) => {
		if (!node || typeof node !== 'object' || depth > 8) { return; }
		if (Array.isArray(node)) { for (const x of node) { walk(x, depth + 1); } return; }
		const id = typeof node.space_id === 'string' ? node.space_id : (typeof node.spaceId === 'string' ? node.spaceId : '');
		const name = typeof node.name === 'string' ? node.name : '';
		if (id && name && !seen.has(id)) { seen.add(id); out.push({ spaceId: id, name }); }
		for (const v of Object.values(node)) { walk(v, depth + 1); }
	};
	walk(root, 0);
	return out;
}

/** 从 `wiki +space-create` 的输出里取新建的 spaceId（照真源 ✓：任意嵌套里的第一个 space_id/spaceId ✓）。 */
export function parseCreatedSpaceId(raw) {
	const root = parseLoose(raw);
	let found = '';
	const walk = (node, depth) => {
		if (found || !node || typeof node !== 'object' || depth > 8) { return; }
		if (Array.isArray(node)) { for (const x of node) { walk(x, depth + 1); } return; }
		const id = typeof node.space_id === 'string' ? node.space_id : (typeof node.spaceId === 'string' ? node.spaceId : '');
		if (id) { found = id; return; }
		for (const v of Object.values(node)) { walk(v, depth + 1); }
	};
	walk(root, 0);
	return found;
}

/** 同名判定（照真源 ✓：忽略大小写与首尾空白 —— 飞书侧名字大小写不敏感，重复建库最难收拾 ✗）。 */
export function findSameNameSpace(spaces, name) {
	const wanted = sanitizeSpaceName(name).toLowerCase();
	if (!wanted) { return undefined; }
	return (spaces ?? []).find(s => String(s?.name ?? '').trim().toLowerCase() === wanted);
}

/** 缺 CLI / 未登录时的指引（照真源语义 ✓：不隐藏问题，直接给安装与登录命令 ✓）。 */
export const LARK_CLI_MISSING_HINT =
	'没跑成 `lark-cli`：请确认已安装并在 PATH 里（或给 `cliPath` 绝对路径），且已用**用户身份**登录'
	+ '（`lark-cli auth login --as user`）。装好后可以用「知识库设置 → 飞书同步 → 目录映射 → 🔄 刷新知识库列表」重试。';
