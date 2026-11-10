// @vssaros/dsh-kb — 知识库「文件夹根目录」配置（**dsh 侧唯一真源**，纯逻辑 + 零依赖）。
//
// 2026-11-10 用户裁决：① 选中的根**直接当唯一库根**（不再套一层 `<vaultId>/`）；
//   ② 两个顶层区用磁盘真名 `数据源/` 与 `知识库列表/`；③ **以 dsh 侧配置为准，移除 IDE 侧配置和逻辑**。
//
// ⇒ 根配置落盘在 `<数据根>/.kb-root.json`，由本插件自己读写；IDE 侧不再读幽灵设置
//   `agentStudio.knowledge.storage.path`、不再往 `roots-<id>.yml` 注入 `kbRoot/kbVaults/kbActiveVaultId`。
//
// 优先级（全部都是 dsh 侧）：`config.kbRoot`（独立启动器 / vssaros.config.json 显式配置）
//   → `<数据根>/.kb-root.json`（聊天框工具卡写入）→ `<数据根>/knowledge-base`（缺省）。
//
// ⚠ 本模块**不碰 I/O**：读盘在 store.js（同步，只在 apply 时读一次并缓存）、写盘在 index.js 的路由里。
//   这样纯函数可以直接被守卫/探针验证，不必起 Host。

import { isAbsolute, join, resolve } from 'node:path';

/** 配置文件名（落在数据根下，不在知识库根里 —— 换根时配置不会跟着丢）。 */
export const ROOT_CONFIG_FILE = '.kb-root.json';
/** 缺省根的子目录名（与 IDE 侧历史缺省同值，但 IDE 侧已不再是真源）。 */
export const DEFAULT_ROOT_SUBDIR = 'knowledge-base';
/** 两个顶层区（磁盘真名；`库`/`笔记` 是 2026-11-02 改名前的旧称，不要再写）。 */
export const LIBRARY_SUBDIR = '数据源';
export const NOTES_SUBDIR = '知识库列表';

export function defaultRootOf(dataRoot) {
	return join(String(dataRoot || ''), DEFAULT_ROOT_SUBDIR);
}

export function rootConfigFileOf(dataRoot) {
	return join(String(dataRoot || ''), ROOT_CONFIG_FILE);
}

/**
 * 归一化 + 校验用户给的根路径。返回 `{ ok, path, error }`，**不抛**。
 * 硬约束：必须绝对路径、不能含 `? * " < > |`、不能是明显的盘符根/家目录（那会把整个盘当库）。
 */
export function normalizeRootPath(raw) {
	const input = typeof raw === 'string' ? raw.trim() : '';
	if (!input) { return { ok: false, path: '', error: '请填写知识库文件夹根目录的绝对路径' }; }
	let decoded = input;
	try { decoded = decodeURIComponent(input); } catch { /* 不是百分号编码就按原样 */ }
	// ⚠ 必须在 `resolve()` **之前**判：`resolve('relative/x')` 会悄悄返回 `<cwd>/relative/x`
	//   ⇒ 放在后面判 `isAbsolute` 恒真，校验形同虚设（端到端探针抓到的真 bug ✓）。
	if (!isAbsolute(decoded)) {
		return { ok: false, path: '', error: '请填写绝对路径（例如 E:\\我的知识库）；相对路径会落到宿主进程的当前目录' };
	}
	const path = resolve(decoded);
	if (/[?*"<>|]/.test(path.slice(2))) {
		return { ok: false, path: '', error: '路径里含有非法字符 ? * " < > |' };
	}
	const parts = path.split(/[\\/]+/).filter(Boolean);
	if (parts.length < 2) {
		return { ok: false, path: '', error: '不能把盘符根目录当作知识库根目录：' + path };
	}
	return { ok: true, path, error: '' };
}

/**
 * 根 vault 的 id。全链路（`isVaultId` / 路由闸 / 工具参数）只认
 * `yyyyMMddHHmmss-随机` 或 `ext-<4~16 hex>` ⇒ 用路径的稳定短哈希造后者。
 * 与 `/api/vault-add` 的 attach 分支同款哈希（同一目录永远得到同一个 id）。
 */
export function rootVaultIdOf(dir) {
	let h = 0;
	const s = String(dir || '').toLowerCase();
	for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
	return 'ext-' + h.toString(16).padStart(8, '0');
}

/** 解析配置文件；坏 JSON / 坏形状一律返回 null（不抛、不猜路径）。 */
export function parseRootConfig(text) {
	try {
		const obj = JSON.parse(String(text || ''));
		if (!obj || typeof obj !== 'object' || typeof obj.path !== 'string') { return null; }
		const checked = normalizeRootPath(obj.path);
		return checked.ok ? { path: checked.path } : null;
	} catch { return null; }
}

export function serializeRootConfig(path) {
	return JSON.stringify({ version: 1, path }, null, 2) + '\n';
}

/**
 * 候选根目录（卡片右侧那几项）。只读、不猜：
 *   · `default` = `<数据根>/knowledge-base`
 *   · `workspace` = 当前工作区下的 `知识库/`（拿不到就不给）
 *   · `existing` = 已经含 `数据源/` 或 `知识库列表/` 的目录（由调用方扫出后传进来）
 * 每项带 `path / label / recommended / note / exists / sections`。
 */
export function buildRootCandidates({ dataRoot, configured, workspaceRoot, existing = [] } = {}) {
	const items = [];
	const seen = new Set();
	const push = (item) => {
		const p = item && item.path;
		if (!p || seen.has(p.toLowerCase())) { return; }
		seen.add(p.toLowerCase());
		items.push(item);
	};
	if (configured) {
		push({ path: configured, label: '当前配置', recommended: false, note: '正在使用的知识库文件夹根目录', exists: true, sections: [] });
	}
	const def = defaultRootOf(dataRoot);
	push({ path: def, label: '默认位置', recommended: true, note: 'app 数据根下 · 不存在时创建，并补 数据源/ 与 知识库列表/', exists: false, sections: [] });
	if (workspaceRoot) {
		push({ path: join(String(workspaceRoot), '知识库'), label: '当前工作区', recommended: false,
			note: '跟着项目走，可随代码一起备份', exists: false, sections: [] });
	}
	for (const item of existing) {
		const p = typeof item === 'string' ? item : item?.path;
		if (!p) { continue; }
		push({ path: p, label: '已有根目录', recommended: false,
			note: '检测到 数据源/ 与 知识库列表/ · 直接接入，不移动不复制', exists: true,
			sections: Array.isArray(item?.sections) ? item.sections : [LIBRARY_SUBDIR, NOTES_SUBDIR] });
	}
	return items;
}

/** 「根即唯一库根」时，这个根下的两个顶层区绝对路径。 */
export function rootSectionsOf(root) {
	return {
		library: join(String(root || ''), LIBRARY_SUBDIR),
		notes: join(String(root || ''), NOTES_SUBDIR),
	};
}

/** 相对/绝对的展示归一（Windows 盘符大小写不影响比较）。 */
export function sameRootPath(a, b) {
	if (!a || !b) { return false; }
	const norm = (p) => resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
	return norm(a) === norm(b);
}
