// @vssaros/dsh-agents — memory（Agent 记忆 Git 化，2026-10-16 二期；mockup doc/agents-memory-mockup.html）。
//
// 模型（BotHarness「Git 仓库即记忆」的收窄版，拍板点见 mockup 右侧栏）：
//   ① 记忆目录 = `<agentsRoot>/<id>/memory/`（与 .agent.md 同目录树 ⇒ 内置/覆写语义天然兼容 ✓）；
//   ② 注入 = 装配 system prompt 时把 MEMORY.md 的前 N 字符追加在人设段后（人设段本来就是
//      函数形式 ✓，不动 preset 身份）；装配是同步的 ⇒ 快照走**缓存**（index.js 挂载即读 + 每分钟定时读）。
//      两个 `.agent.md` 字段控制口径（2026-10-19）：
//        · `memory-chars`：N（缺省 2048；0 = 关闭注入；夹到 512~20000）；
//        · `memory-mode` ：`session`（缺省，**同一会话内冻结** —— 前缀稳定才能命中 prompt cache；
//                          改了 MEMORY.md 要等新会话/压缩才生效，与 DSB 的 SOUL/MEMORY 冻结同一取舍）
//                          `live`（旧行为：每 60s 刷新，会话中途也可能变，但前缀每轮不同 ⇒ 缓存失效）；
//   ③ Git 化**可选、逐 agent**；提交只能人按「提交快照」（API 没有给模型开的口 ✗——
//      写记忆走 agent 自己的文件工具，人在这个页签审阅与提交 ✓）；
//   ④ 历史：**看**任一版（`git show <rev>:<file>`，只读全文）+ **回滚**到任一版（2026-10-19 补齐）。
//      回滚 = 把那一版的**单个文件**写回工作区 + 自动提交一条快照；**不是** `git checkout`
//      （checkout 会顺手覆盖其它文件/丢未提交改动 ✗）。rev 只认 7~40 位十六进制，文件名必须平铺。
//
// ⚠ git 是**子进程**（机器上可能没有 git ⇒ 所有 Git 操作如实报错「找不到 git」，不伪装 ✗）。
// ⚠ 文件名防穿越：只认 basename 白名单字符（记忆是 Markdown 平铺文件，不允许子目录 ✓）。

import { renameWithRetry } from './atomicWrite.js';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import { agentsRootOf, dataRootOf, scanAgentsFromConfig } from './store.js';
import { presetIdOf } from './core/agents.js';
import { MEMORY_CHARS_DEFAULT, MEMORY_CHARS_MAX, MEMORY_CHARS_MIN, clampMemoryChars } from './core/memoryLimits.js';

const execFileP = promisify(execFile);

// 口径真源搬进 `core/memoryLimits.js`（三处解析合并成一处，2026-10-20）：
//   `core/agents.js` 读 frontmatter、`core/create.js` 校验草稿、这里夹值 —— 以前各写一份，
//   改一处忘一处时"页面显示的上限"与"实际注入的上限"会静默分叉。
// 这里 re-export 是为了不打断既有 import（`index.js` / 探针 / 外部脚本都从 memory.js 取）。
export { MEMORY_CHARS_MAX, MEMORY_CHARS_MIN, clampMemoryChars };

/**
 * 注入 prompt 的快照上限（**字符**，与 `.agent.md` 的 `memory-chars` 同口径）。
 *
 * 为什么用字符而不是字节：用户能自己数（一个汉字、一个字母、一个空格都算 1），
 * 而字节数会被中文放大 3 倍、不同编码还会漂。旧名 `SNAPSHOT_BYTES` 保留为别名，
 * 老代码 import 它不炸（值同 2048）。
 */
export const SNAPSHOT_CHARS = MEMORY_CHARS_DEFAULT;
/** @deprecated 用 {@link SNAPSHOT_CHARS}；历史上按字节算过，实际实现一直是按字符切。 */
export const SNAPSHOT_BYTES = SNAPSHOT_CHARS;

/**
 * 提交历史条数：缺省 20，上限 100。
 * 页面可以按需请求更多（`?limit=`），但不许无限 —— 一条 `git log` 的输出要整段进内存与 JSON。
 */
const LOG_LIMIT = 20;
const LOG_LIMIT_MAX = 100;

/** 归一化历史条数：非法/缺省 → 20，夹到 (0, 100]。 */
/**
 * 「核记忆」模板（首次自动创建时写入；之后**绝不覆盖**）。
 * 与 DeepSeekBot 的 `CORE_MEMORY_TEMPLATE` 同定位：只放"不该忘的事实/指针"，细节进别的文件。
 */
export const CORE_MEMORY_TEMPLATE = [
	'# 记忆',
	'',
	'<!-- 每轮注入到 system prompt（按 memory-chars 截断）。',
	'     这里只放"不该忘的事实 / 偏好 / 约定"；细节放到别的文件，这里只放指针。',
	'     加一条：追加一个 Markdown 列表项。改动在**新会话**生效。 -->',
	'',
	'- （还没有条目 —— 在这里加第一条）',
	'',
].join('\n');

