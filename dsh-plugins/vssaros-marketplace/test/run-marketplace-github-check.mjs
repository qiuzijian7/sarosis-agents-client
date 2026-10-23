#!/usr/bin/env node
// @vssaros/dsh-marketplace — **GitHub 发布源**守卫（★ 2026-10-22 用户需求）
//
// 需求：「上传的技能 / agent / mcp / 工作台 本体是一个 GitHub 地址」⇒
//   商品不打包，只登记"从哪拿"，安装时按地址去取。
//
// 这套守卫钉三件事：
//   ① **地址归一化**：用户粘的各种 GitHub 形态（裸 owner/repo、tree、blob、archive、
//      releases/download）都要解析成服务端认的 `github-source` / `github-release`；
//   ② **安全边界**：只允许 https + GitHub 域（防 SSRF）、体积上限、超时报错；
//   ③ **安装根定位**：GitHub archive 顶层是 `<repo>-<ref>/`，而技能常埋在
//      `skills/<name>/SKILL.md` ⇒ 不定位就会"装了个空壳"（技能列表里啥也没有 ✗）。
//
// 跑法：node dsh-plugins/vssaros-marketplace/test/run-marketplace-github-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');
const importLib = (name) => import(pathToFileURL(path.join(LIB, name)).href);

const {
	parseGitHubSource, resolveDownloadUrl, locateInstallRoot, downloadGitHubTarball, isAllowedHost,
} = await importLib('githubSource.js');
const { packTarGzFromMap, listTarGzEntries } = await importLib('tar.js');
const { installBundle } = await importLib('installers.js');

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};
const thrown = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message ?? e); } };
const thrownAsync = async (fn) => { try { await fn(); return ''; } catch (e) { return String(e.message ?? e); } };

console.log('★ GitHub 作为发布源\n');

// ── ① 地址归一化 ────────────────────────────────────────────────
{
	const cases = [
		['Anthropic/skills', { type: 'github-source', name: 'Anthropic/skills' }],
		['https://github.com/o/r', { type: 'github-source', name: 'o/r' }],
		['https://github.com/o/r.git', { type: 'github-source', name: 'o/r' }],
		['https://github.com/o/r/tree/main', { type: 'github-source', name: 'o/r', commit: 'main' }],
		['https://github.com/o/r/tree/v1.2.3/skills/x', { type: 'github-source', name: 'o/r', commit: 'v1.2.3' }],
		['https://github.com/o/r/blob/main/skills/x/SKILL.md', { type: 'github-source', name: 'o/r', commit: 'main' }],
		['https://github.com/o/r/archive/refs/heads/main.tar.gz', { type: 'github-source', name: 'o/r', commit: 'main' }],
		['https://github.com/o/r/releases/download/v1.0.0/pkg.tar.gz',
			{ type: 'github-release', url: 'https://github.com/o/r/releases/download/v1.0.0/pkg.tar.gz' }],
		['https://codeload.github.com/o/r/tar.gz/v2', { type: 'github-source', name: 'o/r', commit: 'v2' }],
	];
	for (const [input, want] of cases) {
		let got;
		let err = '';
		try { got = parseGitHubSource(input); } catch (e) { err = String(e.message ?? e); }
		check(`① 解析 ${input}`, !err && JSON.stringify(got) === JSON.stringify(want), err || JSON.stringify(got));
	}

	// 拒绝：非 https / 非 GitHub 域 / 空 / 乱写
	const bad = [
		['http://github.com/o/r', 'http'],
		['https://evil.com/o/r', 'evil.com'],
		['ftp://github.com/o/r', 'ftp'],
		['', '空'],
		['随便一句话', '看不懂'],
	];
	for (const [input, tag] of bad) {
		const msg = thrown(() => parseGitHubSource(input));
		check(`① 拒绝 ${tag || input}`, msg.length > 0, msg ? '' : '(没报错!)');
	}
	check('① 白名单只认 GitHub 相关域', isAllowedHost('github.com') && isAllowedHost('codeload.github.com')
		&& !isAllowedHost('evil.com') && !isAllowedHost('127.0.0.1'));
}

