/*---------------------------------------------------------------------------------------------
 *  「新建分类 → 同步到飞书知识库」端到端测试 —— 2026-09-24
 *
 *  对应用户场景（技能 `kb-category-feishu` 要覆盖的请求）：
 *      「在笔记中新建 xxx 文件夹，并同步到飞书 "xxx" 知识库中」
 *
 *  与同目录 `kbFeishuSyncScript.test.ts` 的分工：
 *    · 那份测的是**纯函数语义**（categoryOf / applyExplicitMappings / migrateSpaceMappings …），
 *      fixture 统一用 `库/AI` 作同步源、笔记都**已同步过**（有 token/历史落点）；
 *    · 本份测**用户视角的完整链路**：同步源是产品默认的 `笔记`、分类**从零新建**、
 *      笔记**从未同步**（无 token），并**真跑内置脚本 dry-run** 校验最终落点与用户意图一致。
 *
 *  ⚠ 真跑脚本（`resources/.agents/kb/feishu-sync.mjs --dry-run`）之所以可行：
 *    脚本里所有远端调用（建库 / 建节点 / 插图片 / 思维导图 / 索引写入 / prune 删远端）
 *    都在 `if (args.dryRun) { … continue; }` 之后或 `if (!args.dryRun)` 之内
 *    ⇒ dry-run 全程**不碰 lark-cli、不写远端、不改本地**（本文件有专门用例钉死「零副作用」）。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/browser/knowledge/kbCategoryFeishuFlow.test.ts
 *--------------------------------------------------------------------------------------------*/

// @ts-ignore -- 资源脚本以 .mjs 分发，无 .d.ts 声明
import * as syncModule from '../../../../../../../resources/.agents/kb/feishu-sync.mjs';
import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 脚本是 `.mjs`（无类型声明）⇒ 按 `any` 使用，断言运行时行为（同 kbFeishuSyncScript.test.ts 的做法）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sync: any = syncModule;

/** 产品默认同步源目录（`kb_feishu_sync` 工具与设置面板的默认值都是「笔记」）。 */
const SRC = '笔记';
/** 用户口中「飞书 "xxx" 知识库」的 spaceId（真实取值来自知识库 URL 或面板列表）。 */
const SPACE_AI = '7691234567890abc';
const SPACE_NAME = '我的AI库';
/** 既有分类（上次同步已建过库）的 spaceId —— 用于验证「新建分类不波及既有分类」。 */
const SPACE_EXISTING = '7709999999999xyz';
/** 新分类名（用户说的「新建 xxx 文件夹」）。 */
const CATEGORY = '深度学习';
/** 内置脚本与技能手册的相对路径。 */
const SCRIPT_REL = 'resources/.agents/kb/feishu-sync.mjs';
const SKILL_REL = 'resources/.agents/skills/kb-category-feishu/SKILL.md';

// ─── fixture ────────────────────────────────────────────────────────────────

function tmpVault(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cat-feishu-'));
}

function writeFileEnsured(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, 'utf8');
}

/** 在笔记区写一篇「刚被 agent 新建出来」的笔记（无 feishu 记账字段 —— agent 不该手写）。 */
function writeNote(vault: string, relFromNotes: string, title: string): string {
	const rel = `${SRC}/${relFromNotes}`;
	const file = path.join(vault, ...rel.split('/'));
	writeFileEnsured(file, `---\ntype: concept\ntitle: ${title}\ncreated: 2026-09-24\n---\n\n# ${title}\n\n正文。\n`);
	return file;
}

/** 写「本地目录 → 飞书知识库」显式映射（契约见技能手册与 feishuSyncCore）。 */
function writeSpaceMap(vault: string, mappings: Array<{ dir: string; spaceId?: string; spaceName?: string }>): void {
	fs.writeFileSync(path.join(vault, '.feishu-space-map.json'),
		JSON.stringify({ version: 1, mappings }, null, 2), 'utf8');
}

/** 真跑内置脚本的 dry-run，返回合并后的 stdout/stderr（UTF-8）。 */
function runDryRun(vault: string, extraArgs: string[] = []): { out: string; status: number | null } {
	const script = path.join(process.cwd(), SCRIPT_REL);
	assert.ok(fs.existsSync(script), `内置同步脚本不存在：${script}`);
	const r = cp.spawnSync(process.execPath,
		[script, '--vault', vault, '--src', SRC, '--dry-run', ...extraArgs],
		{ encoding: 'utf8', timeout: 60_000 });
	return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

/** 统计输出里某子串出现次数（比跨行正则更稳，用于「哪几篇落到哪个知识库」）。 */
function count(out: string, needle: string): number {
	return out.split(needle).length - 1;
}

/** vault 内全部文本文件的「相对路径 → 内容」快照（用于零副作用断言）。 */
function snapshotVault(vault: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (dir: string): void => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) { walk(full); continue; }
			out.set(path.relative(vault, full).replace(/\\/g, '/'), fs.readFileSync(full, 'utf8'));
		}
	};
	walk(vault);
	return out;
}

