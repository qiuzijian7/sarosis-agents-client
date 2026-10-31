// @vssaros/dsh-kb — 版本管理的**远端抽象层**（★ 2026-10-31，P1）。
//
// 设计底线（改代码前先读，这几条是用户明确要求的取舍）：
//  ① **默认 local**：不配置远端就绝不会有上传行为（P0 的本地 Git 已经能独立工作）。
//  ② **显式授权**：远端类型/地址/凭据都由用户在界面上填；没有"自动发现/默认建议"。
//  ③ **凭据不进库**：token 存在**数据根**的 `kb-remotes.json`（不是库目录）⇒
//     不会被 git 提交、不会随笔记同步出去（见 REMOTE_STORE_FILE）。
//  ④ **凭据不落 .git/config**：推送/拉取一律用 `-c http.extraheader=Authorization: …` 传，
//     命令结束就没了 ⇒ `git remote -v` / `.git/config` 里看不到 token。
//  ⑤ **不追求协同**：pull 有冲突就报错（不自动合并），让用户自己决定 —— 与 P0 同一取舍。
//
// 为什么单独一个文件：URL 归一化与鉴权拼装是**判据**，必须可单测 ⇒ 不依赖 dsh 包。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 支持的远端类型：
 *   `local`   = **无远端**（默认，零上传）—— P0 的本地 Git 独立可用，不配也能用。
 *   `path`    = 另一个**目录**当远端（本机另一块盘 / 内网共享盘 / 移动硬盘）⇒ **不需要任何服务器** ✓
 *   github / gitlab / forgejo = 常见托管（只是鉴权头不同，命令都是标准 git）。
 */
export const REMOTE_TYPES = ['local', 'path', 'github', 'gitlab', 'forgejo'];

/** 远端配置存哪：**数据根**下（不进库目录 ⇒ 不会被提交、不会进版本）。 */
export const REMOTE_STORE_FILE = 'kb-remotes.json';

/** 默认的远端名（git remote 的名字）。 */
export const REMOTE_NAME = 'origin';

/**
 * ★ 2026-10-31：**访问令牌存宿主凭据库**（与商城 JWT 同一套 ctx.credentials）。
 *
 * 为什么不是写在 kb-remotes.json：那个文件在数据根下、是明文 ——
 * 令牌属于"长期有效的第三方凭证"，应与配置分开存放、由宿主统一管理
 * （商城的 VSSAROS_MARKET_JWT 就是这个口径）。
 * 落点：ctx.credentials ⇒ dsh-credentials-local ⇒ <dshHome>/.credentials.yaml
 */
export const KB_GIT_TOKEN_REF_PREFIX = 'VSSAROS_KB_GIT_TOKEN_';

/**
 * 库 id ⇒ 凭据引用名（必须是 POSIX 标识符：只留 [A-Z0-9_]，且以字母开头）。
 * 例：ext-34ca9164 ⇒ VSSAROS_KB_GIT_TOKEN_EXT_34CA9164
 */
