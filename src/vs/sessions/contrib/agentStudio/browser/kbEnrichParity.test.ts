/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbEnrichParity.test.ts — 确定性补链（`enrichWikilinks`）的**跨引擎对账**。
 *
 *  它把正文里**整词出现**的其它笔记标题包成 `[[标题]]` ⇒ 知识图谱多一条边 ✓。
 *  两侧（IDE 的导入/构建路径 与 dsh 侧的 plguin）都做这件事 ⇒ 判据必须逐条一致：
 *  跳代码块 ✓、已有 `[[…]]` 不重复 ✓、自身标题不补 ✓、标题 < 2 字符不补 ✓、只在正文（frontmatter 外）替换 ✓。
 *  差一条就会出现"同一个库在两边图谱边数不同"，而**两边都不报错** ✗✗。
 *
 *  运行方式：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/browser/kbEnrichParity.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

import { URI } from '../../../../base/common/uri.js';
import { enrichWikilinks } from './knowledge/enrichWikilinks.js';

/* 内存 FS（与 kbNavigationParity / kbGatingParity 同一套 stub 口径 ✓） */
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
			if (dirs.has(k) || k === '') { return { resource: uri, name: k.split('/').pop() ?? '', isDirectory: true, children: [] }; }
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
	};
	return { service: service as any, content: (p: string) => files.get(keyOf(URI.file(p)))?.content };
}

const NOTES = '/vault/笔记';

/**
 * 夹具（每条判据一个位）：
 *   · 目标里同时出现：可补的标题 ✓、**代码块内**的同名文字（不许动 ✓）、**已有** `[[…]]` ✓、**自身**标题 ✓、1 字标题 ✓；
 *   · 候选来自其它笔记的**文件名** ✓（含 1 字的 `甲.md` ⇒ 长度 < 2 不补 ✓）；
 *   · 一个**无 frontmatter** 的目标（走 `rawBlock === ''` 那条分支 ✓）；
 *   · 非 `.md` 文件与系统导航文件（不该成为候选 ✓）。
 */
const FIXTURE: Record<string, string> = {
	[`${NOTES}/概念/垃圾回收.md`]: '# 垃圾回收\n\n正文（候选，不该被自己补链）\n',
	[`${NOTES}/概念/GC机制.md`]: '# GC机制\n\n正文\n',
	[`${NOTES}/概念/内存池.md`]: '# 内存池\n\n正文\n',
	[`${NOTES}/概念/甲.md`]: '# 甲\n\n正文\n',
	// 目标 ①：普通笔记（含可补标题、代码块、已有链接）
	[`${NOTES}/主题/目标甲.md`]: [
		'---',
		'type: concept',
		'title: 目标甲',
		'---',
		'',
		'垃圾回收 与 GC机制 都值得看看。',
		'下面这段代码里的 GC机制 不许动：',
		'```js',
		'const gc = "GC机制";',
		'```',
		'已经链过的 [[内存池]] 不许重复；自己 目标甲 也不补；单字 甲 不补。',
		'',
	].join('\n'),
	// 目标 ②：**无 frontmatter**（rawBlock 为空那条分支）
	[`${NOTES}/主题/目标乙.md`]: '没有任何 frontmatter，但提到 内存池 与 GC机制。\n',
	// 目标 ③：已有 [[GC机制|别名]] 形式 ⇒ 整条候选跳过（不再补裸的 GC机制 ✓）
	[`${NOTES}/主题/目标丙.md`]: '---\ntitle: 目标丙\n---\n\nGC机制 已经有了：[[GC机制|见这里]]，正文里再写 GC机制 也不该变成裸链接之外的东西。\n',
	// 不该成为候选的
	[`${NOTES}/index.md`]: '# 知识库索引\n',
	[`${NOTES}/主题/图.png`]: 'not markdown\n',
};

suite('kb 确定性补链 · 跨引擎对账（真源读数）', () => {
	test('enrichWikilinks 的产出（黄金读数行）', async () => {
		const fs = createFs(FIXTURE);
		const targets = ['目标甲', '目标乙', '目标丙'].map(name => URI.file(`${NOTES}/主题/${name}.md`));
		const allNotes = Object.keys(FIXTURE)
			.filter(path => path.startsWith(`${NOTES}/`) && path.endsWith('.md'))
			.map(path => URI.file(path));
		const results = await enrichWikilinks(fs.service, targets, allNotes);

		const after: Record<string, string> = {};
		for (const path of Object.keys(FIXTURE)) {
			const content = fs.content(path);
			if (typeof content === 'string') { after[path] = content; }
		}

		// ★ 给 dsh 侧的对账读数（`p3-62` 拿同一份夹具跑我们的实现 ⇒ 逐字节比 ✓）。
		// ⚠ 放在断言之前（首跑黄金值必然不等 ⇒ 断言一抛就拿不到读数 ✗ —— 前两轮都踩过 ✓）。
		console.log(`KB_ENRICH_GOLDEN ${JSON.stringify({
			notesDir: NOTES,
			fixture: FIXTURE,
			targets: ['目标甲', '目标乙', '目标丙'].map(name => `${NOTES}/主题/${name}.md`),
			// 候选来源（= 传进 `enrichWikilinks` 的 allNotes ✓）也带上 ⇒ dsh 侧用**同一份输入**跑 ⇒ 才算对账 ✓
			allNotes: allNotes.map(note => note.fsPath.replace(/\\/g, '/')),
			added: results.map(r => ({ path: r.note.fsPath.replace(/\\/g, '/'), titles: r.added })),
			after,
		})}`);

		// ⚠ 只有 **2** 篇有新增 ✓（不是 3 ✗ —— 我第一版写错的是**断言**）：
		//   目标丙 里 `GC机制` 已经出现过 `[[GC机制|见这里]]` ⇒ 按判据④**整条候选跳过** ⇒
		//   它正文里第二处裸的 `GC机制` **也不会**被补 ✓（真源行为，照抄 ✓）。这条正好把判据④钉住了 ✓。
		assert.strictEqual(results.length, 2, '只有目标甲/乙有新增（目标丙因已有 [[GC机制|…]] 而整条跳过 ✓）');
		assert.deepStrictEqual(
			results.map(r => r.added.join(',')).sort(),
			['垃圾回收,GC机制', 'GC机制,内存池'].sort(),   // ⚠ 组内顺序也是真源定的（候选按 Map 插入序 ✓）
			'新增的标题集合与真源一致（候选按文件名去扩展名 ✓、自身与 1 字标题被跳过 ✓）',
		);
		assert.ok(fs.content(`${NOTES}/概念/垃圾回收.md`) === FIXTURE[`${NOTES}/概念/垃圾回收.md`], '非目标笔记一个字不许动');
		assert.ok(!(fs.content(`${NOTES}/主题/目标甲.md`) ?? '').includes('```js\nconst gc = "[[GC机制]]"'), '代码块内不许补链');
		assert.ok(!(fs.content(`${NOTES}/主题/目标甲.md`) ?? '').includes('[[目标甲]]'), '自身标题不许补');
		assert.ok(!(fs.content(`${NOTES}/主题/目标甲.md`) ?? '').includes('[[甲]]'), '1 字标题不许补');
	});
});
