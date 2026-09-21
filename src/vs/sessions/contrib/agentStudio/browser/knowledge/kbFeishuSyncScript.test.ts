/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 知识库 → 飞书同步脚本（`resources/.agents/kb/feishu-sync.mjs`）的行为测试。
 *
 * 覆盖两类「必须正确」的保证：
 *  ① **内容保真**：frontmatter / 表格 / wikilink / 代码块 / 图片引用 经同步管线不被破坏；
 *  ② **位置调整**：本地改**文件名**、换**目录（类别）**、改**类别名**后，飞书侧应当是
 *     「更新同一文档 / 搬迁节点 / 复用知识库」，而**不是**「重复创建 / 误删远端 / 新建多余知识库」。
 *
 * ⚠ 该脚本按 `.mjs` 随产品分发（无类型声明）⇒ 用 `@ts-ignore` 抑制模块解析告警，
 *    断言其**运行时行为**（脚本与产品 TS 是两套运行时，这份测试正是两者之间的契约）。
 */

// @ts-ignore -- 资源脚本以 .mjs 分发，无 .d.ts 声明
import * as syncModule from '../../../../../../../resources/.agents/kb/feishu-sync.mjs';

/**
 * 统一按 `any` 使用：脚本是 `.mjs`（无类型声明），TS 只能推断出很弱的类型
 * （如 `files: {}`、`parseFeishuBlock(): {} | null`），直接断言具体字段会引出
 * 一堆「属性不存在 / 隐式 any 索引」的噪声错误。本测试关注的是**运行时行为**，
 * 故在此显式降级（TS 侧产品代码仍受严格检查）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sync: any = syncModule;
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── fixture ────────────────────────────────────────────────────────────────

/** 文档标识（脚本的 pickDocInfo 要求标识长度 > 6，故不能用 'T1' 之类短串）。 */
const TOKEN_A = 'TokA1234567890abc';
const SPACE_1 = 'SP1111111111';
const SPACE_2 = 'SP2222222222';

/** 建一个临时 vault 目录（不主动清理：交由系统回收，避免测试间相互干扰）。 */
function tmpVault(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'kbsync-test-'));
}

function writeFileEnsured(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, 'utf8');
}

/** 组装带 feishu 块的笔记（含无关 frontmatter 键，用于验证「不破坏其它字段」）。 */
function noteWith(block: Record<string, string>, body: string): string {
	const lines = ['---', 'title: 示例笔记', 'tags: [a, b]', 'feishu:', ...Object.entries(block).map(([k, v]) => `  ${k}: ${v}`), '---', '', body];
	return lines.join('\n');
}

/**
 * 建一个「已同步过一篇笔记」的 vault：
 * frontmatter 与索引都记录**真实内容指纹**（否则「未改动 ⇒ skip」的语义不成立）。
 */
function vaultWithSyncedNote(): { vault: string; src: string; note: string; rel: string; hash: string } {
	const vault = tmpVault();
	const src = '库/AI';
	const rel = `${src}/01-基础概念/笔记A.md`;
	const note = path.join(vault, ...rel.split('/'));
	const body = '# 标题\n\n正文内容。\n';

	writeFileEnsured(note, noteWith({ token: TOKEN_A }, body));
	const raw = fs.readFileSync(note, 'utf8');
	const hash = sync.contentHash(raw);       // 剥 frontmatter ⇒ 与写回后一致
	fs.writeFileSync(note, sync.upsertFeishuBlock(raw, {
		token: TOKEN_A, hash, space: SPACE_1, node: 'NodeA1234567', url: 'https://x/wiki/NodeA1234567',
	}), 'utf8');

	sync.saveIndex(vault, {
		spaces: { '01-基础概念': { spaceId: SPACE_1, name: '01-基础概念' } },
		files: { [rel]: { token: TOKEN_A, hash, space: SPACE_1, node: 'NodeA1234567', url: 'https://x/wiki/NodeA1234567' } },
	});
	return { vault, src, note, rel, hash };
}

// ─── ① 内容保真 ──────────────────────────────────────────────────────────────