export function credentialRefFor(vaultId) {
	let s = String(vaultId ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
	s = s.replace(/^_+|_+$/g, '');
	if (!s) { return ''; }
	if (!/^[A-Z]/.test(s)) { s = 'V' + s; }
	return KB_GIT_TOKEN_REF_PREFIX + s;
}

/** 凭据服务的**最小接口**（宿主给 ctx.credentials，测试给假实现）。 */
const hasCreds = (creds) => Boolean(creds) && typeof creds === 'object';
const credResolve = async (creds, ref) => {
	if (!hasCreds(creds) || !ref) { return undefined; }
	try { return typeof creds.resolve === 'function' ? await creds.resolve(ref) : undefined; } catch { return undefined; }
};
const credSet = async (creds, ref, value) => {
	if (!hasCreds(creds) || !ref || !value) { return false; }
	try { if (typeof creds.set === 'function') { await creds.set(ref, value); return true; } } catch { /* 吞掉：写凭据失败不该让保存远端整体失败 */ }
	return false;
};
const credUnset = async (creds, ref) => {
	if (!hasCreds(creds) || !ref) { return false; }
	try { if (typeof creds.unset === 'function') { await creds.unset(ref); return true; } } catch { /* 同上 */ }
	return false;
};

function runGit(args, cwd, timeoutMs = 60_000) {
	return new Promise((done) => {
		let out = '';
		let err = '';
		let child;
		try {
			child = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
		} catch (e) {
			done({ ok: false, code: -1, stdout: '', stderr: String((e && e.message) || e) });
			return;
		}
		const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
		child.stdout.on('data', (d) => { out += String(d); });
		child.stderr.on('data', (d) => { err += String(d); });
		child.on('error', (e) => { clearTimeout(timer); done({ ok: false, code: -1, stdout: out, stderr: String((e && e.message) || e) }); });
		child.on('close', (code) => { clearTimeout(timer); done({ ok: code === 0, code: code ?? -1, stdout: out, stderr: err }); });
	});
}

/**
 * 归一化用户填的地址 ⇒ 可 `git remote add` 的 URL。
 *
 * 接受这几种写法（用户怎么顺手怎么来）：
 *   github.com/owner/repo · https://github.com/owner/repo(.git) · git@github.com:owner/repo.git
 *   https://gitlab.com/group/repo · https://forge.internal/owner/repo
 *   **本地路径 / file:// 路径** ⇒ 用于"另一块盘/内网共享目录"当远端（无需服务器 ✓）
 *
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
export function normalizeRemoteUrl(type, input) {
	const raw = String(input ?? '').trim();
	if (!raw) { return { ok: false, error: '请填写远端地址' }; }

	// ① 本地路径 / file:// ⇒ 任何类型都允许（"不依赖服务器"这条用户很在意）
	if (/^file:\/\//i.test(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || /^[\\/]{2}/.test(raw) || raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../')) {
		let p = raw.replace(/^file:\/\//i, '');
		if (/^[a-zA-Z]:/.test(p)) { p = p.replace(/^\/+/, ''); }
		return { ok: true, url: p.replace(/\\/g, '/'), kind: 'path' };
	}

	// ② SSH 形式 ⇒ 原样（凭据交给 ssh-agent，我们不碰私钥）
	if (/^git@|^ssh:\/\//i.test(raw)) { return { ok: true, url: raw, kind: 'ssh' }; }

	// ③ https URL / 裸域名
	let s = raw;
	if (!/^https?:\/\//i.test(s)) { s = 'https://' + s; }
	if (type === 'github' && !/\.git$/i.test(s)) { s += '.git'; }
	if (type === 'gitlab' && !/\.git$/i.test(s)) { s += '.git'; }
	if (type === 'forgejo' && !/\.git$/i.test(s)) { s += '.git'; }
	return { ok: true, url: s, kind: 'https' };
}

/**
 * 鉴权：拼成 `-c http.extraheader=…` ⇒ **不落 .git/config**。
 * 本地路径 / SSH ⇒ 不需要（返回空数组）。
 */
export function authArgs(type, token, urlKind) {
	if (urlKind === 'path' || urlKind === 'ssh') { return []; }
	const tk = String(token ?? '').trim();
	if (!tk) { return []; }
	const header = (() => {
		switch (type) {
			case 'gitlab': return `PRIVATE-TOKEN: ${tk}`;
			case 'forgejo': return `Authorization: token ${tk}`;   // Gitea/Forgejo 用 token 前缀
			case 'github':
			default: return `Authorization: Bearer ${tk}`;
		}
	})();
	return ['-c', `http.extraheader=${header}`];
}

// ── 远端配置存取（**数据根**，不进库目录）────────────────────────────────
const storePath = (dataRoot) => join(String(dataRoot ?? ''), REMOTE_STORE_FILE);

/** 读全部远端配置。缺省 = `local`。 */
export function readRemoteStore(dataRoot) {
	try {
		const j = JSON.parse(readFileSync(storePath(dataRoot), 'utf8'));
		return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
	} catch { return {}; }
}

/**
 * 取某个库的远端配置（拿不到 ⇒ **local**）。
 *
 * ⚠ 返回的 token 只用于内存里的命令拼装，UI 只回 hasToken ⇒ 不把明文吐给前端。
 * ⚠ creds = 宿主的 ctx.credentials ⇒ 令牌**只从凭据库读**（kb-remotes.json 不再存明文）。
 *   若读到旧文件里残留的明文 ⇒ 顺手迁进凭据库并从文件里删掉（一次性升级，不留明文）。
 */
export async function readRemote(dataRoot, vaultId, creds) {
	const id = String(vaultId ?? '');
	const all = readRemoteStore(dataRoot);
	const c = all[id];
	if (!c || typeof c !== 'object') { return { type: 'local' }; }

	const ref = credentialRefFor(id);
	let token = await credResolve(creds, ref);

	// 迁移：老配置里还留着明文 ⇒ 搬进凭据库，再从文件删掉
	if (!token && typeof c.token === 'string' && c.token) {
		token = c.token;
		if (await credSet(creds, ref, token)) {
			delete c.token;
			try { writeFileSync(storePath(dataRoot), JSON.stringify(all, null, 2), 'utf8'); } catch { /* best effort */ }
		}
	}

	return {
		type: REMOTE_TYPES.includes(c.type) ? c.type : 'local',
		...(c.url ? { url: String(c.url) } : {}),
		...(c.branch ? { branch: String(c.branch) } : {}),
		...(token ? { token } : {}),
		...(c.updatedAt ? { updatedAt: c.updatedAt } : {}),
	};
}

/**
 * 写某个库的远端配置（type=local ⇒ 视为"断开远端"，清掉地址与凭据）。
 *
 * ⚠ 令牌**只写凭据库**（ctx.credentials）；kb-remotes.json 里只留
 *   type / url / branch / updatedAt 这些**非机密**字段 ⇒ 文件里永远没有明文。
 * ⚠ 断开（local）时必须 unset ⇒ 否则"登出了令牌还留着"（与 tof 那次的口径一致）。
 */
export async function writeRemote(dataRoot, vaultId, cfg, creds) {
	const all = readRemoteStore(dataRoot);
	const id = String(vaultId ?? '');
	if (!id) { return { ok: false, error: '缺少库 id' }; }
	const ref = credentialRefFor(id);

	if (!cfg || cfg.type === 'local') {
		delete all[id];
		await credUnset(creds, ref);
	} else {
		if (!REMOTE_TYPES.includes(cfg.type)) { return { ok: false, error: '不支持的远端类型：' + cfg.type }; }
		const n = normalizeRemoteUrl(cfg.type, cfg.url);
		if (!n.ok) { return { ok: false, error: n.error }; }
		all[id] = {
			type: cfg.type,
			url: n.url,
			branch: String(cfg.branch ?? '').trim() || 'master',
			// 注意：**不写 token**（明文不落这个文件）
			updatedAt: new Date().toISOString(),
		};
		const tk = String(cfg.token ?? '').trim();
		if (tk) { await credSet(creds, ref, tk); }
	}
	try {
		const p = storePath(dataRoot);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify(all, null, 2), 'utf8');
	} catch (e) {
		return { ok: false, error: '写远端配置失败：' + String((e && e.message) || e) };
	}
	const remote = await readRemote(dataRoot, id, creds);
	return { ok: true, remote: { ...remote, hasToken: Boolean(remote.token) } };
}

