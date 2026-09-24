/*---------------------------------------------------------------------------------------------
 *  内置技能契约（builtinSkillContracts）—— 2026-09-24
 *
 *  背景：技能是**纯文件**（`resources/.agents/skills/**​/SKILL.md`），它与代码之间有四条
 *  「只在运行时才暴露」的隐式契约；任何一条破了都**不报错**，只静默降级：
 *
 *   ① agent 的 `skills[]` 必须能解析到真实技能 —— 写错的 id 是**静默空引用**
 *      （历史遗留：`knowledge-base-expert` 长期挂着不存在的 `writing`，没人发现）；
 *   ② 技能 frontmatter 的 `name`/`description` 必须齐备，且派生出的 **id 唯一**
 *      —— 重复 id 会让后扫描者覆盖前者（技能凭空消失）；
 *   ③ agent 的 required 技能必须都落在**注入预算**内 —— 超出会被降级为「摘要」，
 *      表现为技能"存在但没生效"（见 common/skillInjectionBudget.ts）；
 *   ④ 技能文档里的常量（映射文件名 / 设置键名 / feishu 记账字段）必须与代码/脚本一致
 *      —— 否则文档把 agent 教错，且没有任何信号。
 *
 *  本测试只依赖 FS 与真实产品产物（技能目录 + 内置同步脚本），不需要 DOM / DI。
 *  运行（仓库根目录；聚合器会自动发现本文件）：
 *      npm run test-agentstudio-common
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { getBuiltinAgents } from '../../common/builtinAgents.js';
import { resolveSkillId, SKILL_ID_PATTERN } from '../../common/skillId.js';
import { renderSkillBody, type ISkillDefinition } from '../../common/skills.js';
import { AGENT_STUDIO_KB_FEISHU_CATEGORY_DEPTH } from '../../common/constants.js';
import {
	planSkillInjections, DEFAULT_SKILL_BUDGET, SKILL_PRIORITY_REQUIRED, type ISkillBudgetCandidate,
} from '../../common/skillInjectionBudget.js';

/** 内置技能目录（相对仓库根；测试以仓库根为 cwd，与 architectureBoundaries.test.ts 同约定）。 */
const SKILLS_REL = 'resources/.agents/skills';
/** 飞书同步脚本（`feishu:` 记账字段与映射文件名的真源）。 */
const SYNC_SCRIPT_REL = 'resources/.agents/kb/feishu-sync.mjs';
/** 本次新增的分类↔知识库关联技能（文档契约断言的对象）。 */
const CATEGORY_SKILL_ID = 'kb-category-feishu';
/** KB agent 的 id（注入预算断言的对象）。 */
const KB_AGENT_ID = 'knowledge-base-expert';

/**
 * 存量悬空挂载的**显式允许清单**（2026-09-24 实测：本仓 `resources/.agents/skills/`
 * 的 153 个技能里没有这两个 id，用户技能库 `~/.vssaros/skills`、`~/.vssaros-dev/skills` 里也没有）：
 *   · `writing`  —— writer / designer / code-architect 等 agent 期望的写作指南
 *   · `planning` —— saros-claw / planner / workflow-agent 等期望的规划指南
 *
 * 保留而非删除的原因：它们更像**计划中但从未创建**的技能（可选钩子），删掉就丢失了
 * 「这几个 agent 缺一份对应指南」这个信号；而运行时无法解析 ⇒ 空引用、无副作用。
 * ⚠ 容忍是**仅限存量**的：任何别的悬空 id 都会判红 —— 拼错的 id 与「有意的可选钩子」
 * 在数据上不可区分，必须由人显式登记。
 *
 * ⚠ 本清单还有第二种正当用途：**用户可自行安装的可选技能**。它们装在用户全局技能库
 * （`~/.vssaros/skills/`，例如 `tutor` / `tutor-setup`）里，不在本仓 `resources/.agents/skills/`
 * 的扫描范围内；某内置 agent 若要挂载这类技能，必须在此登记，否则会被误报为悬空。
 */
const KNOWN_ABSENT_SKILL_IDS: ReadonlySet<string> = new Set(['writing', 'planning']);

interface IScannedSkill {
	/** 磁盘目录名 */
	readonly dir: string;
	/** SKILL.md 相对仓库根的路径（正斜杠） */
	readonly rel: string;
	/** 权威 id（= 真源 resolveSkillId(显式 id, name)） */
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** SKILL.md 正文（frontmatter 之后） */
	readonly body: string;
	/** 技能目录绝对路径（供 renderSkillBody 替换 ${SKILL_DIR}） */
	readonly dirAbs: string;
}

