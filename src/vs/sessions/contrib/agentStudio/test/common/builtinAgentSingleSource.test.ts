/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内置 agent 的**单一真源**守卫。
 *
 * ★ 真源 = `resources/.agents/agents/<id>/.agent.md`（2026-10-19 用户裁决）。
 *
 * 历史（为什么需要这个用例）：这里曾经是"文件优先 + 代码回退"的**双真源** ⇒ 改一边另一边不知道，
 *   实测 15 个里 5 个漂移：saros-claw 挂的 `web-content-import`、`kb-game-teardown` 只在代码里
 *   （文件里没有 ⇒ **长期没生效**）；tester 反过来是文件里那份 v2.0.0 才是新的、代码里只有一句话。
 *   中途还走过一次"以代码为准、删掉文件"的反向收敛，最终定回文件为真源：内置 agent 是随包发布的
 *   **内容**，用 md 表达（可 diff、可人工改、与业界 `.agent.md` 同形）比埋在 TS 里合适。
 *
 * 代码里那份 `getBuiltinAgents()` 因此降级为**回退镜像**（资源目录不可读时才用）。本文件守四件事：
 *   ① 真源目录存在、每个子目录都有 `.agent.md`；
 *   ② 每份 `.agent.md` 自身合法（id/name/systemPrompt 齐备、id 唯一、挂的技能真实存在）；
 *   ③ **代码镜像与文件真源逐字段一致** —— 这正是"漂移即红"的那一条（③ 一红就说明又有人只改了一边）；
 *   ④ knowledge-base-expert 挂着 help-me-understand（技能登记没被回退）。
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseAgentMd } from '../../common/agentMdFormat.js';
import { getBuiltinAgents, USER_FACING_BUILTIN_AGENT_IDS } from '../../common/builtinAgents.js';

const AGENTS_DIR = 'resources/.agents/agents';
const SKILLS_DIR = 'resources/.agents/skills';

/**
 * 曾经被容忍的"技能并不存在"的历史钩子（`writing` / `planning`）—— 与 `builtinSkillContracts.test.ts`
 * 的 `KNOWN_ABSENT_SKILL_IDS` **同一个集合**（改一处要改两处，否则两个守卫口径会漂）。
 *
 * ★ 2026-10-19 已**全部清理**（依据查过：内置库没有这两个 id；用户库里那枚叫 writing-skills、
 *   是另一个 id ⇒ 摘掉没有削功能 ✓）。这里保留集合只是为了**给一条更明确的报错**——
 *   谁要再挂回去，会被本用例点名。
 *   ⚠ 口径对齐：`builtinSkillContracts.test.ts` 的同名集合现在也是**空集**（同样变硬）
 *   ⇒ 两处都不会再静默放过（改一处要改两处，别让它们漂 ✗）。
 */
const KNOWN_ABSENT_SKILL_IDS = new Set(['writing', 'planning']);

/** 换行与首尾空白归一化（两份来源的行尾可能不同 ⇒ 只比内容）。 */
const norm = (s: string | undefined): string => (s ?? '').replace(/\r\n/g, '\n').trim();

function readBuiltinFiles(): Array<{ id: string; text: string }> {
	const abs = path.join(process.cwd(), AGENTS_DIR);
	assert.ok(fs.existsSync(abs), `内置 agent 真源目录不见了：${AGENTS_DIR}`);
	const out: Array<{ id: string; text: string }> = [];
	for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
		// ⚠ `dirent.isDirectory` 是**方法**不是属性 —— 写成属性会得到函数（truthy）⇒ 把散落的 .md 文件也当目录（踩过）。
		if (!d.isDirectory()) { continue; }
		const file = path.join(abs, d.name, '.agent.md');
		if (!fs.existsSync(file)) { continue; }
		out.push({ id: d.name, text: fs.readFileSync(file, 'utf8') });
	}
	return out;
}