export function clampLogLimit(value) {
	const n = typeof value === 'string' ? Number(value.trim()) : value;
	if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
		return LOG_LIMIT;
	}
	return Math.min(LOG_LIMIT_MAX, Math.trunc(n));
}

/** 记忆目录。 */
export function memoryDirOf(config, agentId) {
	const id = String(agentId ?? '');
	/* 自定义 agent：与 `.agent.md` 同目录树（原行为，一个字没改） */
	const ownRoot = join(agentsRootOf(config), id);
	if (id && existsSync(ownRoot)) { return join(ownRoot, 'memory'); }
	/* ★ 2026-10-27「记忆没有内容」：内置/预设 agent 在 `agentsRoot` 下**没有**目录
	   （md 在 `agents-builtin/<id>/`，那是每次启动重建的 runDir 副本 ⇒ 写进去会丢）。
	   以前返回 `agentsRoot/<id>/memory` —— 那个目录永远不存在 ⇒
	   「记忆」页签恒为 0 条，agent 写了也随重启消失。
	   ⇒ 落到数据根下一个稳定位置。 */
	return join(dataRootOf(config), 'agent-memory', id);
}

/* ── 记忆备份（2026-10-21，对齐 DSB 的 `memory/recovery.ts`）──────────────────
 * 为什么放**仓库外**：记忆目录本身是 git 工作树，把备份塞进去会污染历史（每次备份都变成
 * 一个未跟踪目录，`git status` 永远脏 ✗）。所以放 `<数据根>/memory-backups/<agent>/<ts>/`。
 * 什么时候备份：提交快照前、回滚前、从备份恢复前（DSB 也是"有变更 / 恢复前"才备）。
 * 保留：最近 20 份（删最旧，失败忽略 —— 备份不该让主流程失败）。
 */

/** 某个 agent 的备份根目录。 */
export function memoryBackupRootOf(config, agentId) {
	return join(dataRootOf(config), 'memory-backups', String(agentId ?? ''));
}

/** 保留份数上限。 */
export const MEMORY_BACKUP_KEEP = 20;

/**
 * 把当前记忆目录里的**平铺文件**复制一份到备份根，并写 `meta.json`。
 * 目录不存在 / 没有文件 ⇒ 返回 null（没什么可备的，不是错误）。
 */
export async function backupMemory(config, agentId, reason = 'manual') {
	const src = memoryDirOf(config, agentId);
	let names = [];
	try {
		names = (await readdir(src, { withFileTypes: true }))
			.filter(e => e.isFile() && safeMemoryFileName(e.name))
			.map(e => e.name);
	} catch {
		return null;
	}
	if (!names.length) {
		return null;
	}
	const at = Date.now();
	const root = memoryBackupRootOf(config, agentId);
	const dest = join(root, String(at));
	await mkdir(dest, { recursive: true });
	for (const name of names) {
		await cp(join(src, name), join(dest, name));
	}
	await writeFile(join(dest, 'meta.json'), JSON.stringify({ at, reason, files: names }, null, 2), 'utf8');

	// 只留最近 N 份
	try {
		const dirs = (await readdir(root, { withFileTypes: true }))
			.filter(e => e.isDirectory() && /^\d+$/.test(e.name))
			.map(e => e.name)
			.sort();
		while (dirs.length > MEMORY_BACKUP_KEEP) {
			const old = dirs.shift();
			await rm(join(root, old), { recursive: true, force: true }).catch(() => undefined);
		}
	} catch { /* 清理失败不影响备份本身 */ }

	return { id: String(at), at, reason, files: names };
}

/* ── 分支（2026-10-21，对齐 DSB 的 `memory_switch_branch` / `memory_continue_from_commit`）──
 * 典型用法：想试验性重写 MEMORY.md ⇒ 从当前提交拉一条 `exp` 分支去改；不合意就切回 `main`，
 * 原记忆一行没动。切分支**要求工作树干净**：否则未提交的改动会被带到另一条分支上，
 * 用户看到的是"我明明回滚了怎么还是新的"。
 */