/**
 * 极简 frontmatter 读取：只取顶层 `key: value`（与 registry 的 parseFrontmatter 同子集，
 * 本测试只需要 name / description / id 三个标量字段，故不重复实现数组与引号语义）。
 */
function readFrontmatter(text: string): { meta: Record<string, string>; body: string } {
	if (!text.startsWith('---')) { return { meta: {}, body: text }; }
	const end = text.indexOf('\n---', 3);
	if (end < 0) { return { meta: {}, body: text }; }
	const meta: Record<string, string> = {};
	for (const rawLine of text.slice(3, end).split('\n')) {
		const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(rawLine.replace(/\r$/, ''));
		if (m) { meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
	}
	return { meta, body: text.slice(end + 4).replace(/^\r?\n/, '') };
}

/** 递归扫描内置技能（含 `obsidian-skills/<skill>` 这种一层容器目录）。 */
function scanBuiltinSkills(): IScannedSkill[] {
	const root = path.join(process.cwd(), SKILLS_REL);
	assert.ok(fs.existsSync(root), `内置技能目录不存在（路径基准变了？）：${root}`);
	const out: IScannedSkill[] = [];
	const walk = (dir: string, depth: number): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) { continue; }
			const full = path.join(dir, entry.name);
			const skillMd = path.join(full, 'SKILL.md');
			if (fs.existsSync(skillMd)) {
				const { meta, body } = readFrontmatter(fs.readFileSync(skillMd, 'utf8'));
				const name = (meta['name'] ?? entry.name).trim();
				out.push({
					dir: entry.name,
					rel: path.relative(process.cwd(), skillMd).replace(/\\/g, '/'),
					// ⚠ id 规则取自真源（与 registry `_parseSkillFile` 同一函数），不在此处另写一套 slug。
					id: resolveSkillId(meta['id'], name),
					name,
					description: meta['description'] ?? '',
					body,
					dirAbs: full,
				});
			}
			if (depth < 1) { walk(full, depth + 1); }
		}
	};
	walk(root, 0);
	return out;
}

