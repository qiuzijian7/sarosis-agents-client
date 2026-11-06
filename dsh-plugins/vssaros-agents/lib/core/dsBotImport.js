// @vssaros/dsh-agents — DS Bot 团队的离线导入：规划（纯函数，2026-11-06，superagent v2 第 8 项「适配层」）
//
// DS Bot（ds-bot，Apache-2.0）把整个团队存在 `<home>/state.json`（version 1）：Bot 的名字、角色、人设（`instructions`）、
// 工作目录、模型、能力（skill / mcp / pack）、群；每个 Bot 的记忆在 `<home>/memory/bots/<id>/MEMORY.md`。
// 这里只把它**规划**成 VsSaros Bots 的 `.agent.md` 草稿（写盘在 bin/import-ds-bot.mjs），口径：
//   · 导：名字、角色、人设、工作目录（可写）、skill 类能力（落成 `dsbot-<名>` 技能）、pack 里的 skill、记忆里的事实。
//   · 不导：密钥（secrets.json 只列名字）、MCP 能力（命令/地址可能带密钥，交给人在 MCP 设置里重配）、私密 Bot、
//     模型（DS Bot 的 `provider/model` 在这台机器上不一定能路由 ⇒ 跟随默认模型，报告里写明原模型）、
//     会话与运行时数据（sessionId / segments / log …）、浏览器登录态。
//   · 群：要开会话，离线建不了 ⇒ 只在报告里列出（成员已换成导入后的 id），人在 Bots 里照着建。
//   · 重复导入：已导入过的 Bot（`.agent.md` 里 `imported-from: ds-bot:<原 id>`）跳过，不会出第二份。
// 口径依据 ds-bot 0.2.7 的 ds-bot/src/host/store.js、ds-bot/src/host/roster.js、ds-bot/src/host/capabilities.js、
// ds-bot/src/host/memory.js（Copyright 2026 Fei2411 and the DS Bot contributors，Apache License 2.0；见本插件 NOTICE）。

import { presetIdOf } from './agents.js';
import { suggestIdFromName } from './create.js';

export const DS_BOT_STATE_VERSION = 1;
export const IMPORT_MARK = 'imported-from';
export const IMPORT_SOURCE = 'ds-bot';
const SKILL_PREFIX = 'dsbot-';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FACT_MAX = 300;

const oneLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isAbsolutePath = (value) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(String(value ?? ''));

/** DS Bot 记忆文件里的事实：`## Index` 之外的每条 `- ` 列表项，去掉行尾 `[source: …]` 元数据（≤300 字符）。 */
export function factsOf(markdown) {
	const facts = [];
	let inIndex = false;
	for (const raw of String(markdown ?? '').split(/\r?\n/)) {
		const line = raw.trim();
		if (/^#{1,6}\s/.test(line)) { inIndex = /^#{1,6}\s+index\s*$/i.test(line); continue; }
		if (inIndex || !line.startsWith('- ')) { continue; }
		const text = line.slice(2).replace(/\s*\[[^\]]*\]\s*$/, '').trim();
		if (text && !/^\[\[.*\]\]$/.test(text)) { facts.push(text.slice(0, FACT_MAX)); }
	}
	return facts;
}

/** 能力名 → 展开后的 skill 能力（pack 展开一层；mcp 与不认识的归入 skipped）。 */
function skillsOf(names, items) {
	const skills = [], skipped = [];
	const visit = (name, depth) => {
		const item = items?.[name];
		if (!item) { skipped.push({ name, reason: 'missing' }); return; }
		if (item.kind === 'skill') { skills.push(item); return; }
		if (item.kind === 'pack' && depth === 0) { for (const inner of item.items ?? []) { visit(inner, 1); } return; }
		skipped.push({ name, reason: item.kind === 'mcp' ? 'mcp' : 'unsupported' });
	};
	for (const name of names ?? []) { visit(String(name), 0); }
	return { skills, skipped };
}

