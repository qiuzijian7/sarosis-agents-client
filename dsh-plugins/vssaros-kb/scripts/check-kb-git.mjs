/*
 * 守卫：知识库的**本地版本管理（Git）**。
 *
 * 为什么钉这些（2026-10-31 新增能力）：
 *   · 用户要求"先做不依赖服务器的本地 Git" ⇒ **任何联网/上传行为都是回归** ⇒ 钉"只跑本地 git 命令"。
 *   · 用户的库是**私人笔记** ⇒ 没有显式 init 就绝不能有 git 行为 ⇒ 钉"maybeAutoCommit 在非仓库时是 no-op"。
 *   · 缓存/索引进版本会让历史变成噪音、仓库膨胀 ⇒ 钉 .gitignore 条目。
 *   · 围栏（relInside）一旦失效，git 操作可能碰到库外文件 ⇒ 钉行为。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-git.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LIB = path.join(HERE, '../lib');
const CORE = fs.readFileSync(path.join(LIB, 'core/kbGit.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
let BUNDLE = '';
try { BUNDLE = fs.readFileSync(path.join(LIB, 'web/kbSideview.js'), 'utf8'); } catch { /* 可能还没构建 */ }

let pass = 0;
const failed = [];
async function check(name, fn) {
	try { fn(); pass += 1; console.log('PASS  ' + name); }
	catch (e) { failed.push(name); console.log('FAIL  ' + name + '  — ' + (e && e.message ? e.message : e)); }
}