// ── ② 发布源 → 下载地址 ─────────────────────────────────────────
{
	check('② github-source + 无 commit ⇒ codeload + HEAD',
		resolveDownloadUrl({ type: 'github-source', name: 'o/r' }) === 'https://codeload.github.com/o/r/tar.gz/HEAD');
	check('② github-source + commit ⇒ 带 ref',
		resolveDownloadUrl({ type: 'github-source', name: 'o/r', commit: 'v1.0.0' })
		=== 'https://codeload.github.com/o/r/tar.gz/v1.0.0');
	check('② github-release ⇒ 原直链',
		resolveDownloadUrl({ type: 'github-release', url: 'https://github.com/o/r/releases/download/v1/a.tar.gz' })
		=== 'https://github.com/o/r/releases/download/v1/a.tar.gz');

	const bad = [
		[{ type: 'github-source', name: 'not-a-repo' }, 'name 非 owner/repo'],
		[{ type: 'github-release', url: 'https://evil.com/a.tar.gz' }, '非 GitHub 域'],
		[{ type: 'github-release', url: 'http://github.com/a/b' }, '非 https'],
		[{ type: 'npm', name: 'x' }, 'npm 明确不支持'],
		[{ type: 'weird' }, '未知类型'],
	];
	for (const [dist, tag] of bad) {
		const msg = thrown(() => resolveDownloadUrl(dist));
		check(`② 拒绝 ${tag}`, msg.length > 0, msg ? '' : '(没报错!)');
	}
}

// ── ③ 安装根定位（不定位就会装个空壳）────────────────────────────
{
	const rootSkill = locateInstallRoot([
		{ path: 'SKILL.md', data: Buffer.from('x') },
		{ path: 'a/b.txt', data: Buffer.from('y') },
	], 'skill');
	check('③ 根目录就有 SKILL.md ⇒ 根 = ""', rootSkill.root === '' && rootSkill.files.length === 2);

	// GitHub archive 的典型形态：<repo>-<ref>/skills/name/SKILL.md
	const nested = locateInstallRoot([
		{ path: 'repo-main/README.md', data: Buffer.from('r') },
		{ path: 'repo-main/skills/demo/SKILL.md', data: Buffer.from('---\nname: d\n---\n') },
		{ path: 'repo-main/skills/demo/scripts/run.sh', data: Buffer.from('echo') },
	], 'skill');
	check('③ 嵌套 SKILL.md ⇒ 定位到 skills/demo 并剥掉前缀',
		nested.root === 'repo-main/skills/demo'
		&& nested.files.some(f => f.path === 'SKILL.md')
		&& nested.files.some(f => f.path === 'scripts/run.sh')
		&& !nested.files.some(f => f.path.includes('repo-main')),
		JSON.stringify({ root: nested.root, files: nested.files.map(f => f.path) }));

	check('③ workflow 认 workflow.json',
		locateInstallRoot([{ path: 'a/b/workflow.json', data: Buffer.from('{}') }], 'workflow').root === 'a/b');
	check('③ agent 认 .agent.md',
		locateInstallRoot([{ path: 'pack/x/.agent.md', data: Buffer.from('---\nname: a\n---\n') }], 'agent').root === 'pack/x');

	// 找不到 / 多个 都必须报错（不猜）
	const none = thrown(() => locateInstallRoot([{ path: 'README.md', data: Buffer.from('x') }], 'skill'));
	check('③ 找不到入口文件 ⇒ 报错（不装空壳）', none.includes('找不到'), none);
	const many = thrown(() => locateInstallRoot([
		{ path: 'a/SKILL.md', data: Buffer.from('x') },
		{ path: 'b/SKILL.md', data: Buffer.from('x') },
	], 'skill'));
	check('③ 多处入口 ⇒ 报错（不猜装哪个）', many.includes('多处'), many);
	check('③ 不认识的 kind ⇒ 报错', thrown(() => locateInstallRoot([], 'mcp')).length > 0);
}

