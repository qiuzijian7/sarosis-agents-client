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
