// @vssaros/dsh-kb — 知识库的**本地 Git 版本管理**（★ 2026-10-31 用户需求）。
//
// 设计底线（写死在注释里，改代码前先读）：
//  ① **不依赖任何服务器**：全部操作都在这台机器上、这个库目录里跑 `git`，不走网络、不上传。
//  ② **必须显式开启**：`init` 由用户在界面上点出来；没有 `.git` 就没有任何 git 行为。
//  ③ **围栏**：一切路径都必须落在库目录内（`relInside`）⇒ 不许 git 操作碰到库外的东西。
//  ④ **不追求协同**：Git 只在本地提供"历史 / diff / 回滚"。多人同时改一篇的冲突**要人工解** ——
//     这不是缺陷，是取舍：先解决"误删能找回"，再谈协同（见 docs/research/kb-sharing-marketplace-versioning.md）。
//
// 为什么单独一个文件：判据与命令拼装必须**可单测** ⇒ 只依赖 node:fs / node:child_process，不 import 任何 dsh 包。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * ★ 2026-10-31（真机：E:\VsSarosVault 145MB，其中素材 7MB）：**二进制素材走 Git LFS**。
 *   为什么：图片/PDF 每次改动都会在 git 里多一份**全量 blob**（改 10 次 = 10 份），
 *   而 LFS 只在 git 里留一个指针 ⇒ 仓库不会被素材撑大。
 *   ⚠ **.md / .svg / .json 不在此列**：它们是文本，必须留在 git 里才能 diff / blame ✓
 *   ⚠ 只在 `git lfs` 可用时启用（没装就跳过，绝不因此建库失败）。
 */
export const LFS_DEFAULT_PATTERNS = [
	'*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.bmp', '*.tiff',
	'*.pdf', '*.psd', '*.ai', '*.sketch',
	'*.mp4', '*.mov', '*.webm', '*.mp3', '*.wav',
	'*.zip', '*.7z', '*.rar', '*.pptx', '*.docx', '*.xlsx',
];

/** 库内的 Git 配置文件名（存自动提交开关等）。 */
export const KB_GIT_CONFIG_FILE = '.kb-git.json';

/**
 * 默认忽略：这些是**可再生**的缓存/索引/日志/备份 —— 进 Git 只会让历史全是噪音、仓库迅速膨胀。
 * （.kb-backup 是快照目录，也不该进版本）
 */
export const GITIGNORE_ENTRIES = [
	'.kb-html-cache/',
	// ★ 2026-10-31（真机：E:\VsSarosVault 145MB，其中 .tmp-media 里 3 个 mp4 就 138MB）：
	//   这些**临时媒体**若在首次提交时进了库，就永远留在历史里（git 删了文件 blob 还在）⇒ 必须先忽略。
	'.tmp-media/',
	// ★ 同批发现：下面这几个是**真实存在**的缓存/索引/日志文件名（之前写的是带连字符的猜测名 ⇒ 没生效）
	'.kbkernel.json',
	'.kbkernel.json.bak-*',
	'.kb-ingest-cache.json',
	'.kb-insights-cache.json',
	'.op-log.jsonl',
	// Obsidian 的应用态（插件/工作区，1.7MB）⇒ 不是笔记内容，不进版本
	'.obsidian/',
	'.kb-build-cache.json',
	'.kb-kernel.json',
	'.kb-insights-cache.json',
	'.kb-topic-overview-cache.json',
	'.feishu-sync.json',
	'.feishu-space-map.json',
	'.feishu-space-map.json.bak-*',
	'.feishu-sync.log',
	'.kb-feishu-sync.log',
	'.tmp-media/',
	'.canvas-text-migration-backup/',
	'.kb-backup/',
	// 本机私有设置（自动提交开关等）：换台机器就不同 ⇒ 不进版本（否则 dirty 永远不为 0）
	'.kb-git.json',
	'.DS_Store',
	'Thumbs.db',
];

/**
 * 判断相对路径是否落在库目录内（**纯字符串**，不碰 fs）。
 * @returns 归一化后的相对路径（用 `/`）；越界 ⇒ undefined
 */
export function relInside(vaultDir, rel) {
	const root = resolve(String(vaultDir ?? ''));
	const p = resolve(root, String(rel ?? ''));
	if (p !== root && !p.startsWith(root + sep)) { return undefined; }
	let r = p.slice(root.length).replace(/\\/g, '/');
	while (r.startsWith('/')) { r = r.slice(1); }
	if (r === '' || r.split('/').includes('..')) { return undefined; }
	return r;
}

