// @vssaros/dsh-agents — 工作区记忆（2026-11-02，用户拍板「记忆 = Bot × 工作区 两层」）
//
// ── 为什么要有这一层 ──────────────────────────────────────────────────────────
// Bot 记忆（`memory.js`）按 agent 存：`<数据根>/agent-memory/<agentId>/MEMORY.md`。普通会话
// （标准 / PTC 模式，没选 Bot）因此**既没有记忆可看、也没有任何记忆被注入** —— 聊天框「记忆」页签
// 只能显示"记忆按 Bot 隔离"。而"这个项目的约定 / 决策 / 踩坑"本来就属于**工作区**，不属于某个 Bot。
//
// ── 三条拍板口径（2026-11-02）──────────────────────────────────────────────
//   ① 归属 = **git 根**：会话 cwd 往上找最近一个含 `.git`（目录或文件，worktree / submodule 都是文件）
//      的祖先 ⇒ 子目录开的会话共用一份；非 git 目录按 cwd 本身。多根工作区按**根**存。
//   ② 注入 = **所有会话**（普通会话 + Bot 会话；Bot 会话里排在 Bot 记忆之后，两层各自有上限）。
//   ③ 写入 = 专用工具 `workspace_memory`（**Host 写盘**）——
//      dsh 的文件沙箱写根只有 `[会话 cwd, tmp]`（`dsh-sandbox` 的 `writableRoots`），而记忆在
//      `<数据根>` 下 ⇒ "让 agent 直接编辑 MEMORY.md" 在 `workspace-write` 沙箱下**会被拒**。
//      本机看不出来，是因为本机沙箱已降级为 `danger-full-access`（`common/dshSandboxCompat.ts`）。
//
// ── 为什么这里**全是同步 I/O** ──────────────────────────────────────────────
// system prompt 的 section `text(context)` 是**同步**提供者（每次装配都被调用）⇒ 不能 await。
//   · git 根判定用"向上找 `.git`"（几次 stat），**不起 git 子进程**（对照 dsh-memory-evolve 在
//     每次渲染时 spawnSync git 的反面教材）；结果按 cwd 缓存。
//   · MEMORY.md 读取按 (路径, mtime, size) 缓存 ⇒ 稳态只有一次 stat。
// 写路径（工具 / 页面）是低频的，同步写 + tmp/rename 原子替换即可。
//
// ── 安全边界 ────────────────────────────────────────────────────────────────
// cwd 只用来**算身份**（哈希）与**往上 stat**，从不往 cwd 里写任何东西；写入一律落在
// `<数据根>/workspace-memory/<key>/` ⇒ 页面传什么路径都写不出这个目录。

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { MEMORY_CHARS_DEFAULT, MEMORY_CHARS_MAX, MEMORY_CHARS_MIN } from './core/memoryLimits.js';
import { dataRootOf } from './store.js';

/** 工作区记忆根目录名（在数据根下）。 */
export const WORKSPACE_MEMORY_DIRNAME = 'workspace-memory';
/** 工作区元信息文件（身份 + 注入口径）。 */
export const SCOPE_FILE = 'scope.json';
/** 记忆正文文件（与 Bot 记忆同名同格式，方便以后复用演化页）。 */
export const MEMORY_FILE = 'MEMORY.md';
/** 一条记忆的长度区间（工具写入用；人在页面整篇编辑不受这个限制）。 */
export const ENTRY_MIN_CHARS = 2;
export const ENTRY_MAX_CHARS = 400;
/** 往上找 `.git` 的最大层数（防御：符号链接环 / 极深路径）。 */
const MAX_ASCEND = 48;
/** cwd → 工作区身份 的缓存时长（`.git` 被新建/删除的情况很少，1 分钟足够）。 */
const RESOLVE_TTL_MS = 60_000;

/** 首次创建时写入的模板（之后**绝不覆盖**）。 */
export const WORKSPACE_MEMORY_TEMPLATE = [
	'# 工作区记忆',
	'',
	'<!-- 这个工作区里所有会话都会注入本文件的前 N 个字符（N = 注入上限，默认 2048）。',
	'     只放"这个项目里不该忘的事"：约定、决策、架构要点、踩过的坑；细节放仓库文档，这里只放指针。',
	'     AI 用 workspace_memory 工具追加；人可以在聊天框「记忆」页签里整篇编辑。改动在新会话生效。 -->',
	'',
].join('\n');

/** 模板占位行（旧模板 / 手写时可能出现）—— 第一次 add 时顺手删掉。 */
const PLACEHOLDER_RE = /^\s*[-*+]\s+（还没有条目/;

