/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbGatingParity.test.ts — 去抽象化门控（`status: active / pending`）的**跨引擎对账**。
 *
 *  为什么要有它：门控决定"哪些派生笔记算正式、哪些算候选"，它读的是笔记 frontmatter 的
 *  `sources`（归一成小写 basename 后**去重计数**）、`title`（经 `aliases.json` **同义归一**）、
 *  `type`（只有 concept/comparison/synthesis/entity 四类被门控 ✓）。
 *  dsh 侧构建出来的笔记也带 frontmatter ⇒ 两边必须给出**同一套裁决**，
 *  否则"同一个库在两个界面里一批笔记的状态不一样"，而**两边都不报错** ✗✗。
 *  ⇒ 本测试拿**真** `applyDeabstractionGating` 在内存 FS 上跑一遍，把裁决前后的**文件内容**打成
 *    一行 `KB_GATING_GOLDEN {...}` 给 dsh 侧的对账探针消费（`poc/dsh-p0/scripts/p3-59-kb-gating.mjs` ✓）。
 *
 *  运行方式：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/browser/kbGatingParity.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

import { URI } from '../../../../base/common/uri.js';
import { applyDeabstractionGating } from './knowledge/kbVaultFs.js';

/* 内存 FS（与 `kbImportControllerAgentSession.test.ts` / `kbNavigationParity.test.ts` 同一套 stub 口径 ✓） */
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
const NOTES = `${VAULT}/笔记`;

/**
 * 夹具（刻意把**每条会影响裁决的分支**都放进去了）：
 *   · `sources` 的三种写法（块序列 / 流列表 / 单值）＋ 无 `sources` ＋ 重复来源（去重后只算 1 ✓）；
 *   · `title` 经 `aliases.json` 归一到同一 canonical（「GC机制」/「垃圾回收」⇒ 共享来源数 ⇒ 两篇一起转正式 ✓）；
 *   · 非门控类型（`howto`）**不许**被动 ✓；无 frontmatter 的笔记**不许**被动 ✓；
 *   · `sources` 已是 `status: active` 但来源不足 ⇒ 必须**降级**为 pending（`changed` 反向也要对 ✓）。
 */
const FIXTURE: Record<string, string> = {
	// ① 单来源 + 别名命中 ⇒ 与 ② 共享 canonical ⇒ 两篇 distinct=2 ⇒ 一起 active
	[`${NOTES}/概念/甲.md`]: '---\ntype: concept\ntitle: GC机制\nsources:\n  - [[库/概念/素材甲.md]]\n---\n\n正文甲\n',
	[`${NOTES}/概念/乙.md`]: '---\ntype: concept\ntitle: 垃圾回收\nsources: ["[[库/概念/素材乙.md]]"]\n---\n\n正文乙\n',
	// ③ 两个不同来源（流列表 + 重复项）⇒ distinct=2 ⇒ active；重复的那条不该把计数抬到 3
	[`${NOTES}/概念/丙.md`]: '---\ntype: concept\ntitle: 丙\nsources: [库/概念/素材丙.md, "[[库/概念/素材丁.md]]", 素材丙.md]\n---\n\n正文丙\n',
	// ④ 无 sources ⇒ distinct=0 ⇒ pending
	[`${NOTES}/概念/戊.md`]: '---\ntype: concept\ntitle: 戊\n---\n\n正文戊\n',
	// ⑤ 已是 active 但只有 1 个来源 ⇒ 必须降级 pending（"反向 also 对" ✓）
	[`${NOTES}/概念/己.md`]: '---\ntype: concept\ntitle: 己\nstatus: active\nsources: 库/概念/素材己.md\n---\n\n正文己\n',
	// ⑥ 非门控类型 ⇒ 一个字都不许动
	[`${NOTES}/实操/庚.md`]: '---\ntype: howto\ntitle: 庚\nsources:\n  - [[库/概念/素材甲.md]]\n---\n\n正文庚\n',
	// ⑦ 无 frontmatter ⇒ 读不到 type ⇒ 不许动
	[`${NOTES}/概念/辛.md`]: '没有 frontmatter 的笔记\n',
	// ⑧ 系统导航文件 ⇒ 不参与（真源 SYS_INDEX_FILES ✓）
	[`${NOTES}/index.md`]: '# 知识库索引\n',
	// 别名表在 **vault 根**（真源 `loadKbAliases(fileService, dirname(notesDir))` ✓）
	[`${VAULT}/aliases.json`]: JSON.stringify({ aliases: { 垃圾回收: ['GC机制', 'GarbageCollection'] } }, null, 2),
};

suite('kb 去抽象化门控 · 跨引擎对账（真源读数）', () => {
	test('applyDeabstractionGating 的裁决与落盘内容（黄金读数行）', async () => {
		const fs = createFs(FIXTURE);
		const result = await applyDeabstractionGating(fs.service, URI.file(NOTES));

		const after: Record<string, string> = {};
		for (const path of Object.keys(FIXTURE)) {
			const content = fs.content(path);
			if (typeof content === 'string') { after[path] = content; }
		}

		// ★ 给 dsh 侧的对账读数（`p3-59` 拿同一份夹具跑我们的实现 ⇒ 逐字节比 ✓）。
		// ⚠ 放在断言**之前**（首次跑时黄金值必然不等 ⇒ 断言一抛就拿不到读数 ✓，这坑在导航那轮踩过 ✓）。
		console.log(`KB_GATING_GOLDEN ${JSON.stringify({ notesDir: NOTES, vaultDir: VAULT, fixture: FIXTURE, result, after })}`);

		// 真源的裁决（计数随夹具走 ⇒ 这里钉的是"分布"，内容由 dsh 侧逐字节对账 ✓）
		assert.strictEqual(result.active + result.pending, 5, '被门控的笔记应为 5 篇（甲/乙/丙/戊/己）');
		assert.strictEqual(result.active, 3, '甲+乙（别名同 canon）与丙 ⇒ 3 篇正式');
		assert.strictEqual(result.pending, 2, '戊（无来源）与己（单来源）⇒ 2 篇候选');
		// 不许误伤非门控类型与无 frontmatter 的笔记
		assert.strictEqual(fs.content(`${NOTES}/实操/庚.md`), FIXTURE[`${NOTES}/实操/庚.md`], 'howto 不该被动');
		assert.strictEqual(fs.content(`${NOTES}/概念/辛.md`), FIXTURE[`${NOTES}/概念/辛.md`], '无 frontmatter 不该被动');
		assert.strictEqual(fs.content(`${NOTES}/index.md`), FIXTURE[`${NOTES}/index.md`], '系统导航文件不该被动');
		// 裁决确实落盘了（status 字段）
		assert.ok(/^status: active$/m.test(fs.content(`${NOTES}/概念/甲.md`) ?? ''), '甲应被写成 active');
		assert.ok(/^status: pending$/m.test(fs.content(`${NOTES}/概念/己.md`) ?? ''), '己应被降级为 pending');
	});
});