/** 分支名白名单（与版本名同口径）。 */
const BRANCH_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** 分支清单（含当前分支与未提交文件数）。 */
export async function listBranches(config, agentId) {
	const status = await gitStatusOf(config, agentId);
	if (!status.enabled) {
		return { enabled: false, current: '', branches: [], dirty: 0 };
	}
	const cur = (await git(status.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || '';
	const out = await git(status.dir, ['for-each-ref', '--format=%(refname:short)\t%(objectname:short)\t%(committerdate:short)', 'refs/heads']);
	const branches = out.ok && out.out
		? out.out.split('\n').filter(Boolean).map(line => {
			const [name, hash, date] = line.split('\t');
			return { name, hash: hash ?? '', date: date ?? '', current: name === cur };
		})
		: [];
	branches.sort((a, b) => (a.current === b.current ? a.name.localeCompare(b.name) : (a.current ? -1 : 1)));
	// `branch` 是 `current` 的别名：GET 的载荷用 `branch`（页面直接读），POST 的返回值也一致
	return { enabled: true, current: cur, branch: cur, branches, dirty: status.dirty ?? 0 };
}

/**
 * 切分支 / 从某个提交拉新分支。
 *
 * @param input `{ name, create?: boolean, from?: '<7~40 位 sha>' }`
 *   · `create: true` + `from` ⇒ `git checkout -b <name> <sha>`（从那次提交继续）
 *   · `create: true` 无 `from` ⇒ 从当前 HEAD 拉
 *   · `create: false` ⇒ 切到已有分支（不存在 ⇒ 404）
 */
export async function switchBranch(config, agentId, input) {
	const name = String(input?.name ?? '').trim();
	if (!BRANCH_NAME_RE.test(name)) {
		throw Object.assign(new Error(`分支名只能用字母/数字/. _ -（1~64）：${name || '(空)'}`), { httpStatus: 400 });
	}
	const status = await gitStatusOf(config, agentId);
	if (!status.enabled) {
		throw Object.assign(new Error('还没启用 Git 版本化（先点「启用」）'), { httpStatus: 409 });
	}
	if ((status.dirty ?? 0) > 0) {
		throw Object.assign(new Error(`还有 ${status.dirty} 个文件没提交：先「提交快照」再切分支（否则改动会被带到另一条分支上）`), { httpStatus: 409 });
	}
	const dir = status.dir;
	if (input?.create === true) {
		const from = String(input?.from ?? '').trim();
		if (from && !/^[0-9a-f]{7,40}$/.test(from)) {
			throw Object.assign(new Error(`from 只认 7~40 位提交号：${from}`), { httpStatus: 400 });
		}
		const out = from
			? await git(dir, ['checkout', '-b', name, from])
			: await git(dir, ['checkout', '-b', name]);
		if (!out.ok) {
			throw Object.assign(new Error(`建分支失败：${out.out || '(无输出)'}（同名分支已存在？）`), { httpStatus: 409 });
		}
	} else {
		const exists = await git(dir, ['rev-parse', '--verify', `refs/heads/${name}`]);
		if (!exists.ok) {
			throw Object.assign(new Error(`没有这个分支：${name}`), { httpStatus: 404 });
		}
		const out = await git(dir, ['checkout', name]);
		if (!out.ok) {
			throw Object.assign(new Error(`切分支失败：${out.out || '(无输出)'}`), { httpStatus: 409 });
		}
	}
	return { ...(await listBranches(config, agentId)), switched: name, created: input?.create === true };
}

/**
 * 记忆目录的"指纹"（文件名 + 大小 + mtime，排序后拼串）。
 *
 * 用途：判断"这一轮之后记忆有没有被动过"——比做内容 diff 便宜得多，也够用
 * （记忆是 Markdown 小文件，mtime 粒度足够；真要内容级判断再上 hash）。
 */
export async function memoryFingerprintOf(config, agentId) {
	const dir = memoryDirOf(config, agentId);
	let entries = [];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return '';
	}
	const parts = [];
	for (const e of entries.filter(x => x.isFile() && safeMemoryFileName(x.name))) {
		const st = await stat(join(dir, e.name)).catch(() => null);
		parts.push(`${e.name}:${st?.size ?? 0}:${Math.round(st?.mtimeMs ?? 0)}`);
	}
	return parts.sort().join('|');
}

/**
 * 自动备份（2026-10-21，对齐 DSB 的「一次对话结束 ⇒ 记忆有变就备份」）。
 *
 * 触发：任一 agent 会话**回合结束**时，比对该 agent 记忆目录的指纹；与上次不同 ⇒ 备份一份
 *       （写到仓库外的 `<数据根>/memory-backups/`，见 `backupMemory`）。
 *
 * 为什么值得做：agent 改自己的记忆是**工具驱动**的（没有提炼流水线，ADR 0003），
 * 改完你可能根本不知道、更不会记得点「提交快照」。自动备份至少保证"改坏了能回到上一版"。
 *
 * 刻意不做：不判断"改得好不好"、不做内容级 diff、也不自动提交 —— 备份只负责**留档**，
 * 提交仍然是人按按钮（模型没有提交口，这是刻意的权限边界）。
 */
export function installMemoryBackupWatcher(ctx, config) {
	// 每个 agent 上次见过的指纹（内存态，进程重启后重新建立 ⇒ 第一次会自动备一次）
	const seen = new Map();
	// presetId → agentId 的反查表（扫盘不便宜 ⇒ 缓存 60 秒）
	let presetMap = new Map();
	let presetMapAt = 0;
	const resolveAgentId = async (preset) => {
		if (!presetMap.size || Date.now() - presetMapAt > 60_000) {
			const scanned = await scanAgentsFromConfig(config).catch(() => ({ agents: [] }));
			presetMap = new Map((scanned.agents ?? []).map(a => [presetIdOf(a.id), a.id]));
			presetMapAt = Date.now();
		}
		return presetMap.get(preset) ?? '';
	};
	return ctx.on('agent/turn-stopping', async (payload) => {
		const session = payload?.agent?.session;
		if (!session?.id) { return; }
		try {
			const { readLiveSession } = await import('./live.js');
			const row = await readLiveSession(config, session.id).catch(() => null);
			const preset = row?.row?.presetId ?? '';
			if (!preset) { return; }
			const agentId = await resolveAgentId(preset);
			if (!agentId) { return; }
			const fp = await memoryFingerprintOf(config, agentId);
			if (!fp) { return; }                        // 没有记忆文件 ⇒ 无事可做
			if (seen.get(agentId) === fp) { return; }  // 这一轮没动过记忆
			seen.set(agentId, fp);
			await backupMemory(config, agentId, 'auto-after-turn').catch(() => null);
		} catch {
			/* 备份失败不该影响回合结束 ✓ */
		}
	});
}

/** 备份列表（新 → 旧）。 */
export async function listMemoryBackups(config, agentId) {
	const root = memoryBackupRootOf(config, agentId);
	let ents = [];
	try {
		ents = await readdir(root, { withFileTypes: true });
	} catch {
		return { backups: [], keep: MEMORY_BACKUP_KEEP };
	}
	const backups = [];
	for (const e of ents.filter(x => x.isDirectory() && /^\d+$/.test(x.name))) {
		const at = Number(e.name);
		let meta = {};
		try {
			meta = JSON.parse(await readFile(join(root, e.name, 'meta.json'), 'utf8'));
		} catch { /* 没有 meta 也照样列出来 */ }
		backups.push({
			id: e.name,
			at,
			reason: typeof meta.reason === 'string' ? meta.reason : '',
			files: Array.isArray(meta.files) ? meta.files : [],
		});
	}
	backups.sort((a, b) => b.at - a.at);
	return { backups, keep: MEMORY_BACKUP_KEEP };
}

/**
 * 从备份恢复：先给**当前状态**再备一份（DSB 同口径，恢复错了还能回来），
 * 再把备份里的文件复制回记忆目录，最后提交一条快照。
 */
export async function restoreMemoryBackup(config, agentId, backupId) {
	const id = String(backupId ?? '').trim();
	if (!/^\d+$/.test(id)) {
		throw Object.assign(new Error('备份 id 不合法（应为毫秒时间戳）'), { httpStatus: 400 });
	}
	const dir = join(memoryBackupRootOf(config, agentId), id);
	let names = [];
	try {
		names = (await readdir(dir, { withFileTypes: true }))
			.filter(e => e.isFile() && safeMemoryFileName(e.name))
			.map(e => e.name);
	} catch {
		throw Object.assign(new Error(`没有这个备份：${id}`), { httpStatus: 404 });
	}
	if (!names.length) {
		throw Object.assign(new Error(`这个备份里没有记忆文件：${id}`), { httpStatus: 404 });
	}
	await backupMemory(config, agentId, `before-restore-${id}`).catch(() => null);
	const target = memoryDirOf(config, agentId);
	await mkdir(target, { recursive: true });
	for (const name of names) {
		await cp(join(dir, name), join(target, name));
	}
	let snapshot;
	try {
		snapshot = await snapshotGit(config, agentId, `恢复到备份 ${id}`);
	} catch (e) {
		snapshot = { error: String(e?.message ?? e) };
	}
	return { id, files: names, snapshot };
}

/** 文件名白名单（防穿越：只要 basename 形状的 .md/.txt）。 */
export function safeMemoryFileName(name) {
	const base = basename(String(name ?? ''));
	if (!/^[A-Za-z0-9._一-龥-]{1,80}\.(md|txt)$/.test(base) || base.startsWith('.')) {
		return undefined;
	}
	return base;
}

/** 列出记忆文件（目录不存在 ⇒ missing，不抛）。 */
export async function listMemoryFiles(config, agentId) {
	const dir = memoryDirOf(config, agentId);
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const files = [];
		for (const e of entries.filter(x => x.isFile() && safeMemoryFileName(x.name))) {
			const info = await stat(join(dir, e.name)).catch(() => null);
			files.push({ name: e.name, size: info?.size ?? 0, updatedAt: info?.mtimeMs ?? null });
		}
		files.sort((a, b) => (a.name === 'MEMORY.md' ? -1 : b.name === 'MEMORY.md' ? 1 : a.name.localeCompare(b.name)));
		return { files, dir };
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return { files: [], dir, missing: dir };
		}
		throw e;
	}
}