/** 提示注入短语（与 dsh-memory-evolve 的 scanThreat 同口径；写入前拒绝）。 */
const THREAT_PATTERNS = [
	/ignore\s+(all\s+)?(previous|prior|earlier|above|your)\s+(instructions?|prompts?|messages?|rules?)/i,
	/disregard\s+(all\s+)?(previous|prior|earlier|above|your)\s+(instructions?|prompts?|messages?|rules?)/i,
	/forget\s+(all|everything|your\s+instructions)/i,
	/忽略(所有|之前|以上|先前)(的)?(指令|指示|提示|规则)/,
	/无视(所有|之前|以上|先前)(的)?(指令|指示|提示|规则)/,
];

/** @returns 拒绝原因；没问题返回 `''`。 */
export function threatOf(text) {
	for (const re of THREAT_PATTERNS) {
		if (re.test(String(text ?? ''))) {
			return '内容像是在改写指令（如"忽略之前的指令"），已拒绝写入记忆。若确为有意内容，请在页签里人工编辑。';
		}
	}
	return '';
}

/**
 * 把 `{{` / `}}` 拆开。
 * 系统提示词的 section 默认会把 `{{name}}` 当模板变量解析，**未注册的变量直接抛** ⇒ 整段装配失败 ⇒
 * 该会话每一轮都起不来（dsh-memory-evolve issue #53 的真实事故）。记忆是自由文本，必须在写入与注入两头都拆。
 */
export function defuseTemplate(text) {
	return String(text ?? '').replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
}

/** 去掉 HTML 注释（模板里那段说明是给人看的，注入时只浪费 token）。 */
export function stripHtmlComments(text) {
	return String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
}

