// @vssaros/dsh-agents — Agent 打包 / 导入（2026-10-19，对齐 DSB 的 bot-zip 能力）。
//
// 目标：把一个 agent **连同记忆**发出去 / 换台机器装回来，不依赖市场、不依赖 Host 在线。
//
// 包形状（刻意扁平 + 可读）：
//   agent.json       清单：{ schema:'vssaros-agent/1', id, name, exportedAt, model?, modelAssignment?, role?, skills?, tools?, workspaces? }
//   .agent.md        定义原文（逐字，含 frontmatter；**它才是唯一真源**）
//   memory/MEMORY.md 等（可选；导出时勾了才带）
//
// 安全口径（导入是**别人给的文件**进你的磁盘 ⇒ 宁可严）：
//   · 路径只认 `agent.json` / `.agent.md` / `<单层目录>/.agent.md` / `memory/<安全文件名>`；
//     出现绝对路径、`..`、多层目录、反斜杠穿越 ⇒ 整包拒绝（不"跳过坏条目继续装"）；
//   · 记忆文件名走 `safeMemoryFileName`（与页面/工具同一个白名单）；
//   · 单条目 ≤ 2MB、总条目 ≤ 200（挡 zip 炸弹的粗糙形态）；
//   · 目标目录已存在且没 `overwrite` ⇒ 409（绝不静默覆盖用户改过的 agent）。
//
// 记忆是否随包走：**库默认包含**（`includeMemory !== false`；CLI 同口径，`--no-memory` 关闭），
//   但**页面的一键导出默认不含**（`sideview.js` 的导出确认框，默认不勾）——因为记忆里常有
//   项目/客户细节，一键动作必须是"最不意外"的那个；要带出去得显式勾选 ✓。
//
// 不做：签名/信任链、增量 diff、多 agent 整包（一个包一个 agent，语义最清楚）。

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { agentFromFile, slugify } from './core/agents.js';
import { zipRead, zipWrite } from './core/zip.js';
import { memoryDirOf, safeMemoryFileName } from './memory.js';
import { agentsRootOf, dataRootOf } from './store.js';

export const PACK_SCHEMA = 'vssaros-agent/1';
export const MANIFEST_NAME = 'agent.json';
export const AGENT_MD_NAME = '.agent.md';
export const MEMORY_PREFIX = 'memory/';
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 200;

const httpError = (status, message) => Object.assign(new Error(message), { httpStatus: status });

