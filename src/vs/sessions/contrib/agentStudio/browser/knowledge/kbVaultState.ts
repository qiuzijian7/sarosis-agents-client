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
