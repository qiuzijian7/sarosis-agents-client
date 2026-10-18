// @vssaros/dsh-agents — memory（Agent 记忆 Git 化，2026-10-16 二期；mockup doc/agents-memory-mockup.html）。
//
// 模型（BotHarness「Git 仓库即记忆」的收窄版，拍板点见 mockup 右侧栏）：
//   ① 记忆目录 = `<agentsRoot>/<id>/memory/`（与 .agent.md 同目录树 ⇒ 内置/覆写语义天然兼容 ✓）；
//   ② 注入 = 装配 system prompt 时把 MEMORY.md 前 SNAPSHOT_BYTES 追加在人设段后（人设段本来就是
//      函数形式 ✓，不动 preset 身份）；装配是同步的 ⇒ 快照走**缓存**（index.js 定时刷新），
//      口径 = "冻结快照"，最多滞后一个刷新周期，如实写 ✓；
//   ③ Git 化**可选、逐 agent**；提交只能人按「提交快照」（API 没有给模型开的口 ✗——
//      写记忆走 agent 自己的文件工具，人在这个页签审阅与提交 ✓）；
//   ④ v1 回滚 = 只读历史 + 复制旧内容，**不做** git checkout 写口 ✗。
//
// ⚠ git 是**子进程**（机器上可能没有 git ⇒ 所有 Git 操作如实报错「找不到 git」，不伪装 ✗）。
// ⚠ 文件名防穿越：只认 basename 白名单字符（记忆是 Markdown 平铺文件，不允许子目录 ✓）。

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import { agentsRootOf } from './store.js';

const execFileP = promisify(execFile);

/** 注入 prompt 的快照上限（字节）。 */
export const SNAPSHOT_BYTES = 2048;
/** 提交历史条数上限。 */
const LOG_LIMIT = 20;

/** 记忆目录。 */
export function memoryDirOf(config, agentId) {
	return join(agentsRootOf(config), String(agentId ?? ''), 'memory');
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

/** 注入用快照：MEMORY.md 前 SNAPSHOT_BYTES（没有就空串）。 */
export async function readMemorySnapshot(config, agentId) {
	try {
		const text = await readFile(join(memoryDirOf(config, agentId), 'MEMORY.md'), 'utf8');
		const trimmed = text.trim();
		if (!trimmed) {
			return '';
		}
		const cut = Buffer.byteLength(trimmed, 'utf8') > SNAPSHOT_BYTES
			? `${trimmed.slice(0, SNAPSHOT_BYTES)}\n…（截断，完整索引在记忆目录）`
			: trimmed;
		return `\n\n## 记忆索引（MEMORY.md 快照）\n${cut}`;
	} catch {
		return ''; // 没有记忆目录/文件 ⇒ 不注入（正常态 ✓）
	}
}

/* ── Git（子进程；机器没装 git ⇒ 如实报错）──────────────────────────── */

async function git(dir, args) {
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
		return { ok: true, out: stdout.trim() };
	} catch (e) {
		if (e?.code === 'ENOENT') {
			throw Object.assign(new Error('这台机器找不到 git 命令——装 git 后才能用版本化'), { httpStatus: 503 });
		}
		return { ok: false, out: String(e?.stderr ?? e?.message ?? e).trim() };
	}
}

/** 路径同值判定（Windows：分隔符/大小写归一）。 */
function samePath(a, b) {
	return String(a ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
		=== String(b ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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

/** 提交快照（人按按钮；没有变更 ⇒ 如实说，不造空提交 ✓）。 */
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
export async function gitLogOf(config, agentId) {
	const status = await gitStatusOf(config, agentId);
	if (!status.enabled) {
		return { enabled: false, log: [] };
	}
	const out = await git(status.dir, ['log', `--max-count=${LOG_LIMIT}`, '--pretty=format:%h%x09%ci%x09%s']);
	const log = out.ok && out.out
		? out.out.split('\n').filter(Boolean).map(line => {
			const [hash, date, ...rest] = line.split('\t');
			return { hash, date: (date ?? '').slice(0, 16), subject: rest.join('\t') };
		})
		: [];
	return { enabled: true, log };
}
