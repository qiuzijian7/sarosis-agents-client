/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbNavigationParity.test.ts — 导航文件（`笔记/index.md` / `笔记/overview.md`）的**跨引擎对账**。
 *
 *  为什么要有它：这两个文件是**两侧视图共读**的导航产物 —— IDE 侧的 `maintainKbNavigation`
 *  与 dsh 侧插件（`dsh-plugins/vssaros-kb/lib/core/kbNavigation.js`）都会生成它们。
 *  两边只要差一个字符（少一个空行、类型排序换成 `localeCompare`、引号/注释没剥干净），
 *  用户就会看到"同一个库在两个界面里长得不一样"，而**两边都不会报错** ✗✗。
 *  ⇒ 本测试拿**真** `KbImportController.maintainKbIndex` / `maintainKbOverview` 在内存 FS 上生成一遍，
 *    钉成黄金串，并把同一份读数打成一行 `KB_NAV_GOLDEN {...}` 给 dsh 侧的对账探针消费
 *    （`poc/dsh-p0/scripts/p3-58-kb-navigation.mjs` ⇒ 逐字节比 ✓）。
 *
 *  运行方式：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/browser/kbNavigationParity.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

import { URI } from '../../../../base/common/uri.js';
import { KbImportController } from './kbImportController.js';

/* ------------------------------------------------------------------ *
 * 内存 FS（与 `kbImportControllerAgentSession.test.ts` 同一套 stub 口径）
 * ------------------------------------------------------------------ */

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
		async stat(uri: URI): Promise<any> { return service.resolve(uri); },
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

/**
 * 夹具（刻意把**每一条会影响输出的分支**都放进去）：
 *   · frontmatter `type`：普通值 / 带引号 + `#注释` / 缺失（⇒ 退化到目录名）✓
 *   · 层级：3 段（topic = 第 2 段）与 2 段（topic = `(直接)`）与 1 段（type = `(root)`）✓
 *   · 必须被排除的：系统导航文件（`index.md` / `知识体系.md`）、点开头的目录、非 `.md` 文件 ✓
 */
const NOTES_DIR = '/vault/笔记';
const FIXTURE: Record<string, string> = {
	[`${NOTES_DIR}/主题/概念/甲.md`]: '---\ntype: concept\ntitle: 甲\n---\n\n正文甲\n',
	[`${NOTES_DIR}/主题/概念/丁.md`]: '---\ntype: "concept" # 语义类型\n---\n\n正文丁\n',
	[`${NOTES_DIR}/主题/乙.md`]: '没有 frontmatter 的笔记\n',
	[`${NOTES_DIR}/丙.md`]: '---\ntitle: 丙\n---\n\n根级笔记（无 type ⇒ 落到 (root)）\n',
	[`${NOTES_DIR}/历史/旧事/戊.md`]: '---\ntype: history\n---\n\n正文戊\n',
	// ▼ 下面这些**不许**进索引 / 总览
	[`${NOTES_DIR}/index.md`]: '（系统导航文件，会被重写）\n',
	[`${NOTES_DIR}/知识体系.md`]: '（系统导航文件）\n',
	[`${NOTES_DIR}/.review/待审.md`]: '---\ntype: concept\n---\n\n不该被扫到\n',
	[`${NOTES_DIR}/主题/图.png`]: 'not markdown\n',
};