/** 读单个记忆文件（白名单校验 + 上限 256KB）。 */
export async function readMemoryFile(config, agentId, name) {
	const base = safeMemoryFileName(name);
	if (!base) {
		throw Object.assign(new Error(`文件名不合法：${name ?? '(空)'}（只要平铺的 .md/.txt）`), { httpStatus: 400 });
	}
	try {
		const text = await readFile(join(memoryDirOf(config, agentId), base), 'utf8');
		return { name: base, text: text.length > 262144 ? `${text.slice(0, 262144)}\n…（截断，完整内容在磁盘）` : text };
	} catch (e) {
		if (e?.code === 'ENOENT') {
			throw Object.assign(new Error(`没有这个记忆文件：${base}`), { httpStatus: 404 });
		}
		throw e;
	}
}

/**
 * 注入用快照：MEMORY.md 的前 `chars` 个字符（没有就空串；`chars <= 0` = 关闭）。
 *
 * ⚠ 2026-10-19：上限改为**逐 agent 可配**（`.agent.md` 的 `memory-chars`），默认 2048 字符，
 * 与原行为一致（原实现虽名 SNAPSHOT_BYTES，实际一直按字符切 —— 这里把名字与语义对齐）。
 */
export async function readMemorySnapshot(config, agentId, chars = SNAPSHOT_CHARS) {
	const cap = clampMemoryChars(chars);
	if (cap <= 0) {
		return '';
	}
	try {
		const text = await readFile(join(memoryDirOf(config, agentId), 'MEMORY.md'), 'utf8');
		const trimmed = text.trim();
		if (!trimmed) {
			return '';
		}
		const cut = trimmed.length > cap
			? `${trimmed.slice(0, cap)}\n…（截断：上限 ${cap} 字符，完整索引在记忆目录）`
			: trimmed;
		return `\n\n## 记忆索引（MEMORY.md 快照）\n${cut}`;
	} catch {
		return ''; // 没有记忆目录/文件 ⇒ 不注入（正常态 ✓）
	}
}