await check('服务端有 /api/kb-git 路由', () => {
	if (!INDEX.includes('/api/kb-git`')) { throw new Error('没有 /api/kb-git'); }
});
await check('服务端把 kbGit 的 op 都分发了（init/status/commit/log/logFile/show/restore/config）', () => {
	for (const op of ['init', 'status', 'commit', 'log', 'logFile', 'show', 'restore', 'config']) {
		if (!INDEX.includes(`case '${op}':`)) { throw new Error('缺 op：' + op); }
	}
});
await check('保存正文后会触发自动提交（maybeAutoCommit）', () => {
	if (!/void maybeAutoCommit\(/.test(INDEX)) { throw new Error('保存后没有自动提交钩子'); }
});
await check('面板提供 kbGit 动作（bundle 通过它调服务端）', () => {
	if (!/kbGit: \(op, extra\)/.test(CLIENT)) { throw new Error('面板没有 kbGit'); }
});
await check('bundle 有版本按钮与版本面板', () => {
	if (!BUNDLE) { throw new Error('读不到 bundle'); }
	if (!BUNDLE.includes('data-kb-git-btn') || !BUNDLE.includes('data-kb-git-panel')) { throw new Error('bundle 缺版本 UI'); }
});

// ── 行为层：直接跑 core 的纯逻辑 ─────────────────────────────────────────
const G = await import('file:///' + path.join(LIB, 'core/kbGit.js').replace(/\\/g, '/'));

// ★ 2026-10-31（真机：E:\VsSarosVault 素材 7MB；不开 LFS ⇒ 每次改图都在 git 里多一份全量 blob）
await check('★ 二进制素材走 Git LFS，且 .md 必须留在 git 里（文本要能 diff）', () => {
	if (!Array.isArray(G.LFS_DEFAULT_PATTERNS) || !G.LFS_DEFAULT_PATTERNS.length) { throw new Error('没有 LFS 默认类型'); }
	for (const p of ['*.png', '*.pdf', '*.mp4']) {
		if (!G.LFS_DEFAULT_PATTERNS.includes(p)) { throw new Error('LFS 应覆盖 ' + p); }
	}
	// ⚠ 反向：.md / .svg / .json 绝不能进 LFS（进了就 diff 不了、blame 不了）
	for (const bad of ['*.md', '*.svg', '*.json', '*.canvas']) {
		if (G.LFS_DEFAULT_PATTERNS.includes(bad)) { throw new Error(bad + ' 不该走 LFS（文本必须留在 git 里）✗'); }
	}
});
await check('★ LFS 是 best effort：没装 lfs 也**不能**连累建库', async () => {
	if (typeof G.setupLfs !== 'function') { throw new Error('没有 setupLfs'); }
	const r = await G.setupLfs('', []);
	if (r.enabled !== false) { throw new Error('空目录竟然返回 enabled:true'); }
	if (!/await setupLfs\(root, LFS_DEFAULT_PATTERNS\)/.test(CORE)) { throw new Error('initRepo 没有接 LFS'); }
	if (!/opts\.lfs !== false/.test(CORE)) { throw new Error('必须能用 opts.lfs=false 关掉 LFS'); }
});
await check('围栏：库外路径一律拒绝（纯字符串）', () => {
	if (G.relInside('/vault/a', '../out.md') !== undefined) { throw new Error('越界没被拦'); }
	if (G.relInside('/vault/a', 'notes/x.md') === undefined) { throw new Error('库内路径被误拦'); }
});
await check('.gitignore 覆盖可再生的缓存/索引/备份', () => {
	const need = ['.kb-html-cache/', '.kb-build-cache.json', '.feishu-sync.json', '.kb-backup/'];
	for (const n of need) { if (!G.GITIGNORE_ENTRIES.includes(n)) { throw new Error('缺忽略项：' + n); } }
});
await check('maybeAutoCommit：**显式关掉**自动提交 ⇒ 不提交', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'kbgit-guard2-'));
	try {
		mkdirSync(path.join(dir, '笔记'), { recursive: true });
		writeFileSync(path.join(dir, '笔记/a.md'), '# a\n', 'utf8');
		const init = await G.initRepo(dir);
		if (!init.ok) { throw new Error('init 失败：' + (init.error || '')); }
		G.writeGitConfig(dir, { autoCommit: false });
		writeFileSync(path.join(dir, '笔记/a.md'), '# a\n\n第二版\n', 'utf8');
		const r = await G.maybeAutoCommit(dir, '测试');
		if (!r.skipped) { throw new Error('关掉后竟然提交了'); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

await check('★ 默认开启：配置缺省 ⇒ autoInit / autoCommit 都是 true', () => {
	const c = G.readGitConfig(path.join(os.tmpdir(), `kbgit-no-such-dir-${Date.now()}`));
	if (c.autoInit !== true || c.autoCommit !== true) { throw new Error('默认是 ' + JSON.stringify(c)); }
});

await check('★ 默认开启：**没有 .git 时保存会自动建库并提交**（用户不用先点开启）', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'kbgit-guard4-'));
	try {
		mkdirSync(path.join(dir, '笔记'), { recursive: true });
		writeFileSync(path.join(dir, '笔记/a.md'), '# a\n\n第一版\n', 'utf8');
		if (G.isRepo(dir)) { throw new Error('一开始就有仓库，用例没意义'); }
		await G.maybeAutoCommit(dir, '保存 a.md');
		if (!G.isRepo(dir)) { throw new Error('没有自动建库'); }
		const log = await G.gitLog(dir, '笔记/a.md', 10);
		if (!Array.isArray(log.items) || log.items.length < 1) { throw new Error('没有产生提交'); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

await check('★ 关掉后（autoInit:false）⇒ 连仓库都不建（绝不擅自 git init）', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'kbgit-guard5-'));
	try {
		mkdirSync(path.join(dir, '笔记'), { recursive: true });
		writeFileSync(path.join(dir, '笔记/a.md'), '# a\n', 'utf8');
		G.writeGitConfig(dir, { autoInit: false, autoCommit: false });
		await G.maybeAutoCommit(dir, '保存 a.md');
		if (G.isRepo(dir)) { throw new Error('关掉了还建库 ✗'); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
await check('init → 提交 → 按文件取历史（端到端，临时目录）', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'kbgit-guard3-'));
	try {
		mkdirSync(path.join(dir, '笔记'), { recursive: true });
		writeFileSync(path.join(dir, '笔记/a.md'), '# a\n\n第一版\n', 'utf8');
		if (!(await G.initRepo(dir)).ok) { throw new Error('init 失败'); }
		writeFileSync(path.join(dir, '笔记/a.md'), '# a\n\n第二版\n', 'utf8');
		if (!(await G.gitCommit(dir, 'chore(kb): 第二版')).ok) { throw new Error('commit 失败'); }
		const log = await G.gitLog(dir, '笔记/a.md', 20);
		if (!Array.isArray(log.items) || log.items.length < 2) { throw new Error('该文件历史不足 2 条'); }
		const oldest = log.items[log.items.length - 1];
		const shown = await G.gitShowFile(dir, oldest.hash, '笔记/a.md');
		if (!shown.ok || !String(shown.content || '').includes('第一版')) { throw new Error('取不到旧版本内容'); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log('\n' + (failed.length ? `✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项` : `✓ 全部 ${pass} 项通过`));
if (failed.length) { process.exit(1); }
