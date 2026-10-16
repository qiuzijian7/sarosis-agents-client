/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbBuildCacheParity.test.ts — 构建缓存 `.kb-build-cache.json` 的**跨引擎对账**（P1 验收）。
 *
 *  P1 的验收标准（doc/dsh-kb-build-orchestration.html §4 的 P1 行）是：
 *  **两侧对"待构建数量"给出同一个数**（同一夹具对账 ✓）。本测试提供"IDE 侧那个数"：
 *    ① 用**真** `collectPendingSources`（`knowledge/kbVaultFs.ts:97-122`）在同一夹具上数一遍 ⇒ 待构建清单；
 *    ② 用**真** `writeBuildCache` 写一份缓存 ⇒ 它的**字节**就是格式契约（`JSON.stringify(cache, null, 2)` ✓
 *       —— 两空格缩进、无尾换行 ✓），dsh 侧的 `serializeBuildCache` 必须逐字节相同 ✓。
 *
 *  ★ 缓存由**外部**喂进来（`KB_CACHE_PARITY_CACHE` 环境变量，JSON 文本 ✓）：
 *    因为"dsh 写出来的缓存长什么样"要先由 dsh 侧算出来（`poc/dsh-p0/scripts/p3-66-kb-build-cache.mjs` ✓），
 *    再交回 IDE 侧数一遍 ⇒ 这就是"**同一份缓存在两个引擎下的待构建数**" ✓✓（否则比的是两份不同输入 ✗）。
 *    未给该变量时按"没有缓存文件"跑（那就是夹具的**初始**状态 ⇒ 两个数都算得出来 ✓）。
 *
 *  运行方式：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/browser/kbBuildCacheParity.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

import { URI } from '../../../../base/common/uri.js';
import { collectPendingSources, writeBuildCache } from './knowledge/kbVaultFs.js';

/* 内存 FS（与 kbNavigationParity / kbInsightsParity 等同一套 stub 口径 ✓；这里**带可控 mtime** ✓） */
interface ISeedFile { content: string; mtime: number }

function createFs(seed: Record<string, ISeedFile | string>) {
	const files = new Map<string, ISeedFile>();
	const dirs = new Set<string>(['/']);
	const keyOf = (uri: URI) => uri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
	const addDir = (k: string) => {
		const segs = k.split('/').filter(Boolean);
		let acc = '';
		for (const s of segs) { acc += '/' + s; dirs.add(acc); }
	};
	for (const [p, v] of Object.entries(seed)) {
		const k = URI.file(p).fsPath.replace(/\\/g, '/');
		files.set(k, typeof v === 'string' ? { content: v, mtime: 100 } : v);
		addDir(k.split('/').slice(0, -1).join('/'));
	}
	const service: any = {
		async resolve(uri: URI): Promise<any> {
			const k = keyOf(uri);
			if (files.has(k)) {
				const f = files.get(k)!;
				return { resource: uri, name: k.split('/').pop(), isDirectory: false, mtime: f.mtime, size: f.content.length };
			}
			if (dirs.has(k) || k === '') {
				const prefix = k === '' ? '/' : k + '/';
				const children: any[] = [];
				const seen = new Set<string>();
				for (const d of dirs) {
					if (d === k || !d.startsWith(prefix)) { continue; }
					const seg = d.slice(prefix.length);
					if (!seg.includes('/') && !seen.has(seg)) { seen.add(seg); children.push({ resource: URI.file(prefix + seg), name: seg, isDirectory: true }); }
				}
				for (const [p, f] of files) {
					if (!p.startsWith(prefix)) { continue; }
					const rest = p.slice(prefix.length);
					const seg = rest.split('/')[0];
					if (rest.includes('/')) {
						if (!seen.has(seg)) { seen.add(seg); children.push({ resource: URI.file(prefix + seg), name: seg, isDirectory: true }); }
					} else if (!seen.has(seg)) {
						seen.add(seg);
						children.push({ resource: URI.file(p), name: seg, isDirectory: false, mtime: f.mtime, size: f.content.length });
					}
				}
				return { resource: uri, name: k.split('/').pop() ?? '', isDirectory: true, children };
			}
			throw new Error('not found: ' + k);
		},
		async readFile(uri: URI): Promise<{ value: { toString(): string; byteLength: number } }> {
			const f = files.get(keyOf(uri));
			if (!f) { throw new Error('not found'); }
			return { value: { toString: () => f.content, byteLength: f.content.length } };
		},
		async writeFile(uri: URI, value: { toString(): string }): Promise<void> {
			const k = keyOf(uri);
			files.set(k, { content: value.toString(), mtime: 200 });
			addDir(k.split('/').slice(0, -1).join('/'));
		},
		async createFolder(uri: URI): Promise<void> { addDir(keyOf(uri)); },
	};
	return { service: service as any, content: (p: string) => files.get(keyOf(URI.file(p)))?.content };
}

const VAULT = '/vault';
const fp = (p: string) => URI.file(p).fsPath;