/** 路径比较口径：Windows 大小写不敏感 + 统一分隔符；其余平台原样。 */
function normCase(p) {
	const s = String(p ?? '');
	return process.platform === 'win32' ? s.replace(/\//g, '\\').toLowerCase() : s;
}

/** 去掉末尾分隔符（根目录 `C:\` / `/` 保留）。 */
function trimTrailingSep(p) {
	const s = resolve(String(p ?? ''));
	if (s.length > 3 && (s.endsWith('/') || s.endsWith('\\'))) {
		return s.slice(0, -1);
	}
	return s;
}

/** 工作区身份键：根路径（归一后）sha1 的前 12 位。 */
export function workspaceKeyOf(root) {
	return createHash('sha1').update(normCase(trimTrailingSep(root))).digest('hex').slice(0, 12);
}

/**
 * 找到存放 git 配置的目录（只读、失败返回 `''`）。
 *   · `.git` 是目录            ⇒ 就是它；
 *   · `.git` 是文件（worktree / submodule）⇒ 内容形如 `gitdir: <路径>`（可相对）。
 *       - worktree：该 gitdir 里有 `commondir` 文件，指向主仓库的 `.git` ⇒ 配置在主仓库那边；
 *       - submodule：gitdir 在上级仓库的 `.git/modules/<名>`，没有 commondir ⇒ 配置就在它自己里面。
 */
function gitConfigDirOf(root) {
	const dotGit = join(root, '.git');
	let info;
	try { info = statSync(dotGit); } catch { return ''; }
	if (info.isDirectory()) { return dotGit; }
	let gitdir = '';
	try {
		const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
		gitdir = m ? resolve(root, m[1]) : '';
	} catch {
		return '';
	}
	if (!gitdir || !existsSync(gitdir)) { return ''; }
	try {
		const common = readFileSync(join(gitdir, 'commondir'), 'utf8').trim();
		if (common) { return resolve(gitdir, common); }
	} catch {
		/* 没有 commondir ⇒ 不是 worktree（submodule 或普通 gitdir），配置在 gitdir 自己里 */
	}
	return gitdir;
}

/**
 * 从 git 配置读 origin 的 url（只读、失败返回 `''`）。
 * 目录形态、worktree、submodule 三种 `.git` 都支持（见 `gitConfigDirOf`）。
 */
function originUrlOf(root) {
	try {
		const dir = gitConfigDirOf(root);
		if (!dir) { return ''; }
		const cfg = readFileSync(join(dir, 'config'), 'utf8');
		const m = /\[remote\s+"origin"\][^[]*?\n\s*url\s*=\s*(.+)/.exec(cfg);
		return m ? m[1].trim() : '';
	} catch {
		return '';
	}
}

/** cwd → 身份 的缓存（键 = normCase(cwd)）。 */
const resolveCache = new Map();

/**
 * 把会话 cwd 解析成工作区身份（**同步**；不起子进程）。
 * @param {string} cwd 会话工作目录（必须是已存在的绝对路径）
 * @returns `{ key, root, cwd, isGit, name, remote }`；cwd 不合法返回 `null`（调用方必须显式处理）
 */
export function resolveWorkspace(cwd) {
	const raw = typeof cwd === 'string' ? cwd.trim() : '';
	if (!raw || raw.length > 1024 || !isAbsolute(raw)) {
		return null;
	}
	const abs = trimTrailingSep(raw);
	const cacheKey = normCase(abs);
	const hit = resolveCache.get(cacheKey);
	if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) {
		return hit.value;
	}
	let isDir = false;
	try { isDir = statSync(abs).isDirectory(); } catch { isDir = false; }
	if (!isDir) {
		resolveCache.delete(cacheKey);
		return null;
	}
	// 同一目录的多种写法（Windows 8.3 短名 `QIUZIJ~1`、符号链接、盘符大小写）必须落到**同一个 key**，
	// 否则同一个仓库会分裂成两份记忆（探针实测：临时目录的短名与长名哈希不同）⇒ 先 realpath。
	let canonical = abs;
	try { canonical = trimTrailingSep(realpathSync.native(abs)); } catch { canonical = abs; }
	let root = canonical;
	let isGit = false;
	let dir = canonical;
	for (let i = 0; i < MAX_ASCEND; i += 1) {
		if (existsSync(join(dir, '.git'))) {
			root = dir;
			isGit = true;
			break;
		}
		const parent = dirname(dir);
		if (!parent || parent === dir) { break; }
		dir = parent;
	}
	const value = {
		key: workspaceKeyOf(root),
		root,
		cwd: abs,
		isGit,
		name: basename(root) || root,
		remote: isGit ? originUrlOf(root) : '',
	};
	resolveCache.set(cacheKey, { at: Date.now(), value });
	return value;
}

/** 某个工作区的记忆目录（只由 key 决定 ⇒ 页面传什么 cwd 都写不出 `<数据根>/workspace-memory/`）。 */
export function workspaceMemoryDirOf(config, key) {
	if (!/^[0-9a-f]{12}$/.test(String(key ?? ''))) {
		throw Object.assign(new Error(`工作区键不合法：${String(key)}`), { httpStatus: 400 });
	}
	return join(dataRootOf(config), WORKSPACE_MEMORY_DIRNAME, key);
}

/** 归一注入口径（`scope.json` 里的 chars/mode 可能被手改坏 ⇒ 读取时容错）。 */
export function normalizeLimits(raw) {
	const n = Number(raw?.chars);
	let chars = MEMORY_CHARS_DEFAULT;
	if (Number.isFinite(n)) {
		chars = n <= 0 ? 0 : Math.min(MEMORY_CHARS_MAX, Math.max(MEMORY_CHARS_MIN, Math.trunc(n)));
	}
	return { chars, mode: raw?.mode === 'live' ? 'live' : 'session' };
}

/** 读 `scope.json`（不存在 / 坏 JSON ⇒ `null`）。 */
function readScope(dir) {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, SCOPE_FILE), 'utf8'));
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}