/**
 * 写常驻记忆 `MEMORY.md`（「记忆」页签的人工写口，2026-10-19）。
 *
 * 口径：上限 = `MEMORY_CHARS_MAX`（20000）；**超了直接 400，不静默截断**——静默截断会让人
 * 以为存进去了，实际少一截（这类"看起来成功"的失败最难查）。
 */
export async function writeCoreMemory(config, agentId, text) {
	const value = String(text ?? '');
	if (value.length > MEMORY_CHARS_MAX) {
		throw Object.assign(new Error(`MEMORY.md 最多 ${MEMORY_CHARS_MAX} 字符（当前 ${value.length}），请先精简`), { httpStatus: 400 });
	}
	const dir = memoryDirOf(config, agentId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'MEMORY.md'), value, 'utf8');
	return { name: 'MEMORY.md', chars: value.length, limit: MEMORY_CHARS_MAX };
}

/* ── Git（子进程；机器没装 git ⇒ 如实报错）──────────────────────────── */

async function git(dir, args, options = {}) {
	try {
		const { stdout } = await execFileP('git', ['-C', dir, ...args], {
			timeout: 15000,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			// ⚠ Windows 必带：dsh Host 是 node.exe（本身没有可继承的控制台）⇒ 这里若不带
			// windowsHide，每条 git 都会让系统新分配一个控制台窗口 ⇒ 切 agent 时
			// Windows Terminal/conhost 连闪几下（2026-10-17 真机取证：闪窗控制台属主
			// git.exe 的父进程就是 dsh Host 的 node.exe；gitStatusOf 一次要跑多条 git）。
			windowsHide: true,
		});
		// `options.raw`：要**逐字**内容时用（`git show <rev>:<file>` 的结尾换行是有意义的，
		// 一律 trim 会把"回滚"写成少一个换行的版本 ⇒ p3-135 抓到过）。
		return { ok: true, out: options.raw === true ? stdout : stdout.trim() };
	} catch (e) {
		if (e?.code === 'ENOENT') {
			throw Object.assign(new Error('这台机器找不到 git 命令——装 git 后才能用版本化'), { httpStatus: 503 });
		}
		return { ok: false, out: String(e?.stderr ?? e?.message ?? e).trim() };
	}
}

/** 路径同值判定（Windows：分隔符/大小写归一）。 */
/**
 * 路径等价判定（Windows 上有三个坑，缺一个就误判）：
 *   ① 分隔符 `\` vs `/`；② 大小写；③ **8.3 短名**（`C:\Users\QIUZIJ~1\…` vs `C:\Users\qiuzijian\…`）。
 * ③ 是 2026-10-19 被 p3-135 抓出来的：`os.tmpdir()` 返回短名、`git rev-parse --show-toplevel`
 * 返回长名 ⇒ 旧的字符串比较判不等 ⇒ 记忆 Git 在"短用户名/TEMP 路径"的机器上永远显示"没启用"。
 * 用 `realpathSync.native` 归一（解析短名 + 符号链接）；解析失败就退回原串比较。
 */