// ── ④ 下载：安全边界 ────────────────────────────────────────────
{
	const okFetch = () => async () => ({
		ok: true, status: 200,
		headers: { get: () => '10' },
		arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
	});
	const buf = await downloadGitHubTarball('https://codeload.github.com/o/r/tar.gz/main', { fetchImpl: okFetch() });
	check('④ 正常下载返回 Buffer', Buffer.isBuffer(buf) && buf.length === 3);

	let msg = await thrownAsync(() => downloadGitHubTarball('https://evil.com/x.tar.gz', { fetchImpl: okFetch() }));
	check('④ 非白名单域 ⇒ 拒绝（防 SSRF）', msg.includes('不允许'), msg);

	msg = await thrownAsync(() => downloadGitHubTarball('http://github.com/o/r', { fetchImpl: okFetch() }));
	check('④ http ⇒ 拒绝', msg.includes('https'), msg);

	msg = await thrownAsync(() => downloadGitHubTarball('https://codeload.github.com/o/r/tar.gz/x', {
		fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => '' }),
	}));
	check('④ HTTP 404 ⇒ 报错带状态码', /404/.test(msg), msg);

	// Content-Length 超限 ⇒ 立刻拒（不下完再判）
	msg = await thrownAsync(() => downloadGitHubTarball('https://codeload.github.com/o/r/tar.gz/x', {
		maxBytes: 5,
		fetchImpl: async () => ({
			ok: true, status: 200, headers: { get: () => '9999' },
			arrayBuffer: async () => new Uint8Array([1]).buffer,
		}),
	}));
	check('④ Content-Length 超上限 ⇒ 立刻拒', msg.includes('太大'), msg);

	// 实际字节超限（服务端没给 content-length）
	msg = await thrownAsync(() => downloadGitHubTarball('https://codeload.github.com/o/r/tar.gz/x', {
		maxBytes: 2,
		fetchImpl: async () => ({
			ok: true, status: 200, headers: { get: () => null },
			arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
		}),
	}));
	check('④ 实际字节超上限 ⇒ 拒（不落盘）', msg.includes('太大'), msg);

	// 超时（abort）
	msg = await thrownAsync(() => downloadGitHubTarball('https://codeload.github.com/o/r/tar.gz/x', {
		timeoutMs: 30,
		fetchImpl: async (_url, init) => new Promise((_res, rej) => {
			init.signal.addEventListener('abort', () => {
				const err = new Error('aborted');
				err.name = 'AbortError';
				rej(err);
			});
		}),
	}));
	check('④ 超时 ⇒ 报"超时"而不是沉默挂住', msg.includes('超时'), msg);
}

// ── ④b 流式下载（★ 2026-10-23：边收边判 + 进度；老 fetch 只有 arrayBuffer 也要能用）──
{
	/** 造一个假的流式响应：把若干 chunk 依次吐出来，并记录是否被 cancel。 */
	const streamFetch = (chunks, { declared = null } = {}) => {
		const state = { cancelled: false, read: 0 };
		const fetchImpl = async () => ({
			ok: true, status: 200,
			headers: { get: () => declared },
			body: {
				getReader: () => ({
					read: async () => {
						if (state.cancelled || state.read >= chunks.length) { return { done: true, value: undefined }; }
						const value = chunks[state.read++];
						return { done: false, value: new Uint8Array(value) };
					},
					cancel: async () => { state.cancelled = true; },
				}),
			},
		});
		return { fetchImpl, state };
	};

	// ① 正常流式：两段拼起来字节对、进度单调、总数正确
	// ⚠ 必须自己兜住异常：若"流式分支"被删掉，这里的调用会抛（stub 没有 arrayBuffer）
	//   ⇒ 不兜的话整个测试进程直接崩，看起来像"没失败"（变异测试踩到过 ✗）。
	const progress = [];
	const ok = streamFetch([[1, 2], [3, 4, 5]]);
	let buf = Buffer.alloc(0);
	let streamErr = '';
	try {
		buf = await downloadGitHubTarball('https://codeload.github.com/o/r/tar.gz/main', {
			fetchImpl: ok.fetchImpl,
			onProgress: (received, total) => progress.push({ received, total }),
		});
	} catch (e) { streamErr = String(e && e.message || e); }
	check('④b 流式分支存在（有 body 流就走流式，不依赖 arrayBuffer）', !streamErr, streamErr);
	check('④b 流式：分段拼装字节正确', Buffer.isBuffer(buf) && buf.length === 5 && buf[4] === 5, `${buf.length}B`);
	check('④b 流式：进度回调单调递增且终值等于总长', progress.length === 2 && progress[0].received === 2 && progress[1].received === 5, JSON.stringify(progress));
	check('④b 流式：进度回调带上限值（给 UI 画进度条）', progress.every(p => p.total === 64 * 1024 * 1024), JSON.stringify(progress[0] || null));

	// ② 流式超限：第二段就超过上限 ⇒ 立刻中止 + cancel 连接（不继续收）
	const over = streamFetch([[1, 2, 3], [4, 5, 6]]);
	const overMsg = await thrownAsync(() => downloadGitHubTarball('https://codeload.github.com/o/r/tar.gz/x', {
		maxBytes: 4,
		fetchImpl: over.fetchImpl,
	}));
	check('④b 流式超限 ⇒ 报"太大"', overMsg.includes('太大'), overMsg);
	check('④b 流式超限 ⇒ 主动 cancel（不让服务端继续推）', over.state.cancelled === true, JSON.stringify(over.state));

	// ③ 回退：没有 body 流（老实现 / stub）仍走 arrayBuffer 并照常判上限
	const noStream = await downloadGitHubTarball('https://codeload.github.com/o/r/tar.gz/x', {
		fetchImpl: async () => ({
			ok: true, status: 200, headers: { get: () => null },
			arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer,
		}),
	});
	check('④b 无 body 流 ⇒ 回退 arrayBuffer（老运行时/测试 stub 兼容）', noStream.length === 3 && noStream[0] === 9, `${noStream.length}B`);
}