function readRepoFile(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 把扫描结果包成 registry 侧的 ISkillDefinition 形状（仅预算计算用到的字段 + resource）。 */
function toSkillDefinition(s: IScannedSkill): ISkillDefinition {
	return {
		id: s.id,
		name: s.name,
		description: s.description,
		activation: 'manual',
		prompt: s.body,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resource: { fsPath: s.dirAbs } as any,
	} as ISkillDefinition;
}

suite('内置技能契约（builtinSkillContracts）', () => {

	test('技能目录：每个 SKILL.md 都有 name/description，派生 id 合法且唯一', () => {
		const skills = scanBuiltinSkills();
		// 防「路径失效 ⇒ 扫到 0 个 ⇒ 全绿」的假绿
		assert.ok(skills.length > 50, `扫描到的技能数异常偏少（${skills.length}）——${SKILLS_REL} 结构变了？`);

		const byId = new Map<string, string[]>();
		for (const s of skills) {
			assert.ok(s.name, `${s.rel}: name 为空`);
			assert.ok(s.description, `${s.rel}: description 为空`);
			assert.ok(SKILL_ID_PATTERN.test(s.id),
				`${s.rel}: 派生 id "${s.id}" 不合法（name="${s.name}"）—— 需在 frontmatter 显式给 id`);
			byId.set(s.id, [...(byId.get(s.id) ?? []), s.rel]);
		}

		const duplicated = [...byId.entries()].filter(([, rels]) => rels.length > 1)
			.map(([id, rels]) => `${id} ← ${rels.join(' + ')}`);
		assert.deepStrictEqual(duplicated, [],
			`技能 id 重复 ⇒ 后扫描者静默覆盖前者，技能会凭空消失：\n    ${duplicated.join('\n    ')}`);
	});

	test('★ 内置 agent 的 skills[] 全部可解析（无新增悬空 id）', () => {
		const knownIds = new Set(scanBuiltinSkills().map(s => s.id));
		const dangling: Array<{ agentId: string; skillId: string }> = [];
		for (const agent of getBuiltinAgents()) {
			for (const skillId of agent.skills ?? []) {
				if (!knownIds.has(skillId.toLowerCase())) {
					dangling.push({ agentId: agent.id, skillId: skillId.toLowerCase() });
				}
			}
		}
		const fresh = dangling.filter(d => !KNOWN_ABSENT_SKILL_IDS.has(d.skillId));
		assert.deepStrictEqual(fresh.map(d => `${d.agentId} → "${d.skillId}"`), [],
			'以下技能挂载指向**不存在的技能**（静默空引用，挂了等于没挂）：\n    '
			+ fresh.map(d => `${d.agentId} → "${d.skillId}"`).join('\n    ')
			+ '\n    （若确属「待补技能」的可选钩子，请显式加入 KNOWN_ABSENT_SKILL_IDS 并说明原因）');
	});

	test('★ KB agent 的 required 技能全部落在注入预算内（不被降级为摘要）', () => {
		const agent = getBuiltinAgents().find(a => a.id === KB_AGENT_ID);
		assert.ok(agent, `找不到内置 agent ${KB_AGENT_ID}`);

		const byId = new Map(scanBuiltinSkills().map(s => [s.id, s]));
		const candidates: ISkillBudgetCandidate[] = [];
		for (const skillId of agent.skills ?? []) {
			const s = byId.get(skillId.toLowerCase());
			if (!s) { continue; }   // 悬空 id 由上一个用例负责报告
			const skill = toSkillDefinition(s);
			candidates.push({
				skill,
				priority: SKILL_PRIORITY_REQUIRED,
				// 与 registry 同口径：正文按 renderSkillBody 计长（含 ${SKILL_DIR} 替换）
				contentChars: renderSkillBody(skill).length,
			});
		}
		assert.ok(candidates.length > 0, 'KB agent 没挂任何可解析的技能？');

		const plan = planSkillInjections(candidates, DEFAULT_SKILL_BUDGET);
		const usedChars = candidates.reduce((n, c) => n + c.contentChars, 0);
		assert.deepStrictEqual(plan.summary.map(s => s.id), [],
			`以下技能超出注入预算，会被降级为「摘要」（技能存在但没生效）：${plan.summary.map(s => s.id).join(', ')}\n`
			+ `    当前 ${candidates.length} 个技能 / ${usedChars} 字符；`
			+ `上限 ${DEFAULT_SKILL_BUDGET.maxFullSkills} 个 / ${DEFAULT_SKILL_BUDGET.maxPromptChars} 字符。\n`
			+ '    处理：清理无用挂载、压缩技能正文，或调整 sessions.agentStudio.skills.maxSkillsInPrompt。');
		assert.strictEqual(plan.full.length, candidates.length);
	});

	test(`★ ${CATEGORY_SKILL_ID} 已挂到 KB agent`, () => {
		const agent = getBuiltinAgents().find(a => a.id === KB_AGENT_ID);
		assert.ok(agent, `找不到内置 agent ${KB_AGENT_ID}`);
		assert.ok((agent.skills ?? []).includes(CATEGORY_SKILL_ID),
			`${KB_AGENT_ID} 的 skills 未包含 ${CATEGORY_SKILL_ID} —— 用户要求「新建分类 + 关联飞书知识库」时 agent 看不到该手册`);
	});

	test('★ 技能文档与代码常量一致（映射文件名 / 设置键 / feishu 记账字段）', () => {
		const skill = scanBuiltinSkills().find(s => s.id === CATEGORY_SKILL_ID);
		assert.ok(skill, `找不到技能 ${CATEGORY_SKILL_ID}`);
		const text = fs.readFileSync(path.join(process.cwd(), skill.rel), 'utf8');
		const script = readRepoFile(SYNC_SCRIPT_REL);

		// ① 目录↔知识库映射文件名：真值取自内置脚本，禁用测试里写死字面量
		const mapFile = /const SPACE_MAP_FILE = '([^']+)'/.exec(script)?.[1];
		assert.ok(mapFile, `未能从 ${SYNC_SCRIPT_REL} 提取 SPACE_MAP_FILE —— 脚本被重构？请同步本测试`);
		assert.ok(text.includes(mapFile!), `技能文档必须写明映射文件名「${mapFile}」（agent 靠它写显式映射）`);

		// ② 设置键：真源 = common/constants.ts（键名改了 ⇒ 文档不改就红）
		assert.ok(text.includes(AGENT_STUDIO_KB_FEISHU_CATEGORY_DEPTH),
			`技能文档必须写出设置键「${AGENT_STUDIO_KB_FEISHU_CATEGORY_DEPTH}」（否则用户改不对、agent 也指不对路）`);

		// ③ feishu 记账字段：真值取自脚本写 frontmatter 的 block 字面量
		const blockBody = /const block = \{([\s\S]*?)\n\s*\};/.exec(script)?.[1] ?? '';
		const fields = [...blockBody.matchAll(/^\s*([A-Za-z][\w]*)\s*[:,]/gm)].map(m => m[1]);
		assert.ok(fields.length >= 6,
			`未能从 ${SYNC_SCRIPT_REL} 的 block 字面量提取 feishu 记账字段（提取到 ${fields.length} 个）—— 脚本重构后请同步本测试`);
		const missing = fields.filter(f => !text.includes(f));
		assert.deepStrictEqual(missing, [],
			`技能文档必须列出这些 feishu 记账字段（由脚本维护、禁止手改）：${missing.join(', ')}`);
	});
});