function canonicalPath(value) {
	const raw = String(value ?? '');
	let resolved = raw;
	try {
		resolved = realpathSync.native(raw);
	} catch {
		try {
			resolved = realpathSync(raw);
		} catch {
			resolved = raw;
		}
	}
	return resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function samePath(a, b) {
	return canonicalPath(a) === canonicalPath(b);
}

/**
 * Git 状态：{ enabled, branch, commits, dirty, dirtyFiles }。
 * ⚠ 「在仓库里」不够：记忆目录可能落在**外层仓库**的工作区里（比如开发期的仓内夹具 ✗——
 *   探针就是那么抓住的：rev-parse 说 true，其实命中的是外层仓，快照会提交进外层仓 ✗✗）。
 *   ⇒ 必须 `--show-toplevel` **恰好等于**记忆目录才算启用 ✓。
 */
export async function gitStatusOf(config, agentId) {
	const dir = memoryDirOf(config, agentId);
	const probe = await git(dir, ['rev-parse', '--is-inside-work-tree']);
	if (!probe.ok || probe.out !== 'true') {
		return { enabled: false, dir };
	}
	const top = await git(dir, ['rev-parse', '--show-toplevel']);
	if (!top.ok || !samePath(top.out, dir)) {
		return { enabled: false, dir, note: '落在外层仓库的工作区里（不算启用）' };
	}
	const branch = (await git(dir, ['branch', '--show-current'])).out || 'main';
	const countText = (await git(dir, ['rev-list', '--count', 'HEAD'])).out;
	const porcelain = await git(dir, ['status', '--porcelain']);
	const dirtyFiles = porcelain.ok && porcelain.out ? porcelain.out.split('\n').filter(Boolean) : [];
	return {
		enabled: true,
		dir,
		branch,
		commits: Number.isFinite(Number(countText)) ? Number(countText) : 0,
		dirty: dirtyFiles.length,
		dirtyFiles: dirtyFiles.map(l => l.slice(3)).slice(0, 50),
	};
}

/** 启用 Git 化：建目录（如缺）+ git init + 初始提交（空目录也提交一个占位说明，免得 HEAD 不存在）。 */
export async function enableGit(config, agentId) {
	const dir = memoryDirOf(config, agentId);
	await mkdir(join(dir), { recursive: true });
	const status = await gitStatusOf(config, agentId);
	if (status.enabled) {
		return status; // 幂等 ✓
	}
	const init = await git(dir, ['init']);
	if (!init.ok) {
		throw Object.assign(new Error(`git init 失败：${init.out}`), { httpStatus: 500 });
	}
	// 初始提交：把现有记忆文件全收进来；一个文件都没有就放一条 README（否则 log 无 HEAD 可读）
	const readme = (await listMemoryFiles(config, agentId)).files.length === 0;
	if (readme) {
		const { writeFile } = await import('node:fs/promises');
		await writeFile(join(dir, 'MEMORY.md'), '# 记忆索引\n\n（还没有条目——agent 用文件工具写，人在这里审阅与提交）\n', 'utf8');
	}
	await git(dir, ['add', '-A']);
	const commit = await git(dir, ['-c', 'user.name=vssaros-agents', '-c', 'user.email=agents@vssaros.local', 'commit', '-m', readme ? '初始提交（启用版本化）' : '初始提交（收纳现有记忆）']);
	if (!commit.ok) {
		throw Object.assign(new Error(`初始提交失败：${commit.out}`), { httpStatus: 500 });
	}
	return gitStatusOf(config, agentId);
}

/**
 * 确保记忆库「可用且非空」（2026-10-27，幂等）。
 *
 * 做的事，按这个**顺序**（顺序有意义）：
 *   ① mkdir 记忆目录
 *   ② 写 `MEMORY.md` 模板 —— **只在不存在时**写，绝不覆盖已有内容
 *   ③ `enableGit`（init + 初始提交）—— 必须在 ② 之后，否则它会写入自己那版简陋 README
 *
 * ⚠ git 失败**不抛**（返回 `git:'unavailable'`）：没有 git 的机器仍该能用文件模式的记忆 ——
 *   这是我们相对 DeepSeekBot 的优势（它 `git-not-found` 直接判记忆不可用）。
 * ⚠ 调用点：建 bot 之后 + `/api/memory` 的 GET 入口（后者让**老 bot** 也被照顾到，不用重建）。
 */
export async function ensureMemoryRepo(config, agentId) {
	const id = String(agentId ?? '').trim();
	if (!id) { return { ok: false, reason: 'no-agent' }; }
	const dir = memoryDirOf(config, id);
	await mkdir(dir, { recursive: true });

	/* ② 模板：缺失才写（`stat` 成功就说明已有文件） */
	let wroteTemplate = false;
	const corePath = join(dir, 'MEMORY.md');
	let exists = false;
	try { await stat(corePath); exists = true; } catch { exists = false; }
	if (!exists) {
		await writeFile(corePath, CORE_MEMORY_TEMPLATE, 'utf8');
		wroteTemplate = true;
	}

	/* ③ git：软失败 */
	let gitState = 'ready';
	try {
		const st = await gitStatusOf(config, id);
		if (!st.enabled) {
			await enableGit(config, id);
			gitState = 'initialized';
		}
	} catch (e) {
		/* 没装 git / 版本太老：文件模式照常可用，只是没有版本与分支 */
		gitState = 'unavailable';
	}

	/* ④ 初始版本（2026-10-27）：让「版本」页签也有内容。
	   「版本」= git tag，前一步只保证有提交与分支，还得有人手动打第一个 tag。
	   用户在截图里报的是"记忆/演化/版本/分支都没内容"，这是最后一个空格子。
	   ⚠ 只在**一个 tag 都没有**时打 —— 绝不覆盖用户已有的版本名。
	   ⚠ 打 tag 失败不影响记忆可用性（只是「版本」页签继续空着，不该让整次初始化失败）。 */
	let tagged = '';
	if (gitState !== 'unavailable') {
		try {
			const vers = await listVersions(config, id);
			if (vers.enabled && !vers.versions.length) {
				await setVersion(config, id, INITIAL_VERSION_TAG);
				tagged = INITIAL_VERSION_TAG;
			}
		} catch {
			tagged = '';
		}
	}

	return {
		ok: true,
		created: wroteTemplate || gitState === 'initialized',
		wroteTemplate,
		git: gitState,
		tagged,
	};
}

/**
 * 初始化时打的那个版本名（`v0` 而不是 `v1`：它是"起点"，不是"第一个正式版本"）。
 * 用户之后按「打 tag」起的名字与它并列，互不影响。
 */
export const INITIAL_VERSION_TAG = 'v0';


/** 提交快照（人按按钮；没有变更 ⇒ 如实说，不造空提交 ✓）。 */
/**
 * 「版本」= 记忆仓库的 **git tag**（2026-10-21，对齐 DeepSeekBot 的 `MemoryVersion`）。
 *
 * 为什么用 tag 而不是另建一份 versions.json：DSB 的「版本」也是 tag（`accepted.ts` 的
 * `MemoryVersion { tag, ... }`），且 tag 天然绑在 commit 上 —— 不会出现"版本记录与历史对不上"。
 * 只读列表；打/删走 `setVersion`。
 */
export async function listVersions(config, agentId) {
	const status = await gitStatusOf(config, agentId);
	if (!status.enabled) {
		return { enabled: false, versions: [] };
	}
	const out = await git(status.dir, ['tag', '--sort=-creatordate', '--format=%(refname:short)\t%(creatordate:short)\t%(objectname:short)']);
	const versions = out.ok && out.out
		? out.out.split('\n').filter(Boolean).map(line => {
			const [tag, date, hash] = line.split('\t');
			return { tag, date: date ?? '', hash: hash ?? '' };
		})
		: [];
	return { enabled: true, versions };
}

/**
 * 给「当前 HEAD」打一个版本名（或删掉一个）。
 *
 * 口径：版本名只允许字母数字与 `. _ -`（1..64），前缀不加 —— 用户看到什么就是什么。
 * ⚠ 只在**已启用 Git** 的仓库上可用；删版本不会动 commit（历史与文件都在）。
 */
export async function setVersion(config, agentId, tag, remove, rev) {
	const status = await gitStatusOf(config, agentId);
	if (!status.enabled) {
		throw Object.assign(new Error('还没启用 Git 版本化（先点「启用」）'), { httpStatus: 409 });
	}
	const name = String(tag ?? '').trim();
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
		throw Object.assign(new Error(`版本名只能用字母/数字/. _ -（1~64）：${name || '(空)'}`), { httpStatus: 400 });
	}
	// `rev`：给**指定提交**起名（DSB 的「给这个版本起名」就是给某次提交打 tag），缺省打 HEAD
	const target = String(rev ?? '').trim();
	if (target && !/^[0-9a-f]{7,40}$/.test(target)) {
		throw Object.assign(new Error(`rev 只认 7~40 位提交号：${target}`), { httpStatus: 400 });
	}
	const out = remove
		? await git(status.dir, ['tag', '-d', name])
		: await git(status.dir, target ? ['tag', name, target] : ['tag', name]);
	if (!out.ok) {
		throw Object.assign(new Error(`git tag 失败：${out.out || '(无输出)'}`), { httpStatus: 400 });
	}
	return { tag: name, rev: target || '', removed: remove === true, ...(await listVersions(config, agentId)) };
}