// ── ⑤ 与安装器串起来：GitHub 包 ⇒ 落盘（入口在嵌套目录也能装对）──
{
	const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-gh-'));
	// 模拟 GitHub archive：<repo>-<ref>/skills/demo/SKILL.md
	const gz = packTarGzFromMap({
		'repo-main/README.md': '# repo\n',
		'repo-main/skills/demo/SKILL.md': '---\nname: demo\n---\n\n正文\n',
		'repo-main/skills/demo/scripts/run.sh': 'echo hi\n',
	});
	const { files } = await listTarGzEntries(gz);
	const located = locateInstallRoot(files, 'skill');
	const res = await installBundle({
		dataRoot, kind: 'skill', storeId: 'gh-demo', version: '1.0.0',
		gzBuffer: packTarGzFromMap(Object.fromEntries(located.files.map(f => [f.path, f.data.toString('utf8')]))),
	});
	const skillMd = fs.readFileSync(path.join(res.targetDir, 'SKILL.md'), 'utf8');
	check('⑤ GitHub 形态的包能装到**正确目录**（不是整仓）',
		fs.existsSync(path.join(res.targetDir, 'scripts', 'run.sh')) && !fs.existsSync(path.join(res.targetDir, 'repo-main')),
		res.targetDir);
	check('⑤ 装完 frontmatter 仍回写 storeId/version',
		/^storeId: gh-demo$/m.test(skillMd) && /^version: 1\.0\.0$/m.test(skillMd));
	fs.rmSync(dataRoot, { recursive: true, force: true });
}

// ── ⑥ 发布外部源：只登记来源，不打包上传 ────────────────────────
{
	const { publishExternal } = await importLib('publisher.js');
	const calls = [];
	const fakeMarket = (createStatus = 200) => ({
		request: async (method, urlPath, body) => {
			calls.push({ method, urlPath, body });
			if (urlPath === '/packages' && createStatus === 409) {
				throw new Error('HTTP 409: slug "gh-skill" 已被占用');
			}
			return { ok: true };
		},
	});

	calls.length = 0;
	const r = await publishExternal({
		market: fakeMarket(),
		kind: 'skill',
		localId: 'gh-skill',
		version: '1.2.0',
		source: 'https://github.com/o/r/tree/main',
		changelog: '首个版本',
	});
	const createCall = calls.find(c => c.urlPath === '/packages');
	const extCall = calls.find(c => c.urlPath.endsWith('/versions/external'));
	check('⑥ 外部源发布：先建包（kind/slug/name）',
		Boolean(createCall) && createCall.body.kind === 'skill' && createCall.body.slug === 'gh-skill');
	check('⑥ 外部源发布：登记版本到 /versions/external',
		Boolean(extCall) && extCall.method === 'POST');
	check('⑥ distribution 已归一化（tree 地址 ⇒ github-source + commit）',
		extCall.body.distribution.type === 'github-source'
		&& extCall.body.distribution.name === 'o/r'
		&& extCall.body.distribution.commit === 'main',
		JSON.stringify(extCall.body.distribution));
	check('⑥ 版本与 changelog 一起提交', extCall.body.version === '1.2.0' && extCall.body.changelog === '首个版本');
	check('⑥ 不产生任何**上传**（本体不打包）', !calls.some(c => c.urlPath.includes('/versions/raw')));
	check('⑥ 返回值标明是 external', r.ok === true && r.external === true && r.created === true);

	// 包已存在（409）⇒ 容忍并继续登记版本
	calls.length = 0;
	const r2 = await publishExternal({
		market: fakeMarket(409), kind: 'skill', localId: 'gh-skill', version: '1.2.1', source: 'o/r',
	});
	check('⑥ 包已存在（409）⇒ 容忍，继续登记新版本',
		r2.created === false && calls.some(c => c.urlPath.endsWith('/versions/external')));

	// 拒绝：非法 slug / 空版本 / 非 GitHub 源
	let msg = await thrownAsync(() => publishExternal({ market: fakeMarket(), kind: 'skill', localId: 'Bad Slug', version: '1.0.0', source: 'o/r' }));
	check('⑥ 非法 slug ⇒ 拒绝', msg.includes('slug'), msg);
	msg = await thrownAsync(() => publishExternal({ market: fakeMarket(), kind: 'skill', localId: 'ok', version: '  ', source: 'o/r' }));
	check('⑥ 空白版本 ⇒ 拒绝', msg.includes('版本'), msg);
	msg = await thrownAsync(() => publishExternal({ market: fakeMarket(), kind: 'skill', localId: 'ok', version: '1.0.0', source: 'https://evil.com/o/r' }));
	check('⑥ 非 GitHub 源 ⇒ 拒绝（防 SSRF）', msg.includes('GitHub') || msg.includes('evil.com'), msg);

	// 所有 kind 都能登记外部源（服务端 external 不限类型）
	for (const kind of ['skill', 'agent', 'mcp', 'workbench', 'workflow', 'knowledge']) {
		calls.length = 0;
		const rr = await publishExternal({ market: fakeMarket(), kind, localId: `ext-${kind}`, version: '1.0.0', source: 'o/r' });
		check(`⑥ ${kind} 也能用 GitHub 源发布`, rr.ok === true && calls.some(c => c.urlPath.endsWith('/versions/external')));
	}
}