/** 跑一条 git 命令（带超时，永不抛异常）。 */
export function runGit(args, cwd, timeoutMs = 30_000) {
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
		child.stdout.on('data', (d) => { out += String(d); if (out.length > 4_000_000) { try { child.kill('SIGKILL'); } catch { /* ignore */ } } });
		child.stderr.on('data', (d) => { err += String(d); });
		child.on('error', (e) => { clearTimeout(timer); done({ ok: false, code: -1, stdout: out, stderr: String((e && e.message) || e) }); });
		child.on('close', (code) => { clearTimeout(timer); done({ ok: code === 0, code: code ?? -1, stdout: out, stderr: err }); });
	});
}

/** 库目录是不是一个 git 仓库。 */
export function isRepo(dir) {
	try { return existsSync(join(String(dir), '.git')); } catch { return false; }
}

/**
 * 读库级 Git 配置（没有 ⇒ **默认全开**，见下）。
 *
 * ★ 2026-10-31（用户：知识库的文章**默认开启版本管理**）：
 *   autoInit   默认 **true** ⇒ 第一次写入时自动 `git init`（用户不必先点"开启"）；
 *   autoCommit 默认 **true** ⇒ 每次保存正文自动留一个版本。
 *   ⚠ 两者都**只在本机这个库目录里**跑 git：不联网、不上传 ⇒ 默认开也是安全的 ✓。
 *   ⚠ 用户仍可在界面上关掉（关掉后行为回到"什么都不做"）。
 */
export function readGitConfig(dir) {
	const file = join(String(dir), KB_GIT_CONFIG_FILE);
	try {
		const j = JSON.parse(readFileSync(file, 'utf8'));
		return {
			autoInit: j?.autoInit !== false,		// 没写 ⇒ 默认开
			autoCommit: j?.autoCommit !== false,	// 没写 ⇒ 默认开
			...(typeof j?.lastCommitAt === 'string' ? { lastCommitAt: j.lastCommitAt } : {}),
		};
	} catch {
		return { autoInit: true, autoCommit: true };
	}
}

/** 写库级 Git 配置（best effort：写失败不该影响主流程）。 */
export function writeGitConfig(dir, patch) {
	const next = { ...readGitConfig(dir), ...(patch ?? {}) };
	try {
		writeFileSync(join(String(dir), KB_GIT_CONFIG_FILE), JSON.stringify(next, null, 2), 'utf8');
	} catch { /* best effort */ }
	return next;
}

/** 生成/补全 .gitignore（已存在就**追加**缺失项，不覆盖用户自己的内容）。 */
export function ensureGitignore(dir) {
	const file = join(String(dir), '.gitignore');
	let text = '';
	try { text = readFileSync(file, 'utf8'); } catch { text = ''; }
	const missing = GITIGNORE_ENTRIES.filter((e) => !text.split(/\r?\n/).some((l) => l.trim() === e));
	if (!missing.length) { return { changed: false, file, added: [] }; }
	const block = [
		'',
		'# ---- VsSaros 知识库：可再生文件（索引/缓存/日志/备份）不进版本 ----',
		...missing,
		'# ---------------------------------------------------------------',
	].join('\n');
	try {
		writeFileSync(file, (text ? text.replace(/\s*$/, '') : '') + block + '\n', 'utf8');
		return { changed: true, file, added: missing };
	} catch { return { changed: false, file, added: [] }; }
}

/**
 * 启用 Git LFS 并登记类型（**best effort**：`git lfs` 不可用 ⇒ 直接返回 enabled:false，
 * 建库**绝不因此失败**）。
 */
export async function setupLfs(dir, patterns) {
	const root = String(dir ?? '');
	if (!root) { return { enabled: false, patterns: [], why: 'no-dir' }; }
	const list = Array.isArray(patterns) ? patterns : LFS_DEFAULT_PATTERNS;
	try {
		const ver = await runGit(['lfs', 'version'], root, 15_000);
		if (!ver.ok) { return { enabled: false, patterns: [], why: 'lfs-not-installed' }; }
		await runGit(['lfs', 'install'], root, 30_000);
		for (const p of list) { await runGit(['lfs', 'track', p], root, 30_000); }
		return { enabled: true, patterns: list };
	} catch (e) {
		return { enabled: false, patterns: [], why: String((e && e.message) || e) };
	}
}