suite('内置 agent 单一真源（.agent.md）', () => {

	test('① 真源目录存在，且每个子目录都有 .agent.md', () => {
		const abs = path.join(process.cwd(), AGENTS_DIR);
		assert.ok(fs.existsSync(abs), `内置 agent 的真源目录不存在：${AGENTS_DIR}（真源是这里的 .agent.md，不是代码）`);
		// ⚠ `isDirectory` 是方法（写成属性会恒为 truthy ⇒ 把文件也算进来，踩过）
		const dirs = fs.readdirSync(abs, { withFileTypes: true }).filter(d => d.isDirectory());
		assert.ok(dirs.length >= 15, `内置 agent 只剩 ${dirs.length} 个？`);
		const missing = dirs.filter(d => !fs.existsSync(path.join(abs, d.name, '.agent.md'))).map(d => d.name);
		assert.deepStrictEqual(missing, [], `这些 agent 目录里没有 .agent.md：${missing.join('、')}`);
	});

	test('② 每份 .agent.md 自身合法（id/name/systemPrompt 齐备、id 唯一、挂的技能真实存在）', () => {
		const files = readBuiltinFiles();
		const seen = new Set<string>();
		for (const f of files) {
			const parsed = parseAgentMd(f.text);
			assert.ok(parsed, `${f.id}/.agent.md 解析失败`);
			const a = parsed!.agent;
			assert.ok(a.id, `${f.id} 缺 id`);
			assert.strictEqual(a.id, f.id, `${f.id} 的 frontmatter id 与目录名不一致（目录名才是 id）`);
			assert.strictEqual(seen.has(a.id!), false, `id 重复：${a.id}`);
			seen.add(a.id!);
			assert.ok(a.name, `${f.id} 缺 name`);
			assert.ok(parsed!.systemPrompt && parsed!.systemPrompt.length > 0, `${f.id} 缺正文（systemPrompt）`);
			for (const skill of a.skills ?? []) {
				// 2026-10-19 已清理掉这两个"技能不存在"的挂载 ⇒ 再挂回来会在这里被点名（见常量注释）。
				assert.strictEqual(KNOWN_ABSENT_SKILL_IDS.has(skill), false,
					`${f.id} 又挂回了不存在的技能「${skill}」—— 挂了等于没挂，别再挂`);
				assert.ok(fs.existsSync(path.join(process.cwd(), SKILLS_DIR, skill)),
					`${f.id} 挂了不存在的技能「${skill}」—— 静默空引用，挂了等于没挂`);
			}
		}
	});

/**
 * 给出"第一个差异在哪"的上下文片段。
 *
 * ★★ 2026-10-19（真机教训）：这条守卫原先只 push **字段名**（`xxx.systemPrompt`），
 *   于是失败信息只说"不一致"、不说**差在哪** ⇒ 改 agent 定义时只能盲试
 *   （实测盲试 8 轮都没收敛，因为 systemPrompt 是「自己的 prompt + 共享常量 + delegation」三段拼出来的）。
 *   ⇒ 现在失败时会带：首个差异的字符位置 + 两侧前后各 60 字符（换行显示为 \n）。
 */
function describeDrift(expected: string, actual: string): string {
	let i = 0;
	while (i < expected.length && i < actual.length && expected[i] === actual[i]) { i++; }
	const from = Math.max(0, i - 60);
	const cut = (s: string) => s.slice(from, i + 60).replace(/\r/g, '').replace(/\n/g, '\\n');
	return `（首个差异 @${i} 字符\n        文件: …${cut(expected)}…\n        代码: …${cut(actual)}…）`;
}

	test('③ 代码镜像（getBuiltinAgents）与文件真源逐字段一致 —— 漂移即红', () => {
		const files = readBuiltinFiles();
		const byId = new Map<string, ReturnType<typeof parseAgentMd>>();
		for (const f of files) { byId.set(f.id, parseAgentMd(f.text)); }

		const drift: string[] = [];
		for (const code of getBuiltinAgents()) {
			const file = byId.get(code.id);
			if (!file) { drift.push(`${code.id}：文件真源里没有它（只在代码里 ⇒ 会不会根本没生效？）`); continue; }
			if (norm(file.agent.name) !== norm(code.name)) { drift.push(`${code.id}.name`); }
			if (norm(file.agent.description) !== norm(code.description)) { drift.push(`${code.id}.description`); }
			if (norm(file.systemPrompt) !== norm(code.systemPrompt)) {
				drift.push(`${code.id}.systemPrompt${describeDrift(norm(file.systemPrompt), norm(code.systemPrompt))}`);
			}
			if (JSON.stringify([...(file.agent.skills ?? [])].sort()) !== JSON.stringify([...(code.skills ?? [])].sort())) {
				drift.push(`${code.id}.skills（文件=${(file.agent.skills ?? []).join(',')} 代码=${(code.skills ?? []).join(',')}）`);
			}
			if (JSON.stringify([...(file.agent.tools ?? [])].sort()) !== JSON.stringify([...(code.tools ?? [])].sort())) {
				// 同样把差异列出来（tools 是短列表，直接给两边内容最省事）
				const fileTools = [...(file.agent.tools ?? [])].sort().join(',');
				const codeTools = [...(code.tools ?? [])].sort().join(',');
				drift.push(`${code.id}.tools（文件=${fileTools} 代码=${codeTools}）`);
			}
		}
		// 反向：文件里有、代码里没有的（回退镜像缺一份 ⇒ 资源不可读时这个 agent 就消失了）
		const codeIds = new Set(getBuiltinAgents().map(a => a.id));
		for (const f of files) {
			if (!codeIds.has(f.id)) { drift.push(`${f.id}：只在文件真源里、代码镜像没有（回退时会丢）`); }
		}
		assert.deepStrictEqual(drift, [],
			'内置 agent 又漂移了（文件真源与代码镜像不一致）—— 改的时候**两边一起改**，或把代码那份彻底删掉：\n    '
			+ drift.join('\n    '));
	});

/** ⑤/⑥ 共用：取 frontmatter 原文（不做 YAML 解析，只按行判字段）。 */
function frontmatterOf(text: string): string {
	const end = text.indexOf('\n---', 3);
	return end < 0 ? '' : text.slice(3, end);
}

	/**
	 * ⑤ 展示白名单：IDE 常量 ⇄ `.agent.md` 的 `userFacing: true`。
	 *
	 * 为什么要有这条（2026-10-20）：dsh 侧的名册/群成员/子代理候选按 **文件字段** 过滤
	 * （`dsh-plugins/vssaros-agents` 的 `isShownAgent`），IDE 侧按 **代码常量** 过滤
	 * （`USER_FACING_BUILTIN_AGENT_IDS`）。两处各写一份名单必然漂移（这个仓库已经栽过
	 * "同一份清单两条读取路径" 至少两次）⇒ 用这条用例把它们钉在同一个集合上：
	 * 改一边不改另一边，这里立刻红。
	 */
	test('⑤ 展示白名单 = 文件里 userFacing: true 的集合（IDE 常量 ⇄ .agent.md）', () => {
		const marked = readBuiltinFiles()
			.filter(f => /^userFacing:\s*true\s*$/m.test(frontmatterOf(f.text)))
			.map(f => f.id)
			.sort();
		const listed = [...USER_FACING_BUILTIN_AGENT_IDS].sort();
		assert.deepStrictEqual(marked, listed,
			'展示白名单漂移了：IDE 常量 USER_FACING_BUILTIN_AGENT_IDS 与 `.agent.md` 的 `userFacing: true` 必须一模一样\n    '
			+ `文件=(${marked.join(',')}) 代码=(${listed.join(',')})`);
	});

	/**
	 * ⑥ 审查族必须声明 `subagents: false`。
	 *
	 * 理由：dsh 的 `tools.restrict()` 只作用于**继承来的全局工具**（`Restrictions intersect;
	 * scoped registrations remain visible.`），而 `subagent` 行是同一 preset 作用域内挂的 ⇒
	 * 工具 allowlist **拦不住**它。所以「审查只有一个席位」的唯一真闸是这个字段，丢掉它
	 * 就等于让每个审查 agent 重新长出"再派一个 reviewer"的能力（成本翻倍、票不算数）。
	 */
	test('⑥ 审查族声明 subagents: false（dsh 侧据此不挂 tool-subagent / fork 行）', () => {
		const reviewers = ['code-reviewer', 'task-reviewer', 're-reviewer'];
		for (const id of reviewers) {
			const file = byIdPath(id);
			assert.ok(file, `真源里找不到 ${id}/.agent.md`);
			assert.ok(/^subagents:\s*false\s*$/m.test(frontmatterOf(file!)),
				`${id} 的 frontmatter 里没有 \`subagents: false\` —— 它会在 dsh 侧拿到 subagent 工具（审查席位翻倍）`);
		}
	});

	test('④ knowledge-base-expert 挂着 help-me-understand（技能登记没被回退）', () => {
		const file = byIdPath('knowledge-base-expert');
		assert.ok(file, '真源里找不到 knowledge-base-expert/.agent.md');
		const parsed = parseAgentMd(file!);
		assert.ok(parsed, 'knowledge-base-expert/.agent.md 解析失败');
		assert.ok((parsed!.agent.skills ?? []).includes('help-me-understand'),
			'knowledge-base-expert 的 skills 里没有 help-me-understand —— 讲懂技能没挂上');
	});
});

function byIdPath(id: string): string | undefined {
	const file = path.join(process.cwd(), AGENTS_DIR, id, '.agent.md');
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}