// ── 命令 ────────────────────────────────────────────────────────────────

/** 当前仓库已有 remote 吗（拿名字与 URL）。 */
export async function gitRemoteList(dir) {
	const r = await runGit(['remote', '-v'], dir);
	const map = {};
	for (const line of String(r.stdout || '').split('\n')) {
		const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
		if (m) { map[m[1]] = m[2]; }
	}
	return map;
}

/** 设置/更新 remote（地址变了就 set-url）。 */
export async function gitRemoteSet(dir, url, name = REMOTE_NAME) {
	const have = await gitRemoteList(dir);
	const args = have[name] ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url];
	const r = await runGit(args, dir);
	if (!r.ok) { return { ok: false, error: (r.stderr || r.stdout || '').trim().slice(0, 200) }; }
	return { ok: true, name, url };
}

/** 断开远端（只摘 remote，不动 .git 里的历史）。 */
export async function gitRemoteRemove(dir, name = REMOTE_NAME) {
	const have = await gitRemoteList(dir);
	if (!have[name]) { return { ok: true, noop: true }; }
	const r = await runGit(['remote', 'remove', name], dir);
	return r.ok ? { ok: true } : { ok: false, error: (r.stderr || '').trim().slice(0, 200) };
}

/** 连通性测试：`git ls-remote`（不改动任何东西）。 */
export async function gitRemoteTest(url, type, token) {
	const n = normalizeRemoteUrl(type, url);
	if (!n.ok) { return { ok: false, error: n.error }; }
	const args = [...authArgs(type, token, n.kind), 'ls-remote', n.url];
	const r = await runGit(args, process.cwd(), 30_000);
	if (!r.ok) {
		return { ok: false, error: (r.stderr || r.stdout || '').trim().slice(0, 240) || '连不上远端' };
	}
	return { ok: true, refs: String(r.stdout || '').split('\n').filter(Boolean).length };
}