suite('用户场景：笔记中新建分类文件夹 → 同步到飞书知识库', () => {

	test('★ 模式 A（默认）：新分类未配置映射 ⇒ 预告「将创建」，既有分类的知识库不受影响', () => {
		const vault = tmpVault();
		writeNote(vault, `${CATEGORY}/Transformer.md`, 'Transformer');
		writeNote(vault, '已有分类/旧笔记.md', '旧笔记');
		writeNote(vault, '根笔记.md', '根笔记');   // 无类别（直接在笔记区根）⇒ 走 parent 落点
		// 既有分类上次同步已经建过库 ⇒ 写进索引，验证「新建分类不会波及它」
		fs.writeFileSync(path.join(vault, '.feishu-sync.json'), JSON.stringify({
			version: 2,
			spaces: { '已有分类': { spaceId: SPACE_EXISTING, name: '已有分类' } },
			files: {}, mindmaps: {},
		}), 'utf8');

		const { out, status } = runDryRun(vault);

		assert.strictEqual(status, 0, `dry-run 应当正常退出：\n${out}`);
		assert.match(out, /类别（1 级目录）: 2 个/, `应识别出 2 个类别：\n${out}`);
		assert.match(out, new RegExp(`· ${CATEGORY} → \\(将创建\\)`), `新分类应预告自动建库：\n${out}`);
		assert.match(out, new RegExp(`· 已有分类 → ${SPACE_EXISTING}`), `既有分类应复用原知识库：\n${out}`);
		assert.match(out, new RegExp(`将创建知识库 1 个：${CATEGORY}`), `只该新建 1 个知识库（不得波及既有分类）：\n${out}`);
		assert.match(out, /计划: create=3 update=0 skip=0/, `三篇都是首次同步 ⇒ create：\n${out}`);
		assert.match(out, /\[create\] 笔记\/深度学习\/Transformer\.md/, `新笔记应出现在计划里：\n${out}`);
		// 落点：新分类 → 待建知识库；既有分类 → 原知识库；无类别的根笔记 → parent
		assert.strictEqual(count(out, '--space-id (将创建)'), 1, `只有新分类那篇指向待建库：\n${out}`);
		assert.strictEqual(count(out, `--space-id ${SPACE_EXISTING}`), 1, `既有分类那篇应落原知识库：\n${out}`);
		// 无类别笔记：computeTargets 把落点直接赋为 parent 值（'my_library' 可被 wiki 识别）
		assert.match(out, /默认落点（无类别文件）: my_library/, out);
		assert.strictEqual(count(out, '--space-id my_library'), 1, `无类别笔记应落 parent（my_library）：\n${out}`);
	});

	test('★★ 模式 B：新分类显式映射到指定知识库 ⇒ 该分类及其**子目录**的笔记都落到用户指定的知识库', () => {
		const vault = tmpVault();
		writeNote(vault, `${CATEGORY}/Transformer.md`, 'Transformer');
		writeNote(vault, `${CATEGORY}/注意力机制/Attention.md`, 'Attention');   // 子目录也应被绑定
		writeSpaceMap(vault, [{ dir: `${SRC}/${CATEGORY}`, spaceId: SPACE_AI, spaceName: SPACE_NAME }]);

		const { out, status } = runDryRun(vault);

		assert.strictEqual(status, 0, `dry-run 应当正常退出：\n${out}`);
		assert.match(out, /\[map\] 应用用户自定义映射 1 条（命中 2 篇）/, `显式映射应命中两篇（含子目录）：\n${out}`);
		assert.match(out, new RegExp(`· ${SRC}/${CATEGORY} → ${SPACE_AI}（${SPACE_NAME}）`), `类别应显示映射到的知识库：\n${out}`);

		const hits = out.match(new RegExp(`wiki \\+node-create --space-id ${SPACE_AI}`, 'g')) ?? [];
		assert.strictEqual(hits.length, 2, `两篇都应落到 ${SPACE_AI}（含子目录那篇）：\n${out}`);
		assert.ok(!/将创建知识库/.test(out), `已映射 ⇒ 不得再预告新建知识库（否则会多出一个空库）：\n${out}`);
		assert.ok(!/--parent-position/.test(out), `有类别且已映射 ⇒ 不该走 parent 落点：\n${out}`);
	});

	test('★ 陷阱：映射条目只写 spaceName 不写 spaceId ⇒ 被**静默忽略**（落点退回自动建库）', () => {
		const vault = tmpVault();
		writeNote(vault, `${CATEGORY}/Transformer.md`, 'Transformer');
		writeSpaceMap(vault, [{ dir: `${SRC}/${CATEGORY}`, spaceName: SPACE_NAME }]);

		const { out, status } = runDryRun(vault);

		assert.strictEqual(status, 0, '缺 spaceId 不应报错（这正是危险之处）：\n' + out);
		assert.ok(!/\[map\] 应用用户自定义映射/.test(out), `无 spaceId 的映射必须被丢弃：\n${out}`);
		assert.match(out, new RegExp(`· ${CATEGORY} → \\(将创建\\)`),
			`映射失效后回落到「自动建库」⇒ 不会进用户指定的「${SPACE_NAME}」：\n${out}`);
	});

	test('★ dry-run 零副作用：不改任何本地文件、不写索引', () => {
		const vault = tmpVault();
		writeNote(vault, `${CATEGORY}/Transformer.md`, 'Transformer');
		writeSpaceMap(vault, [{ dir: `${SRC}/${CATEGORY}`, spaceId: SPACE_AI, spaceName: SPACE_NAME }]);

		const before = snapshotVault(vault);
		const { status } = runDryRun(vault);
		const after = snapshotVault(vault);

		assert.strictEqual(status, 0);
		assert.deepStrictEqual([...after.entries()], [...before.entries()], 'dry-run 不得改动 vault 内任何文件');
		assert.ok(!fs.existsSync(path.join(vault, '.feishu-sync.json')), 'dry-run 不得写同步索引');
	});

	test('categoryDepth=2 ⇒ 二级目录成为知识库单位（分类层级较深时的配置）', () => {
		const vault = tmpVault();
		writeNote(vault, `${CATEGORY}/01-基础/x.md`, 'X');

		const { out, status } = runDryRun(vault, ['--category-depth', '2']);

		assert.strictEqual(status, 0, out);
		assert.match(out, new RegExp(`· ${CATEGORY}/01-基础 → \\(将创建\\)`),
			`depth=2 时类别应是「深度学习/01-基础」：\n${out}`);
	});

	test('关闭自动建库 ⇒ 未映射分类的文档被跳过并**明确告警**（不静默丢失）', () => {
		const vault = tmpVault();
		writeNote(vault, `${CATEGORY}/Transformer.md`, 'Transformer');

		const { out, status } = runDryRun(vault, ['--no-auto-create-spaces']);

		assert.strictEqual(status, 0, out);
		assert.match(out, /未映射的类别（1 个，其文档本次跳过）：深度学习/, `必须明确告警：\n${out}`);
		assert.match(out, new RegExp(`· ${CATEGORY} → \\(未映射，跳过\\)`), out);
	});
});

