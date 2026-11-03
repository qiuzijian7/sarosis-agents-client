// @vssaros/dsh-agents — 工作区记忆（2026-11-02 落地 / 2026-11-03 P2）
//   跑法：node dsh-plugins/vssaros-agents/test/workspace-memory.test.mjs
//
// 钉住的是"出过事 / 最容易被改坏"的几条，不是把实现再抄一遍：
//   ① 作用域 id `ws.<12hex>` 与 agent id 互不相交，目录只由 key 决定（防路径穿越）
//   ② 同一仓库的子目录会话 / 8.3 短名 / 大小写差异 ⇒ 同一个 key（否则同一仓库记忆会分裂）
//   ③ 注入端与写入端都要拆 `{{ }}`（未注册模板变量会让整个会话装配失败）
//   ④ scope.json 内容不变就不重写（否则记忆仓库的工作树永远是脏的）
//   ⑤ `gitStatusOf` 的 dirtyFiles 不能少首字符（porcelain 首行前导空格被 trim 吃掉的老 bug）
//   ⑥ 回合末自动提交：偏好 > config > 缺省；偏好立刻生效
//   ⑦ 认领：只在同 remote + 旧根不存在时列出；复制不是移动；已有记忆不覆盖
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoCommitAfterTurn, ensureMemoryRepo, gitStatusOf, memoryAutoCommitOnTurn, memoryDirOf } from '../lib/memory.js';
import { setMemoryPrefs } from '../lib/memoryPrefs.js';
import {
	addEntryForCwd, removeEntryForCwd,
	claimWorkspaceMemory, findClaimableMemories, isWorkspaceScope, keyOfScopeId, resolveWorkspace, scopeIdOfKey,
	workspaceEntryAction, workspaceMemoryDirOf, workspaceMemoryView, workspaceSnapshotText, writeWorkspaceMemory,
} from '../lib/workspaceMemory.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

const root = mkdtempSync(join(tmpdir(), 'vssaros-wsmem-'));
const dataRoot = join(root, 'data');
const config = { dataRoot, agentsRoot: join(root, 'agents') };
const makeRepo = (name, remote) => {
	const dir = join(root, 'repos', name);
	mkdirSync(dir, { recursive: true });
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
	if (remote) { execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir }); }
	return dir;
};