/** 当前分支名。 */
export async function currentBranch(dir) {
	const r = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
	return String(r.stdout || '').trim();
}

/**
 * 拉取。**有冲突就报错，不自动合并**（第 ⑤ 条底线）。
 * 先 fetch，再看能不能 fast-forward / 已最新；否则返回 `conflict`。
 */
export async function gitPull(dir, cfg) {
	const branch = String(cfg?.branch ?? '').trim() || (await currentBranch(dir)) || 'master';
	const n = normalizeRemoteUrl(cfg?.type, cfg?.url);
	if (!n.ok) { return { ok: false, error: n.error }; }
	const auth = authArgs(cfg?.type, cfg?.token, n.kind);

	const fetch = await runGit([...auth, 'fetch', REMOTE_NAME, branch], dir);
	if (!fetch.ok) { return { ok: false, error: '拉取失败：' + (fetch.stderr || fetch.stdout || '').trim().slice(0, 240) }; }

	// 本地有未提交改动 ⇒ 先说清楚，别悄悄覆盖
	const st = await runGit(['status', '--porcelain'], dir);
	if (String(st.stdout || '').trim()) {
		return { ok: false, error: '本地有未提交的改动，请先提交再拉取（避免覆盖你正在写的内容）' };
	}
	const merge = await runGit(['merge', '--ff-only', `${REMOTE_NAME}/${branch}`], dir);
	if (!merge.ok) {
		return { ok: false, conflict: true, error: '远端有本地没有的改动（快进不了）。请在命令行处理，或先备份后再拉。' };
	}
	return { ok: true, branch };
}

/** 推送（本地必须有提交 ⇒ 没有就先提示）。 */
export async function gitPush(dir, cfg) {
	const branch = String(cfg?.branch ?? '').trim() || (await currentBranch(dir)) || 'master';
	const n = normalizeRemoteUrl(cfg?.type, cfg?.url);
	if (!n.ok) { return { ok: false, error: n.error }; }
	const auth = authArgs(cfg?.type, cfg?.token, n.kind);

	const log = await runGit(['log', '-1'], dir);
	if (!log.ok && /does not have any commits/i.test(log.stderr + log.stdout)) {
		return { ok: false, error: '还没有任何提交，先保存一次再推送' };
	}
	const r = await runGit([...auth, 'push', '-u', REMOTE_NAME, branch], dir, 120_000);
	if (!r.ok) {
		const msg = (r.stderr || r.stdout || '').trim().slice(0, 240);
		return { ok: false, error: '推送失败：' + msg };
	}
	return { ok: true, branch };
}