/** 原子写（tmp + rename；Windows 上 rename 偶发 EPERM ⇒ 退避重试一次同步版）。 */
function atomicWriteSync(file, text) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp.${process.pid}.${Date.now().toString(36)}`;
	writeFileSync(tmp, text, 'utf8');
	const delays = [10, 30, 80];
	for (let attempt = 0; ; attempt += 1) {
		try {
			renameSync(tmp, file);
			return;
		} catch (e) {
			const code = String(e?.code ?? '');
			if (attempt >= delays.length || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) {
				throw e;
			}
			const until = Date.now() + delays[attempt];
			while (Date.now() < until) { /* 同步退避：写路径低频，最多 120ms */ }
		}
	}
}

/** 写 `scope.json`（合并身份字段 + 口径；保留 createdAt）。
 *  ⚠ 内容没变就**不写**（updatedAt 不算）：工作区记忆目录是 git 仓库，每次 add 都改 scope.json
 *  会让工作树永远是脏的，「未提交 N」恒不为 0，自动提交也会把每次元信息抖动当成一次改动。 */
function writeScope(dir, ws, patch = {}) {
	const prev = readScope(dir) ?? {};
	const limits = normalizeLimits({ ...prev, ...patch });
	const next = {
		kind: 'workspace',
		key: ws.key,
		root: ws.root,
		name: ws.name,
		isGit: ws.isGit,
		remote: ws.remote || prev.remote || '',
		chars: limits.chars,
		mode: limits.mode,
		createdAt: Number.isFinite(prev.createdAt) ? prev.createdAt : Date.now(),
	};
	// 认领来源是一次性事实，原样保留
	if (typeof prev.claimedFrom === 'string') { next.claimedFrom = prev.claimedFrom; }
	if (typeof prev.claimedBy === 'string') { next.claimedBy = prev.claimedBy; }
	const same = readScope(dir) && Object.keys(next).every((k) => JSON.stringify(prev[k]) === JSON.stringify(next[k]))
		&& Object.keys(prev).every((k) => k === 'updatedAt' || k in next);
	if (same) { return { ...next, updatedAt: prev.updatedAt }; }
	const stamped = { ...next, updatedAt: Date.now() };
	atomicWriteSync(join(dir, SCOPE_FILE), `${JSON.stringify(stamped, null, 2)}\n`);
	return stamped;
}

/** MEMORY.md 读取缓存（键 = 路径；命中条件 = mtime + size 都没变）。 */
const textCache = new Map();

/** 同步读 MEMORY.md（不存在 ⇒ `{ exists:false, text:'' }`）。 */
export function readWorkspaceMemoryText(config, key) {
	const file = join(workspaceMemoryDirOf(config, key), MEMORY_FILE);
	let info;
	try { info = statSync(file); } catch { return { exists: false, text: '', file }; }
	const hit = textCache.get(file);
	if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
		return { exists: true, text: hit.text, file };
	}
	let text = '';
	try { text = readFileSync(file, 'utf8'); } catch { return { exists: false, text: '', file }; }
	textCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, text });
	return { exists: true, text, file };
}

/** 进程内写锁（同一工作区的写操作串行；跨进程只有一个 Host 写者）。 */
const writing = new Set();
function withWriteLock(key, fn) {
	if (writing.has(key)) {
		throw Object.assign(new Error('这个工作区的记忆正在被另一次写入占用，稍后再试'), { httpStatus: 409 });
	}
	writing.add(key);
	try { return fn(); } finally { writing.delete(key); }
}

/** 列表项行 ⇒ `{ index(行号), text(去掉"- "与日期前缀后的正文), raw }`。 */
export function parseEntries(text) {
	const lines = String(text ?? '').split(/\r?\n/);
	const out = [];
	let inComment = false;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (inComment) {
			if (line.includes('-->')) { inComment = false; }
			continue;
		}
		if (line.includes('<!--') && !line.includes('-->')) { inComment = true; continue; }
		const m = /^\s*[-*+]\s+(.*)$/.exec(line);
		if (!m || PLACEHOLDER_RE.test(line)) { continue; }
		const body = m[1].trim();
		out.push({ line: i, text: body.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, ''), raw: body });
	}
	return out;
}

/** 今天的 `YYYY-MM-DD`（本地时间）。 */
function today() {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 一条记忆的正文归一：压成单行、拆模板花括号、去两端空白。 */
function normalizeEntry(content) {
	return defuseTemplate(String(content ?? '').replace(/\s+/g, ' ').trim());
}

/**
 * 读一个工作区的完整视图（页面 / 工具 list 共用）。
 * @returns `{ workspace, dir, exists, text, chars, limits, entries, scope }`
 */
export function workspaceMemoryView(config, ws) {
	const dir = workspaceMemoryDirOf(config, ws.key);
	const scope = readScope(dir);
	const limits = normalizeLimits(scope ?? {});
	const { exists, text } = readWorkspaceMemoryText(config, ws.key);
	return {
		workspace: ws,
		dir,
		exists,
		text,
		chars: text.length,
		limits: { ...limits, max: MEMORY_CHARS_MAX, min: MEMORY_CHARS_MIN },
		entries: parseEntries(text),
		scope,
	};
}

/** 首次使用：建目录 + 模板 + scope.json（已存在 ⇒ 什么都不覆盖，幂等）。 */
export function ensureWorkspaceMemory(config, ws) {
	const dir = workspaceMemoryDirOf(config, ws.key);
	const file = join(dir, MEMORY_FILE);
	if (!existsSync(file)) {
		atomicWriteSync(file, WORKSPACE_MEMORY_TEMPLATE);
	}
	if (!readScope(dir)) {
		writeScope(dir, ws);
	}
	return dir;
}

/**
 * 人在页面上整篇写 MEMORY.md。
 * ⚠ 超上限**直接拒**（400），不静默截断 —— 截断会让人以为存进去了，实际少一截。
 */
export function writeWorkspaceMemory(config, ws, text) {
	const value = defuseTemplate(String(text ?? ''));
	if (value.length > MEMORY_CHARS_MAX) {
		throw Object.assign(new Error(`工作区记忆最多 ${MEMORY_CHARS_MAX} 字符（当前 ${value.length}），请先精简`), { httpStatus: 400 });
	}
	return withWriteLock(ws.key, () => {
		const dir = workspaceMemoryDirOf(config, ws.key);
		atomicWriteSync(join(dir, MEMORY_FILE), value);
		writeScope(dir, ws);
		return { chars: value.length, limit: MEMORY_CHARS_MAX };
	});
}

/** 改注入口径（只改 scope.json，正文不动）。 */
export function setWorkspaceMemoryLimits(config, ws, input) {
	const raw = input?.chars;
	const patch = {};
	if (raw !== undefined && raw !== null && raw !== '') {
		const n = Number(raw);
		if (!Number.isFinite(n)) {
			throw Object.assign(new Error(`注入上限要是数字：${String(raw)}`), { httpStatus: 400 });
		}
		if (n !== 0 && (n < MEMORY_CHARS_MIN || n > MEMORY_CHARS_MAX)) {
			throw Object.assign(new Error(`注入上限要在 ${MEMORY_CHARS_MIN}~${MEMORY_CHARS_MAX} 之间（0 = 关闭注入）`), { httpStatus: 400 });
		}
		patch.chars = Math.trunc(n);
	}
	if (input?.mode !== undefined && input?.mode !== null && input?.mode !== '') {
		if (input.mode !== 'live' && input.mode !== 'session') {
			throw Object.assign(new Error(`注入模式只能是 session 或 live：${String(input.mode)}`), { httpStatus: 400 });
		}
		patch.mode = input.mode;
	}
	return withWriteLock(ws.key, () => {
		const dir = workspaceMemoryDirOf(config, ws.key);
		ensureWorkspaceMemory(config, ws);
		const scope = writeScope(dir, ws, patch);
		return { chars: scope.chars, mode: scope.mode };
	});
}

/**
 * 条目级操作（工具用；Bot 记忆与工作区记忆**共用**这一份实现）。
 *
 * 语义（借 dsh-memory-evolve 的 memory 工具）：
 *   · add     追加一条 `- [YYYY-MM-DD] 正文`；正文相同（忽略日期）⇒ 判重复、不再追加
 *   · replace 用 `match`（唯一子串）定位一条，整条换成新正文（日期刷新为今天）
 *   · remove  用 `match`（唯一子串）定位一条并删除
 *   · list    列出全部条目
 * `match` 命中 0 条或多条都**拒绝并说明**（多条时列出候选），绝不猜。
 *
 * @param {string} file MEMORY.md 绝对路径
 * @param {{action:string, content?:string, match?:string}} input
 * @param {{template?:string, lockKey:string, label:string}} opts
 * @returns `{ ok, message, entries? }`
 */
export function applyEntryAction(file, input, opts) {
	const action = String(input?.action ?? '').trim();
	const label = opts?.label ?? '记忆';
	const readText = () => {
		try { return readFileSync(file, 'utf8'); } catch { return null; }
	};
	if (action === 'list') {
		const text = readText();
		if (text === null) {
			return { ok: true, message: `${label}还没有建立（第一次 add 时自动创建）。`, entries: [] };
		}
		const entries = parseEntries(text);
		return {
			ok: true,
			message: entries.length ? `${label}共 ${entries.length} 条（${text.length} 字符）` : `${label}还没有条目。`,
			entries,
		};
	}
	if (action !== 'add' && action !== 'replace' && action !== 'remove') {
		return { ok: false, message: `未知 action：${action || '(空)'}（只支持 list / add / replace / remove）` };
	}
	const content = normalizeEntry(input?.content);
	const match = String(input?.match ?? '').trim();
	if (action !== 'remove') {
		if (content.length < ENTRY_MIN_CHARS) {
			return { ok: false, message: 'content 不能为空（写一句完整的事实，例如"部署端口是 8080"）。' };
		}
		if (content.length > ENTRY_MAX_CHARS) {
			return { ok: false, message: `一条记忆最多 ${ENTRY_MAX_CHARS} 字符（当前 ${content.length}）—— 细节放仓库文档，这里只放结论或指针。` };
		}
		const threat = threatOf(content);
		if (threat) { return { ok: false, message: threat }; }
	}
	if (action !== 'add' && !match) {
		return { ok: false, message: `${action} 需要 match（能唯一定位那一条的一小段原文）。` };
	}
	return withWriteLock(opts.lockKey, () => {
		const original = readText();
		let text = original ?? (opts.template ?? '');
		const lines = text.split(/\r?\n/);
		const entries = parseEntries(text);
		if (action === 'add') {
			if (entries.some((e) => e.text === content)) {
				return { ok: true, duplicate: true, message: `已经记过这一条，没有重复写入（${label}共 ${entries.length} 条）。`, entries };
			}
			const kept = lines.filter((l) => !PLACEHOLDER_RE.test(l));
			while (kept.length && kept[kept.length - 1].trim() === '') { kept.pop(); }
			kept.push(`- [${today()}] ${content}`, '');
			text = kept.join('\n');
		} else {
			const hits = entries.filter((e) => e.raw.includes(match));
			if (hits.length === 0) {
				return { ok: false, message: `没有找到包含「${match}」的条目（先 list 看看原文）。`, entries };
			}
			if (hits.length > 1) {
				return {
					ok: false,
					message: `「${match}」命中了 ${hits.length} 条，请给更长的一段原文：\n${hits.map((h) => `- ${h.raw}`).join('\n')}`,
					entries,
				};
			}
			const target = hits[0].line;
			if (action === 'replace') {
				const indent = /^(\s*)/.exec(lines[target])[1];
				lines[target] = `${indent}- [${today()}] ${content}`;
			} else {
				lines.splice(target, 1);
			}
			text = lines.join('\n');
		}
		if (text.length > MEMORY_CHARS_MAX) {
			return { ok: false, message: `写入后会超过 ${MEMORY_CHARS_MAX} 字符上限（${text.length}），请先 remove 或合并旧条目。` };
		}
		atomicWriteSync(file, text);
		const after = parseEntries(text);
		const verb = action === 'add' ? '已追加' : action === 'replace' ? '已替换' : '已删除';
		return { ok: true, message: `${verb}。${label}现有 ${after.length} 条（${text.length} 字符）；改动在新会话生效。`, entries: after };
	});
}

/** 工作区记忆的条目操作（工具 scope=workspace）。 */
export function workspaceEntryAction(config, ws, input) {
	if (String(input?.action ?? '') !== 'list') {
		ensureWorkspaceMemory(config, ws);
	}
	const dir = workspaceMemoryDirOf(config, ws.key);
	const result = applyEntryAction(join(dir, MEMORY_FILE), input, {
		template: WORKSPACE_MEMORY_TEMPLATE,
		lockKey: `ws:${ws.key}`,
		label: `工作区「${ws.name}」的记忆`,
	});
	if (result.ok && String(input?.action ?? '') !== 'list') {
		try { writeScope(dir, ws); } catch { /* 元信息刷新失败不影响正文写入 */ }
	}
	return result;
}

/**
 * 注入用快照文本（**同步**；section 提供者直接调用）。
 * @returns 要拼进 system prompt 的整段文字；没有内容 / 注入关闭 ⇒ `''`
 */
export function workspaceSnapshotText(config, ws) {
	const view = workspaceMemoryView(config, ws);
	const cap = view.limits.chars;
	if (cap <= 0 || !view.exists) {
		return { text: '', limits: view.limits };
	}
	const body = defuseTemplate(stripHtmlComments(view.text)).replace(/\n{3,}/g, '\n\n').trim();
	if (!body || /^#\s*工作区记忆\s*$/.test(body)) {
		return { text: '', limits: view.limits };
	}
	const cut = body.length > cap ? `${body.slice(0, cap)}\n…（截断：上限 ${cap} 字符，完整内容在工作区记忆文件）` : body;
	const text = [
		`## 工作区记忆（${ws.name}）`,
		cut,
		'',
		`以上是工作区「${ws.root}」里沉淀的项目约定 / 决策 / 踩坑（所有会话共享）。`
		+ '发现新的、以后仍然成立的项目事实时，用 workspace_memory 工具 add（scope=workspace）；不要直接改记忆文件。'
		+ '改动在新会话生效。',
	].join('\n');
	return { text, limits: view.limits };
}