suite('feishu-sync 脚本 · 内容保真', () => {

	suite('指纹口径（normalizeForHash / contentHash）', () => {
		test('剥 frontmatter：同步写回 frontmatter 不应被当成「内容变化」', () => {
			const body = '# 标题\n\n正文。\n';
			const a = `---\ntitle: x\n---\n\n${body}`;
			const b = `---\ntitle: x\nfeishu:\n  token: TokA1234567890\n  syncedAt: 2026-09-21\n---\n\n${body}`;
			assert.strictEqual(sync.contentHash(a), sync.contentHash(b));
		});

		test('换行差异（CRLF / LF）与行尾空白不影响指纹', () => {
			const lf = '# 标题\n\n正文。\n';
			const crlf = lf.replace(/\n/g, '\r\n') + '   \n';
			assert.strictEqual(sync.contentHash(lf), sync.contentHash(crlf));
		});

		test('本地绝对路径归一：换机器 / 挪目录后不应误判为内容变化', () => {
			const a = '见 ![](C:\\Users\\a\\img.png) 与 file:///c:/tmp/x.png';
			const b = '见 ![](D:\\other\\img.png) 与 file:///d:/yyy/x.png';
			assert.strictEqual(sync.contentHash(a), sync.contentHash(b));
		});

		test('正文真的变了 ⇒ 指纹必须变（否则同步会漏更新）', () => {
			assert.notStrictEqual(sync.contentHash('# A\n'), sync.contentHash('# B\n'));
		});
	});

	suite('frontmatter 读写', () => {
		test('无 frontmatter ⇒ 前置新块，正文逐字保留', () => {
			const raw = '# 标题\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
			const out = sync.upsertFeishuBlock(raw, { token: TOKEN_A });
			assert.ok(out.startsWith('---\nfeishu:\n  token: '));
			assert.ok(out.includes(raw.trim()), '正文必须完整保留');
		});

		test('已有其它 frontmatter 键 ⇒ 追加 feishu 块且不破坏其它键', () => {
			const raw = '---\ntitle: 示例笔记\ntags: [a, b]\n---\n\n正文。\n';
			const out = sync.upsertFeishuBlock(raw, { token: TOKEN_A, hash: 'H1' });
			assert.ok(out.includes('title: 示例笔记'));
			assert.ok(out.includes('tags: [a, b]'));
			assert.strictEqual(sync.parseFeishuBlock(sync.splitFrontmatter(out).frontmatter)!.token, TOKEN_A);
		});

		test('重复写入 ⇒ 只替换不重复（幂等）', () => {
			let raw = '# 标题\n';
			raw = sync.upsertFeishuBlock(raw, { token: TOKEN_A, hash: 'H1' });
			raw = sync.upsertFeishuBlock(raw, { token: TOKEN_A, hash: 'H2' });
			raw = sync.upsertFeishuBlock(raw, { token: TOKEN_A, hash: 'H3' });
			assert.strictEqual((raw.match(/^feishu:$/gm) ?? []).length, 1, 'feishu 块只应有一处');
			assert.strictEqual(sync.parseFeishuBlock(sync.splitFrontmatter(raw).frontmatter)!.hash, 'H3');
		});

		test('正文中的 `---` 水平线不影响正文完整性', () => {
			const raw = noteWith({ token: TOKEN_A }, '段落一\n\n---\n\n段落二\n');
			const { body } = sync.splitFrontmatter(raw);
			assert.ok(body.includes('段落一') && body.includes('段落二') && body.includes('---'));
		});
	});

	suite('markdown 预处理与表格', () => {
		test('表格内 [[目标|别名]] ⇒ 替换为别名（否则飞书按表格分隔符截断内容）', () => {
			const md = '| 项目 | 说明 |\n| --- | --- |\n| 双链 | [[00-首页|知识库首页]] |\n';
			const out = sync.prepareMarkdownForSync(md);
			assert.ok(out.includes('| 双链 | 知识库首页 |'), '别名替换后表格列数应保持');
			assert.ok(out.includes('| 项目 | 说明 |'), '表头不应被改动');
		});

		test('[[目标]]（无别名）保持原样（便于飞书内搜索定位）', () => {
			const out = sync.prepareMarkdownForSync('参见 [[某笔记]] 与 [[另一篇|别名]]。');
			assert.ok(out.includes('[[某笔记]]'));
			assert.ok(out.includes('别名') && !out.includes('[[另一篇|别名]]'));
		});

		test('普通表格 / 代码块 / 列表逐字保真（不含 wikilink 时）', () => {
			const md = [
				'| a | b |',
				'| --- | --- |',
				'| 1 | 2 |',
				'',
				'```js',
				'const x = 1 | 2;',
				'```',
				'',
				'- 列表项一',
				'- 列表项二',
			].join('\n');
			assert.strictEqual(sync.prepareMarkdownForSync(md), md);
		});
	});

	suite('图片引用抽取（extractImages）', () => {
		function dirWith(names: string[]): string {
			const dir = tmpVault();
			for (const n of names) { writeFileEnsured(path.join(dir, n), 'x'); }
			return dir;
		}

		test('Obsidian embed 与标准 md 图片都被替换为占位并登记', () => {
			const dir = dirWith(['a.png', 'b.jpg']);
			const { markdown, images } = sync.extractImages('图一 ![[a.png]] 图二 ![](b.jpg)', dir);
			assert.strictEqual(images.length, 2);
			assert.deepStrictEqual(images.map((i: { ref: string }) => i.ref), ['a.png', 'b.jpg']);
			assert.ok(!markdown.includes('![[a.png]]') && !markdown.includes('(b.jpg)'));
			assert.ok(markdown.includes(images[0].placeholder) && markdown.includes(images[1].placeholder));
			assert.ok(images.every((i: { absPath: string }) => fs.existsSync(i.absPath)));
		});

		test('多图占位编号递增且与 images 顺序一致', () => {
			const dir = dirWith(['1.png', '2.png', '3.png']);
			const { markdown, images } = sync.extractImages('![](1.png) ![](2.png) ![](3.png)', dir);
			assert.deepStrictEqual(images.map((i: { placeholder: string }) => i.placeholder),
				['KBSYNCIMG1', 'KBSYNCIMG2', 'KBSYNCIMG3']);
			assert.ok(markdown.indexOf('KBSYNCIMG1') < markdown.indexOf('KBSYNCIMG2'));
		});

		test('文件不存在 ⇒ 保留原引用并记入 missing（调用方据此告警，避免「以为已同步」）', () => {
			const { markdown, images, missing } = sync.extractImages('![](missing.png)', dirWith([]));
			assert.strictEqual(images.length, 0);
			assert.deepStrictEqual(missing, ['missing.png']);
			assert.ok(markdown.includes('![](missing.png)'));
		});

		test('独占段落引用 ⇒ 占位独立成段（block_replace 是整块替换，必须独占）', () => {
			const { markdown, images, inline } = sync.extractImages('正文\n\n![[a.png]]\n\n后续', dirWith(['a.png']));
			assert.strictEqual(images.length, 1);
			assert.strictEqual(images[0].standalone, true);
			assert.deepStrictEqual(inline, []);
			assert.ok(markdown.includes('\n\nKBSYNCIMG1\n\n'), '占位应被空行包裹而独占段落');
		});

		test('行内/表格内引用 ⇒ 标记 inline（无法自动插入，保留占位文本以便人工定位）', () => {
			const r = sync.extractImages('| 表格 | ![](a.png) | 单元 |', dirWith(['a.png']));
			assert.strictEqual(r.images[0].standalone, false);
			assert.deepStrictEqual(r.inline, ['a.png']);
			assert.ok(r.markdown.includes('KBSYNCIMG1'));
		});

		test('远程 / 绝对路径 / 非图片双链 ⇒ 一律不处理', () => {
			const md = '![](https://x/y.png) ![](C:\\abs\\z.png) ![[某笔记]] ![[note.png.md]]';
			const { markdown, images } = sync.extractImages(md, dirWith(['a.png']));
			assert.strictEqual(images.length, 0);
			assert.strictEqual(markdown, md);
		});
	});
});