// ── ⑦ 外部源全链安装：distribution → 下载 → 定位根 → 落盘 ────────
{
	const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-ghinst-'));
	// 假 GitHub：返回 <repo>-<ref>/skills/demo/SKILL.md 形态的 tar.gz
	const archive = packTarGzFromMap({
		'repo-main/README.md': '# readme\n',
		'repo-main/skills/demo/SKILL.md': '---\nname: demo\n---\n\n正文\n',
	});
	const url = resolveDownloadUrl({ type: 'github-source', name: 'o/r', commit: 'main' });
	check('⑦ github-source ⇒ codeload tar.gz 地址', url === 'https://codeload.github.com/o/r/tar.gz/main', url);

	const gz = await downloadGitHubTarball(url, {
		fetchImpl: async (u) => ({
			ok: true, status: 200,
			headers: { get: () => null },
			arrayBuffer: async () => gzBufferToArrayBuffer(archive),
			__url: u,
		}),
	});
	const { files } = await listTarGzEntries(gz);
	const located = locateInstallRoot(files, 'skill');
	const res = await installBundle({
		dataRoot, kind: 'skill', storeId: 'ext-demo', version: '2.0.0',
		files: located.files,
	});
	check('⑦ 全链：下载 → 定位根 → 落盘到 skills/ext-demo',
		fs.existsSync(path.join(res.targetDir, 'SKILL.md'))
		&& !fs.existsSync(path.join(res.targetDir, 'repo-main')),
		res.targetDir);
	check('⑦ 装完仍会回写 storeId/version（升级溯源）',
		/^storeId: ext-demo$/m.test(fs.readFileSync(path.join(res.targetDir, 'SKILL.md'), 'utf8')));
	fs.rmSync(dataRoot, { recursive: true, force: true });
}

/** Buffer → ArrayBuffer（模拟 fetch 的 arrayBuffer()）。 */
function gzBufferToArrayBuffer(buf) {
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ── ⑧ 接线：Host 安装时**必须按 distribution 分流**，发布时支持 source ──
//   源码级断言（不绑具体行）：这两条接线一旦断，功能会"看起来有、点了没反应"✗
{
	const idxSrc = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
	check('⑧ 安装按版本级 manifest.distribution 分流（外部源走 GitHub）',
		/manifest\?\.distribution/.test(idxSrc) && idxSrc.includes('installFromExternal'));
	check('⑧ 外部源安装 = 解析地址 → 下载 → 定位根 → installBundle',
		idxSrc.includes('resolveDownloadUrl') && idxSrc.includes('downloadGitHubTarball')
		&& idxSrc.includes('locateInstallRoot'));
	check('⑧ 发布支持 source（登记外部源，不打包上传）',
		/params\.source/.test(idxSrc) && idxSrc.includes('publishExternal'));
	check('⑧ 外部源模块在 files 白名单里（否则装出去的插件缺模块）', (() => {
		const pkg = JSON.parse(fs.readFileSync(path.join(LIB, '..', 'package.json'), 'utf8'));
		return Array.isArray(pkg.files) && pkg.files.includes('lib/githubSource.js');
	})());
	check('⑧ 页面有「GitHub 地址」来源切换', (() => {
		const page = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
		return page.includes('GitHub 地址') && /mode:\s*'github'/.test(page);
	})());
}

console.log(`\n[marketplace github] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