/** 测试 / 探针用：清空进程内缓存。 */
export function __resetWorkspaceMemoryCaches() {
	resolveCache.clear();
	textCache.clear();
	writing.clear();
}

/**
 * 给**其它插件**用的两个入口（2026-11-03，记忆库的草稿提升 / 撤销）。
 * 逻辑放在这里（而不是 `vssarosAgents` 服务的闭包里）是为了能脱离 Host 单测；`index.js` 只做转发。
 * cwd 只用来算身份，写入永远落在 `<数据根>/workspace-memory/<key>/`。
 * @returns {{ ok: boolean, duplicate?: boolean, message: string, workspace?: {key: string, name: string, root: string} }}
 */
export function addEntryForCwd(config, cwd, content) {
	const ws = resolveWorkspace(String(cwd ?? ''));
	if (!ws) {
		return { ok: false, message: `工作目录不可用：${String(cwd ?? '') || '(空)'}（不存在或不是目录）` };
	}
	const r = workspaceEntryAction(config, ws, { action: 'add', content: String(content ?? '') });
	return { ok: r.ok === true, duplicate: r.duplicate === true, message: String(r.message ?? ''), workspace: { key: ws.key, name: ws.name, root: ws.root } };
}

/** 从工作区记忆里删一条；`notFound` = 这条已不在（视为目标已达成）。 */
export function removeEntryForCwd(config, cwd, match) {
	const ws = resolveWorkspace(String(cwd ?? ''));
	if (!ws) {
		return { ok: false, message: `工作目录不可用：${String(cwd ?? '') || '(空)'}（不存在或不是目录）` };
	}
	const r = workspaceEntryAction(config, ws, { action: 'remove', match: String(match ?? '') });
	return { ok: r.ok === true, notFound: r.ok !== true && /没有找到包含/.test(String(r.message ?? '')), message: String(r.message ?? '') };
}

