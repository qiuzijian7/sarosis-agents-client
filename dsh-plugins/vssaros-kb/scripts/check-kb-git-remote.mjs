/*
 * 守卫：版本管理的**远端抽象层**（P1）。
 *
 * 钉的是几条"不可退让"的口径（2026-10-31 新增）：
 *   · **默认 local**：没配远端就绝不能有上传行为（用户的库是私人笔记）。
 *   · **令牌只进宿主凭据库**（ctx.credentials，与商城 JWT 同一套）⇒
 *     `kb-remotes.json` 里**永远没有明文**；断开时 `unset`。
 *   · **凭据不落 .git/config**：推送/拉取用 `-c http.extraheader=…` ⇒ 命令结束即失效。
 *   · **目录也能当远端**：`path` 类型 ⇒ 不依赖任何服务器（另一块盘 / 共享盘）。
 *   · **不自动合并**：pull 冲突要报错，不能悄悄覆盖用户正在写的内容。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-git-remote.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LIB = path.join(HERE, '../lib');
const CORE = path.join(LIB, 'core/kbGitRemote.js');
const REM = fs.readFileSync(CORE, 'utf8');
const INDEX = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
let BUNDLE = '';
try { BUNDLE = fs.readFileSync(path.join(LIB, 'web/kbSideview.js'), 'utf8'); } catch { /* 未构建 */ }

const G = await import('file:///' + path.join(LIB, 'core/kbGit.js').replace(/\\/g, '/'));
const R = await import('file:///' + CORE.replace(/\\/g, '/'));

/** 假凭据服务（接口与 ctx.credentials 一致：resolve / set / unset）。 */
const makeCreds = () => {
	const store = new Map();
	return {
		store,
		async resolve(ref) { return store.get(ref); },
		async set(ref, v) { store.set(ref, String(v)); },
		async unset(ref) { store.delete(ref); },
	};
};

let pass = 0;
const failed = [];
function check(name, fn) {
	try { fn(); pass += 1; console.log('PASS  ' + name); }
	catch (e) { failed.push(name); console.log('FAIL  ' + name + '  — ' + (e && e.message ? e.message : e)); }
}