/**
 * 初始化：git init + .gitignore + 首次提交。
 *
 * ⚠ opts.message：首次提交的信息。默认「chore(kb): 初始化版本管理」；
 *   但**因保存而自动建库**时，首条历史里已经有那次保存的内容 ⇒ 文案要说明这一点
 *   （否则用户看到"初始化版本管理"会以为自己的保存没记进去 —— 2026-10-31 实测的困惑点）。
 */
export async function initRepo(dir, opts = {}) {
	const root = String(dir ?? '');
	if (!root) { return { ok: false, error: '缺少库目录' }; }
	if (isRepo(root)) {
		ensureGitignore(root);
		return { ok: true, repo: true, already: true };
	}
	const r1 = await runGit(['init'], root);
	if (!r1.ok) { return { ok: false, error: `git init 失败：${(r1.stderr || r1.stdout || '').trim().slice(0, 200)}` }; }
	// 提交者身份：库级设置（不碰全局 ⇒ 不污染用户自己的 git 配置）
	await runGit(['config', 'user.name', opts.userName || 'VsSaros KB'], root);
	await runGit(['config', 'user.email', opts.userEmail || 'kb@local'], root);
	const ig = ensureGitignore(root);
	// ★ 二进制素材走 LFS（best effort：没装 lfs 就跳过 ⇒ 建库照常成功）
	let lfs = { enabled: false, patterns: [] };
	if (opts.lfs !== false) { lfs = await setupLfs(root, LFS_DEFAULT_PATTERNS); }
	const add = await runGit(['add', '-A'], root);
	if (!add.ok) { return { ok: false, error: `git add 失败：${(add.stderr || '').trim().slice(0, 200)}` }; }
	const cm = await runGit(['commit', '-m', String(opts?.message ?? '').trim() || 'chore(kb): 初始化版本管理'], root);
	if (!cm.ok && !/nothing to commit/i.test(cm.stdout + cm.stderr)) {
		return { ok: false, error: `首次提交失败：${(cm.stderr || cm.stdout || '').trim().slice(0, 200)}` };
	}
	return { ok: true, repo: true, gitignore: ig.added, lfs }; 
}

/** 状态：是否仓库 / 分支 / 未提交变更数 / 最后一次提交。 */
export async function gitStatus(dir) {
	const root = String(dir ?? '');
	if (!isRepo(root)) { return { ok: true, repo: false, dirty: 0 }; }
	const [br, st, last] = await Promise.all([
		runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root),
		runGit(['status', '--porcelain'], root),
		runGit(['log', '-1', '--format=%H%x1f%ct%x1f%s'], root),
	]);
	const dirty = String(st.stdout || '').split('\n').filter((l) => l.trim()).length;
	let lastCommit = null;
	const parts = String(last.stdout || '').trim().split('');
	if (parts.length >= 3 && parts[0]) {
		lastCommit = { hash: parts[0], time: Number(parts[1]) * 1000 || 0, message: parts[2] };
	}
	return {
		ok: true,
		repo: true,
		branch: String(br.stdout || '').trim() || '(未知)',
		dirty,
		lastCommit,
	};
}

/** 提交（add -A + commit）。没有变更 ⇒ 返回 `noop`。 */
export async function gitCommit(dir, message) {
	const root = String(dir ?? '');
	if (!isRepo(root)) { return { ok: false, error: '该库还没有开启版本管理' }; }
	const stt = await runGit(['status', '--porcelain'], root);
	if (!String(stt.stdout || '').trim()) { return { ok: true, noop: true }; }
	const add = await runGit(['add', '-A'], root);
	if (!add.ok) { return { ok: false, error: `git add 失败：${(add.stderr || '').trim().slice(0, 200)}` }; }
	const cm = await runGit(['commit', '-m', String(message || 'chore(kb): 自动提交')], root);
	if (!cm.ok) { return { ok: false, error: `提交失败：${(cm.stderr || cm.stdout || '').trim().slice(0, 200)}` }; }
	const h = await runGit(['rev-parse', 'HEAD'], root);
	writeGitConfig(root, { lastCommitAt: new Date().toISOString() });
	return { ok: true, hash: String(h.stdout || '').trim() };
}

/**
 * 日志。`file` 为空 ⇒ 整个库；否则只列该文件的提交。
 * 格式：`%H%x1f%ct%x1f%an%x1f%s`
 */