/** 防御：key 拼出来的目录一定在 `<数据根>/workspace-memory/` 之内（守卫用）。 */
export function isInsideWorkspaceMemoryRoot(config, dir) {
	const root = resolve(dataRootOf(config), WORKSPACE_MEMORY_DIRNAME);
	const full = resolve(dir);
	return full.length > root.length && normCase(full).startsWith(normCase(root + sep));
}

// ══════════════════════════════════════════════════════════════════════════════
// 作用域 id（2026-11-03，P2）
//
// Bot 记忆的所有 Git / 备份 / 回滚 / 分道图 / 演化页能力都以 `agentId` 为键（`memoryDirOf(config, id)`）。
// 与其为工作区另写一套，不如给工作区一个**不会与 agent id 撞**的作用域 id，让 `memoryDirOf` 认得它：
//   `ws.<12 位十六进制 key>`
// ⇒ 为什么是这个形态：
//   · 点号：agent id 经 slugify 只有 [a-z0-9-]，不会含点 ⇒ 不可能撞；
//   · 仍落在演化页路由 `/x/agents/memory/<id>` 的路径段字符集 `[A-Za-z0-9._-]` 内（冒号不行）；
//   · 12 位十六进制 = 身份键本身 ⇒ 页面传什么都只能指向 `<数据根>/workspace-memory/<key>`。
// ══════════════════════════════════════════════════════════════════════════════