/** VsSaros 技能名（只用 DS Bot 能力名里合法的字符，前缀 `dsbot-`）。 */
export const skillNameOf = (capability) => `${SKILL_PREFIX}${String(capability).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 64);

/** 给新 Bot 挑一个不撞的 id：英文名的 slug → `dsbot-<slug>` → `dsbot-<原 id 前 8 位>`。 */
function pickId(bot, taken) {
	const slug = suggestIdFromName(bot.name);
	// DS Bot 的 id 是 DSH 会话 id（常见形如 `session-<hex>`）：去掉 `session` 前缀再取 8 位，免得都叫 dsbot-session…
	const raw = String(bot.id ?? '').replace(/^session[-_]?/i, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase();
	const candidates = [slug, slug && `dsbot-${slug}`, raw && `dsbot-${raw}`, `dsbot-${taken.size + 1}`].filter(Boolean);
	for (const id of candidates) {
		const lower = id.toLowerCase();
		if (ID_RE.test(id) && !id.endsWith('.') && !taken.has(lower) && ![...taken].some(other => presetIdOf(other) === presetIdOf(id))) { return id; }
	}
	return undefined;
}

/**
 * 规划一次导入。
 * @param state DS Bot 的 state.json（已 JSON.parse）
 * @param input `{ existingIds: string[], imported: Record<原 id, 已有 VsSaros id>, memoryOf(原 id): string|undefined, existingSkills: string[], secretNames: string[] }`
 * @returns `{ bots: [...], skills: [...], groups: [...], secrets: string[], warnings: string[] }`
 * @throws state 不是 DS Bot 的 version 1 团队文件
 */
export function planDsBotImport(state, input = {}) {
	if (!state || typeof state !== 'object' || typeof state.bots !== 'object') { throw new Error('这不是 DS Bot 的团队文件（缺 bots）'); }
	if (state.version !== DS_BOT_STATE_VERSION) { throw new Error(`DS Bot 团队文件的 version 是 ${state.version}，只认 ${DS_BOT_STATE_VERSION}（更新的 DS Bot 存的，先别导入）`); }
	const taken = new Set((input.existingIds ?? []).map(id => String(id).toLowerCase()));
	const imported = input.imported ?? {};
	const existingSkills = new Set((input.existingSkills ?? []).map(name => String(name).toLowerCase()));
	const items = state.capabilities?.items ?? {};
	const warnings = [];
	const skills = new Map();
	const bots = [];
	const idOf = new Map();
	for (const bot of Object.values(state.bots)) {
		const source = String(bot?.id ?? '');
		const name = oneLine(bot?.name, 80);
		if (!source || !name) { warnings.push(`跳过一条没有 id 或名字的 Bot 记录`); continue; }
		if (bot.private === true) { bots.push({ source, name, action: 'skip', reason: 'private' }); continue; }
		if (imported[source]) { idOf.set(source, imported[source]); bots.push({ source, name, action: 'skip', reason: 'already-imported', id: imported[source] }); continue; }
		const id = pickId(bot, taken);
		if (!id) { bots.push({ source, name, action: 'skip', reason: 'no-id' }); continue; }
		taken.add(id.toLowerCase());
		idOf.set(source, id);
		const { skills: own, skipped } = skillsOf(bot.capabilities, items);
		for (const capability of own) {
			const skill = skillNameOf(capability.name);
			if (!skills.has(skill)) {
				skills.set(skill, { name: skill, source: capability.name, description: oneLine(capability.description || `DS Bot 能力 ${capability.name}`, 200),
					content: String(capability.content ?? ''), action: existingSkills.has(skill) ? 'keep' : 'create' });
			}
		}
		const notes = [];
		if (bot.model) { notes.push(`DS Bot 用的模型是 ${bot.model}：导入后跟随默认模型，需要的话在设置里选`); }
		if (bot.permission) { notes.push(`DS Bot 的权限预设是 ${bot.permission}：VsSaros 的 Bot 按会话的权限运行`); }
		for (const item of skipped) { notes.push(item.reason === 'mcp' ? `MCP 能力 ${item.name} 没导入（命令/地址可能带密钥）：在 MCP 设置里重配` : `能力 ${item.name} 没导入（${item.reason}）`); }
		if (bot.workDir && !isAbsolutePath(bot.workDir)) { notes.push(`工作目录 ${bot.workDir} 不是绝对路径，没导入`); }
		const instructions = String(bot.instructions ?? '').replace(/\r\n/g, '\n').trim();
		const role = oneLine(bot.role, 40);
		const memory = factsOf(input.memoryOf?.(source));
		bots.push({ source, name, action: 'create', id, notes, memory,
			draft: {
				id, name, role,
				description: oneLine(role || instructions.split('\n')[0] || `从 DS Bot 导入的 ${name}`, 200),
				persona: instructions || `你是 ${name}${role ? `，${role}` : ''}。`,
				skills: own.map(capability => skillNameOf(capability.name)).filter((value, i, all) => all.indexOf(value) === i),
				workspacesWrite: bot.workDir && isAbsolutePath(bot.workDir) ? [String(bot.workDir)] : [],
				delegatable: false,
			} });
	}
	const groups = Object.values(state.rooms ?? {}).map((room) => {
		const members = (room?.members ?? []).map(id => ({ source: id, id: idOf.get(id) })).filter(item => item.id);
		return { source: String(room?.id ?? ''), name: oneLine(room?.name, 60), members: members.map(item => item.id),
			missing: (room?.members ?? []).length - members.length, admin: room?.admin ? idOf.get(room.admin) : undefined,
			mode: room?.mode === 'everyone' ? 'everyone' : 'admin', notice: oneLine(room?.notice, 2000) };
	}).filter(group => group.source);
	return { bots, skills: [...skills.values()], groups, secrets: (input.secretNames ?? []).map(String), warnings };
}

/** 把「从 DS Bot 导入」写进 .agent.md 的 frontmatter（不碰其它行）；已有就不改。 */
export function markImported(text, source) {
	const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
	const lines = String(text).split(/\r?\n/);
	if (lines[0]?.trim() !== '---') { return { error: '没有 frontmatter' }; }
	const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
	if (end < 0) { return { error: '没有 frontmatter 结束行' }; }
	if (lines.slice(1, end).some(line => line.startsWith(`${IMPORT_MARK}:`))) { return { text }; }
	lines.splice(end, 0, `${IMPORT_MARK}: ${IMPORT_SOURCE}:${source}`);
	return { text: lines.join(eol) };
}

/** 一个 .agent.md 是不是从 DS Bot 导入的：返回原 id。 */
export function importedSourceOf(text) {
	const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''))?.[1] ?? '';
	return new RegExp(`^${IMPORT_MARK}:\\s*${IMPORT_SOURCE}:(\\S+)\\s*$`, 'm').exec(head)?.[1];
}