export async function gitLog(dir, file, limit = 30) {
	const root = String(dir ?? '');
	if (!isRepo(root)) { return { ok: true, repo: false, items: [] }; }
	let rel = undefined;
	if (file) {
		rel = relInside(root, file);
		if (rel === undefined) { return { ok: false, error: '拒绝访问库外文件：' + file }; }
	}
	const args = ['log', '-n', String(Math.min(Math.max(Number(limit) || 30, 1), 200)), '--format=%H%x1f%ct%x1f%an%x1f%s'];
	if (rel) { args.push('--', rel); }
	const r = await runGit(args, root);
	if (!r.ok && !/does not have any commits/i.test(r.stderr + r.stdout)) {
		return { ok: false, error: (r.stderr || r.stdout || '').trim().slice(0, 200) };
	}
	const items = String(r.stdout || '').split('\n').filter(Boolean).map((line) => {
		const [hash, t, author, subject] = line.split('');
		return { hash: String(hash || ''), time: Number(t) * 1000 || 0, author: author || '', message: subject || '' };
	});
	return { ok: true, repo: true, items };
}

/**
 * **自动提交**（写入之后的钩子）。
 *
 * ⚠ 三条硬口径：
 *   ① 只有用户**显式开启过**（`init` + autoCommit=true）才提交 ⇒ 没有 .git 就绝无行为；
 *   ② 全程**本地**（就在这个库目录里跑 git）⇒ 不联网、不上传；
 *   ③ 绝不影响主流程：任何失败都吞掉（写库已经成功了，不该因为提交失败而报错）。
 */
export async function maybeAutoCommit(dir, reason) {
	try {
		const root = String(dir ?? '');
		if (!root) { return { ok: true, skipped: true, why: 'no-dir' }; }
		const cfg = readGitConfig(root);
		/*
		 * ★ 2026-10-31（用户：**默认开启**）：还没有 .git 时，若 autoInit ⇒ 先自动 init。
		 *   这样"用户什么都不用做"，保存一次就有历史（这是版本管理能兜住误删的前提）。
		 *   ⚠ init 只在本机这个目录里 ⇒ 不产生任何上传 ✓。
		 */
		if (!isRepo(root)) {
			if (!cfg.autoInit) { return { ok: true, skipped: true, why: 'not-a-repo' }; }
			// 首条历史里就含这次保存的内容 ⇒ 文案写清楚，别让"初始化版本管理"误导用户
			const init = await initRepo(root, { message: `chore(kb): ${String(reason || '自动提交')}（首次建立版本管理）` });
			if (!init.ok) { return { ok: true, skipped: true, why: 'init-failed', error: init.error }; }
		}
		if (!cfg.autoCommit) { return { ok: true, skipped: true, why: 'auto-commit-off' }; }
		return await gitCommit(root, `chore(kb): ${String(reason || '自动提交')}`);
	} catch {
		return { ok: true, skipped: true, why: 'error' };
	}
}

/** 取某个提交里该文件的内容（用于"查看旧版本"）。 */
export async function gitShowFile(dir, rev, file) {
	const root = String(dir ?? '');
	if (!isRepo(root)) { return { ok: false, error: '该库还没有开启版本管理' }; }
	const rel = relInside(root, file);
	if (rel === undefined) { return { ok: false, error: '拒绝访问库外文件：' + file }; }
	if (!/^[0-9a-fA-F]{4,40}$/.test(String(rev || ''))) { return { ok: false, error: '提交号不合法：' + rev }; }
	const r = await runGit(['show', `${rev}:${rel}`], root, 20_000);
	if (!r.ok) { return { ok: false, error: (r.stderr || r.stdout || '').trim().slice(0, 200) }; }
	return { ok: true, content: r.stdout };
}

/** 把文件恢复到某个提交的版本（= 回滚，会生成一条新提交，历史不丢）。 */
export async function gitRestoreFile(dir, rev, file) {
	const root = String(dir ?? '');
	if (!isRepo(root)) { return { ok: false, error: '该库还没有开启版本管理' }; }
	const rel = relInside(root, file);
	if (rel === undefined) { return { ok: false, error: '拒绝访问库外文件：' + file }; }
	if (!/^[0-9a-fA-F]{4,40}$/.test(String(rev || ''))) { return { ok: false, error: '提交号不合法：' + rev }; }
	const co = await runGit(['checkout', rev, '--', rel], root);
	if (!co.ok) { return { ok: false, error: `恢复失败：${(co.stderr || co.stdout || '').trim().slice(0, 200)}` }; }
	const cm = await gitCommit(root, `chore(kb): 恢复 ${rel} 到 ${String(rev).slice(0, 7)}`);
	return { ok: true, ...(cm.hash ? { hash: cm.hash } : {}), noop: cm.noop === true };
}
