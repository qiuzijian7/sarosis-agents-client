import { URI } from '../../../../../base/common/uri.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IKbVault } from '../views/knowledgeBase/kbTypes.js';

/**
 * KB Vault / 存储根相关的存储键与解析辅助，集中于此以避免在 knowledgeBaseView
 * 与 workbench 命令之间重复硬编码字符串常量。
 */

export const STORAGE_VAULTS = 'agentStudio.kb.vaults';
export const STORAGE_ACTIVE = 'agentStudio.kb.active';
/** 知识库目录：单一路径，Vault 及其「库」「笔记」子文件夹均在此目录下。 */
export const STORAGE_KB_DIR = 'agentStudio.kb.kbDir';

const KB_ROOT_SUBPATH = '.vssaros/knowledge-base';

/** 解析 KB 存储根 URI（与 knowledgeBaseView.rootUri 完全一致）。 */
export function resolveKbRootUri(storageService: IStorageService, environmentService: INativeEnvironmentService): URI {
	const custom = storageService.get(STORAGE_KB_DIR, StorageScope.APPLICATION);
	if (custom) { return URI.file(custom); }
	return URI.joinPath(environmentService.userHome, ...KB_ROOT_SUBPATH.split('/'));
}

/** 读取当前激活的 Vault（无则取第一个未关闭的）。 */
export function loadActiveKbVault(storageService: IStorageService): IKbVault | undefined {
	const raw = storageService.get(STORAGE_VAULTS, StorageScope.APPLICATION);
	if (!raw) { return undefined; }
	let vaults: IKbVault[] = [];
	try { vaults = JSON.parse(raw); } catch { return undefined; }
	const activeId = storageService.get(STORAGE_ACTIVE, StorageScope.APPLICATION);
	return vaults.find(v => v.id === activeId && !v.closed) ?? vaults.find(v => !v.closed);
}

/** 激活 Vault 的「笔记 / 迁移」目录 URI（旧版数据迁移目标）。 */
export function resolveVaultNotesDir(vault: IKbVault, kbRootUri: URI): URI {
	const root = vault.customPath ? URI.file(vault.customPath) : URI.joinPath(kbRootUri, vault.id);
	return URI.joinPath(root, '笔记', '迁移');
}

// ─── Vault 目录命名（2026-09-23）─────────────────────────────────────────────
//
// 背景：新建 Vault 原先固定用 `joinPath(kbDir, vault.id)`，而 `id` 是 21 位时间戳
// ⇒ 磁盘上出现 `20260922123131-827wo3k/` 这种不可读目录。用户要求：
//   ① 新建用**可读目录名**；② 若知识库目录尚未被占用，**直接复用它**（不再套子目录）。
// 这组纯函数把「命名与占用判定」从视图里抽出来，便于单测。

/** Vault 目录名的最大长度（Windows 路径预算友好）。 */
const VAULT_DIR_MAX_LEN = 80;

/**
 * 把 Vault 名称转成可读、跨平台安全的**目录名**。
 *
 * - Windows 非法字符 `< > : " / \ | ? *` 与控制字符 → `_`
 * - 去掉首尾空白与结尾的点（Windows 会静默丢弃结尾 `.`/空格）
 * - 超长截断；结果为空 ⇒ 回退 `知识库`
 */
export function sanitizeVaultDirName(name: string): string {
	// eslint-disable-next-line no-control-regex
	const cleaned = (name ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
	const trimmed = cleaned.replace(/[. ]+$/, '').slice(0, VAULT_DIR_MAX_LEN).trim();
	return trimmed || '知识库';
}

/**
 * 路径的直接父目录（同时兼容 `\` 与 `/`；无父 ⇒ `''`）。
 *
 * 用于判定「某目录是否为 Vault 的公共父目录」—— 这种目录被占用，
 * 新建 Vault 时不应把 `库`/`笔记` 直接铺在别人的父目录上。
 */
export function parentDirOf(fsPath: string): string {
	const p = (fsPath ?? '').replace(/[\\/]+$/, '');
	const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
	return idx > 0 ? p.slice(0, idx) : '';
}

/**
 * 知识库目录（kbDir）是否已被现有 Vault「占用」：
 *  · 某 Vault 的根**就是**它；或
 *  · 某 Vault 的根在它**之下**（⇒ 它是已有 Vault 的公共父目录）。
 *
 * 未占用 ⇒ 新建 Vault 可以直接复用它（用户需求：「直接使用该目录即可」）。
 */
export function isKbDirOccupied(kbDirPath: string, vaultRootPaths: readonly string[]): boolean {
	const kb = (kbDirPath ?? '').replace(/[\\/]+$/, '').toLowerCase();
	if (!kb) { return true; }   // 路径未知 ⇒ 保守视为占用
	return vaultRootPaths.some(p => {
		const v = (p ?? '').replace(/[\\/]+$/, '').toLowerCase();
		if (!v) { return false; }
		return v === kb || parentDirOf(v) === kb;
	});
}

/**
 * 在给定「是否已用」判定下挑选不冲突的目录名：`name`、`name 2`、`name 3`…
 *
 * ⚠ 只避让**其它 Vault 已使用的路径**，不检查磁盘是否已有同名目录 —— 那正是
 * 「目录里已有内容就直接加载」的期望行为（复用而非另建一份）。
 */
export function nextVaultDirName(base: string, isTaken: (dirName: string) => boolean, maxTries = 100): string {
	const clean = base || '知识库';
	for (let i = 0; i < maxTries; i++) {
		const candidate = i === 0 ? clean : `${clean} ${i + 1}`;
		if (!isTaken(candidate)) { return candidate; }
	}
	return `${clean} ${Date.now()}`;
}