suite('技能手册（kb-category-feishu）与机制一致', () => {

	test('★ 手册里的映射 JSON 示例「照抄可用」（真源能读回同值）', () => {
		const skillText = fs.readFileSync(path.join(process.cwd(), SKILL_REL), 'utf8');
		// 容错：行尾可能是 CRLF，围栏块也可能因缩进（列表项内）而带前导空格
		const blocks = [...skillText.matchAll(/```json[^\n]*\r?\n([\s\S]*?)```/g)].map(m => m[1]);
		const mappingBlock = blocks.find(b => b.includes('"mappings"'));
		assert.ok(mappingBlock, `手册里应有一个含 "mappings" 的 JSON 示例：\n${SKILL_REL}`);

		// 照抄进 vault → 必须被脚本原样读回（字段名/层级写错的话这里会红）
		const vault = tmpVault();
		fs.writeFileSync(path.join(vault, '.feishu-space-map.json'), mappingBlock, 'utf8');
		const parsed = JSON.parse(mappingBlock);
		const back = sync.loadSpaceMap(vault);
		assert.deepStrictEqual(back, parsed.mappings.map((m: { dir: string; spaceId: string; spaceName?: string }) => ({
			dir: m.dir, spaceId: m.spaceId, spaceName: m.spaceName ?? '',
		})), '手册示例必须能被脚本 1:1 读回（含 spaceName 缺省语义）');
	});

	test('映射文件名与脚本常量一致（手册/面板/脚本三处同一份契约）', () => {
		const script = fs.readFileSync(path.join(process.cwd(), SCRIPT_REL), 'utf8');
		const mapFile = /const SPACE_MAP_FILE = '([^']+)'/.exec(script)?.[1];
		assert.strictEqual(sync.SPACE_MAP_FILE, mapFile, '脚本导出常量应与内部字面量一致');
		assert.strictEqual(sync.SPACE_MAP_FILE, '.feishu-space-map.json');

		const skillText = fs.readFileSync(path.join(process.cwd(), SKILL_REL), 'utf8');
		assert.ok(skillText.includes(sync.SPACE_MAP_FILE), '手册必须写明映射文件名');
	});
});
