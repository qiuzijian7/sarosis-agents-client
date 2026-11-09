// @vssaros/dsh-agents — 主管创建 bot（2026-11-04，superagent 主管组团 T2）
//
// 由 dsh-superagent 的 `orchestrator_team_create_bot` 经团队总线调用。闸门在调用方（主管）：
//   配额「每计划 3 个 / 全局 20 个」、查重、工具风险分级、高风险进待办由 superagent 决定。
// 这里只做 Bots 名册这一侧的事：校验草稿 → 写 .agent.md → 标 created-by → 初始化记忆 → 同步 preset。
//
// ⚠ 不 import index.js：syncPresets 定义在 index.js 内部（且 index.js 会 import 本文件的调用者），
//   所以由顶层把同步函数注入进来（与 createAgentFromDraft 的 HTTP 路由同一条注册链）。

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentFromDraft, previewAgentDraft } from './create.js';
import { normalizeDraft } from './core/create.js';
import { agentsRootOf } from './store.js';

/** 主管创建的 bot 全局上限（调用方也有一份，这里是名册侧兜底）。 */
export const SUPERVISOR_BOT_CAP = 20;

/** Bots 侧的结构化错误（带 HTTP 语义，团队总线原样抛给调用方）。 */
function refusal(status, message) { return Object.assign(new Error(message), { httpStatus: status }); }

/** 读 .agent.md 原文，判断是不是主管创建的。 */
async function marked(file) {
	try { return /^created-by\s*:\s*supervisor\s*$/mi.test(await readFile(file, 'utf8')); }
	catch { return false; }
}

/** 名册里主管创建的 bot 数（自定义根，含内置根之外的全部）。 */
export async function supervisorBotCount(config) {
	const root = agentsRootOf(config);
	let entries;
	try { entries = await readdir(root, { withFileTypes: true }); }
	catch (e) { if (e?.code === 'ENOENT') return 0; throw e; }
	let count = 0;
	for (const entry of entries) {
		if (entry.isDirectory() && await marked(join(root, entry.name, '.agent.md'))) count += 1;
	}
	return count;
}

/** 把 created-by: supervisor 写进 frontmatter（不碰其它行，保留 CRLF）。 */
async function markSupervisor(file) {
	const text = await readFile(file, 'utf8');
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== '---') throw refusal(500, '新建的 .agent.md 没有 frontmatter');
	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i].trim() === '---') { end = i; break; }
	}
	if (end < 0) throw refusal(500, '新建的 .agent.md 没有 frontmatter 结束行');
	if (await marked(file)) return;
	lines.splice(end, 0, 'created-by: supervisor');
	await writeFile(file, lines.join(eol), 'utf8');
}

/**
 * 创建并登记一个可委派的 bot。
 * @param input.draft `{ id, name, description, role, skills, tools, persona }`
 * @param sync 注入的 preset 同步函数（顶层 index.js 里的 syncPresets）
 */
export async function createTeamBot(config, input, sync) {
	const draft = normalizeDraft({ ...input?.draft, delegatable: true });
	if (!draft.id || !draft.name) throw refusal(400, '建 bot 需要 id 和 name');
	const preview = await previewAgentDraft(config, draft);
	if (preview.errors.length) {
		throw refusal(preview.conflict ? 409 : 400, preview.errors.join('；'));
	}
	if (await supervisorBotCount(config) >= SUPERVISOR_BOT_CAP) {
		throw refusal(409, `主管创建的 bot 已达全局上限 ${SUPERVISOR_BOT_CAP} 个`);
	}
	const created = await createAgentFromDraft(config, draft);
	await markSupervisor(created.file);
	if (typeof sync === 'function') await sync().catch(() => undefined);
	return { id: created.id, name: created.name, preset: created.presetId, file: created.file };
}
