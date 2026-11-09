// @vssaros/dsh-agents — 团队步骤的记忆沉淀（2026-11-04，superagent v2 P4）
//
// superagent 在一个团队步骤结束后，经记忆总线（lib/memoryBus.js）交来一份「执行证据」。
// 由本插件（它管 bot 记忆）决定落到哪里：
//   · mode = 'facts'：只往**该 bot** 的 MEMORY.md 追加一条事实（不调模型、不产生技能）；
//   · mode = 'skill'：同样记一条事实，并在技能库的草稿区 `<dataRoot>/skills/.drafts/<name>/SKILL.md`
//     写一份**归属该 bot** 的技能草稿（vssaros-skills 的布局与 frontmatter），等人在面板批准后转正。
// 门槛（哪个步骤算 skill）由 superagent 判定（≥3 回合，或失败过 / 重派过），这里照单执行。
//
// 2026-11-06：草稿由模型提炼（lib/stepDistill.js 一次性调用，提示与解析在 lib/core/skillDistill.js），
// 与该 bot 已有的技能相似 ⇒ 出那项技能的新版本草稿（批准后替换生效版，旧版留 SKILL.v<N>.md），否则新建；
// 风险分级（low / medium / high）写进 frontmatter。模型不可用时退回模板草稿，标 `distilled: template`。
// 这是全仓唯一写技能文件的路径（superagent 只交证据：team_distill → 记忆总线 → 这里）。
// 草稿用临时文件 + rename 落盘；没有拿 vssaros-skills 的 `<skillsRoot>.lock`（那把锁的格式属于它，跨插件不复用）。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataRootOf } from './store.js';
import { appendToInbox, ENTRY_MAX_CHARS, unifiedMemoryStore } from './memoryFiles.js';
import { gradeRisk, pickSimilar, renderSkill, templateOf } from './core/skillDistill.js';

/** @vssaros/dsh-memory 的 store.add 结果 → 本模块的 fact 形状（`{ ok, message, duplicate? }`）。 */
function unifiedFact(r) {
	return { ok: r?.ok === true, message: String(r?.message ?? ''), ...(r?.duplicate ? { duplicate: true } : {}) };
}

export const DRAFTS_DIR = '.drafts';
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 技能库根目录：与 vssaros-skills 的默认值一致（`<dataRoot>/skills`）。 */
export function skillsRootOf(config) {
	const configured = typeof config?.skillsRoot === 'string' ? config.skillsRoot.trim() : '';
	return configured || join(dataRootOf(config), 'skills');
}

const slug = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const clip = (text, max) => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** 一份证据对应的技能名：bot + 步骤标题，同一 bot 的同一类步骤得到同一个名字。 */
export function skillNameOf(evidence) {
	const hash = createHash('sha256').update(`${evidence.botId}\n${String(evidence.stepTitle ?? '').trim()}`).digest('hex').slice(0, 8);
	const name = `bot-${slug(evidence.botId).slice(0, 40) || 'agent'}-${hash}`;
	return SKILL_NAME_RE.test(name) ? name : `bot-${hash}`;
}

/** bot 记忆里的一行事实（≤400 字符）。 */
export function factOf(evidence) {
	const head = `[团队工单] ${clip(evidence.ticketTitle, 60)} · ${evidence.stepKey} ${clip(evidence.stepTitle, 40)} · ${evidence.outcome}`;
	const tail = [evidence.attempts > 1 ? `第 ${evidence.attempts} 次完成` : '', clip(evidence.report, 400)].filter(Boolean).join('；');
	return clip(`${head}：${tail}`, ENTRY_MAX_CHARS);
}