export async function snapshotGit(config, agentId, message) {
	const dir = memoryDirOf(config, agentId);
	const status = await gitStatusOf(config, agentId);
	if (!status.enabled) {
		throw Object.assign(new Error('还没启用 Git 版本化（先点「启用」）'), { httpStatus: 409 });
	}
	if (status.dirty === 0) {
		return { ...status, committed: false, note: '没有未提交的变更（不用提交）' };
	}
	await git(dir, ['add', '-A']);
	const msg = String(message ?? '').trim() || `快照：${status.dirty} 个文件变更`;
	const commit = await git(dir, ['-c', 'user.name=vssaros-agents', '-c', 'user.email=agents@vssaros.local', 'commit', '-m', msg]);
	if (!commit.ok) {
		throw Object.assign(new Error(`提交失败：${commit.out}`), { httpStatus: 500 });
	}
	return { ...(await gitStatusOf(config, agentId)), committed: true };
}

/** 提交历史（只读；未启用 ⇒ 空）。 */
/** 版本号白名单：只认 7~40 位十六进制（`git show` 的 rev 会进命令行 ⇒ 必须挡注入）。 */
const REV_RE = /^[0-9a-f]{7,40}$/i;

/**
 * 读某个**历史版本**里的一个记忆文件（只读）。
 *
 * 为什么不用 `git diff`：用户要的是"这一版到底写了什么"，全文比 unified diff 好读；
 * diff 留给页面自己按需算（前端能做的事不占后端口子）。
 */
