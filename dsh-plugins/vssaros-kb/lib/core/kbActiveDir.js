// @vssaros/dsh-kb — 「当前目录」的持久化 + 写笔记路径兜底（★ 2026-10-19）。
//
// **为什么需要它**（用户报的真机 bug）：
//   模型调 `kb_write_note` 时只知道自己编的路径（`笔记/xxx.md`），**不知道用户在页面上正待在哪个目录**
//   ⇒ 写出来的笔记全落在「笔记」区**根**，而用户当前在 `01_学习` 里工作 ⇒ 位置不对 ✗。
//   dsh 的工具是**无状态**的（每次调用独立），页面状态也传不进工具 ⇒ 只能：
//     ① 页面把「当前目录」**上报**到磁盘（sidecar 文件，服务端可读）；
//     ② 写笔记时若**模型没给目录层级**，就用它兜底。
//
// **兜底规则（刻意保守）**：
//   只在「路径直接落在笔记区根」时改写（`笔记/xxx.md` ⇒ `笔记/<当前目录>/xxx.md`）。
//   一旦模型自己带了子目录（`笔记/UE5/xxx.md`）就**原样不动** —— 那是它明确表达的位置，
//   替它改会变成"我让它写这儿、它写到别处"那种最难查的形态 ✗。
//
// **必须可观测**：改写后返回 `redirected/from/resolved`，调用方要把它们放进工具结果
//   （模型据此知道"落点被调整过"，用户也能看懂为什么文件出现在别处 ✓）。

/** sidecar 文件名（放在资料库根下，与各 vault 目录同级）。 */
export const ACTIVE_DIR_FILE = '.active-dir.json';

/**
 * 纯函数：按「当前目录」改写写笔记的相对路径。
 *
 * @param {string} relPath 模型给的路径（vault 相对，形如 `笔记/xxx.md`）
 * @param {string} activeDir 当前目录 —— **vault 相对**（形如 `笔记/01_学习`，与页面 `data-dir-rel` 同口径 ✓）；
 *   空 = 不兜底。⚠ 不要再接受"笔记区相对"（`01_学习`）那种形态：两种口径混用必然拼出
 *   `笔记/笔记/...` 这种路径（本文件第一版就差点这么写 ✓）。
 * @param {string} [notesDir] 笔记区目录名（默认 `笔记`）
 * @returns {{ relPath: string, redirected: boolean, from?: string, resolved?: string }}
 */
export function applyActiveDir(relPath, activeDir, notesDir = '笔记') {
	const raw = typeof relPath === 'string' ? relPath.trim().replace(/\\/g, '/') : '';
	const dir = typeof activeDir === 'string' ? activeDir.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '';
	// 不兜底的情形：路径空 / 没写当前目录 / 不在笔记区（库区有围栏，改写没意义）
	if (!raw || !dir) { return { relPath: raw, redirected: false }; }
	if (raw !== notesDir && !raw.startsWith(notesDir + '/')) { return { relPath: raw, redirected: false }; }
	if (dir !== notesDir && !dir.startsWith(notesDir + '/')) { return { relPath: raw, redirected: false }; }
	// 当前目录就是笔记区根 ⇒ 落到根，改不改一样（避免产出 `笔记//x.md`）
	if (dir === notesDir) { return { relPath: raw, redirected: false }; }
	const tail = raw === notesDir ? '' : raw.slice(notesDir.length + 1);
	// 模型已经给了子目录（`UE5/xxx.md`）⇒ 尊重它，不改 ✗
	if (!tail || tail.includes('/')) { return { relPath: raw, redirected: false }; }
	const resolved = `${dir}/${tail}`;
	return { relPath: resolved, redirected: true, from: raw, resolved };
}

/**
 * 读某个 vault 的当前目录（读不到/坏了 ⇒ 空串，**不抛**）。
 * @param {object} io `{ readFile }`（注入以便单测；生产传 node:fs/promises 的实现）
 */
export async function readActiveDir(io, kbRoot, vaultId) {
	try {
		const text = await io.readFile(joinPath(kbRoot, ACTIVE_DIR_FILE), 'utf8');
		const parsed = JSON.parse(text);
		const dir = parsed?.[vaultId];
		return typeof dir === 'string' ? dir : '';
	} catch {
		return '';
	}
}

/**
 * `__activeVaultId` —— sidecar 里记录「**用户在页面上选的当前库**」的键。
 * 用双下划线前缀，避免与 vaultId（形如 `20260922123131-827wo3k`）撞名 ✓。
 */
export const ACTIVE_VAULT_KEY = '__activeVaultId';

/**
 * 写某个 vault 的当前目录（合并写；失败**不抛** —— 记不住当前目录不该让页面报错）。
 *
 * ★ 2026-10-19：**顺手记下"这就是当前库"** —— 页面每次上报都带着 vaultId，
 *   那一次上报本身就说明"用户现在在这个库里" ⇒ 不需要再开一条 API ✓
 *   （工具侧读它优先于 IDE 注入的 `kbActiveVaultId`，于是"切库后立刻写"也能跟上 ✓）。
 */
export async function writeActiveDir(io, kbRoot, vaultId, dirRel) {
	try {
		let parsed = {};
		try { parsed = JSON.parse(await io.readFile(joinPath(kbRoot, ACTIVE_DIR_FILE), 'utf8')) ?? {}; } catch { parsed = {}; }
		parsed[vaultId] = String(dirRel ?? '');
		parsed[ACTIVE_VAULT_KEY] = String(vaultId ?? '');
		await io.writeFile(joinPath(kbRoot, ACTIVE_DIR_FILE), JSON.stringify(parsed, null, 2), 'utf8');
		return true;
	} catch {
		return false;
	}
}

/**
 * 读「当前库」（页面最后上报的那个；读不到/坏了 ⇒ 空串，调用方退回 IDE 注入值 ✓）。
 */
export async function readActiveVault(io, kbRoot) {
	try {
		const text = await io.readFile(joinPath(kbRoot, ACTIVE_DIR_FILE), 'utf8');
		const parsed = JSON.parse(text);
		const id = parsed?.[ACTIVE_VAULT_KEY];
		return typeof id === 'string' ? id : '';
	} catch {
		return '';
	}
}

/** 拼路径（不 import node:path，保持本文件是**纯逻辑**、可直接单测 ✓）。 */
function joinPath(base, name) {
	const b = String(base ?? '').replace(/[\\/]+$/, '');
	return `${b}/${name}`;
}
