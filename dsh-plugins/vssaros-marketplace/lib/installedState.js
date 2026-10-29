// @vssaros/dsh-marketplace — 「这台机器上到底装了什么」的唯一判据（★ 2026-10-29）
//
// 为什么要单独一层：台账 `installed-packages.json` 是**历史记录**，只增不减 ——
//   用户在资源管理器里删掉 `skills/xxx`、或从旧机器同步来一份台账，条目仍然留着。
//   真机实测（2026-10-29）：台账里 135 条 skill，磁盘上只剩 21 个目录
//   ⇒ 若直接拿台账给商品打「已安装」，会有 **100+ 个商品谎报已安装**
//     （比不显示更糟：用户点进去发现并没有装，还找不到卸载入口）✗
// ⇒ 有落地物可查的 kind（skill / workflow / agent / mcp）**一律以磁盘为准**；
//   没有落地物可查的 kind（plugin / workbench）只能信台账
//   （它们装在 dsh profile 的 node_modules 里，本插件既不负责也无从点名）。
//
// 判据分两问，**先问"在不在"再问"什么版本"**：
//   ① 落地物在不在 —— 决定"算不算已安装"（唯一判据）
//   ② 版本号取哪份 —— 磁盘读得出就用磁盘（升级判断要准），读不出才回退台账
//      （老技能手写的 SKILL.md 经常没有 `version:` 字段，不能因此判成"没装" ✗）
//
// 输出就是页面上的「已安装 vX.Y.Z」：
//   `list` / `detail` / `installed` **共用这一份** ⇒ 三个表面不可能各说一套 ✓

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readInstalled } from './installedLedger.js';
import { installedVersionOf, targetRootOf } from './installers.js';
import { mcpDirOf, readMcpPackageConfig, readMcpJson } from './mcpInstall.js';

/** 台账 key：`kind:storeId`（与列表商品的 `kind:slug` 同形）。 */
export function installedKey(kind, storeId) {
	return `${String(kind ?? '')}:${String(storeId ?? '')}`;
}

/** 这个 kind 有没有"可以核对"的落地物（没有 ⇒ 只能信台账）。 */
export function hasDiskPresence(kind) {
	return kind === 'skill' || kind === 'workflow' || kind === 'agent' || kind === 'mcp';
}

/** 路径是否存在（`stat` 成功即算）。 */
async function exists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * 某个 kind+id 的**落地物文件**（`null` = 这个 kind 没有可查的落地物 ⇒ 信台账）。
 */
function landingFileOf(dataRoot, kind, storeId) {
	if (kind === 'skill') { return join(targetRootOf(dataRoot, 'skill'), storeId, 'SKILL.md'); }
	if (kind === 'workflow') { return join(targetRootOf(dataRoot, 'workflow'), storeId, 'workflow.json'); }
	if (kind === 'agent') { return join(targetRootOf(dataRoot, 'agent'), storeId, '.agent.md'); }
	if (kind === 'mcp') { return join(mcpDirOf(dataRoot, storeId), 'config.json'); }
	return null;
}

/**
 * 单条台账条目的**真实**已装版本；没装（落地物已经没了）⇒ `''`。
 *
 * mcp 例外：除了 `mcp/<id>/config.json`，还要求 `mcp.json` 里注册着这个名字
 * —— 只删目录不注销会让启动报"MCP 服务器起不来"，所以注册项也算落地物 ✓
 *
 * @param {string} dataRoot
 * @param {{ kind?: string, storeId?: string, version?: string }} entry
 * @param {{ mcpJson?: { servers?: Record<string, unknown> } | null }} [opts]
 * @returns {Promise<string>} 版本号；`''` = 没装
 */
export async function resolveEntryVersion(dataRoot, entry, opts = {}) {
	const kind = String(entry?.kind ?? '');
	const storeId = String(entry?.storeId ?? '');
	if (!dataRoot || !kind || !storeId) { return ''; }
	const ledgerVersion = typeof entry.version === 'string' ? entry.version : '';
	const landing = landingFileOf(dataRoot, kind, storeId);
	// 没有可查的落地物（plugin / workbench / knowledge …）⇒ 只能信台账
	if (!landing) { return ledgerVersion; }
	try {
		if (!await exists(landing)) { return ''; }
		if (kind === 'mcp') {
			const mcp = opts.mcpJson ?? await readMcpJson(dataRoot);
			if (!mcp?.servers || !mcp.servers[storeId]) { return ''; }
			const pkg = await readMcpPackageConfig(dataRoot, storeId);
			return pkg.version || ledgerVersion;
		}
		// 磁盘读得出版本就以磁盘为准（升级判断要跟真正装上的那份对得上）
		const diskVersion = await installedVersionOf({ dataRoot, kind, storeId });
		return diskVersion || ledgerVersion;
	} catch {
		// id 非法 / 文件坏 / 权限 ⇒ 当作"没装"（宁可少标一个"已安装"，也不要谎报）
		return '';
	}
}

/**
 * 全量映射：`kind:storeId` → 真实已装版本（**没装的不进 Map**）。
 *
 * @param {string} dataRoot
 * @returns {Promise<Map<string, string>>}
 */
export async function resolveInstalledVersions(dataRoot) {
	const out = new Map();
	if (!dataRoot) { return out; }
	const entries = await readInstalled(dataRoot);
	if (entries.length === 0) { return out; }
	// mcp.json 只读一次（否则每个 mcp 条目都重读一遍文件）
	const mcpJson = await readMcpJson(dataRoot).catch(() => null);
	const resolved = await Promise.all(entries.map(async entry =>
		[installedKey(entry.kind, entry.storeId), await resolveEntryVersion(dataRoot, entry, { mcpJson })]));
	for (const [key, version] of resolved) {
		if (version) { out.set(key, version); }
	}
	return out;
}
