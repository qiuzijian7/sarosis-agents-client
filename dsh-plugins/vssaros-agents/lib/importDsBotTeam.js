// @vssaros/dsh-agents — DS Bot 团队的离线导入：读盘与落盘（2026-11-06，superagent v2 第 8 项「适配层」）
//
// 规划在 lib/core/dsBotImport.js（纯函数，口径与不导的东西都写在那里）；这里只做 I/O：
//   读：`<DS Bot home>/state.json`、`memory/bots/<id>/MEMORY.md`、`secrets.json` 的**名字**（值一个字都不读出来）；
//       VsSaros 这边已有的 agent 目录、已导入过的 Bot（`.agent.md` 的 `imported-from: ds-bot:<id>`）、技能目录。
//   写（`apply: true` 才写）：技能 `<skills>/<dsbot-名>/SKILL.md`（已有不覆盖）→ `.agent.md`（createAgentFromDraft，
//       只新建不覆盖）+ 导入标记 → 记忆事实进收件箱（统一记忆下次启动并入）。
// DS Bot 的 home：`--ds-home` 指定，否则 `$DSH_HOME/bot`，否则 `~/.dsh/bot`（与 ds-bot index.js / folders.js 同口径）。
// Host 运行时也能跑：只读 DS Bot 的文件（它的写入是临时文件 + rename，读到的总是完整的一版）。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createAgentFromDraft } from './create.js';
import { importedSourceOf, markImported, planDsBotImport } from './core/dsBotImport.js';
import { appendToInbox } from './memoryFiles.js';
import { skillsRootOf } from './stepMemory.js';
import { agentsRootOf } from './store.js';

/** DS Bot 的数据目录（与 ds-bot 同口径）。 */
export function dsBotHomeOf(explicit, env = process.env) {
	if (typeof explicit === 'string' && explicit.trim()) { return resolve(explicit.trim()); }
	const dsh = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim().replace(/^~(?=[\\/]|$)/, homedir()) : join(homedir(), '.dsh');
	return join(resolve(dsh), 'bot');
}
/** DS Bot 记忆目录名：合法 id 原样，否则 sha256 前 32 位（memory.js 的 safeId）。 */
const safeId = (id) => (/^[\w-]{1,128}$/.test(id) ? id : createHash('sha256').update(id).digest('hex').slice(0, 32));
const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } };
const dirsOf = (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch { return []; } };

/**
 * 导入一次。`apply` 为 false 时只返回规划，不写任何文件。
 * @param config VsSaros Bots 的 config（agentsRoot / dataRoot / skillsRoot）
 * @param options `{ dsHome?, apply? }`
 * @returns 规划（见 planDsBotImport）+ `{ home, applied: { bots: [{id, file}], skills: string[], facts: number, failed: [{name, error}] } }`
 */
export async function importDsBotTeam(config, options = {}) {
	const home = dsBotHomeOf(options.dsHome);
	const statePath = join(home, 'state.json');
	const raw = readText(statePath);
	if (raw === undefined) { throw new Error(`没找到 DS Bot 的团队文件 ${statePath}（用 --ds-home 指定 DS Bot 的数据目录）`); }
	let state;
	try { state = JSON.parse(raw); } catch { throw new Error(`${statePath} 不是合法的 JSON`); }
	const agentsRoot = agentsRootOf(config);
	const existingIds = dirsOf(agentsRoot);
	const imported = {};
	for (const id of existingIds) {
		const source = importedSourceOf(readText(join(agentsRoot, id, '.agent.md')));
		if (source) { imported[source] = id; }
	}
	const skillsRoot = skillsRootOf(config);
	let secretNames = [];
	try { secretNames = (JSON.parse(readText(join(home, 'secrets.json')) ?? '{}').secrets ?? []).map(item => String(item?.name ?? '')).filter(Boolean); } catch { secretNames = []; }
	const plan = planDsBotImport(state, {
		existingIds, imported, existingSkills: dirsOf(skillsRoot), secretNames,
		memoryOf: (id) => readText(join(home, 'memory', 'bots', safeId(id), 'MEMORY.md')),
	});
	const applied = { bots: [], skills: [], facts: 0, failed: [] };
	if (!options.apply) { return { home, ...plan, applied }; }
	for (const skill of plan.skills.filter(item => item.action === 'create')) {
		const dir = join(skillsRoot, skill.name);
		if (existsSync(join(dir, 'SKILL.md'))) { continue; }
		mkdirSync(dir, { recursive: true });
		const text = ['---', `name: ${skill.name}`, `description: ${JSON.stringify(skill.description)}`, 'metadata:', `  origin: ${JSON.stringify(`ds-bot capability ${skill.source}`)}`, '---', '',
			skill.content.trim() || `# ${skill.source}\n\n（DS Bot 里这项能力没有正文。）`, ''].join('\n');
		const tmp = join(dir, `SKILL.md.tmp.${process.pid}`);
		writeFileSync(tmp, text, 'utf8');
		renameSync(tmp, join(dir, 'SKILL.md'));
		applied.skills.push(skill.name);
	}
	for (const bot of plan.bots.filter(item => item.action === 'create')) {
		try {
			const created = await createAgentFromDraft(config, bot.draft);
			const marked = markImported(readFileSync(created.file, 'utf8'), bot.source);
			if (marked.text) { writeFileSync(created.file, marked.text, 'utf8'); }
			for (const fact of bot.memory) { appendToInbox(config, created.id, `[从 DS Bot 导入] ${fact}`); applied.facts += 1; }
			applied.bots.push({ id: created.id, file: created.file });
		} catch (error) {
			applied.failed.push({ name: bot.name, error: String(error?.message ?? error) });
		}
	}
	return { home, ...plan, applied };
}