export const WS_SCOPE_PREFIX = 'ws.';
const WS_SCOPE_RE = /^ws\.([0-9a-f]{12})$/;

/** 是不是工作区作用域 id。 */
export function isWorkspaceScope(id) {
	return WS_SCOPE_RE.test(String(id ?? ''));
}

/** `ws.<key>` → `<key>`；不是作用域 id 返回 `''`。 */
export function keyOfScopeId(id) {
	const m = WS_SCOPE_RE.exec(String(id ?? ''));
	return m ? m[1] : '';
}

/** `<key>` → `ws.<key>`。 */
export function scopeIdOfKey(key) {
	return `${WS_SCOPE_PREFIX}${key}`;
}

/** 读某个作用域的 scope.json（演化页用；工作区目录没建立 ⇒ `null`）。 */
export function readWorkspaceScope(config, scopeId) {
	const key = keyOfScopeId(scopeId);
	if (!key) { return null; }
	return readScope(workspaceMemoryDirOf(config, key));
}

/**
 * 从 scope.json 还原一个"够写"的工作区描述（不再 stat 磁盘上的根目录）。
 * 为什么不直接 `resolveWorkspace(scope.root)`：工作区被搬走 / 改名后根目录已不存在，
 * 但这份记忆（含 Git 历史）仍然应该能在演化页里看到、导出、回滚 —— 只要 key 对得上就够了。
 */
export function workspaceFromScopeId(config, scopeId) {
	const key = keyOfScopeId(scopeId);
	if (!key) { return null; }
	const scope = readScope(workspaceMemoryDirOf(config, key));
	if (!scope) { return null; }
	const root = typeof scope.root === 'string' ? scope.root : '';
	return {
		key,
		root,
		cwd: root,
		name: typeof scope.name === 'string' && scope.name ? scope.name : (basename(root) || key),
		isGit: scope.isGit === true,
		remote: typeof scope.remote === 'string' ? scope.remote : '',
	};
}