suite('kb 导航文件 · 跨引擎对账（真源读数）', () => {
	test('maintainKbIndex / maintainKbOverview 产出（黄金串 + 给 dsh 侧对账的读数行）', async () => {
		const fs = createFs(FIXTURE);
		const notesDir = URI.file(NOTES_DIR);
		await KbImportController.maintainKbIndex(fs.service, notesDir);
		await KbImportController.maintainKbOverview(fs.service, notesDir);

		const index = fs.content(`${NOTES_DIR}/index.md`) ?? '';
		const overview = fs.content(`${NOTES_DIR}/overview.md`) ?? '';

		// ★ 给 dsh 侧的对账读数（`p3-58` 解析这一行 ⇒ 与它自己生成的**逐字节**比 ✓）。
		// ⚠ 放在断言**之前**：黄金串在首次跑（或真源改动后）必然不等 ⇒ 断言一抛，
		//   后面的打印就不会执行 ⇒ 拿不到新读数（这是第一次写就踩过的坑 ✓）。
		// 连**夹具本体**一起带上（notesDir + 每个文件的相对路径与正文 ✓）⇒ dsh 侧探针用同一份字节跑自己的实现，
		// 不必复制夹具（复制就会有两份夹具各自漂移 ✗ ⇒ 那种"对账"其实对的是我抄的那份 ✓）。
		console.log(`KB_NAV_GOLDEN ${JSON.stringify({ notesDir: NOTES_DIR, fixture: FIXTURE, index, overview })}`);

		// 钉住真实现的产出（这两串是**跑出来的**读数，不是手推的 ✓；真源改了就得同步改这里）✓
		assert.strictEqual(index, GOLDEN_INDEX, 'index.md 产出与黄金串不一致');
		assert.strictEqual(overview, GOLDEN_OVERVIEW, 'overview.md 产出与黄金串不一致');
		// 排除规则必须真的生效（系统文件不许被索引成笔记 ✓）
		assert.ok(!index.includes('知识体系'), 'index.md 不该把系统导航文件当笔记');
		assert.ok(!index.includes('待审'), '点开头的目录不该被扫到');
		assert.ok(!index.includes('图.png'), '非 .md 不该被扫到');
	});
});

/**
 * 黄金串：由**真实现**在上面的夹具上产出（2026-10-13 读数，逐行来自 `KB_NAV_GOLDEN` 那一行 ✓）。
 *
 * ⚠ 注意 `## concept"` 那一组 —— 它不是笔误 ✓：夹具里 `丁.md` 的 frontmatter 是
 *   `type: "concept" # 语义类型`，而真源 `readNoteFrontmatterType`（`kbVaultFs.ts:844-846`）的**顺序**是
 *   "先剥首尾引号、再剥 `#注释`" ⇒ 结尾那个引号剥完后不再处于末尾 ⇒ 类型名就是 `concept"` ✗。
 *   这是真源的真实行为 ⇒ 我们**照抄**（dsh 侧同一顺序 ✓），而不是"顺手修好它" ✗ ——
 *   修了就会变成"同一个库在两个界面里分组不同"，且两边都不报错 ✓✓（这正是本测试存在的理由）。
 */
const GOLDEN_INDEX = [
	'# 知识库索引', '',
	'> 按 frontmatter `type` 语义分组。请勿手改。', '',
	'- 高层导航：[[overview]]　·　图谱洞察：[[insights]]', '',
	'## (root)',
	'- [[丙|丙]]', '',
	'## concept',
	'- [[主题/概念/甲|甲]]', '',
	'## concept"',
	'- [[主题/概念/丁|丁]]', '',
	'## history',
	'- [[历史/旧事/戊|戊]]', '',
	'## 主题',
	'- [[主题/乙|乙]]', '',
].join('\n');

const GOLDEN_OVERVIEW = [
	'# 知识库总览', '',
	'> 按 frontmatter `type` 语义分组。全量见 [[index]]，图谱洞察见 [[insights]]。', '',
	'> 共 **5** 篇笔记，**5** 个类型。', '',
	'## (root)（1 篇）',
	'- (直接)：1 篇 → [[index#(root)]]', '',
	'## concept（1 篇）',
	'- 概念：1 篇 → [[concept/概念]]', '',
	'## concept"（1 篇）',
	'- 概念：1 篇 → [[concept"/概念]]', '',
	'## history（1 篇）',
	'- 旧事：1 篇 → [[history/旧事]]', '',
	'## 主题（1 篇）',
	'- (直接)：1 篇 → [[index#主题]]', '',
].join('\n');