// ─── ② 位置调整：改名 / 移动 / 类别改名 ──────────────────────────────────────

suite('feishu-sync 脚本 · 改名 / 移动 / 类别改名', () => {

	suite('类别推导（categoryOf）', () => {
		test('默认取 src 下第 1 级目录；更深层级可选', () => {
			assert.strictEqual(sync.categoryOf('库/AI/01-基础概念/子/笔记.md', '库/AI', 1), '01-基础概念');
			assert.strictEqual(sync.categoryOf('库/AI/01-基础概念/子/笔记.md', '库/AI', 2), '01-基础概念/子');
		});
		test('文件直接在 src 根下 ⇒ null（走默认落点，不新建知识库）', () => {
			assert.strictEqual(sync.categoryOf('库/AI/00-首页.md', '库/AI', 1), null);
		});
		test('depth = 0 ⇒ 不分类别；src 前缀不匹配 ⇒ null', () => {
			assert.strictEqual(sync.categoryOf('库/AI/01-x/a.md', '库/AI', 0), null);
			assert.strictEqual(sync.categoryOf('库/别的/01-x/a.md', '库/AI', 1), null);
		});
	});

	suite('索引读写与 v1 迁移', () => {
		test('缺失或损坏的索引 ⇒ 空 v2 结构（不抛错）', () => {
			const vault = tmpVault();
			assert.deepStrictEqual(sync.loadIndex(vault), { version: 2, spaces: {}, files: {} });
			fs.writeFileSync(path.join(vault, '.feishu-sync.json'), '{ not json', 'utf8');
			assert.deepStrictEqual(sync.loadIndex(vault), { version: 2, spaces: {}, files: {} });
		});
		test('v1 扁平结构自动迁移进 files', () => {
			const vault = tmpVault();
			fs.writeFileSync(path.join(vault, '.feishu-sync.json'),
				JSON.stringify({ '库/AI/a.md': { token: TOKEN_A, hash: 'H1' } }), 'utf8');
			const idx = sync.loadIndex(vault);
			assert.strictEqual(idx.version, 2);
			assert.strictEqual(idx.files['库/AI/a.md'].token, TOKEN_A);
			assert.deepStrictEqual(idx.spaces, {});
		});
		test('saveIndex → loadIndex 往返保留 spaces 与 files', () => {
			const vault = tmpVault();
			sync.saveIndex(vault, {
				spaces: { '01-x': { spaceId: SPACE_1, name: '01-x' } },
				files: { '库/AI/01-x/a.md': { token: TOKEN_A, hash: 'H1', space: SPACE_1, node: 'N1' } },
			});
			const back = sync.loadIndex(vault);
			assert.strictEqual(back.spaces['01-x'].spaceId, SPACE_1);
			assert.strictEqual(back.files['库/AI/01-x/a.md'].node, 'N1');
		});
	});

	suite('★ 改名 / 移动后「更新而非重复创建」', () => {
		test('已同步文档：内容未变 ⇒ skip；内容变化 ⇒ update（都不会 create）', () => {
			const { vault, src, note } = vaultWithSyncedNote();
			const idx = sync.loadIndex(vault);

			let plan = sync.collectPlan(vault, [src], { categoryDepth: 1, index: idx });
			assert.strictEqual(plan.length, 1);
			assert.strictEqual(plan[0].action, 'skip', 'frontmatter 回写不应触发 update');

			fs.appendFileSync(note, '\n新增一段。\n', 'utf8');
			plan = sync.collectPlan(vault, [src], { categoryDepth: 1, index: sync.loadIndex(vault) });
			assert.strictEqual(plan[0].action, 'update');
		});

		test('改文件名后仍识别为同一文档（绝不 create ⇒ 不重复创建）', () => {
			const { vault, src, note, rel } = vaultWithSyncedNote();
			const renamedRel = `${src}/01-基础概念/笔记A-改名.md`;
			fs.renameSync(note, path.join(vault, ...renamedRel.split('/')));
			fs.appendFileSync(path.join(vault, ...renamedRel.split('/')), '\n改名后顺带改内容。\n', 'utf8');

			const plan = sync.collectPlan(vault, [src], { categoryDepth: 1, index: sync.loadIndex(vault) });
			assert.strictEqual(plan.length, 1);
			assert.strictEqual(plan[0].rel, renamedRel);
			assert.strictEqual(plan[0].action, 'update', 'token 随文件移动 ⇒ 更新原文档');
			assert.strictEqual(plan[0].feishu.token, TOKEN_A);
			assert.strictEqual(plan[0].prevSpace, SPACE_1, '★ 靠 token 反查恢复历史落点');
			assert.notStrictEqual(rel, renamedRel);
		});

		test('改文件名但内容未变且未记录标题 ⇒ skip（不会无谓重传正文）', () => {
			const { vault, src, note } = vaultWithSyncedNote();
			fs.renameSync(note, path.join(path.dirname(note), '笔记A2.md'));
			const plan = sync.collectPlan(vault, [src], { categoryDepth: 1, index: sync.loadIndex(vault) });
			assert.strictEqual(plan[0].action, 'skip');
			assert.strictEqual(plan[0].prevTitle, '', 'fixture 未记录 feishu.title');
		});

		test('★ 文件名（标题）变化 ⇒ 提升为 update（否则远端标题永远不跟随）', () => {
			const base = vaultWithSyncedNote();
			// 模拟「已同步过一次」：frontmatter 的 feishu 块里记录标题
			const raw = fs.readFileSync(base.note, 'utf8');
			fs.writeFileSync(base.note, sync.upsertFeishuBlock(raw, {
				token: TOKEN_A, hash: base.hash, title: '笔记A', space: SPACE_1, node: 'NodeA1234567',
			}), 'utf8');

			fs.renameSync(base.note, path.join(path.dirname(base.note), '笔记A-新名.md'));   // 只改文件名
			const plan = sync.collectPlan(base.vault, [base.src], { categoryDepth: 1, index: sync.loadIndex(base.vault) });

			assert.strictEqual(plan[0].action, 'update', '标题变化必须触发 update 通路（内含 drive +update-title）');
			assert.strictEqual(plan[0].prevTitle, '笔记A');
			assert.strictEqual(plan[0].title, '笔记A-新名');
			assert.notStrictEqual(plan[0].action, 'create', '仍是同一篇文档');
		});

		test('标题未变 ⇒ 维持 skip（不给正常同步增加 API 调用）', () => {
			const base = vaultWithSyncedNote();
			const raw = fs.readFileSync(base.note, 'utf8');
			fs.writeFileSync(base.note, sync.upsertFeishuBlock(raw, {
				token: TOKEN_A, hash: base.hash, title: '笔记A', space: SPACE_1, node: 'NodeA1234567',
			}), 'utf8');
			const plan = sync.collectPlan(base.vault, [base.src], { categoryDepth: 1, index: sync.loadIndex(base.vault) });
			assert.strictEqual(plan[0].action, 'skip');
			assert.strictEqual(plan[0].prevTitle, plan[0].title);
		});

		test('改名后索引旧条目必须可迁移（否则 --prune 会误删远端节点）', () => {
			const { vault, src, note, rel } = vaultWithSyncedNote();
			const renamedRel = `${src}/01-基础概念/笔记A-改名.md`;
			fs.renameSync(note, path.join(vault, ...renamedRel.split('/')));

			const idx = sync.loadIndex(vault);
			const plan = sync.collectPlan(vault, [src], { categoryDepth: 1, index: idx });
			const moved = sync.migrateIndexEntries(idx, plan);

			assert.strictEqual(moved.length, 1);
			assert.deepStrictEqual([moved[0].from, moved[0].to], [rel, renamedRel]);
			assert.strictEqual(moved[0].token, TOKEN_A);
			assert.ok(!idx.files[rel], '旧路径条目必须被移除（prune 才不会当成「本地已删除」）');
			assert.ok(idx.files[renamedRel], '★ 新路径条目必须存在（迁移而非删除）——否则后续读不到 prevSpace，位置调整将永久失效');
			assert.strictEqual(idx.files[renamedRel].space, SPACE_1, '迁移应保留历史落点');
		});
	});

	suite('★ 换目录（换类别）⇒ 目标知识库与搬迁判定', () => {
		const SPACES = {
			'01-基础概念': { spaceId: SPACE_1, name: '01-基础概念' },
			'02-架构设计': { spaceId: SPACE_2, name: '02-架构设计' },
		};

		function moveToCategory(category: string, newName = '笔记A.md') {
			const base = vaultWithSyncedNote();
			const to = `${base.src}/${category}/${newName}`;
			fs.mkdirSync(path.dirname(path.join(base.vault, ...to.split('/'))), { recursive: true });
			fs.renameSync(base.note, path.join(base.vault, ...to.split('/')));
			const idx = sync.loadIndex(base.vault);
			const plan = sync.collectPlan(base.vault, [base.src], { categoryDepth: 1, index: idx });
			return { ...base, to, idx, plan };
		}

		test('类别更新为目标知识库，且判定需要跨库搬迁', () => {
			const { plan } = moveToCategory('02-架构设计');
			sync.computeTargets(plan, SPACES);
			assert.strictEqual(plan[0].category, '02-架构设计');
			assert.strictEqual(plan[0].targetSpace, SPACE_2);
			assert.strictEqual(plan[0].prevSpace, SPACE_1, '★ token 反查得到上次落点');
			assert.strictEqual(plan[0].needsMove, true, 'SP1 → SP2 ⇒ 必须 move');
			assert.strictEqual(plan[0].action, 'skip', '内容未变 ⇒ 只搬迁不重写正文');
		});

		test('同时改名 + 换目录 ⇒ 仍是 skip（不重复创建）且索引可迁移', () => {
			const { plan, idx, rel, to } = moveToCategory('02-架构设计', '笔记B.md');
			sync.computeTargets(plan, SPACES);
			assert.strictEqual(plan[0].action, 'skip');
			assert.notStrictEqual(plan[0].action, 'create');
			assert.strictEqual(plan[0].targetSpace, SPACE_2);
			assert.strictEqual(plan[0].needsMove, true);
			assert.deepStrictEqual(sync.migrateIndexEntries(idx, plan)[0].to, to);
			assert.notStrictEqual(rel, to);
		});

		test('仍在原类别 ⇒ 无需搬迁（避免无谓 move 调用）', () => {
			const { vault, src } = vaultWithSyncedNote();
			const plan = sync.collectPlan(vault, [src], { categoryDepth: 1, index: sync.loadIndex(vault) });
			sync.computeTargets(plan, SPACES);
			assert.strictEqual(plan[0].targetSpace, SPACE_1);
			assert.strictEqual(plan[0].needsMove, false);
		});

		test('未映射类别 ⇒ targetSpace 为 null（调用方据此跳过或自动建库）', () => {
			const { plan } = moveToCategory('03-核心组件');
			sync.computeTargets(plan, SPACES);
			assert.strictEqual(plan[0].targetSpace, null);
			assert.strictEqual(plan[0].needsMove, false, '没有目标知识库 ⇒ 无从搬迁');
		});

		test('★ prevSpace 为空（无历史记录）⇒ 不搬迁（避免刚落点就自我 move）', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const plan: any[] = [{ rel: 'x.md', action: 'skip', category: '02-架构设计', prevSpace: '', prevNode: '' }];
			sync.computeTargets(plan, SPACES, 'my_library');
			assert.strictEqual(plan[0].targetSpace, SPACE_2);
			assert.strictEqual(plan[0].needsMove, false);
		});

		test('无类别（src 根下）⇒ 落点由 parentSpace 决定（my_library 可被 wiki 识别）', () => {
			const vault = tmpVault();
			writeFileEnsured(path.join(vault, '库/AI/根笔记.md'), '# 根笔记\n');
			const plan = sync.collectPlan(vault, ['库/AI'], { categoryDepth: 1, index: sync.loadIndex(vault) });
			sync.computeTargets(plan, SPACES, 'my_library');
			assert.strictEqual(plan[0].targetSpace, 'my_library');
			assert.strictEqual(plan[0].needsMove, false, '新建文档不搬迁');
			sync.computeTargets(plan, SPACES, '');
			assert.strictEqual(plan[0].targetSpace, null, '非 my_library 落点（folder token）无 wiki 目标');
		});

		test('新建文档（无 token）不参与搬迁，直接落到目标知识库', () => {
			const vault = tmpVault();
			writeFileEnsured(path.join(vault, '库/AI/01-x/新笔记.md'), '# 新笔记\n');
			const plan = sync.collectPlan(vault, ['库/AI'], { categoryDepth: 1, index: sync.loadIndex(vault) });
			sync.computeTargets(plan, { '01-x': { spaceId: SPACE_1, name: '01-x' } });
			assert.strictEqual(plan[0].action, 'create');
			assert.strictEqual(plan[0].targetSpace, SPACE_1);
			assert.strictEqual(plan[0].needsMove, false);
		});
	});

	suite('★ 类别（目录）改名 ⇒ 复用原知识库，不新建', () => {
		test('目录改名后原 spaceId 被复用（映射键迁移），文档无需搬迁', () => {
			const base = vaultWithSyncedNote();
			const to = `${base.src}/01-基础概念-新/笔记A.md`;
			fs.mkdirSync(path.dirname(path.join(base.vault, ...to.split('/'))), { recursive: true });
			fs.renameSync(base.note, path.join(base.vault, ...to.split('/')));

			const idx = sync.loadIndex(base.vault);
			const plan = sync.collectPlan(base.vault, [base.src], { categoryDepth: 1, index: idx });
			assert.strictEqual(plan[0].category, '01-基础概念-新');
			assert.strictEqual(plan[0].prevSpace, SPACE_1, '★ token 反查提供历史落点，才能识别「这是同一次改名」');

			const renamed = sync.migrateSpaceMappings(idx.spaces, plan);
			assert.strictEqual(renamed.length, 1);
			assert.deepStrictEqual([renamed[0].from, renamed[0].to, renamed[0].spaceId],
				['01-基础概念', '01-基础概念-新', SPACE_1]);
			assert.strictEqual(idx.spaces['01-基础概念'], undefined, '旧键应被移除（不留下空壳映射）');
			assert.strictEqual(idx.spaces['01-基础概念-新'].spaceId, SPACE_1, '复用同一知识库 ⇒ 不新建');

			sync.computeTargets(plan, idx.spaces);
			assert.strictEqual(plan[0].targetSpace, SPACE_1);
			assert.strictEqual(plan[0].needsMove, false, '复用原知识库 ⇒ 无需搬迁');
		});

		test('★ 旧类别目录仍存在 ⇒ 不迁移（区分「文档换目录」与「目录改名」）', () => {
			const plan = [{ category: '02-新', prevSpace: SPACE_1, action: 'skip' }];
			const spaces: Record<string, { spaceId: string }> = { '01-旧': { spaceId: SPACE_1 } };
			// 旧目录仍在 ⇒ 这是「文档换目录」⇒ 不应复用旧知识库（否则新类别不会建库、文档也搬不过去）
			assert.deepStrictEqual(sync.migrateSpaceMappings(spaces, plan, { categoryExists: () => true }), []);
			assert.strictEqual(spaces['02-新'], undefined);
			// 旧目录已消失 ⇒ 这是「目录改名」⇒ 复用同一知识库
			assert.deepStrictEqual(sync.migrateSpaceMappings(spaces, plan, { categoryExists: () => false }), [
				{ from: '01-旧', to: '02-新', spaceId: SPACE_1 },
			]);
		});

		test('类别名未变 ⇒ 不迁移；仅处理未映射类别', () => {
			const plan = [
				{ category: '01-基础概念', prevSpace: SPACE_1, action: 'skip' },
				{ category: '02-新', prevSpace: SPACE_2, action: 'update' },
			];
			const spaces: Record<string, { spaceId: string }> = { '01-基础概念': { spaceId: SPACE_1 }, '02-架构设计': { spaceId: SPACE_2 } };
			const renamed = sync.migrateSpaceMappings(spaces, plan);
			assert.deepStrictEqual(renamed.map((r: { to: string }) => r.to), ['02-新']);
			assert.strictEqual(spaces['02-新'].spaceId, SPACE_2);
		});

		test('无历史空间（v1 索引 / 首次同步）⇒ 不迁移，交给「自动建库」', () => {
			const plan = [{ category: '01-新', prevSpace: undefined, action: 'update' }];
			const spaces: Record<string, { spaceId: string }> = { '01-旧': { spaceId: SPACE_1 } };
			assert.deepStrictEqual(sync.migrateSpaceMappings(spaces, plan), []);
			assert.strictEqual(spaces['01-新'], undefined);
		});
	});

	suite('返回解析兼容（pickDocInfo · 事故防回归）', () => {
		test('识别 doc_id / document_id / node_token 与 doc_url / url', () => {
			const cases: Array<[Record<string, unknown>, string, string]> = [
				[{ data: { doc_id: TOKEN_A, doc_url: 'https://x/wiki/' + TOKEN_A } }, TOKEN_A, 'https://x/wiki/' + TOKEN_A],
				[{ data: { document_id: 'DocB1234567890' } }, 'DocB1234567890', ''],
				[{ data: { node_token: 'NodeC123456789', url: 'https://y/wiki/NodeC123456789' } }, 'NodeC123456789', 'https://y/wiki/NodeC123456789'],
			];
			for (const [payload, token, url] of cases) {
				const info = sync.pickDocInfo(payload);
				assert.strictEqual(info.token, token);
				if (url) { assert.strictEqual(info.url, url); }
			}
		});

		test('无标识 ⇒ 返回空 token（调用方必须据此报错，绝不静默记账）', () => {
			assert.strictEqual(sync.pickDocInfo({ data: {} }).token, '');
		});
	});
});