try {
	// ① 作用域 id
	check('★ 作用域 id 只认 ws.<恰好 12 位十六进制>', () => {
		assert.equal(isWorkspaceScope('ws.0123456789ab'), true);
		for (const bad of ['ws.0123456789a', 'ws.0123456789abc', 'ws.0123456789AB', 'ws-0123456789ab', 'my-bot', 'ws.', '../ws.0123456789ab', '']) {
			assert.equal(isWorkspaceScope(bad), false, `不该认：${bad}`);
		}
		assert.equal(keyOfScopeId('ws.0123456789ab'), '0123456789ab');
		assert.equal(keyOfScopeId('my-bot'), '');
	});
	check('★ memoryDirOf：ws 作用域落 <数据根>/workspace-memory/<key>；agent 路径不受影响', () => {
		assert.equal(memoryDirOf(config, 'ws.0123456789ab'), join(dataRoot, 'workspace-memory', '0123456789ab'));
		assert.equal(memoryDirOf(config, 'some-builtin'), join(dataRoot, 'agent-memory', 'some-builtin'));
	});
	check('非法 key 抛 400（防路径穿越）', () => {
		for (const bad of ['../evil', '0123456789a', 'ZZZZZZZZZZZZ', '']) {
			assert.throws(() => workspaceMemoryDirOf(config, bad), (e) => e.httpStatus === 400, bad);
		}
	});

	// ② 身份：子目录会话归到 git 根；短名 / 长名同一个 key
	const repoA = makeRepo('A', 'https://example.com/team/proj.git');
	mkdirSync(join(repoA, 'src', 'deep'), { recursive: true });
	const wsA = resolveWorkspace(repoA);
	check('★ 子目录会话与仓库根同一个 key', () => {
		const sub = resolveWorkspace(join(repoA, 'src', 'deep'));
		assert.equal(sub.key, wsA.key);
		assert.equal(sub.isGit, true);
	});
	check('★ Windows 8.3 短名与长名同一个 key（否则同一仓库分裂成两份记忆）', () => {
		const long = realpathSync.native(repoA);
		assert.equal(resolveWorkspace(long).key, wsA.key);
		assert.equal(resolveWorkspace(repoA).key, wsA.key);
	});
	check('非绝对路径 / 不存在的目录 ⇒ null（不猜）', () => {
		assert.equal(resolveWorkspace('relative/dir'), null);
		assert.equal(resolveWorkspace(join(root, 'no-such-dir')), null);
		assert.equal(resolveWorkspace(''), null);
	});

	// ③ 花括号
	check('★ 写入与注入两端都拆 {{ }}', () => {
		workspaceEntryAction(config, wsA, { action: 'add', content: '变量写法 {{session}} 原样记' });
		const view = workspaceMemoryView(config, wsA);
		assert.ok(!/\{\{|\}\}/.test(view.text), '落盘文本里不能有原始双花括号');
		const { text } = workspaceSnapshotText(config, wsA);
		assert.ok(text.includes('{ {session} }') && !/\{\{|\}\}/.test(text), '注入文本里不能有原始双花括号');
		writeWorkspaceMemory(config, wsA, '- 手写 {{x}} 也要拆\n');
		assert.ok(!/\{\{/.test(workspaceMemoryView(config, wsA).text), '整篇写入同样要拆');
		workspaceEntryAction(config, wsA, { action: 'replace', match: '手写', content: '变量写法 {{session}}' });
		workspaceEntryAction(config, wsA, { action: 'add', content: '端口是 8080' });
	});

	// ④⑤ Git 化、scope.json 稳定、dirtyFiles 不缺字
	const idA = scopeIdOfKey(wsA.key);
	await checkAsync('ensureMemoryRepo 对 ws 作用域生效，初始提交带上已有内容', async () => {
		const r = await ensureMemoryRepo(config, idA);
		assert.equal(r.ok, true);
		const st = await gitStatusOf(config, idA);
		assert.equal(st.enabled, true);
		assert.ok(st.commits >= 1);
		assert.ok(readFileSync(join(st.dir, 'MEMORY.md'), 'utf8').includes('8080'), '已有内容不能被模板覆盖');
	});
	await checkAsync('★ scope.json 内容不变就不重写：反复 add 后工作树里只有 MEMORY.md 是脏的', async () => {
		workspaceEntryAction(config, wsA, { action: 'add', content: '第二条' });
		workspaceEntryAction(config, wsA, { action: 'add', content: '第三条' });
		const st = await gitStatusOf(config, idA);
		assert.deepEqual(st.dirtyFiles, ['MEMORY.md']);
	});
	await checkAsync('★ dirtyFiles 首个文件名不缺首字符（porcelain 前导空格被 trim 的老 bug）', async () => {
		const st = await gitStatusOf(config, idA);
		assert.equal(st.changes[0].path, 'MEMORY.md');
		assert.equal(st.changes[0].kind, 'updated');
	});

	// ⑥ 自动提交偏好
	await checkAsync('★ 自动提交：缺省开 → 偏好关立刻生效 → config 被偏好覆盖', async () => {
		assert.equal(memoryAutoCommitOnTurn(config), true);
		assert.equal((await autoCommitAfterTurn(config, idA)).committed, true);
		assert.equal((await gitStatusOf(config, idA)).dirty, 0);
		setMemoryPrefs(config, { autoCommit: false });
		assert.equal(memoryAutoCommitOnTurn(config), false, '偏好关 ⇒ 无需重启立刻生效');
		workspaceEntryAction(config, wsA, { action: 'add', content: '关着时的改动' });
		const r = await autoCommitAfterTurn(config, idA);
		assert.equal(r.committed, false);
		assert.equal((await gitStatusOf(config, idA)).dirty, 1, '改动留在工作区');
		assert.equal(memoryAutoCommitOnTurn({ ...config, memoryAutoCommit: true }), false, '偏好优先于 config');
		setMemoryPrefs(config, { autoCommit: true });
		assert.equal(memoryAutoCommitOnTurn({ ...config, memoryAutoCommit: false }), true, '偏好 true 也能覆盖 config:false');
		assert.throws(() => setMemoryPrefs(config, { autoCommit: 'yes' }), (e) => e.httpStatus === 400);
	});

	// ⑦ 认领
	await checkAsync('★ 认领：同 remote（忽略 .git 后缀）+ 旧根不存在才列；复制不是移动；已有记忆不覆盖', async () => {
		const oldKey = wsA.key;
		rmSync(repoA, { recursive: true, force: true });
		const wsB = resolveWorkspace(makeRepo('B-moved', 'https://example.com/team/proj'));
		assert.notEqual(wsB.key, oldKey);
		assert.deepEqual(findClaimableMemories(config, wsB).map((c) => c.key), [oldKey]);
		assert.deepEqual(findClaimableMemories(config, resolveWorkspace(makeRepo('C', 'https://example.com/other/repo.git'))), [], '不同 remote 不列');
		assert.deepEqual(findClaimableMemories(config, resolveWorkspace(makeRepo('D', ''))), [], '没有 remote 不猜');
		assert.throws(() => claimWorkspaceMemory(config, wsB, '../etc'), (e) => e.httpStatus === 400);
		assert.throws(() => claimWorkspaceMemory(config, wsB, 'ffffffffffff'), (e) => e.httpStatus === 400);
		claimWorkspaceMemory(config, wsB, oldKey);
		const viewB = workspaceMemoryView(config, wsB);
		assert.ok(viewB.text.includes('8080') && viewB.text.includes('关着时的改动'));
		assert.equal(viewB.scope.claimedFrom, oldKey);
		assert.ok(existsSync(join(workspaceMemoryDirOf(config, oldKey), 'MEMORY.md')), '旧记忆不能被删');
		assert.equal(JSON.parse(readFileSync(join(workspaceMemoryDirOf(config, oldKey), 'scope.json'), 'utf8')).claimedBy, wsB.key);
		assert.equal((await gitStatusOf(config, scopeIdOfKey(wsB.key))).enabled, true, 'Git 历史随认领带过来');
		assert.throws(() => claimWorkspaceMemory(config, wsB, oldKey), (e) => e.httpStatus === 400, '已有记忆不能再认领');
		assert.deepEqual(findClaimableMemories(config, resolveWorkspace(makeRepo('E', 'https://example.com/team/proj.git'))), [], '已被认领的不再出现');
	});
	// ⑨ ensureMemoryRepo 的缓存 / 合并 / 后台补标签（P3 性能）
	await checkAsync('★ ensure：已就绪的重复调用走缓存；.git 被删则重建；并发合并成一个任务；deferTag 先返回后补标签', async () => {
		const { __resetEnsureCache, listVersions: lv } = await import('../lib/memory.js').then(async (m) => ({ __resetEnsureCache: m.__resetEnsureCache, listVersions: m.listVersions }));
		__resetEnsureCache();
		const ws = resolveWorkspace(makeRepo('ens-1', ''));
		const id = scopeIdOfKey(ws.key);
		workspaceEntryAction(config, ws, { action: 'add', content: '缓存测试' });

		// deferTag：返回时仓库已可用，但初始标签可能还没打；稍后补上
		const first = await ensureMemoryRepo(config, id, { deferTag: true });
		assert.equal(first.ok, true);
		assert.equal(first.git, 'initialized');
		assert.equal((await gitStatusOf(config, id)).enabled, true, 'core 返回时 Git 已启用');
		const tagged = await ensureMemoryRepo(config, id); // 与后台任务合并，等到标签补完
		for (let i = 0; i < 50 && !(await lv(config, id)).versions.length; i += 1) { await new Promise((r) => setTimeout(r, 200)); }
		assert.deepEqual((await lv(config, id)).versions.map((v) => v.tag), ['v0'], '后台补上了初始标签');
		assert.ok(tagged.ok);

		// 已就绪 ⇒ 缓存命中（不再跑 git）
		const t0 = Date.now();
		const again = await ensureMemoryRepo(config, id);
		assert.equal(again.cached, true, '第二次应命中缓存');
		assert.ok(Date.now() - t0 < 100, '缓存命中应近乎瞬时：' + (Date.now() - t0) + 'ms');

		// 缓存命中前仍校验：.git 被删 ⇒ 重建，不是假装还在
		rmSync(join(workspaceMemoryDirOf(config, ws.key), '.git'), { recursive: true, force: true });
		const rebuilt = await ensureMemoryRepo(config, id);
		assert.notEqual(rebuilt.cached, true);
		assert.equal((await gitStatusOf(config, id)).enabled, true, '.git 被删后会重新建立');
		assert.ok(readFileSync(join(workspaceMemoryDirOf(config, ws.key), 'MEMORY.md'), 'utf8').includes('缓存测试'), '重建不能丢内容');

		// 并发合并：两个同时进来的调用拿到同一个结果，且不会因 git init 互踩而抛
		__resetEnsureCache();
		const ws2 = resolveWorkspace(makeRepo('ens-2', ''));
		const id2 = scopeIdOfKey(ws2.key);
		workspaceEntryAction(config, ws2, { action: 'add', content: '并发' });
		const [a, b] = await Promise.all([ensureMemoryRepo(config, id2), ensureMemoryRepo(config, id2)]);
		assert.equal(a.ok && b.ok, true);
		assert.equal(a.created, b.created, '合并成同一个任务 ⇒ 结果一致');
		assert.equal((await lv(config, id2)).versions.length, 1, '只打了一个初始标签');
	});

	// ⑩ 给其它插件用的入口（记忆库的草稿提升 / 撤销）
	check('★ addEntryForCwd / removeEntryForCwd：写、去重、撤销、找不到、无效目录', () => {
		const repo = makeRepo('api-1', '');
		const added = addEntryForCwd(config, repo, '以后所有接口都用 camelCase 命名');
		assert.equal(added.ok, true, added.message);
		assert.equal(added.duplicate, false);
		assert.ok(added.workspace && /^[0-9a-f]{12}$/.test(added.workspace.key), '返回 12 位 key');
		assert.ok(workspaceMemoryView(config, resolveWorkspace(repo)).text.includes('camelCase'), '真的写进了该工作区的 MEMORY.md');

		const dup = addEntryForCwd(config, repo, '以后所有接口都用 camelCase 命名');
		assert.equal(dup.ok, true);
		assert.equal(dup.duplicate, true, '重复 ⇒ ok + duplicate，不重复写入');

		// 子目录 cwd 归到同一个 git 根（草稿记的是会话 cwd，常常是子目录）
		mkdirSync(join(repo, 'src'), { recursive: true });
		assert.equal(addEntryForCwd(config, join(repo, 'src'), '以后所有接口都用 camelCase 命名').duplicate, true);

		const gone = removeEntryForCwd(config, repo, '以后所有接口都用 camelCase 命名');
		assert.equal(gone.ok, true, gone.message);
		assert.ok(!workspaceMemoryView(config, resolveWorkspace(repo)).text.includes('camelCase'));
		const again = removeEntryForCwd(config, repo, '以后所有接口都用 camelCase 命名');
		assert.equal(again.ok, false);
		assert.equal(again.notFound, true, '已不在 ⇒ notFound（调用方视为目标已达成）');

		for (const bad of ['', 'relative/dir', join(root, 'no-such-dir')]) {
			assert.equal(addEntryForCwd(config, bad, 'x 这是一句足够长的约定内容').ok, false, `无效目录：${bad}`);
			assert.equal(removeEntryForCwd(config, bad, 'x').ok, false);
		}
	});
	check('addEntryForCwd 同样拒绝提示注入 / 超长，且拆花括号', () => {
		const repo = makeRepo('api-2', '');
		assert.equal(addEntryForCwd(config, repo, 'x'.repeat(401)).ok, false, '超过单条上限');
		const braces = addEntryForCwd(config, repo, '变量写法 {{session}} 要原样记');
		assert.equal(braces.ok, true);
		assert.ok(!/\{\{/.test(workspaceMemoryView(config, resolveWorkspace(repo)).text), '写入端拆 {{ }}');
	});

	// ⑧ remote 读取：worktree / submodule 的 `.git` 是文件，要顺着 gitdir / commondir 找配置
	check('★ git worktree（.git 是文件）也能读到主仓库的 origin', () => {
		const main = makeRepo('wt-main', 'https://example.com/wt/proj.git');
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: main });
		const wtDir = join(root, 'repos', 'wt-linked');
		execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', wtDir], { cwd: main });
		assert.ok(statSync(join(wtDir, '.git')).isFile(), '前提：worktree 的 .git 应是文件');
		const ws = resolveWorkspace(wtDir);
		assert.equal(ws.isGit, true);
		assert.equal(ws.remote, 'https://example.com/wt/proj.git');
	});
	check('★ git submodule（.git 是文件）读到的是子模块自己的 origin，不是上级的', () => {
		const sub = makeRepo('sm-lib', 'https://example.com/sm/lib.git');
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: sub });
		const sup = makeRepo('sm-super', 'https://example.com/sm/super.git');
		execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.name=t', '-c', 'user.email=t@t', 'submodule', 'add', '-q', sub, 'vendor/lib'], { cwd: sup });
		const smDir = join(sup, 'vendor', 'lib');
		assert.ok(statSync(join(smDir, '.git')).isFile(), '前提：submodule 的 .git 应是文件');
		const ws = resolveWorkspace(smDir);
		assert.equal(ws.isGit, true);
		assert.equal(ws.root.toLowerCase(), realpathSync.native(smDir).toLowerCase(), '子模块自成一个工作区（不归到上级）');
		assert.ok(ws.remote && !ws.remote.includes('super.git'), '不能读成上级仓库的 origin：' + ws.remote);
	});
	check('.git 文件损坏 / gitdir 指向不存在 ⇒ remote 为空，不抛', () => {
		const bad = join(root, 'repos', 'bad-gitfile');
		mkdirSync(bad, { recursive: true });
		writeFileSync(join(bad, '.git'), 'gitdir: ../no-such-gitdir\n');
		const ws = resolveWorkspace(bad);
		assert.equal(ws.isGit, true);
		assert.equal(ws.remote, '');
	});
} finally {
	rmSync(root, { recursive: true, force: true });
}

if (fails.length) {
	console.error(`[workspace-memory] ${pass} passing / ${fails.length} failing`);
	for (const f of fails) { console.error(`  ✗ ${f}`); }
	process.exit(1);
}
console.log(`[workspace-memory] ${pass} passing / 0 failing`);