check('远端类型含 local / path / github / gitlab / forgejo', () => {
	for (const t of ['local', 'path', 'github', 'gitlab', 'forgejo']) {
		if (!R.REMOTE_TYPES.includes(t)) { throw new Error('缺类型：' + t); }
	}
});
check('未配置 ⇒ 默认 local（零上传）', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'kb-rem-default-'));
	try {
		const c = await R.readRemote(dir, '随便一个库', makeCreds());
		if (c.type !== 'local') { throw new Error('默认是 ' + c.type); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
check('服务端分发了 remote / remoteSet / remoteTest / push / pull', () => {
	for (const op of ['remote', 'remoteSet', 'remoteTest', 'push', 'pull']) {
		if (!INDEX.includes(`case '${op}':`)) { throw new Error('缺 op：' + op); }
	}
});
check('服务端把 ctx.credentials 接进去了（inject + 传给 read/write）', () => {
	if (!/let KB_CREDENTIALS = null;/.test(INDEX)) { throw new Error('没有模块级凭据变量'); }
	if (!/ctx\.inject\(\['credentials'\]/.test(INDEX)) { throw new Error('没有注入 credentials'); }
	if (!/readRemote\(kbRootOf\(config\), vault\.id, KB_CREDENTIALS\)/.test(INDEX)) { throw new Error('readRemote 没传凭据'); }
	if (!/writeRemote\(kbRootOf\(config\), vault\.id, \{[\s\S]*?\}, KB_CREDENTIALS\)/.test(INDEX)) { throw new Error('writeRemote 没传凭据'); }
	if (!/gitPush\(dir, await readRemote\([^\n]*KB_CREDENTIALS\)\)/.test(INDEX)) { throw new Error('push 没带凭据'); }
	if (!/gitPull\(dir, await readRemote\([^\n]*KB_CREDENTIALS\)\)/.test(INDEX)) { throw new Error('pull 没带凭据'); }
});
check('bundle 有远端配置区块', () => {
	if (!BUNDLE) { throw new Error('读不到 bundle'); }
	if (!BUNDLE.includes('data-kb-git-remote')) { throw new Error('bundle 缺远端 UI'); }
});
check('凭据 ref 是 POSIX 标识符（大写 + 下划线）', () => {
	const refs = [R.credentialRefFor('ext-34ca9164'), R.credentialRefFor('库A'), R.credentialRefFor('a.b/c')];
	for (const r of refs) {
		if (!/^[A-Z][A-Z0-9_]*$/.test(r)) { throw new Error('ref 不合法：' + r); }
	}
	if (!refs[0].startsWith('VSSAROS_KB_GIT_TOKEN_')) { throw new Error('ref 前缀不对：' + refs[0]); }
});
check('地址归一化（5 种写法）', () => {
	const cases = [
		['github', 'github.com/me/kb', 'https://github.com/me/kb.git'],
		['gitlab', 'https://gitlab.com/g/kb', 'https://gitlab.com/g/kb.git'],
		['forgejo', 'https://git.corp/me/kb', 'https://git.corp/me/kb.git'],
	];
	for (const [t, u, want] of cases) {
		const n = R.normalizeRemoteUrl(t, u);
		if (!n.ok || n.url !== want) { throw new Error(t + ' ' + u + ' ⇒ ' + (n.ok ? n.url : n.error)); }
	}
	if (!R.normalizeRemoteUrl('path', 'D:\\backup\\kb.git').ok) { throw new Error('本地路径没被认成 path'); }
	if (R.normalizeRemoteUrl('path', '\\\\nas\\share\\kb.git').kind !== 'path') { throw new Error('UNC 路径没被认成 path'); }
});
check('凭据走 http.extraheader（不落 .git/config），目录型/SSH 不需要', () => {
	const gh = R.authArgs('github', 'ghp_x', 'https');
	if (gh.length !== 2 || !String(gh[1]).startsWith('http.extraheader=')) { throw new Error('github 鉴权参数不对：' + JSON.stringify(gh)); }
	if (R.authArgs('path', 'ghp_x', 'path').length !== 0) { throw new Error('目录型不该带鉴权'); }
	if (R.authArgs('github', '', 'https').length !== 0) { throw new Error('没有 token 就不该带鉴权'); }
});
check('令牌只进凭据库：kb-remotes.json 里**没有明文**', async () => {
	const base = mkdtempSync(path.join(os.tmpdir(), 'kb-rem-cred-'));
	const vault = path.join(base, 'vault'), dataRoot = path.join(base, 'data');
	mkdirSync(vault, { recursive: true }); mkdirSync(dataRoot, { recursive: true });
	try {
		const creds = makeCreds();
		const w = await R.writeRemote(dataRoot, 'v1', { type: 'github', url: 'github.com/me/kb', token: 'ghp_secret' }, creds);
		if (!w.ok) { throw new Error(w.error); }
		const ref = R.credentialRefFor('v1');
		if (creds.store.get(ref) !== 'ghp_secret') { throw new Error('凭据库里没有令牌（ref=' + ref + '）'); }
		const file = readFileSync(path.join(dataRoot, 'kb-remotes.json'), 'utf8');
		if (file.includes('ghp_secret')) { throw new Error('配置文件里出现了明文令牌 ✗'); }
		if (existsSync(path.join(vault, 'kb-remotes.json'))) { throw new Error('配置写进了库目录 ✗'); }
		// 读回来要有令牌（从凭据库取）
		const c = await R.readRemote(dataRoot, 'v1', creds);
		if (c.token !== 'ghp_secret') { throw new Error('读不回令牌'); }
	} finally { rmSync(base, { recursive: true, force: true }); }
});
check('断开远端 ⇒ 凭据库也要 unset（不能"登出了令牌还在"）', async () => {
	const base = mkdtempSync(path.join(os.tmpdir(), 'kb-rem-unset-'));
	const dataRoot = path.join(base, 'data'); mkdirSync(dataRoot, { recursive: true });
	try {
		const creds = makeCreds();
		await R.writeRemote(dataRoot, 'v2', { type: 'gitlab', url: 'https://gitlab.com/g/kb', token: 'glpat_x' }, creds);
		const ref = R.credentialRefFor('v2');
		if (!creds.store.has(ref)) { throw new Error('没写进去'); }
		await R.writeRemote(dataRoot, 'v2', { type: 'local' }, creds);
		if (creds.store.has(ref)) { throw new Error('断开后令牌还在 ✗'); }
		const c = await R.readRemote(dataRoot, 'v2', creds);
		if (c.type !== 'local' || c.token) { throw new Error('断开后还能读到配置/令牌'); }
	} finally { rmSync(base, { recursive: true, force: true }); }
});
check('旧配置里的明文令牌会被迁移进凭据库并从文件删掉', async () => {
	const base = mkdtempSync(path.join(os.tmpdir(), 'kb-rem-migrate-'));
	const dataRoot = path.join(base, 'data'); mkdirSync(dataRoot, { recursive: true });
	try {
		// 手工造一份"老格式"：token 明文躺在文件里
		writeFileSync(path.join(dataRoot, 'kb-remotes.json'), JSON.stringify({
			v9: { type: 'github', url: 'https://github.com/me/kb.git', branch: 'main', token: 'ghp_old_plain' },
		}, null, 2), 'utf8');
		const creds = makeCreds();
		const c = await R.readRemote(dataRoot, 'v9', creds);
		if (c.token !== 'ghp_old_plain') { throw new Error('迁移后读不到令牌'); }
		if (creds.store.get(R.credentialRefFor('v9')) !== 'ghp_old_plain') { throw new Error('没搬进凭据库'); }
		const file = readFileSync(path.join(dataRoot, 'kb-remotes.json'), 'utf8');
		if (file.includes('ghp_old_plain')) { throw new Error('文件里的明文没删 ✗'); }
	} finally { rmSync(base, { recursive: true, force: true }); }
});
check('端到端：目录当远端（无需服务器）→ 推送 → 拉取', async () => {
	const base = mkdtempSync(path.join(os.tmpdir(), 'kb-rem-e2e-'));
	const vault = path.join(base, 'vault'), bare = path.join(base, 'remote.git');
	mkdirSync(path.join(vault, '笔记'), { recursive: true });
	writeFileSync(path.join(vault, '笔记', 'a.md'), '# a\n\n第一版\n', 'utf8');
	try {
		if (!(await G.runGit(['init', '--bare', bare], base)).ok) { throw new Error('建裸仓库失败'); }
		if (!(await G.initRepo(vault)).ok) { throw new Error('init 失败'); }
		const cfg = { type: 'path', url: bare, branch: 'master' };
		if (!(await R.gitRemoteSet(vault, bare)).ok) { throw new Error('设置 remote 失败'); }
		const pu = await R.gitPush(vault, cfg);
		if (!pu.ok) { throw new Error('推送失败：' + (pu.error || '')); }
		const t = await R.gitRemoteTest(bare, 'path', '');
		if (!t.ok || !t.refs) { throw new Error('远端没有收到提交'); }
		const pl = await R.gitPull(vault, cfg);
		if (!pl.ok) { throw new Error('拉取失败：' + (pl.error || '')); }
	} finally { rmSync(base, { recursive: true, force: true }); }
});
check('本地有未提交改动时：拉取要拒绝（不许悄悄覆盖）', async () => {
	const base = mkdtempSync(path.join(os.tmpdir(), 'kb-rem-dirty-'));
	const vault = path.join(base, 'vault'), bare = path.join(base, 'r.git');
	mkdirSync(path.join(vault, '笔记'), { recursive: true });
	writeFileSync(path.join(vault, '笔记', 'a.md'), '# a\n', 'utf8');
	try {
		await G.runGit(['init', '--bare', bare], base);
		await G.initRepo(vault);
		await R.gitRemoteSet(vault, bare);
		await R.gitPush(vault, { type: 'path', url: bare, branch: 'master' });
		writeFileSync(path.join(vault, '笔记', 'a.md'), '# a\n\n未提交的改动\n', 'utf8');
		const pl = await R.gitPull(vault, { type: 'path', url: bare, branch: 'master' });
		if (pl.ok) { throw new Error('有未提交改动竟然允许拉取'); }
		if (!/未提交/.test(String(pl.error || ''))) { throw new Error('拒绝原因不对：' + pl.error); }
	} finally { rmSync(base, { recursive: true, force: true }); }
});

console.log('\n' + (failed.length ? `✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项` : `✓ 全部 ${pass} 项通过`));
if (failed.length) { process.exit(1); }
