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

// 同一份「映射文件」契约的 TS 侧实现（设置面板用它读写 vault 内配置）——与脚本端语义必须一致
import { parseSpaceMap, serializeSpaceMap, parseSpaceList, sanitizeSpaceName, parseCreatedSpaceId } from './feishuSyncCore.js';
// URL 导入纯函数（slug / 图片路径 / HTML 兜底）：与飞书同步同属「知识库 ↔ 外部内容」链路，统一在此回归
import { slugifyTitle, planImagePath, htmlToPlainText, parseYtDlpPrint, parseSubtitlesToText } from '../views/knowledgeBase/kbUrlScraper.js';
import { detectYtDlp, fetchVideoMeta } from './kbVideoFetch.js';
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
			assert.deepStrictEqual(sync.loadIndex(vault), { version: 2, spaces: {}, files: {}, mindmaps: {} });
			fs.writeFileSync(path.join(vault, '.feishu-sync.json'), '{ not json', 'utf8');
			assert.deepStrictEqual(sync.loadIndex(vault), { version: 2, spaces: {}, files: {}, mindmaps: {} });
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

	suite('★ 用户自定义「目录 ↔ 知识库」映射', () => {
		test('最长前缀匹配：更具体的目录优先', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const plan: any[] = [{ rel: '库/AI/01-x/a.md' }, { rel: '库/AI/02-y/b.md' }];
			const spaces: Record<string, { spaceId: string; name?: string }> = {};
			const applied = sync.applyExplicitMappings(plan, spaces, [
				{ dir: '库/AI', spaceId: 'SP_ROOT', spaceName: '根库' },
				{ dir: '库/AI/01-x', spaceId: 'SP_X', spaceName: 'X 库' },
			]);
			assert.strictEqual(plan[0].category, '库/AI/01-x');
			assert.strictEqual(plan[1].category, '库/AI');
			assert.strictEqual(spaces['库/AI/01-x'].spaceId, 'SP_X');
			assert.strictEqual(spaces['库/AI'].spaceId, 'SP_ROOT');
			assert.strictEqual(applied.length, 2);
		});

		test('未命中的文档保持原类别（不影响类别层级推导结果）', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const plan: any[] = [{ rel: '库/别的/a.md', category: '别的' }];
			const spaces: Record<string, { spaceId: string }> = {};
			assert.deepStrictEqual(sync.applyExplicitMappings(plan, spaces, [{ dir: '库/AI', spaceId: 'S1' }]), []);
			assert.strictEqual(plan[0].category, '别的');
			assert.deepStrictEqual(spaces, {});
		});

		test('路径归一（反斜杠 / 尾斜杠）且忽略非法项', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const plan: any[] = [{ rel: '库/AI/01-x/a.md' }];
			const spaces: Record<string, { spaceId: string }> = {};
			const applied = sync.applyExplicitMappings(plan, spaces, [
				{ dir: '库\\AI\\01-x\\', spaceId: 'SP_X' },
				{ dir: '', spaceId: 'BAD' },
				{ dir: '库/AI/02', spaceId: '' },
			]);
			assert.deepStrictEqual(applied.map((a: { spaceId: string }) => a.spaceId), ['SP_X']);
			assert.strictEqual(plan[0].category, '库/AI/01-x');
		});

		test('以用户配置覆盖已有 spaceId（用户显式配置即权威）', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const plan: any[] = [{ rel: '库/AI/01-x/a.md', category: '01-x' }];
			const spaces: Record<string, { spaceId: string; name?: string }> = { '库/AI/01-x': { spaceId: 'OLD' } };
			sync.applyExplicitMappings(plan, spaces, [{ dir: '库/AI/01-x', spaceId: 'NEW', spaceName: '新名' }]);
			assert.strictEqual(spaces['库/AI/01-x'].spaceId, 'NEW');
			assert.strictEqual(spaces['库/AI/01-x'].name, '新名');
		});

		test('loadSpaceMap：数组 / 极简对象 / 缺失 / 损坏 一律不抛错', () => {
			const vault = tmpVault();
			assert.deepStrictEqual(sync.loadSpaceMap(vault), [], '文件不存在 ⇒ 空表');
			fs.writeFileSync(path.join(vault, '.feishu-space-map.json'), '{ broken', 'utf8');
			assert.deepStrictEqual(sync.loadSpaceMap(vault), [], '损坏 JSON ⇒ 空表（不影响同步）');
			fs.writeFileSync(path.join(vault, '.feishu-space-map.json'),
				JSON.stringify({ version: 1, mappings: [{ dir: '库/A', spaceId: 'S1', spaceName: 'A 库' }] }), 'utf8');
			assert.deepStrictEqual(sync.loadSpaceMap(vault), [{ dir: '库/A', spaceId: 'S1', spaceName: 'A 库' }]);
			fs.writeFileSync(path.join(vault, '.feishu-space-map.json'),
				JSON.stringify({ mappings: { '库/B': 'S2' } }), 'utf8');
			assert.deepStrictEqual(sync.loadSpaceMap(vault), [{ dir: '库/B', spaceId: 'S2', spaceName: '' }]);
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

// ─── 设置面板侧：映射文件读写 / 知识库列表解析（feishuSyncCore）────────────────

suite('feishuSyncCore · 映射配置与知识库列表', () => {
	test('parseSpaceMap 与脚本端语义一致（数组 / 极简对象 / 损坏 / 非法项）', () => {
		assert.deepStrictEqual(parseSpaceMap(''), []);
		assert.deepStrictEqual(parseSpaceMap('{ broken'), []);
		assert.deepStrictEqual(
			parseSpaceMap(JSON.stringify({ version: 1, mappings: [{ dir: '库/A', spaceId: 'S1', spaceName: 'A 库' }] })),
			[{ dir: '库/A', spaceId: 'S1', spaceName: 'A 库' }]);
		assert.deepStrictEqual(parseSpaceMap(JSON.stringify({ mappings: { '库/B': 'S2' } })),
			[{ dir: '库/B', spaceId: 'S2', spaceName: '' }]);
		assert.deepStrictEqual(
			parseSpaceMap(JSON.stringify({ mappings: [{ dir: '', spaceId: 'S' }, { dir: '库/C', spaceId: '' }] })),
			[], '缺 dir 或 spaceId 的项应被忽略');
	});

	test('serializeSpaceMap → parseSpaceMap 往返无损（面板保存后脚本可读）', () => {
		const list = [{ dir: '库/A/01-x', spaceId: 'S1', spaceName: 'X 库' }, { dir: '库/B', spaceId: 'S2' }];
		assert.deepStrictEqual(parseSpaceMap(serializeSpaceMap(list)), [
			{ dir: '库/A/01-x', spaceId: 'S1', spaceName: 'X 库' },
			{ dir: '库/B', spaceId: 'S2', spaceName: '' },
		]);
	});

	test('parseSpaceList：兼容顶层数组 / 嵌套 data.items，字段 space_id 与 spaceId', () => {
		assert.deepStrictEqual(
			parseSpaceList(JSON.stringify([{ space_id: 'S1', name: 'A 库' }, { spaceId: 'S2', name: 'B 库' }])),
			[{ spaceId: 'S1', name: 'A 库' }, { spaceId: 'S2', name: 'B 库' }]);
		assert.deepStrictEqual(
			parseSpaceList(JSON.stringify({ ok: true, data: { items: [{ space_id: 'S3', name: 'C 库' }] } })),
			[{ spaceId: 'S3', name: 'C 库' }]);
		assert.deepStrictEqual(parseSpaceList('not json'), []);
		assert.deepStrictEqual(parseSpaceList(''), []);
	});

	test('同一 spaceId 去重（下拉不出现重复项）', () => {
		const raw = JSON.stringify([{ spaceId: 'S1', name: 'A' }, { spaceId: 'S1', name: '重复' }, { spaceId: 'S2', name: 'B' }]);
		assert.deepStrictEqual(parseSpaceList(raw), [{ spaceId: 'S1', name: 'A' }, { spaceId: 'S2', name: 'B' }]);
	});

	test('sanitizeSpaceName：剔除会破坏 shell 引号的字符（名称经双引号传入 CLI）', () => {
		assert.strictEqual(sanitizeSpaceName('  我的 知识库 '), '我的 知识库');
		assert.strictEqual(sanitizeSpaceName('a"b'), 'ab');
		assert.strictEqual(sanitizeSpaceName('x\ny\r'), 'xy');
		assert.strictEqual(sanitizeSpaceName(''), '');
		assert.strictEqual(sanitizeSpaceName(undefined), '');
	});

	test('parseCreatedSpaceId：从 space-create 输出提取 id（嵌套 / 日志混排 / 失败可辨）', () => {
		assert.strictEqual(parseCreatedSpaceId(JSON.stringify({ ok: true, data: { space_id: 'NEW1' } })), 'NEW1');
		assert.strictEqual(parseCreatedSpaceId(JSON.stringify({ data: { space: { spaceId: 'NEW2' } } })), 'NEW2');
		assert.strictEqual(parseCreatedSpaceId('log line\n{"data":{"space_id":"NEW3"}}\n'), 'NEW3');
		assert.strictEqual(parseCreatedSpaceId('{"ok":false,"error":{"message":"x"}}'), '', '失败 ⇒ 空（UI 据此提示）');
		assert.strictEqual(parseCreatedSpaceId(''), '');
	});
});

// ─── URL 导入（抓取正文 + 图片本地化）纯函数 ────────────────────────────────

// ─── 知识库根目录的「思维导图」（mindnote）结构 ──────────────────────────────

suite('思维导图结构（buildMindmapNodes / mindmapHash）', () => {
	test('层级树：根 → 目录（逐级）→ 笔记叶子，且同一结构 id 稳定', () => {
		const entries = [
			{ rel: '01-x/a.md', title: 'A' },
			{ rel: '01-x/sub/b.md', title: 'B' },
			{ rel: 'root.md', title: 'R' },
		];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const nodes: any[] = sync.buildMindmapNodes('测试库', entries);
		const byText = (t: string) => nodes.find(n => n.text === t);
		const byId = (id: string) => nodes.find(n => n.node_id === id);
		assert.ok(byText('测试库'), '应有根节点（库名）');
		assert.ok(byText('01-x'), '应有目录节点');
		assert.ok(byText('sub'), '应有子目录节点');
		assert.strictEqual(byId(byText('A').parent_id).text, '01-x', '笔记挂在所属目录');
		assert.strictEqual(byId(byText('B').parent_id).text, 'sub', '嵌套目录层级正确');
		assert.strictEqual(byId(byText('R').parent_id).text, '测试库', '库根下的笔记直接挂在根节点');
		// ★ 稳定性：同结构两次生成必须完全一致（否则每次同步都会“新增”节点，导图会越来越乱）
		assert.deepStrictEqual(sync.buildMindmapNodes('测试库', entries), nodes);
	});

	test('结构指纹：结构未变 ⇒ 指纹相同（据此跳过远端更新）', () => {
		const a = sync.buildMindmapNodes('库', [{ rel: 'x/a.md', title: 'A' }]);
		const b = sync.buildMindmapNodes('库', [{ rel: 'x/a.md', title: 'A' }]);
		const c = sync.buildMindmapNodes('库', [{ rel: 'x/a.md', title: 'A' }, { rel: 'x/b.md', title: 'B' }]);
		assert.strictEqual(sync.mindmapHash(a), sync.mindmapHash(b));
		assert.notStrictEqual(sync.mindmapHash(a), sync.mindmapHash(c), '新增笔记必须让指纹变化');
		assert.strictEqual(sync.mindmapHash([]), sync.mindmapHash([]));
	});
});

// ─── 格式保真：mermaid / drawio / 流程图 / 混排（2026-09-23）────────────────────
//
// 背景：用户要求「图文、表格、流程图、mermaid、drawio 等格式要正确显示」。
// 本组锁定**同步预处理阶段不破坏这些结构**（飞书侧最终形态另见 §3/§14 说明）。

suite('同步格式保真 · mermaid / drawio / 混排', () => {
	test('mermaid 围栏代码块逐字保留（不能被 wikilink / 表格处理误伤）', () => {
		const md = '```mermaid\ngraph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]\n```\n';
		assert.strictEqual(sync.prepareMarkdownForSync(md), md);
	});

	test('流程图（flowchart）+ 中文标签：内容不被改写', () => {
		const md = '```mermaid\nflowchart LR\n  A[取数] --> B[清洗]\n  B --> C[入库]\n```\n';
		const out = sync.prepareMarkdownForSync(md);
		assert.ok(out.includes('flowchart LR'));
		assert.ok(out.includes('A[取数] --> B[清洗]'), '节点标签与箭头逐字保留');
	});

	test('drawio：`<mxfile>` XML 代码块与 `.drawio` 附件引用都保留（当前不同步为非图片资源）', () => {
		const md = '```xml\n<mxfile><diagram name="架构">x</diagram></mxfile>\n```\n\n![[架构图.drawio]]\n';
		const out = sync.prepareMarkdownForSync(md);
		assert.ok(out.includes('<mxfile>'), 'drawio 源码块保留（飞书侧为代码块文本）');
		assert.ok(out.includes('![[架构图.drawio]]'), 'drawio 附件引用保留（不当作图片处理 ⇒ 不会被误删）');
	});

	test('★ 图文 + 表格 + mermaid + 图片混排：结构逐字保真，且只有本地图片被换成占位', () => {
		const md = [
			'# 混排文档',
			'',
			'| 列A | 列B |',
			'| --- | --- |',
			'| [[双链目标|别名]] | 值 |',
			'',
			'```mermaid',
			'flowchart LR',
			'  X --> Y',
			'```',
			'',
			'![本地图](pic.png)',
			'',
			'![](https://cdn.example.com/remote.png)',
			'',
		].join('\n');

		// ⚠ `dirWith` 是上面「图片引用抽取」suite 的**局部** helper ⇒ 这里自建目录（helper 不跨 suite）
		const dir = tmpVault();
		writeFileEnsured(path.join(dir, 'pic.png'), 'x');
		const { markdown, images, missing } = sync.extractImages(sync.prepareMarkdownForSync(md), dir);

		assert.ok(markdown.includes('| 别名 | 值 |'), '表格内 wikilink 别名替换后列数不变');
		assert.ok(markdown.includes('flowchart LR'), 'mermaid 内容保真');
		assert.ok(markdown.includes('| 列A | 列B |'), '表头未被改动');
		assert.strictEqual(images.length, 1, '只把**本地**图片转成占位（供后续 block_replace 插图）');
		assert.deepStrictEqual(missing, [], '引用的本地图片存在 ⇒ 不应报缺失');
		assert.ok(markdown.includes('https://cdn.example.com/remote.png'), '远程图片保持原样（同步侧不处理外链）');
	});

	test('★ extractAttachments：本地 html 引用 → 占位（feishu 以 file block + Preview 渲染）', () => {
		const dir = tmpVault();
		writeFileEnsured(path.join(dir, 'live-demo.html'), '<html/>');
		const r = sync.extractAttachments('段落\n\n![[live-demo.html]]\n\n后续\n', dir);
		assert.strictEqual(r.attachments.length, 1, '抽到 1 个附件');
		assert.strictEqual(r.attachments[0].ref, 'live-demo.html');
		assert.strictEqual(r.attachments[0].name, 'live-demo.html');
		assert.strictEqual(r.attachments[0].standalone, true, '独占段落 ⇒ 可插入');
		assert.ok(r.markdown.includes('KBSYNCFILE1'), '正文里换成占位');
		assert.ok(!r.markdown.includes('![[live-demo.html]]'), '原引用已被替换');
	});

	test('extractAttachments：文件不存在 ⇒ 保留原文并记入 missing；行内 ⇒ 标 inline', () => {
		const dir = tmpVault();
		const missingCase = sync.extractAttachments('![[not-here.html]]\n', dir);
		assert.deepStrictEqual(missingCase.missing, ['not-here.html']);
		assert.ok(missingCase.markdown.includes('![[not-here.html]]'), '缺文件时原文保留');

		writeFileEnsured(path.join(dir, 'inline.html'), '<html/>');
		const inlineCase = sync.extractAttachments('见 ![[inline.html]] 说明\n', dir);
		assert.strictEqual(inlineCase.attachments.length, 1);
		assert.strictEqual(inlineCase.attachments[0].standalone, false);
		assert.deepStrictEqual(inlineCase.inline, ['inline.html']);
	});

	test('extractAttachments：非 html 引用（图片/图表/笔记）一律不碰', () => {
		const dir = tmpVault();
		const r = sync.extractAttachments('![[a.png]]\n\n![[b.drawio]]\n\n![[笔记]]\n', dir);
		assert.strictEqual(r.attachments.length, 0);
		assert.ok(r.markdown.includes('![[a.png]]'));
		assert.ok(r.markdown.includes('![[b.drawio]]'));
	});

	test('detectUnrenderableDiagrams：只识别 drawio（mermaid 由飞书转画板 ⇒ 不再告警）', () => {
		// ★ 2026-09-24 实测更新：```mermaid 经飞书 markdown 导入会转成 whiteboard(type="mermaid")
		//   画板（原生活图）⇒ 不再属于「飞书不会渲染」的范畴。
		assert.deepStrictEqual(sync.detectUnrenderableDiagrams('```mermaid\ngraph TD\n  A-->B\n```\n'), [],
			'mermaid 不再告警（飞书转画板活图）');
		assert.deepStrictEqual(sync.detectUnrenderableDiagrams('```xml\n<mxfile>x</mxfile>\n```\n'), ['drawio']);
		assert.deepStrictEqual(sync.detectUnrenderableDiagrams('裸 XML：<mxGraphModel>…</mxGraphModel>'), ['drawio']);
		assert.deepStrictEqual(sync.detectUnrenderableDiagrams('```drawio\n<mxfile>x</mxfile>\n```\n'), ['drawio']);
		assert.deepStrictEqual(sync.detectUnrenderableDiagrams('```js\nconst a = 1;\n```\n'), [],
			'普通代码块不算图表源码（避免误报刷屏）');
		assert.deepStrictEqual(sync.detectUnrenderableDiagrams('```mermaid\nA\n```\n\n<mxfile>x</mxfile>'),
			['drawio'], 'mermaid 不报、drawio 报出且去重');
	});

	test('★ SVG 不得被当作可插入图片（飞书实测只认 BMP/GIF/JPEG/PNG/TIFF/WebP）', () => {
		const dir = tmpVault();
		writeFileEnsured(path.join(dir, 'chart.svg'), '<svg/>');
		const { images, markdown } = sync.extractImages('![](chart.svg)', dir);
		assert.strictEqual(images.length, 0, 'svg 不能进插图队列 —— 否则飞书会返回「not a supported … image」而整批中断');
		assert.ok(markdown.includes('![](chart.svg)'), '应原样保留引用（不静默丢弃）');
	});
});

suite('KB URL 导入 · 纯函数（slug / 图片路径 / HTML 兜底）', () => {
	test('slugifyTitle：中文保留、非法字符折叠、超长截断、空标题回退 URL 末段', () => {
		assert.strictEqual(slugifyTitle('知识库 入门指南', 'https://x.com/a'), '知识库-入门指南');
		assert.strictEqual(slugifyTitle('a/b:c?d"e', 'https://x.com/a'), 'a-b-c-d-e');
		assert.strictEqual(slugifyTitle('', 'https://x.com/posts/hello-world'), 'hello-world');
		assert.strictEqual(slugifyTitle(undefined, 'not a url'), 'untitled');
		assert.ok(slugifyTitle('x'.repeat(200), 'https://x.com').length <= 60);
	});

	test('planImagePath：产出相对 md 目录的路径（预览与飞书同步都按此基准解析）', () => {
		assert.deepStrictEqual(planImagePath('slug1', 1, 'https://cdn.example.com/img/photo.jpg'),
			{ rel: 'assets/slug1/1-photo.jpg', ext: 'jpg' });
		// 无扩展名 ⇒ 按 mime 推断，且不带点前缀（否则会写出 img..png）
		assert.strictEqual(planImagePath('s', 2, 'https://x.com/a/b/img', 'image/png').rel, 'assets/s/2-img.png');
		// 非法 URL ⇒ 兜底名，不抛错
		assert.ok(planImagePath('s', 3, '::::').rel.startsWith('assets/s/3-'));
	});

	test('parseSubtitlesToText：VTT/SRT 去时间轴与序号、自动字幕重复行去重、超长截断', () => {
		const vtt = [
			'WEBVTT', '', 'Kind: captions', 'Language: zh',
			'00:00:00.000 --> 00:00:02.000', 'hello',
			'00:00:02.000 --> 00:00:04.000', 'hello',
			'00:00:04.000 --> 00:00:06.000', '<c>world</c>&amp;more',
		].join('\n');
		assert.strictEqual(parseSubtitlesToText(vtt), 'hello\nworld&more', '头部/时间轴/重复行应清理，行内标签与实体应处理');
		const srt = ['1', '00:00:01,000 --> 00:00:02,000', '第一句', '', '2', '00:00:03,000 --> 00:00:04,000', '第二句'].join('\n');
		assert.strictEqual(parseSubtitlesToText(srt), '第一句\n第二句', 'SRT 序号应去掉');
		assert.strictEqual(parseSubtitlesToText(''), '');
		const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
		assert.ok(parseSubtitlesToText(long, 200).length <= 260, '超长字幕应截断（避免塞爆 prompt）');
	});

	test('parseYtDlpPrint：解析 yt-dlp --print 行（||| 与 TSV 均支持，NA 视为空、超长截断）', () => {
		const sep = '|||';
		const m = parseYtDlpPrint(['标题 A', '3661', 'https://x/cover.jpg', '作者B', '20260921', '简介 C'].join(sep));
		assert.strictEqual(m.title, '标题 A');
		assert.strictEqual(m.durationSec, 3661);
		assert.strictEqual(m.cover, 'https://x/cover.jpg');
		assert.strictEqual(m.author, '作者B');
		assert.strictEqual(m.date, '2026-09-21', 'upload_date YYYYMMDD 应格式化');
		assert.strictEqual(m.description, '简介 C');
		// 分隔符自适应：真实 TSV 也能解析
		assert.strictEqual(parseYtDlpPrint('T\t90\tNA\tNA\tNA\tNA').durationSec, 90);
		// 不可用字段（NA）按空处理
		const na = parseYtDlpPrint(['T', 'NA', 'NA', 'NA', 'NA', 'NA'].join(sep));
		assert.strictEqual(na.durationSec, undefined);
		assert.strictEqual(na.cover, undefined);
		assert.strictEqual(na.date, undefined);
		// 超长简介截断（避免把巨量文本落进笔记）
		assert.ok((parseYtDlpPrint(['T', '1', 'NA', 'NA', 'NA', 'x'.repeat(2000)].join(sep)).description ?? '').length <= 500);
	});

	test('yt-dlp 降级：无主进程桥/未安装时只返回「不可用」，绝不抛异常（导入应继续）', async () => {
		// 测试环境没有 Electron 的 vscode.ipcRenderer 桥 ⇒ execShortCommand 返回 undefined
		const d = await detectYtDlp();
		assert.strictEqual(d.installed, false, '无桥环境应判为未安装');
		const v = await fetchVideoMeta('https://www.bilibili.com/video/BV1xx411c7mD');
		assert.strictEqual(v.ok, false, '抓取失败不得抛异常，由调用方降级为「仅记链接」');
		assert.ok(typeof (v as { reason: string }).reason === 'string' && (v as { reason: string }).reason.length > 0);
		// 空 URL 直接拒绝（不发起命令）
		const empty = await fetchVideoMeta('   ');
		assert.strictEqual(empty.ok, false);
	});

	test('htmlToPlainText：去掉 script/style、标题与列表转 markdown、实体解码', () => {
		const html = '<html><head><style>p{color:red}</style><script>var x=1;</script></head>'
			+ '<body><h2>标题</h2><p>A &amp; B</p><ul><li>一</li><li>二</li></ul></body></html>';
		const out = htmlToPlainText(html);
		assert.ok(!out.includes('var x'), 'script 内容应被移除');
		assert.ok(!out.includes('color:red'), 'style 内容应被移除');
		assert.ok(out.includes('## 标题'), '标题应转为 markdown 标题');
		assert.ok(out.includes('- 一') && out.includes('- 二'), '列表项应转为 markdown 列表');
		assert.ok(out.includes('A & B'), '实体应被解码');
		assert.strictEqual(htmlToPlainText(''), '');
	});
});