/** frontmatter 里的版本号（顶层或 `metadata:` 下的 `version:`），没有就是 1。 */
export function versionOf(text) {
	const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''))?.[1] ?? '';
	return Number(/^\s*version:\s*(\d+)\s*$/m.exec(head)?.[1] ?? 1) || 1;
}
const titleOf = (text) => (/^#\s+(.+)$/m.exec(String(text ?? ''))?.[1] ?? '').trim();

/** 归属某个 bot 的技能，已生效的与草稿都算：`[{ name, description, title, version, state, path }]`。 */
export async function skillsOwnedBy(config, botId) {
	const want = `bot:${String(botId ?? '').trim()}`;
	const root = skillsRootOf(config), found = [];
	for (const [dir, state] of [[root, 'active'], [join(root, DRAFTS_DIR), 'draft']]) {
		let entries = [];
		try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) { continue; }
			const path = join(dir, entry.name, 'SKILL.md');
			const text = await readFile(path, 'utf8').catch(() => '');
			if (!text || ownerOf(text) !== want) { continue; }
			found.push({ name: entry.name, description: descriptionOf(text), title: titleOf(text), version: versionOf(text), state, path });
		}
	}
	return found;
}
const writeAtomically = (dir, text) => {
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `SKILL.md.tmp.${process.pid}.${Date.now().toString(36)}`);
	writeFileSync(tmp, text, 'utf8');
	renameSync(tmp, join(dir, 'SKILL.md'));
	return join(dir, 'SKILL.md');
};

/**
 * 记一份步骤证据：该 bot 的记忆里加一条事实；`mode = 'skill'` 时再出一份技能草稿。
 *
 * 2026-11-06（superagent v2 第 7 节）：草稿由模型提炼（`deps.distill`，见 lib/stepDistill.js 与 lib/core/skillDistill.js），
 * 与该 bot 已有的技能比对：同一项 ⇒ 出那项技能的新版本草稿（已有草稿就更新它），否则新建；风险分级写进 frontmatter。
 * 没有 `deps.distill` 或它失败时退回模板草稿（`distilled: false`，带原因）。
 *
 * 返回 `{ fact: {ok, duplicate?, message}, skill?: { name, path, created, state: 'draft', version, risk, riskReasons, distilled, updates?, distillError? } }`。
 * @throws 证据缺字段；bot 记忆写锁冲突（409，调用方稍后重试）。
 */
export async function rememberStep(config, evidence, deps = {}) {
	for (const field of ['botId', 'ticketId', 'stepKey', 'stepTitle', 'outcome', 'mode']) {
		if (!String(evidence?.[field] ?? '').trim()) { throw new Error(`执行证据缺少 ${field}`); }
	}
	if (evidence.mode !== 'facts' && evidence.mode !== 'skill') { throw new Error(`未知 mode：${evidence.mode}`); }
	// Bot 记忆在 @vssaros/dsh-memory 的 bot 轨（写入口 globalThis[Symbol.for('vssaros.memory.store')]）。
	//   它还没就绪（Host 启动早期）⇒ 暂存进旧目录的收件箱；统一存储下次启动时并入，不会丢。
	const unified = unifiedMemoryStore(1);
	const fact = unified && typeof unified.addBotEntry === 'function'
		? unifiedFact(unified.addBotEntry(evidence.botId, factOf(evidence)))
		: appendToInbox(config, evidence.botId, factOf(evidence));
	const result = { fact: { ok: fact.ok, message: fact.message, ...(fact.duplicate ? { duplicate: true } : {}) } };
	if (evidence.mode !== 'skill') { return result; }
	const owned = await skillsOwnedBy(config, evidence.botId);
	// 同名的已生效版与草稿合成一项：版本取较高的那个
	const byName = new Map();
	for (const skill of owned) {
		const seen = byName.get(skill.name);
		byName.set(skill.name, { ...skill, active: skill.state === 'active' || !!seen?.active, draft: skill.state === 'draft' || !!seen?.draft,
			version: Math.max(skill.version, seen?.version ?? 0), description: skill.description || seen?.description || '' });
	}
	const existing = [...byName.values()];
	let content, distilled = false, distillError;
	if (typeof deps.distill === 'function') {
		try {
			content = await deps.distill(evidence, existing.slice(0, 8).map(({ name, description, version }) => ({ name, description, version })));
			distilled = true;
		} catch (error) { distillError = String(error?.message ?? error).slice(0, 300); }
	} else { distillError = '没有提炼模型（记忆系统的模型调用未就绪）'; }
	content ??= templateOf(evidence);
	const target = pickSimilar(content, existing, content.sameAs) ?? byName.get(skillNameOf(evidence));
	const name = target?.name ?? skillNameOf(evidence);
	// 已生效 ⇒ 出新版本草稿；只有草稿（还没批）⇒ 用新证据更新那份草稿，版本不变
	const version = target ? (target.active ? target.version + 1 : target.version) : 1;
	const risk = gradeRisk(content, [content.when, ...content.steps, ...content.pitfalls, ...content.verify, evidence.report].join('\n'));
	const path = writeAtomically(join(skillsRootOf(config), DRAFTS_DIR, name), renderSkill({ name, version, evidence, content, risk, distilled,
		...(target?.active ? { previous: { version: target.version } } : {}) }));
	return { ...result, skill: { name, path, created: !target, state: 'draft', version, risk: risk.level, riskReasons: risk.reasons, distilled,
		...(target ? { updates: target.active ? 'active' : 'draft' } : {}), ...(content.model ? { model: content.model } : {}), ...(distillError ? { distillError } : {}) } };
}