export async function gitShowMemoryFile(config, agentId, rev, name) {
	const status = await gitStatusOf(config, agentId);
	if (!status.enabled) {
		throw Object.assign(new Error('还没启用 Git 版本化（先点「启用」）'), { httpStatus: 409 });
	}
	const rawName = String(name ?? '');
	const file = safeMemoryFileName(rawName);
	if (!file) {
		throw Object.assign(new Error(`文件名不合法：${name ?? '(空)'}（只要平铺的 .md/.txt）`), { httpStatus: 400 });
	}
	if (rawName !== file) {
		// 传了路径（`../secret.md`、`a/b.md`）：`safeMemoryFileName` 会取 basename 把它"修好"，
		// 但读历史是**外部输入**进来的参数 ⇒ 明确拒绝，别静默换成另一个文件（读错文件比报错更糟).
		throw Object.assign(new Error(`文件名不合法：${rawName}（只要平铺文件名，不要带路径）`), { httpStatus: 400 });
	}
	const id = String(rev ?? '').trim();
	if (!REV_RE.test(id)) {
		throw Object.assign(new Error(`版本号不合法：${JSON.stringify(id)}（要 7~40 位十六进制）`), { httpStatus: 400 });
	}
	const out = await git(status.dir, ['show', `${id}:${file}`], { raw: true });
	if (!out.ok) {
		throw Object.assign(new Error(`版本 ${id} 里没有 ${file}（或版本号不存在）`), { httpStatus: 404 });
	}
	return { name: file, rev: id, text: out.out };
}

/**
 * 回滚：把某版本里的**一个**文件内容写回工作区（不是 `git checkout` —— 不碰其它文件），
 * 随后自动提交一条快照（便于再回滚 / 看清是谁改的）。
 *
 * ⚠ 只写平铺记忆文件（`safeMemoryFileName` 白名单）+ 临时文件 rename ⇒ 不会写坏半截。
 * ⚠ 快照失败**不吞**：回滚本身已落盘，返回 `snapshot.error` 如实告诉调用方。
 */
export async function restoreMemoryFile(config, agentId, rev, name, message) {
	const shown = await gitShowMemoryFile(config, agentId, rev, name);
	const dir = memoryDirOf(config, agentId);
	await mkdir(dir, { recursive: true });
	const target = join(dir, shown.name);
	const tmp = `${target}.tmp-${Date.now()}`;
	await writeFile(tmp, shown.text, 'utf8');
	await renameWithRetry(tmp, target);
	let snapshot;
	try {
		snapshot = await snapshotGit(config, agentId, String(message ?? '').trim() || `回滚 ${shown.name} 到 ${shown.rev}`);
	} catch (e) {
		snapshot = { error: String(e?.message ?? e) };
	}
	return { name: shown.name, rev: shown.rev, chars: shown.text.length, snapshot };
}

export async function gitLogOf(config, agentId, status, limit) {
	// `status` 可由调用方传入复用（页面 GET 已经在同一个请求里算过一次；不传就自己算，向后兼容）。
	// 为什么在意：`gitStatusOf` 一次要起 4~5 个 git 子进程，页面上"打开记忆页签"原本会跑两遍。
	const st = status && typeof status.enabled === 'boolean' ? status : await gitStatusOf(config, agentId);
	if (!st.enabled) {
		return { enabled: false, log: [] };
	}
	const out = await git(st.dir, ['log', `--max-count=${clampLogLimit(limit)}`, '--pretty=format:%h%x09%ci%x09%s']);
	const log = out.ok && out.out
		? out.out.split('\n').filter(Boolean).map(line => {
			const [hash, date, ...rest] = line.split('\t');
			return { hash, date: (date ?? '').slice(0, 16), subject: rest.join('\t') };
		})
		: [];
	return { enabled: true, log };
}