/**
 * 游戏拆解技能（kb-game-teardown）—— 2026-09-24 新增并改名（原 `game-teardown`）。
 *
 * 这个技能是**纯 prompt 产物**（没有可执行代码），唯一能测的就是它的**契约**：
 *   ① 触发：用户说的那种话（「拆分游戏」/ 各平台视频链接 / 游戏名 + 拆解）必须真的命中
 *      `activation: auto` 的关键词 —— 技能写得再好，触发不了等于不存在；
 *   ② 能力诚实性：产品**拿不到视频画面**（只有封面一张图）、**agent 不能自己触发 URL 导入**
 *      —— 手册若不写清这两条，模型会「看图说话」编出实机 UI/战斗细节（这是本技能最大的幻觉风险）；
 *   ③ 落盘契约：产物必须是**素材层**（`库/raw`、无 frontmatter），而不是自己写 `笔记/`
 *      —— 写错层会造成素材/产物混淆与重复笔记；
 *   ④ 交接契约：素材落盘后必须**先问用户是否构建**，同意则用 `kb_build`（2026-09-24 起 agent
 *      才能自己发起构建；此前只能让用户点视图按钮）并把构建规则交给 kb-build
 *      —— 不写就会停在「报告写完了」而用户不知道下一步。
 */
suite('游戏拆解技能（kb-game-teardown）', () => {

	const SKILL = 'kb-game-teardown';
	const TEMPLATE_REL = `${SKILLS_REL}/${SKILL}/references/report-template.md`;

	function skill(): IScannedSkill {
		const s = scanBuiltinSkills().find(x => x.id === SKILL);
		assert.ok(s, `找不到技能 ${SKILL}`);
		return s;
	}

	function skillText(): string {
		return fs.readFileSync(path.join(process.cwd(), skill().rel), 'utf8');
	}

	/** 解析 frontmatter 的 `match: [a, b]` 内联数组（registry 支持的写法之一）。 */
	function parseInlineList(raw: string): string[] {
		const t = (raw ?? '').trim();
		if (!t.startsWith('[') || !t.endsWith(']')) { return []; }
		return t.slice(1, -1).split(',')
			.map(x => x.trim().replace(/^["']|["']$/g, ''))
			.filter(Boolean);
	}

	test('★ 触发：用户说「拆分游戏」/ 发来各平台游戏视频链接 / 游戏名 +「拆解」，都能命中 auto 激活关键词', () => {
		const meta = readFrontmatter(fs.readFileSync(path.join(process.cwd(), skill().rel), 'utf8')).meta;
		assert.strictEqual(meta['activation'], 'auto',
			`${SKILL} 应为 auto 激活（否则只有挂了它的 agent 才认识这个技能）`);

		const keywords = parseInlineList(meta['match'] ?? '');
		assert.ok(keywords.length >= 5, `match 关键词太少（${keywords.length} 个）⇒ 大量真实请求会漏触发：${meta['match']}`);
		assert.ok(keywords.some(k => k.includes('拆分游戏')),
			`must 命中用户的实际说法「拆分游戏」；当前关键词：${keywords.join(' / ')}`);

		// 与 registry `resolveActivations` 同一判据：auto 模式下，用户消息**包含**任一关键词即激活
		const messages = [
			'拆分游戏',
			'帮我拆分游戏：原神',
			'拆分游戏 黑神话悟空，重点看核心循环',
			'帮我拆解一下这个游戏 https://www.xiaohongshu.com/discovery/item/66f0c1',
			'这个抖音视频介绍的游戏帮我拆解 https://v.douyin.com/iJw8xQ1/',
			'https://www.youtube.com/watch?v=dQw4w9WgXcQ 请做游戏拆解，重点看核心循环',
			'帮我拆解《明日方舟》的玩法结构',
			'竞品拆解：这款 SLG 的数值是怎么设计的',
		];
		const missed = messages.filter(m => !keywords.some(kw => m.toLowerCase().includes(kw.toLowerCase())));
		assert.deepStrictEqual(missed, [],
			`以下真实用户消息不会触发本技能（auto 激活靠 match 关键词）：\n    ${missed.join('\n    ')}\n`
			+ `    当前关键词：${keywords.join(' / ')}`);
	});

	test('★ 能力诚实性：必须写明「导入需用户操作」「画面只有封面」「标注证据」「披露缺口」', () => {
		const text = skillText();

		// ① agent 无法自行触发 URL 导入 —— 不说清就会假装已拿到视频内容
		assert.match(text, /导入链接/, '必须指引用户去知识库视图点「导入链接 / URL」');

		// ② 画面素材：★ 2026-09-24 起**可以抽帧**了（此前只有封面一张静止图）——
		//    手册必须指向工具、写明依赖、并守住「抽样 ≠ 全片」这条最容易越界的边界。
		assert.match(text, /extract_video_frames/, '必须告诉 agent 有抽帧工具（否则它会以为只能看封面，进而编造画面）');
		assert.match(text, /ffmpeg/, '必须写明抽帧依赖 ffmpeg（缺依赖时给安装指引，而不是改用猜测）');
		assert.match(text, /封面/, '封面仍是元信息素材之一（且不得据此推断实机 UI）');
		assert.ok(/帧/.test(text) && /(帧 00:|时间点)/.test(text), '画面结论必须能标注帧时间点（[帧 mm:ss]）');
		assert.match(text, /(没抽到|没看过)/, '必须写明「没抽到的时段等于没看过」（防把抽样当全片）');

		// ③ 证据纪律：来源标记 + 事实/推断分离 + 反编造
		assert.match(text, /证据/, '必须有「每条结论挂来源标记」的证据纪律');
		assert.match(text, /推断/, '必须区分「事实」与「推断」');
		assert.match(text, /编造|凭经验编/, '必须有反编造条款（不得用常识/经验填补素材缺口）');

		// ④ 素材不足要如实披露，而不是留白或用常识填
		assert.match(text, /素材不足/, '素材不足的维度必须写明「需要什么素材才能补」');

		// ⑤ 反模式清单（零信息量描述是拆解报告最常见的退化形态）
		assert.match(text, /反模式/, '必须有反模式清单');
	});

	test('★ 工具链契约（2026-09-24）：ffmpeg/yt-dlp 随包自带，且默认首选用 `video_analyze`', () => {
		const text = skillText();
		// 随包二进制：技能必须让 agent 知道「不需要用户装东西」，否则它会去要安装步骤、
		// 或者干脆退回凭常识编造画面。
		assert.match(text, /随 VsSaros 自带|自带/, '必须写明媒体工具链随包自带');
		assert.match(text, /resources\/saros\/bin/, '必须给出内置二进制的实际位置（便于排查）');
		assert.match(text, /不需要用户装任何东西|不需要你安装|不需要.{0,4}安装/, '必须明确「不需要用户安装」');
		assert.match(text, /FFMPEG_PATH|YTDLP_PATH|fetch-ffmpeg/, '内置缺失时要给可执行的排查手段');
		// 两条路分工：整体理解用 video_analyze，证据/追问用 extract_video_frames
		assert.match(text, /video_analyze/, '必须告诉 agent 有「一次看懂视频」的工具（此前只能逐张读帧）');
		assert.match(text, /extract_video_frames/, '逐帧证据路径仍要保留');
	});

	test('★ 落盘契约：产物进素材层 `库/raw`（无 frontmatter），不得自己写 `笔记/`', () => {
		const text = skillText();
		assert.match(text, /库\/raw/, '必须写明落点是知识库的 `库/raw`（素材层）');
		assert.match(text, /笔记\//, '必须写明不要自己往 `笔记/` 写（那是构建的活）');
		assert.match(text, /frontmatter/, '必须交代素材**不写** frontmatter（type/title/sources 是构建产物字段）');
		assert.match(text, /assets\//, '帧图必须落到 `库/raw/assets/<游戏名>/` 并用相对路径引用');
	});

	test('★ 交接契约（2026-09-24 更新）：**先问用户**，同意后用 `kb_build` 发起，构建规则交棒 kb-build', () => {
		const text = skillText();
		// ★ 现实已变：agent 现在**有** kb_build 工具可发起构建（此前只能让用户点按钮）。
		//   技能必须据此改写，否则会退回「叫用户自己去点按钮」的旧行为。
		assert.match(text, /kb_build/, '必须告诉 agent 用 kb_build 发起构建');
		assert.match(text, /mode:"preview"|mode: ?'preview'|mode:"build"|mode: ?'build'/, '必须写清两个 mode 的用法（只读预检 / 发起）');
		// 「先问用户」是本技能的显式产品要求（构建是分钟级长任务，不该未经确认就启动）
		assert.match(text, /(先问用户|询问用户|问用户)/, '必须先询问用户是否构建，而不是擅自发起');
		assert.match(text, /(用户同意|用户确认|同意 ⇒|同意 ?⇒)/, '必须写清「同意后才发起」的条件');
		assert.match(text, /勿等|不要等|立即返回/, '必须说明 kb_build 是「发起即返回」的长任务，不要等它跑完');
		assert.match(text, /kb-build/, '构建规则必须交棒给技能 kb-build（单一真源）');
		// 人工入口仍要保留（用户可能更愿意自己点）
		assert.match(text, /批量构建库/, '仍要给出视图按钮入口（人工备选）');
		assert.match(text, /构建为笔记/, '仍要给出单篇构建入口（人工备选）');
	});

	test('形式契约：图用 mermaid、不手写 feishu 字段，且引用的骨架文件真实存在', () => {
		const text = skillText();
		assert.match(text, /mermaid/, '核心循环/系统关系应用 mermaid 表达');
		assert.match(text, /feishu:/, '必须提醒不要手写 feishu 记账字段');
		assert.match(text, /references\/report-template\.md/,
			'报告骨架应以渐进披露方式引用（references/…），否则手册会过长');
		assert.ok(fs.existsSync(path.join(process.cwd(), TEMPLATE_REL)),
			`技能引用的骨架文件不存在（渐进披露断链）：${TEMPLATE_REL}`);
	});

	test('★ 已挂到主助理；主助理具备读图能力（画面证据来自抽帧/截图）', () => {
		const claw = getBuiltinAgents().find(a => a.id === 'saros-claw');
		assert.ok(claw, '找不到内置 agent saros-claw');
		assert.ok((claw.skills ?? []).includes(SKILL),
			`saros-claw 未挂载 ${SKILL} —— 用户直接对助理说「拆解这个游戏」时拿不到手册`);
		assert.ok((claw.tools ?? []).includes('vision_analyze'),
			'saros-claw 缺 vision_analyze ⇒ 帧图/用户发的截图都看不了，画面层结论只能空着');
	});

	test('★ 拆解链路的工具补齐（2026-09-24）：能上网补证 / 能检索知识库 / 两端都能抽帧 / 能发起构建', () => {
		const claw = getBuiltinAgents().find(a => a.id === 'saros-claw');
		const kb = getBuiltinAgents().find(a => a.id === KB_AGENT_ID);
		assert.ok(claw && kb);

		// 主助理：能检索知识库（此前完全不能 ⇒ 写内容无从复用用户既有笔记）+ 能看视频 + **能发起构建**
		// （最后一项是「拆分游戏 → 落库 → 问用户 → 构建」闭环的收尾；缺它整条链路断在最后一步）
		for (const tool of ['kb_search', 'extract_video_frames', 'video_analyze', 'vision_analyze', 'kb_build']) {
			assert.ok((claw!.tools ?? []).includes(tool), `saros-claw 缺 ${tool}`);
		}
		// KB agent：能上网补证（此前完全不能 ⇒ 与「禁止编造」直接冲突）+ 能抽帧
		for (const tool of ['web_search', 'web_extract', 'extract_video_frames', 'vision_analyze']) {
			assert.ok((kb!.tools ?? []).includes(tool), `${KB_AGENT_ID} 缺 ${tool}`);
		}
		// ⚠ 反向契约：KB agent **不该**拿到 kb_build —— 构建会话正由它执行，给它构建工具
		//   会造成「构建中再发起构建」（互斥虽能拦住，但那是把护栏当设计用）。
		assert.ok(!(kb!.tools ?? []).includes('kb_build'),
			`${KB_AGENT_ID} 不应挂 kb_build（构建会话由它自己执行 ⇒ 递归风险）`);
	});
});

/**
 * 多平台内容导入技能（web-content-import）—— 2026-09-24 新增。
 *
 * 与 kb-game-teardown 一样是**纯 prompt 产物**（没有可执行代码），所以能测的只有契约：
 *   ① 触发：用户真的会说的那几种话（各平台链接 + 「存进知识库」）必须命中 `activation: auto` 的关键词
 *      —— 技能写得再好，触发不了等于不存在；⚠ 判据是"消息**包含**关键词"，所以关键词必须是用户真会
 *      连在一起说的片段（写成 `抓取链接` 反而漏掉「抓取**这个**链接」）。
 *   ② 能力诚实性：agent **不能**触发视图的「导入链接」按钮、**没有**页面内执行 JS 的能力、
 *      视频**不下本体**、登录墙只能请用户在那个窗口登录一次（不得索要凭据）—— 不写清就是"假成功"。
 *   ③ 落盘契约：`库/raw`（素材层、**无 frontmatter**）+ 图片**相对路径** `assets/<slug>/…`
 *      （绝对路径会让笔记预览与飞书同步双双失效）。
 *   ④ 形状一致性：两种产物骨架必须与宿主 `compose{Article,Video}Markdown` 对齐，
 *      且 `references/output-template.md` 必须真实存在（断链 = 模型无从下笔）。
 */
suite('多平台内容导入技能（web-content-import）', () => {

	const SKILL = 'web-content-import';
	const TEMPLATE_REL = `${SKILLS_REL}/${SKILL}/references/output-template.md`;

	function skill(): IScannedSkill {
		const s = scanBuiltinSkills().find(x => x.id === SKILL);
		assert.ok(s, `找不到技能 ${SKILL}`);
		return s;
	}

	function skillText(): string {
		return fs.readFileSync(path.join(process.cwd(), skill().rel), 'utf8');
	}

	/** 解析 frontmatter 的 `match: [a, b]` 内联数组（registry 支持的写法之一）。 */
	function parseInlineList(raw: string): string[] {
		const t = (raw ?? '').trim();
		if (!t.startsWith('[') || !t.endsWith(']')) { return []; }
		return t.slice(1, -1).split(',')
			.map(x => x.trim().replace(/^["']|["']$/g, ''))
			.filter(Boolean);
	}

	/** 与 registry `resolveActivations` 同一判据：auto 模式下消息**包含**任一关键词即激活。 */
	function matchesAny(message: string, keywords: readonly string[]): boolean {
		const m = message.toLowerCase();
		return keywords.some(kw => m.includes(kw.toLowerCase()));
	}

	test('★★ 触发：各平台链接 + 「存进知识库」等真实说法都能命中 auto 关键词', () => {
		const meta = readFrontmatter(skillText()).meta;
		assert.strictEqual(meta['activation'], 'auto',
			`${SKILL} 应为 auto 激活（否则没挂它的 agent 根本看不到这个技能）`);

		const keywords = parseInlineList(meta['match'] ?? '');
		assert.ok(keywords.length >= 5, `match 关键词太少（${keywords.length} 个）⇒ 大量真实请求会漏触发`);

		// 用户原话（含本仓日志里真实出现过的说法：丢小红书链接、要求存进知识库）
		const messages = [
			'帮我抓取这个链接的内容 https://mp.weixin.qq.com/s/AbCdEf',
			'把这篇公众号文章存进知识库 https://mp.weixin.qq.com/s/xxxx',
			'这个小红书笔记帮我读一下 https://www.xiaohongshu.com/discovery/item/6ab49a52',
			'https://xhslink.com/o/2Fq3k 存到知识库',
			'帮我总结这个视频 https://www.bilibili.com/video/BV1xx411c7mD',
			'https://b23.tv/abc123 这个视频的字幕给我',
			'这个抖音视频的文案帮我存下来 https://v.douyin.com/iJw8xQ1/',
			'https://youtu.be/dQw4w9WgXcQ 转成 markdown',
			'帮我看看这篇知乎回答 https://www.zhihu.com/question/123456',
			'https://juejin.cn/post/7123456 这篇文章归档一下',
			'这个帖子收藏到知识库 https://weibo.com/1234/abcd',
		];
		const missed = messages.filter(msg => !matchesAny(msg, keywords));
		assert.deepStrictEqual(missed, [],
			`以下真实用户消息不会触发本技能（auto 激活靠 match 关键词）：\n    ${missed.join('\n    ')}\n`
			+ `    当前关键词：${keywords.join(' / ')}`);
	});

	test('★ 能力诚实性：四条"我没有"必须写明（不写就等着模型编造）', () => {
		const text = skillText();

		assert.match(text, /导入链接/, '必须点明：知识库视图那个「导入链接 / URL」按钮 agent 不能触发');
		assert.match(text, /没有「在页面里执行任意 JS」的工具/,
			'必须说明没有页面内 JS 执行能力（否则模型会以为能 in-page fetch 拿登录后的数据）');
		assert.match(text, /不下载视频本体/, '必须说明视频不下本体（否则会声称"已保存视频"）');
		assert.match(text, /登录一次/, '登录墙的出路必须写成"请用户在那个窗口里登录一次"');
		assert.match(text, /绝不[^。\n]*索要/, '必须写死"绝不向用户索要账号密码或 cookie"');
	});

	test('★★ 落盘契约：库/raw（素材层）+ 无 frontmatter + 图片相对路径 + 不写 笔记/', () => {
		const text = skillText();

		assert.match(text, /库\/raw\/<slug>\.md/, '正文必须落到 库/raw/<slug>.md');
		assert.match(text, /素材不写 YAML frontmatter/,
			'素材层不得写 frontmatter（type/title/sources 是笔记才有的字段）');
		assert.match(text, /assets\/<slug>\//,
			'图片必须是相对路径 assets/<slug>/…（绝对路径会让笔记预览与飞书同步双双失效）');
		assert.match(text, /不要\*\*自己往 `笔记\/` 写/,
			'必须禁止自己往 笔记/ 写（会绕过补链/门控/台账）');
	});

	test('★ yt-dlp 命令与宿主 kbVideoFetch 同口径（两条路行为不能不一致）', () => {
		const text = skillText();

		assert.match(text, /--skip-download/);
		assert.match(text, /--write-auto-subs/);
		assert.match(text, /\|\|\|/,
			'元信息必须用 --print + ||| 分隔（--dump-json 含 formats 数组会被命令通道截断）');
		assert.match(text, /execute_code/, '抓取主路径必须是 execute_code（terminal 会弹审批、打断流程）');
	});

	test('★★ 媒体硬要求：关键图片 / 视频地址 / 关键帧三条都在手册与模板里', () => {
		const text = skillText();

		// ① 关键图片：SPA 页面唯一的图片入口是 browser_get_images（snapshot 不给图片）——
		//    不说清的话，模型在图文帖上会以为"快照就够了"，然后基于残缺文本写结论。
		assert.match(text, /browser_get_images/, '关键图片在 SPA 页面的唯一入口');
		assert.match(text, /不采集图片/, '必须点明 browser_snapshot 拿不到图片');

		// ② 视频地址：要给出可执行命令与"哪种 URL"的区分（页面地址长期有效 / 直链有时效）
		assert.match(text, /webpage_url/, '必须给出拿页面地址与直链的确切 --print 字段');
		assert.match(text, /有时效|时效/, '直链有时效，必须提醒标注抓取日期');

		// ③ 关键帧：必须用抽帧工具、且画面结论要挂帧标记
		assert.match(text, /extract_video_frames/, '关键帧要用抽帧工具');
		assert.match(text, /\[帧 mm:ss\]/, '画面结论必须挂帧标记（没抽到的时段等于没看过）');

		const tpl = fs.readFileSync(path.join(process.cwd(), TEMPLATE_REL), 'utf8');
		assert.match(tpl, /视频地址：/, '模板必须有"视频地址"那一行');
		assert.match(tpl, /## 关键帧/, '模板必须有"关键帧"段');
		assert.match(tpl, /拿不到/, '模板必须要求写清"哪些媒体没拿到、为什么"');
	});

	test('★★ 形状一致性：模板文件存在，且与宿主 compose{Article,Video}Markdown 对齐', () => {
		assert.ok(fs.existsSync(path.join(process.cwd(), TEMPLATE_REL)),
			`缺少输出模板 ${TEMPLATE_REL} —— 技能正文引用了它，断链会让模型无处下笔`);

		const tpl = fs.readFileSync(path.join(process.cwd(), TEMPLATE_REL), 'utf8');
		assert.match(tpl, /## 字幕（用于总结视频内容）/,
			'视频骨架必须与 kbImportController 的拼接逐字一致（字幕段标题）');
		assert.match(tpl, /\*\*摘要\*\*/, '文章骨架必须有摘要行（composeArticleMarkdown 的形态）');
		assert.match(tpl, /assets\/<slug>\//, '模板里的图片也必须用相对路径');
	});
});