/** 一个技能文件 frontmatter 里的归属（`owner: "bot:<id>"`，顶层或 `metadata:` 下都认）。 */
export function ownerOf(text) {
	const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''))?.[1] ?? '';
	const value = /^\s*owner:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(head)?.[1];
	return value ? value.trim() : '';
}
const descriptionOf = (text) => {
	const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''))?.[1] ?? '';
	return (/^description:\s*["']?(.*?)["']?\s*$/m.exec(head)?.[1] ?? '').trim();
};

/**
 * 归属某个 bot 的**已生效**技能（`<root>/<name>/SKILL.md`，不含 `.drafts`）：名字与描述，按名字排序，最多 `limit` 个。
 * 读不到技能库（还没建）就是空列表。bot 的会话据此在人设段里列出「你的技能」，用 skill 工具按名字读取。
 */
export async function ownedSkillsOf(config, agentId, limit = 12) {
	const want = `bot:${String(agentId ?? '').trim()}`;
	if (want === 'bot:') { return []; }
	const root = skillsRootOf(config);
	let entries = [];
	try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
	const found = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) { continue; }
		const text = await readFile(join(root, entry.name, 'SKILL.md'), 'utf8').catch(() => '');
		if (text && ownerOf(text) === want) { found.push({ name: entry.name, description: clip(descriptionOf(text), 160) }); }
	}
	return found.sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
}

/**
 * 人设段末尾的「你的技能」一节；没有技能时为空串。
 * @deprecated 17.1 P1（2026-11-09）：preset 的 `skills:` 由 `toPresetDefinition` 消费，
 *   经 `vssarosSkills` 进程内服务置顶到技能目录；不要再把它拼进人设提示词。
 *   保留导出只为兼容既有测试与外部调用方，主链路已不引用。
 */
export function ownedSkillsText(skills) {
	if (!skills?.length) { return ''; }
	return ['', '', '## 你的技能',
		'这些是你在团队工单里沉淀、经人批准的经验。遇到同类任务，先用 skill 工具按名字读取对应技能再动手：',
		...skills.map((skill) => `- ${skill.name}${skill.description ? `：${skill.description}` : ''}`)].join('\n');
}

/** 人对一份技能草稿的决定：'approve' 转正到 `<root>/<name>/SKILL.md`，'reject' 删除草稿。 */
export function decideSkillDraft(config, name, decision) {
	if (!SKILL_NAME_RE.test(String(name ?? ''))) { throw new Error(`技能名不合法：${name}`); }
	const root = skillsRootOf(config);
	const dir = join(root, DRAFTS_DIR, name), draft = join(dir, 'SKILL.md');
	if (!existsSync(draft)) {
		if (existsSync(join(root, name, 'SKILL.md'))) { return { name, state: 'active' }; }
		throw new Error(`没有技能草稿 ${name}`);
	}
	if (decision === 'reject') { rmSync(dir, { recursive: true, force: true }); return { name, state: 'rejected' }; }
	if (decision !== 'approve') { throw new Error(`未知决定：${decision}`); }
	const target = join(root, name), text = readFileSync(draft, 'utf8');
	const live = join(target, 'SKILL.md');
	// 2026-11-06：草稿是已生效技能的新版本 ⇒ 替换生效版，旧版留作 SKILL.v<N>.md；版本不比生效版新就不覆盖
	if (existsSync(live)) {
		const current = readFileSync(live, 'utf8');
		if (versionOf(text) <= versionOf(current)) { throw new Error(`已有同名生效技能 ${name}（v${versionOf(current)}），草稿不是更新的版本，不覆盖`); }
		writeFileSync(join(target, `SKILL.v${versionOf(current)}.md`), current, 'utf8');
	}
	writeAtomically(target, text);
	rmSync(dir, { recursive: true, force: true });
	return { name, state: 'active', version: versionOf(text) };
}