// ══════════════════════════════════════════════════════════════════════════════
// 认领（2026-11-03，P2「git remote 跨设备 / 搬家认领」）
//
// 场景：仓库目录被搬走 / 改名 / 在另一台机器上 clone 到不同路径 ⇒ 路径变了 ⇒ key 变了 ⇒ 旧记忆"断链"。
// 判据：**同一个 git remote（origin url）** 且旧根目录在本机已不存在。
// 做法：**复制**（不是移动）旧目录到新 key 下，旧目录只标 `claimedBy`：
//   · 复制：认错了也不丢数据，旧的还在；
//   · 只在新工作区**还没有记忆**时才允许（绝不覆盖已有内容）。
// ⚠ 不自动认领：只列出候选，由人点确认 —— 同 remote 的多个 clone 可能各有各的约定。
// ══════════════════════════════════════════════════════════════════════════════

/** remote 比较口径：去掉末尾 `.git` 和 `/`，忽略大小写；空串不参与匹配。 */
function normRemote(value) {
	return String(value ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

/**
 * 列出可认领的旧记忆（同 remote、旧根已不存在、没被认领过、不是自己）。
 * @returns {{ key: string, root: string, name: string, chars: number, updatedAt: number }[]}
 */
export function findClaimableMemories(config, ws) {
	const remote = normRemote(ws?.remote);
	if (!remote) { return []; }
	const base = join(dataRootOf(config), WORKSPACE_MEMORY_DIRNAME);
	let names = [];
	try { names = readdirSync(base); } catch { return []; }
	const out = [];
	for (const name of names) {
		if (!/^[0-9a-f]{12}$/.test(name) || name === ws.key) { continue; }
		const dir = join(base, name);
		const scope = readScope(dir);
		if (!scope || normRemote(scope.remote) !== remote) { continue; }
		if (typeof scope.claimedBy === 'string' && scope.claimedBy) { continue; }
		if (typeof scope.root === 'string' && scope.root && existsSync(scope.root)) { continue; }
		const file = join(dir, MEMORY_FILE);
		let size = 0;
		try { size = statSync(file).size; } catch { continue; }
		if (size === 0) { continue; }
		out.push({
			key: name,
			root: String(scope.root ?? ''),
			name: String(scope.name ?? name),
			chars: size,
			updatedAt: Number(scope.updatedAt) || 0,
		});
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
}

/**
 * 认领：把旧 key 的记忆目录（含 Git 历史）复制到当前工作区，并改写 scope.json 的身份。
 * @throws 400：旧 key 不合法 / 不在候选里 / 当前工作区已有记忆
 */
export function claimWorkspaceMemory(config, ws, fromKey) {
	if (!/^[0-9a-f]{12}$/.test(String(fromKey ?? ''))) {
		throw Object.assign(new Error('认领来源不合法'), { httpStatus: 400 });
	}
	const candidates = findClaimableMemories(config, ws);
	if (!candidates.some((c) => c.key === fromKey)) {
		throw Object.assign(new Error('这份记忆不在可认领列表里（remote 不一致、旧目录仍存在，或已被认领）'), { httpStatus: 400 });
	}
	return withWriteLock(ws.key, () => {
		const toDir = workspaceMemoryDirOf(config, ws.key);
		if (existsSync(join(toDir, MEMORY_FILE))) {
			throw Object.assign(new Error('当前工作区已经有记忆，不会被覆盖（先清空或改用「编辑」手动合并）'), { httpStatus: 400 });
		}
		const fromDir = workspaceMemoryDirOf(config, fromKey);
		mkdirSync(toDir, { recursive: true });
		cpSync(fromDir, toDir, { recursive: true, force: false, errorOnExist: false });
		// 新目录的身份改成当前工作区；旧目录标记已被认领（不再出现在候选里）
		const prev = readScope(toDir) ?? {};
		const carried = { chars: prev.chars, mode: prev.mode };
		rmSync(join(toDir, SCOPE_FILE), { force: true });
		const scope = writeScope(toDir, ws, carried);
		atomicWriteSync(join(toDir, SCOPE_FILE), `${JSON.stringify({ ...scope, claimedFrom: fromKey }, null, 2)}\n`);
		const oldScope = readScope(fromDir) ?? {};
		atomicWriteSync(join(fromDir, SCOPE_FILE), `${JSON.stringify({ ...oldScope, claimedBy: ws.key }, null, 2)}\n`);
		textCache.clear();
		return { from: fromKey, to: ws.key };
	});
}
