/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbInsightsParity.test.ts — `insights.md`（知识图谱洞察）的**跨引擎对账**。
 *
 *  dsh 侧现在自己算社区（`dsh-plugins/vssaros-kb/lib/core/kbInsights.js` ＋ `kbCommunities.js` 是
 *  真源 `maintainKbInsights` / `communityDetection.ts` 的逐字移植 ✓），而 IDE 侧仍会重算它 ⇒
 *  两边必须**同形**，否则用户在两个界面看到不同的图谱划分，而**两边都不报错** ✗✗。
 *
 *  ★ 本测试的两条特殊职责：
 *    ① 把"**笔记顺序**"也交给 dsh 侧 ✗ —— 节点/边是**顺序敏感**的（真源建边时用的是"此刻已收集的节点集" ⇒
 *       指向**后面才出现**的笔记的链接会被丢掉 ✓）。顺序由真源同一函数 `collectMdFiles` 产出 ⇒
 *       这里直接用它取一份**有序清单**塞进读数，dsh 侧照单执行 ✓（否则对账比的是"两份不同输入" ✗）。
 *    ② `maintainKbInsights` **不传 chatModel** ⇒ 走真源"无模型"那一档（纯成员列表 ✓）⇒ 输出稳定可比 ✓。
 *
 *  运行方式：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/browser/kbInsightsParity.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

import { URI } from '../../../../base/common/uri.js';
import { KbImportController } from './kbImportController.js';
import { SYS_INDEX_FILES, collectMdFiles } from './knowledge/kbVaultFs.js';

/* 内存 FS（与 kbNavigationParity / kbGatingParity / kbEnrichParity 同一套 stub 口径 ✓） */
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

const NOTES = '/vault/笔记';

/**
 * 夹具（刻意覆盖每条判据与**两条顺序怪癖**）：
 *   · 节点命名四种：`title:` ✓ / `title: "带引号"` ✓ / 无 title ⇒ 文件名 ✓ / **正文中间**出现 `title:` 行（怪癖② ✓）；
 *   · 边过滤：正常 ✓ / `[[X|别名]]` ✓ / 取最后一段路径 `[[库/子/甲]]` ✓ / 自身 ⇒ 丢 ✓ / 不存在 ⇒ 丢 ✓ /
 *     **指向后面才出现的节点** ⇒ 丢（怪癖① ✓，`甲 → 丁` 就是这条）；
 *   · 社区：甲⇄乙、丙↔丁（+ 一条被丢的边 ⇒ 两边不对称 ✓）、戊 孤立（自己一个社区 ✓）。
 */
const FIXTURE: Record<string, string> = {
	[`${NOTES}/主题/甲.md`]: '---\ntitle: 甲\n---\n\n链到 [[乙]]、[[乙|别名]]，还有**后面才出现**的 [[丁]]（这条按顺序语义会被丢掉 ✓）与 [[不存在]]。\n',
	[`${NOTES}/主题/乙.md`]: '没有 frontmatter（节点名取文件名 ✓）：[[甲]] 与 [[甲|另一个别名]]（同一条边两次 ⇒ 权重 2 ✓）。\n',
	[`${NOTES}/主题/丙.md`]: '---\ntitle: 丙\n---\n\n链到 [[丁]]（丁在后面 ⇒ 这条**丢** ✓）。\n',
	[`${NOTES}/主题/丁.md`]: '---\ntitle: 丁\n---\n\n链到 [[丙]]（丙在前面 ⇒ **留** ✓）+ 自身 [[丁]]（丢 ✓）。\n',
	[`${NOTES}/主题/戊.md`]: '孤立节点（无 title ⇒ 用文件名 ✓、无链接 ✓）。\n',
	[`${NOTES}/主题/己.md`]: '开头没有 frontmatter。\n\ntitle: 己的别名（怪癖②：正文明文里的 title: 行也会被当成节点名 ✓）\n',
	[`${NOTES}/主题/庚.md`]: '---\ntitle: "庚"\n---\n\n带引号的 title（剥引号 ⇒ 庚 ✓）；[[库/子/甲]] 取最后一段 ⇒ 命中 甲 ✓。\n',
	// 不该进图的
	[`${NOTES}/index.md`]: '# 知识库索引\n',
	[`${NOTES}/主题/图.png`]: 'not markdown\n',
};

suite('kb 图谱洞察 · 跨引擎对账（真源读数）', () => {
	test('maintainKbInsights 的产出（黄金读数行）', async () => {
		const fs = createFs(FIXTURE);
		const notesDir = URI.file(NOTES);
		// ★ 用**真源同一个函数**取有序清单（顺序敏感 ⇒ 必须交给 dsh 侧同一份输入 ✓）
		const ordered = (await collectMdFiles(fs.service, notesDir, SYS_INDEX_FILES))
			.map(uri => uri.fsPath.replace(/\\/g, '/'));
		await KbImportController.maintainKbInsights(fs.service, notesDir);

		const after: Record<string, string> = {};
		for (const path of Object.keys(FIXTURE)) {
			const content = fs.content(path);
			if (typeof content === 'string') { after[path] = content; }
		}
		// ⚠ `insights.md` **不在**夹具里（它是产物 ×）⇒ 必须按路径**单独**取 ✗
		// （第一版从 `after` 里取 ⇒ 恒为空串 ⇒ 断言在"产物被写出来了吗"这一条上假红 ✓）。
		const insights = fs.content(`${NOTES}/insights.md`) ?? '';

		// ★ 读数（`p3-65` 拿同一份夹具与**同一份顺序**跑我们的移植 ⇒ 比到字节 ✓）。
		// ⚠ 放在断言之前（首跑必然不等 ⇒ 断言一抛就拿不到读数 ✗ —— 前几轮踩过 ✓）。
		console.log(`KB_INSIGHTS_GOLDEN ${JSON.stringify({ notesDir: NOTES, fixture: FIXTURE, ordered, insights, after })}`);

		assert.ok(insights.startsWith('# 知识图谱洞察\n'), 'insights.md 由真源写出');
		assert.ok(insights.includes('条链接'), '统计行在 ✓');
		assert.ok(insights.includes('- [[甲]]') && insights.includes('- [[乙]]'), '社区成员列表用 [[节点名]] ✓');
		assert.ok(insights.includes('*由 KbImportController 自动维护'), '末行出处是真源那句（dsh 侧会换成等价的、如实的版本 ✓）');
		assert.ok(!insights.includes('戊') === false, '孤立节点也要出现在某个社区里 ✓');
	});
});