/**
 * 夹具（刻意覆盖**新鲜度判据的三条分支** ✓）：
 *   · `甲素材.md`：缓存里有它，笔记存在且**比素材新** ⇒ 算已构建（不 pending ✓）；
 *   · `乙素材.md`：缓存里有它，笔记存在但**比素材旧**（素材构建后又被改过）⇒ pending（'素材在构建后被改过' ✓）；
 *   · `丙素材.md`：缓存里**没有** ⇒ pending（'未构建' ✓）；
 *   · `丁素材.md`：缓存指向的笔记**不存在** ⇒ pending（'笔记不存在' ✓）；
 *   · `笔记/丙素材.md`：**是别人的产出**（在缓存 value 里）⇒ 永不当素材（`skippedOutputs` ✓）。
 */
const FIXTURE: Record<string, ISeedFile | string> = {
	[`${VAULT}/库/raw/甲素材.md`]: { content: '# 甲素材\n', mtime: 100 },
	[`${VAULT}/库/raw/乙素材.md`]: { content: '# 乙素材\n', mtime: 300 },
	[`${VAULT}/库/raw/丙素材.md`]: { content: '# 丙素材\n', mtime: 100 },
	[`${VAULT}/库/raw/丁素材.md`]: { content: '# 丁素材\n', mtime: 100 },
	[`${VAULT}/库/raw/笔记/丙素材.md`]: { content: '# 这是某次构建的产出（在缓存 value 里）\n', mtime: 100 },
	[`${VAULT}/笔记/甲笔记.md`]: { content: '---\nsources:\n  - 甲素材.md\n---\n\n甲\n', mtime: 200 },
	[`${VAULT}/笔记/乙笔记.md`]: { content: '---\nsources:\n  - 乙素材.md\n---\n\n乙\n', mtime: 200 },
};

/** 初始缓存（"没有缓存文件"由环境变量缺席表达 ⇒ 那一轮 fixture 里会被注入空对象 ✓）。 */
const CACHE = {
	[fp(`${VAULT}/库/raw/甲素材.md`)]: fp(`${VAULT}/笔记/甲笔记.md`),
	[fp(`${VAULT}/库/raw/乙素材.md`)]: fp(`${VAULT}/笔记/乙笔记.md`),
	[fp(`${VAULT}/库/raw/丁素材.md`)]: fp(`${VAULT}/笔记/丁笔记（不存在）.md`),
	[fp(`${VAULT}/库/raw/戊素材.md`)]: fp(`${VAULT}/库/raw/笔记/丙素材.md`),
};

const logService: any = { info: () => {}, warn: () => {}, error: () => {} };
const notificationService: any = { info: () => {}, warn: () => {}, error: () => {} };
const agentStudioService: any = {};

suite('kb 构建缓存 · 跨引擎对账（真源读数）', () => {
	test('collectPendingSources 与 writeBuildCache 的产出（黄金读数行）', async () => {
		const envCache = process.env.KB_CACHE_PARITY_CACHE;
		const useCache = envCache ? JSON.parse(envCache) : undefined;
		const seed: Record<string, ISeedFile | string> = { ...FIXTURE };
		if (useCache) { seed[`${VAULT}/.kb-build-cache.json`] = JSON.stringify(useCache); }
		const fs = createFs(seed);
		const vaultRoot = URI.file(VAULT);

		const result = await collectPendingSources(fs.service, vaultRoot, logService, notificationService, agentStudioService);
		const pending = result.pending.map(u => u.fsPath.replace(/\\/g, '/')).sort();

		// 格式契约：真源 `writeBuildCache` 的**字节**（dsh 侧 `serializeBuildCache` 必须逐字节相同 ✓）
		await writeBuildCache(fs.service, vaultRoot, CACHE);
		const cacheBytes = fs.content(`${VAULT}/.kb-build-cache.json`)!;

		// ★ 读数（`p3-66` 拿同一份夹具跑我们的移植 ⇒ 比数＋比字节 ✓）
		// ⚠ 放在断言之前（首跑必然不等 ⇒ 断言一抛就拿不到读数 ✗ —— 前几轮踩过 ✓）。
		console.log('KB_CACHE_GOLDEN ' + JSON.stringify({
			vaultRoot: VAULT.replace(/\\/g, '/'),
			fixture: FIXTURE,
			cacheIn: useCache ?? null,
			pending,
			cacheBytes,
			libDir: result.libDir.fsPath.replace(/\\/g, '/'),
			notesDir: result.notesDir.fsPath.replace(/\\/g, '/'),
		}));

		// ★ 期望值的推导（第一版我写错过 ✗：**没有缓存**时不是 1 份，而是**全量 5 份** ✓）：
		//   无缓存 ⇒ 库区 5 个 .md 全算待构建 ✓；
		//   给了缓存 ⇒ 甲（笔记更新 ✓ 不算）／乙（素材 300 > 笔记 200 ⇒ 算 ✓）／丙（无条目 ⇒ 算 ✓）／
		//   丁（笔记不存在 ⇒ 算 ✓）／笔记/丙素材（是缓存 **value** ⇒ 永不当素材 ✓）⇒ 3 份 ✓。
		assert.strictEqual(pending.length, useCache ? 3 : 5, '两侧同一个数：给了 dsh 算出来的缓存后，待构建从 5 降到 3（素材改过 / 未构建 / 笔记不存在 各一 ✓）');
		assert.ok(cacheBytes.startsWith('{\n  "'), 'writeBuildCache 是两空格缩进（格式契约 ✓）');
		assert.ok(!cacheBytes.endsWith('\n'), '无尾换行（格式契约 ✓）');
	});
});
