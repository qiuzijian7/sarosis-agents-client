// @vssaros/dsh-web-content-import — store（主机侧 I/O）：数据根解析 + 知识库 vault 解析 + 落盘。
//
// 数据根口径与其它模块**逐字节同形**（`check-host-config` 的 B2 会逐字节比对 `lib/*.js` 里的
// `dataRootOf` —— 不许漂 ✗）。知识库根口径与 `@vssaros/dsh-kb` 一致：`config.kbRoot` →
// `<数据根>/knowledge-base`（与 IDE 侧 `knowledgeStorage.ts` 的默认一致 ✓）。

import { mkdir, readdir, stat } from 'node:fs/promises';
import { foundation } from './foundationRef.js';
import { homedir } from 'node:os';

import { join } from 'node:path';

import { atomicWriteFile } from './lock.js';


/** 数据根。优先级：`config.dataRoot` → 环境变量 → `~/.vssaros`。 */
export function dataRootOf(config) {
	// 委托到 @vssaros/dsh-foundation（重构 1.3：真源只有一份）；调用签名不变。
	return foundation().dataRootOf(config);
}

/** 知识库根：`config.kbRoot` → `<数据根>/knowledge-base`（与 `@vssaros/dsh-kb` 的 `kbRootOf` 同口径）。 */
export function kbRootOf(config) {
	const configured = typeof config?.kbRoot === 'string' ? config.kbRoot.trim() : '';
	return configured || join(dataRootOf(config), 'knowledge-base');
}

/** vault 目录名形态（与 `@vssaros/dsh-kb` 的 `isVaultId` 同值；插件间不能 import ⇒ 抄一份 ✓）。 */
const VAULT_ID_RE = /^\d{8,14}-[a-z0-9]+$/i;

/**
 * 选定 vault：显式 `vault` 优先；否则第一个 vault 目录（按名称序）。
 * 一个都没有 ⇒ `{ error }`（如实说"还没有知识库"，**不猜目录名** ✗）。
 */
export async function pickVaultDir(root, vault) {
	const want = typeof vault === 'string' ? vault.trim() : '';
	if (want) {
		if (!VAULT_ID_RE.test(want)) {
			return { error: `vault 名不合法：${want}（形态是 yyyyMMddHHmmss-随机）` };
		}
		const dir = join(root, want);
		const info = await stat(dir).catch(() => undefined);
		return info?.isDirectory() ? { id: want, dir } : { error: `没有这个库：${want}（${dir} 不存在）` };
	}
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (e) {
		return { error: `知识库根目录读取失败（${root}）：${e?.message ?? e}` };
	}
	const first = entries.filter(e => e.isDirectory() && VAULT_ID_RE.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))[0];
	return first
		? { id: first.name, dir: join(root, first.name) }
		: { error: `知识库根目录（${root}）下还没有任何库（vault 目录形如 yyyyMMddHHmmss-随机）` };
}

/**
 * 写素材（**原子写**）。⚠ 调用方必须已持有锁（`acquireFileLock`）—— 本函数只管"不半截"，
 * 不管"不丢更新"（那是锁的事 ✓，与 `vssaros-kanban` 的口径同 ✓）。
 * 落点与 IDE 侧 `kbUrlScraper` 逐字对齐：`<vault>/库/raw/<slug>.md`；图片目录 `<vault>/库/raw/assets/<slug>/`。
 */
export async function writeRawMarkdown(vaultDir, slug, markdown) {
	const dir = join(vaultDir, '库', 'raw');
	await mkdir(join(dir, 'assets', slug), { recursive: true });
	const file = join(dir, `${slug}.md`);
	await atomicWriteFile(file, markdown);
	return file;
}