/** agent id 只允许 slug（同时也是目录名）；不给任何 `/` `..` 机会。 */
function checkedAgentId(id) {
	const safe = slugify(id);
	if (!safe || safe !== String(id ?? '').toLowerCase()) {
		// 允许调用方传未归一化的 id（例如名字），归一化后不同就按归一化的用——但要非空
		if (!safe) {
			throw httpError(400, `agent id 不合法：${JSON.stringify(String(id ?? ''))}`);
		}
	}
	return safe;
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * 导出一个 agent（`.agent.md` + 可选记忆）成 zip。
 * @param config 本行 config（`agentsRoot` / `dataRoot`）
 * @param agentId agent id（可用 display name，归一化后使用）
 * @param options `{ includeMemory?: boolean=true, date?: Date }`
 * @returns `{ id, name, fileName, buffer, bytes, memoryFiles: string[], manifest }`
 */
export async function exportAgent(config, agentId, options = {}) {
	const includeMemory = options.includeMemory !== false;
	const id = checkedAgentId(agentId);
	const dir = join(agentsRootOf(config), id);
	const mdPath = join(dir, AGENT_MD_NAME);
	let mdText;
	try {
		mdText = await readFile(mdPath, 'utf8');
	} catch {
		throw httpError(404, `没有这个 agent：${id}（缺 ${AGENT_MD_NAME}）`);
	}
	const parsed = agentFromFile(mdText, { id, file: mdPath });
	if (parsed.error) {
		throw httpError(400, `这个 agent 的定义本身有问题，先修好再导出：${parsed.error}`);
	}
	const agent = parsed.agent;

	/** @type {{name:string,data:Buffer}[]} */
	const entries = [];
	const manifest = {
		schema: PACK_SCHEMA,
		id: agent.id,
		name: agent.name,
		exportedAt: new Date(options.date ?? Date.now()).toISOString(),
		...(agent.description ? { description: agent.description } : {}),
		...(agent.role ? { role: agent.role } : {}),
		...(agent.skills?.length ? { skills: agent.skills } : {}),
		...(agent.tools?.length ? { tools: agent.tools } : {}),
		...(agent.model ? { model: agent.model } : {}),
		...(agent.modelAssignment ? { modelAssignment: agent.modelAssignment } : {}),
		...(agent.workspaces ? { workspaces: agent.workspaces } : {}),
	};
	entries.push({ name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') });
	entries.push({ name: AGENT_MD_NAME, data: Buffer.from(mdText, 'utf8') });

	const memoryFiles = [];
	if (includeMemory) {
		const memDir = memoryDirOf(config, agent.id);
		let names = [];
		try {
			names = (await readdir(memDir)).sort();
		} catch {
			names = [];   // 没有记忆目录是正常态
		}
		for (const raw of names) {
			const safe = safeMemoryFileName(raw);
			if (!safe || safe !== raw) {
				continue;   // 目录里的怪文件不打包（也绝不改名塞进去）
			}
			const buf = await readFile(join(memDir, safe));
			if (buf.length > MAX_ENTRY_BYTES) {
				continue;   // 超大文件不进包（记忆是索引，不是附件仓库）
			}
			entries.push({ name: MEMORY_PREFIX + safe, data: buf });
			memoryFiles.push(safe);
		}
	}

	const buffer = zipWrite(entries, { date: options.date instanceof Date ? options.date : new Date() });
	return {
		id: agent.id,
		name: agent.name,
		fileName: `${agent.id}.agent.zip`,
		buffer,
		bytes: buffer.length,
		memoryFiles,
		manifest,
	};
}

/**
 * 导出并**落盘**到 `<dataRoot>/exports/`（给"右键导出"用：页面拿不到下载动作，
 * 但宿主有 `bridge.reveal(path)` ⇒ 写到磁盘再定位，比赌 WebContentsView 的下载语义可靠）。
 */
export async function saveExport(config, agentId, options = {}) {
	const pack = await exportAgent(config, agentId, options);
	const dir = join(dataRootOf(config), 'exports');
	await mkdir(dir, { recursive: true });
	// ⚠ 文件名要带**毫秒**：原来只到"秒"，连点两次导出会写到同一个文件（后一次静默覆盖前一次 ✗）。
	//   就算带毫秒也再兜一层：已存在就加序号（别赌时钟精度）。
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
	let file = join(dir, `${pack.id}-${stamp}.agent.zip`);
	for (let n = 2; await stat(file).then(() => true, () => false); n += 1) {
		file = join(dir, `${pack.id}-${stamp}-${n}.agent.zip`);
		if (n > 50) {
			throw httpError(500, '导出目录里同名文件太多，请先清理 exports/');
		}
	}
	await writeFile(file, pack.buffer);
	return { id: pack.id, name: pack.name, fileName: pack.fileName, bytes: pack.bytes, memoryFiles: pack.memoryFiles, path: file };
}

/** 包内路径白名单校验（见文件头"安全口径"）。返回规范化后的条目类型。 */
function classifyEntry(name) {
	const norm = String(name ?? '').replace(/\\/g, '/');
	if (!norm || norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').some((seg) => seg === '..' || seg === '')) {
		throw httpError(400, `包里有不安全的路径：${JSON.stringify(name)}`);
	}
	if (norm === MANIFEST_NAME) {
		return { kind: 'manifest', path: norm };
	}
	if (norm === AGENT_MD_NAME) {
		return { kind: 'agentMd', path: norm };
	}
	const nested = /^([^/]+)\/\.agent\.md$/.exec(norm);
	if (nested) {
		return { kind: 'agentMd', path: norm };
	}
	if (norm.startsWith(MEMORY_PREFIX)) {
		const rest = norm.slice(MEMORY_PREFIX.length);
		if (rest.includes('/')) {
			throw httpError(400, `记忆只支持平铺文件（不支持子目录）：${norm}`);
		}
		const safe = safeMemoryFileName(rest);
		if (!safe || safe !== rest) {
			throw httpError(400, `记忆文件名不在白名单里：${norm}`);
		}
		return { kind: 'memory', path: norm, fileName: safe };
	}
	throw httpError(400, `包里有多余的文件（只认 ${MANIFEST_NAME} / ${AGENT_MD_NAME} / ${MEMORY_PREFIX}*）：${norm}`);
}

/**
 * 导入一个 agent 包。
 * @param config 本行 config
 * @param buffer zip 内容
 * @param options `{ overwrite?: boolean=false }`
 * @returns `{ id, name, mode: 'created'|'overwritten', memoryFiles, wrote: string[] }`
 */
export async function importAgent(config, buffer, options = {}) {
	const overwrite = options.overwrite === true;
	let entries;
	try {
		entries = await zipRead(buffer);
	} catch (e) {
		throw httpError(400, `不是有效的 zip：${String(e?.message ?? e)}`);
	}
	if (entries.length > MAX_ENTRIES) {
		throw httpError(400, `包里条目太多（${entries.length} > ${MAX_ENTRIES}）`);
	}
	let mdText = null;
	const memories = [];
	let manifest = null;
	for (const entry of entries) {
		if (entry.data.length > MAX_ENTRY_BYTES) {
			throw httpError(400, `包里有超大文件（>2MB）：${entry.name}`);
		}
		const info = classifyEntry(entry.name);
		if (info.kind === 'agentMd') {
			if (mdText !== null) {
				throw httpError(400, '包里不止一个 .agent.md（一个包只能装一个 agent）');
			}
			mdText = entry.data.toString('utf8');
		} else if (info.kind === 'memory') {
			memories.push({ name: info.fileName, data: entry.data });
		} else if (info.kind === 'manifest') {
			try {
				manifest = JSON.parse(entry.data.toString('utf8'));
			} catch {
				throw httpError(400, `${MANIFEST_NAME} 不是合法 JSON`);
			}
			if (manifest && manifest.schema && manifest.schema !== PACK_SCHEMA) {
				throw httpError(400, `不认识的包格式：${manifest.schema}（本版本只支持 ${PACK_SCHEMA}）`);
			}
		}
	}
	if (mdText === null) {
		throw httpError(400, `包里没有 ${AGENT_MD_NAME}（不是 agent 包？）`);
	}
	const parsed = agentFromFile(mdText, { id: manifest?.id, file: '(zip)' });
	if (parsed.error) {
		throw httpError(400, `包里的定义解析失败：${parsed.error}`);
	}
	const agent = parsed.agent;
	const id = agent.id;
	const dir = join(agentsRootOf(config), id);
	const already = await exists(dir);
	if (already && !overwrite) {
		throw httpError(409, `已存在同名 agent：${id}（换个 id 或显式覆盖）`);
	}
	await mkdir(dir, { recursive: true });
	const wrote = [];
	await writeFile(join(dir, AGENT_MD_NAME), mdText, 'utf8');
	wrote.push(AGENT_MD_NAME);
	const memDir = memoryDirOf(config, id);
	const memoryFiles = [];
	if (memories.length) {
		await mkdir(memDir, { recursive: true });
		for (const mem of memories) {
			await writeFile(join(memDir, mem.name), mem.data);
			memoryFiles.push(mem.name);
		}
	}
	return {
		id,
		name: agent.name,
		mode: already ? 'overwritten' : 'created',
		memoryFiles,
		wrote,
	};
}
