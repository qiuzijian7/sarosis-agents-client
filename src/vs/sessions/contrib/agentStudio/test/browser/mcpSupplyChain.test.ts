/*---------------------------------------------------------------------------------------------
 *  MCP 供应链预检（OSV 恶意包）单元测试 —— 2026-09-24
 *
 *  为什么值得单独测：这条链路会在「安装并**执行**第三方包」之前做一次网络判断，
 *  出错的两个方向都很糟：
 *   · 误拦（把正常包判成恶意）⇒ 用户装不上 MCP，且看不懂为什么；
 *   · 漏拦 / 把失败当成功缓存 ⇒ 给出"看起来安全"的假象（比没有检查更坏）。
 *  故逐条钉住：包名抽取的边界、只认 MAL-*、失败 fail-open **且不缓存**、缓存命中不打网络。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/mcpSupplyChain.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import {
	normalizePackageName, tokenizeCommand, extractPackagesFromStdioCommand, extractPackagesFromInstallCommand,
	extractPackagesFromInstallCommands, parseOsvQueryBatch, checkPackagesAgainstOsv, checkInstallCommandsAgainstOsv,
	checkStdioCommandAgainstOsv, buildOsvBlockedMessage, clearOsvCache, osvCacheSize, OSV_CACHE_TTL_MS,
	type IOsvPackageRef, type OsvFetch,
} from '../../browser/mcpSupplyChain.js';

/** 构造一个假 fetch（记录请求体，按需返回响应或抛错）。 */
function makeFetch(behaviour: { status?: number; payload?: unknown; throwErr?: string }) {
	const calls: Array<{ url: string; body: string }> = [];
	const fetchImpl: OsvFetch = async (url, init) => {
		calls.push({ url, body: init.body });
		if (behaviour.throwErr) { throw new Error(behaviour.throwErr); }
		const status = behaviour.status ?? 200;
		return { ok: status >= 200 && status < 300, status, json: async () => behaviour.payload ?? {} };
	};
	return { fetchImpl, calls };
}

/** 从查询体里取出查了哪些包。 */
function queriedNames(body: string): string[] {
	const parsed = JSON.parse(body) as { queries: Array<{ package: { name: string; ecosystem: string } }> };
	return parsed.queries.map(q => `${q.package.ecosystem}:${q.package.name}`);
}

suite('MCP 供应链 · 包名抽取（纯函数）', () => {

	test('tokenizeCommand：尊重引号（`pip install "a>=1"` 的版本约束不能被拆开）', () => {
		assert.deepStrictEqual(tokenizeCommand('pip install "comfy-cli>=1.14.0"'), ['pip', 'install', 'comfy-cli>=1.14.0']);
		assert.deepStrictEqual(tokenizeCommand('  npx   -y   pkg  '), ['npx', '-y', 'pkg']);
		assert.deepStrictEqual(tokenizeCommand("pip install 'a'"), ['pip', 'install', 'a']);
	});

	test('normalizePackageName：剥版本/extras/环境标记；scoped 包保留 @scope/name', () => {
		assert.strictEqual(normalizePackageName('comfy-cli>=1.14.0'), 'comfy-cli');
		assert.strictEqual(normalizePackageName('pkg==1.2.3'), 'pkg');
		assert.strictEqual(normalizePackageName('@modelcontextprotocol/server-filesystem@latest'), '@modelcontextprotocol/server-filesystem');
		assert.strictEqual(normalizePackageName('pkg[extra]'), 'pkg');
		assert.strictEqual(normalizePackageName('pkg ; python_version<"3.9"'), 'pkg');
	});

	test('★★ 非注册表来源一律返回 undefined（宁可漏报，不误拦本地路径/git 源）', () => {
		for (const raw of ['./local-server', '../x', '/abs/pkg', 'file:///tmp/pkg', 'git+https://a/b.git', 'a:b', 'pkg*']) {
			assert.strictEqual(normalizePackageName(raw), undefined, `${raw} 不该被当成注册表包`);
		}
		assert.strictEqual(normalizePackageName(''), undefined);
	});

	test('★ stdio 定义抽取：npx/npm exec/pnpm dlx/bunx → npm；uvx/pipx run/uv tool run → PyPI', () => {
		const cases: Array<[string, string[], string[]]> = [
			['npx', ['-y', '@modelcontextprotocol/server-filesystem'], ['npm:@modelcontextprotocol/server-filesystem']],
			['npx', ['-y', '--package=figma-developer-mcp', 'npm-run-all'], ['npm:figma-developer-mcp', 'npm:npm-run-all']],
			['npx', ['-p', 'pkg-a', 'pkg-b'], ['npm:pkg-a', 'npm:pkg-b']],
			['npm', ['exec', 'pkg-c'], ['npm:pkg-c']],
			['pnpm', ['dlx', 'pkg-d'], ['npm:pkg-d']],
			['bunx', ['pkg-e'], ['npm:pkg-e']],
			['uvx', ['mcp-server-time'], ['PyPI:mcp-server-time']],
			['uv', ['tool', 'run', 'pkg-f'], ['PyPI:pkg-f']],
			['pipx', ['run', 'pkg-g'], ['PyPI:pkg-g']],
			['pip', ['install', 'comfy-mcp'], ['PyPI:comfy-mcp']],
			['python', ['-m', 'pip', 'install', 'pkg-h'], ['PyPI:pkg-h']],
		];
		for (const [command, args, expected] of cases) {
			const refs = extractPackagesFromStdioCommand(command, args);
			assert.deepStrictEqual(refs.map(r => `${r.ecosystem}:${r.name}`), expected,
				`${command} ${args.join(' ')}`);
		}
	});

	test('★ 原生二进制 / 脚本型命令不查（自有 server、npm run 等）', () => {
		assert.deepStrictEqual(extractPackagesFromStdioCommand('comfy-mcp', []), []);
		assert.deepStrictEqual(extractPackagesFromStdioCommand('codex', ['mcp-server']), []);
		assert.deepStrictEqual(extractPackagesFromStdioCommand('npm', ['run', 'dev']), []);
		assert.deepStrictEqual(extractPackagesFromStdioCommand(undefined, undefined), []);
	});

	test('★ 安装命令抽取（带绝对路径的 pip / npm -g / 引号版本约束）', () => {
		assert.deepStrictEqual(
			extractPackagesFromInstallCommand('C:\\Python\\Scripts\\pip.exe install "comfy-cli>=1.14.0"').map(r => r.name),
			['comfy-cli']);
		assert.deepStrictEqual(extractPackagesFromInstallCommand('npm i -g some-mcp').map(r => r.name), ['some-mcp']);
		assert.deepStrictEqual(extractPackagesFromInstallCommand('git checkout main'), []);
	});

	test('批量安装命令：合并去重', () => {
		const refs = extractPackagesFromInstallCommands(['pip install a', 'pip install a', 'pip install b']);
		assert.deepStrictEqual(refs.map(r => r.name), ['a', 'b']);
	});
});

suite('MCP 供应链 · OSV 响应解析与判定', () => {

	test('★★ 只认 MAL-*：普通 CVE 不得成为阻断理由', () => {
		const refs: IOsvPackageRef[] = [{ name: 'a', ecosystem: 'npm' }, { name: 'b', ecosystem: 'PyPI' }, { name: 'c', ecosystem: 'npm' }];
		const hits = parseOsvQueryBatch({
			results: [
				{ vulns: [{ id: 'CVE-2024-0001' }] },                                   // 普通漏洞 ⇒ 忽略
				{ vulns: [{ id: 'GHSA-x', aliases: ['MAL-2024-1234'] }] },               // 别名命中恶意 ⇒ 拦
				{ vulns: [{ id: 'mal-2025-9' }] },                                       // 大小写不敏感 ⇒ 拦
			],
		}, refs);
		assert.deepStrictEqual(hits.map(h => h.name), ['b', 'c']);
		assert.deepStrictEqual(hits[0].ids, ['MAL-2024-1234']);
	});

	test('形状异常（错误页/空体）⇒ 视为无命中（fail-open，绝不误拦）', () => {
		const refs: IOsvPackageRef[] = [{ name: 'a', ecosystem: 'npm' }];
		assert.deepStrictEqual(parseOsvQueryBatch(undefined, refs), []);
		assert.deepStrictEqual(parseOsvQueryBatch({ results: 'oops' }, refs), []);
		assert.deepStrictEqual(parseOsvQueryBatch({ results: [{}] }, refs), []);
	});
});

suite('MCP 供应链 · 查询与缓存', () => {

	setup(() => clearOsvCache());

	test('空输入 ⇒ clean 且不发请求（自有二进制不该打网络）', async () => {
		const { fetchImpl, calls } = makeFetch({});
		const v = await checkPackagesAgainstOsv([], { fetchImpl });
		assert.strictEqual(v.status, 'clean');
		assert.strictEqual(calls.length, 0);
	});

	test('★★ 命中恶意包 ⇒ blocked（附公告 id，供用户自查）', async () => {
		const { fetchImpl } = makeFetch({ payload: { results: [{ vulns: [{ id: 'MAL-2026-1' }] }] } });
		const v = await checkStdioCommandAgainstOsv('npx', ['-y', 'evil-pkg'], { fetchImpl });
		assert.strictEqual(v.status, 'blocked');
		assert.deepStrictEqual(v.hits.map(h => `${h.ecosystem}:${h.name}:${h.ids.join(',')}`), ['npm:evil-pkg:MAL-2026-1']);
		assert.match(buildOsvBlockedMessage(v), /evil-pkg/);
		assert.match(buildOsvBlockedMessage(v), /osv\.dev/);
	});

	test('★★ 网络失败 ⇒ unknown（fail-open）且**不写缓存**：下次仍会重试', async () => {
		const failing = makeFetch({ throwErr: 'network down' });
		const warns: string[] = [];
		const v1 = await checkPackagesAgainstOsv([{ name: 'pkg', ecosystem: 'npm' }], { fetchImpl: failing.fetchImpl, warn: m => warns.push(m) });
		assert.strictEqual(v1.status, 'unknown');
		assert.match(String(v1.reason), /network down/);
		assert.strictEqual(osvCacheSize(), 0, '失败绝不能被缓存（否则成"看起来已验证"）');
		assert.strictEqual(warns.length, 1, '失败要留 warn 供排查');

		// 重试（这次通了）⇒ 必须真的再发请求
		const ok = makeFetch({ payload: { results: [{}] } });
		const v2 = await checkPackagesAgainstOsv([{ name: 'pkg', ecosystem: 'npm' }], { fetchImpl: ok.fetchImpl });
		assert.strictEqual(v2.status, 'clean');
		assert.strictEqual(ok.calls.length, 1, '失败后不得残留缓存 ⇒ 必须重新查询');
	});

	test('★ HTTP 非 2xx ⇒ unknown（不当成 clean）', async () => {
		const { fetchImpl } = makeFetch({ status: 502, payload: {} });
		const v = await checkPackagesAgainstOsv([{ name: 'pkg', ecosystem: 'npm' }], { fetchImpl });
		assert.strictEqual(v.status, 'unknown');
		assert.match(String(v.reason), /HTTP 502/);
	});

	test('★★ 成功后写缓存：TTL 内不重复打网络；到期后重新查询', async () => {
		const first = makeFetch({ payload: { results: [{}] } });
		let now = 0;
		const opts = { fetchImpl: first.fetchImpl, now: () => now };
		await checkPackagesAgainstOsv([{ name: 'cached-pkg', ecosystem: 'npm' }], opts);
		await checkPackagesAgainstOsv([{ name: 'cached-pkg', ecosystem: 'npm' }], opts);
		assert.strictEqual(first.calls.length, 1, 'TTL 内应命中缓存');

		now = OSV_CACHE_TTL_MS;   // 到期
		const second = makeFetch({ payload: { results: [{}] } });
		await checkPackagesAgainstOsv([{ name: 'cached-pkg', ecosystem: 'npm' }], { fetchImpl: second.fetchImpl, now: () => now });
		assert.strictEqual(second.calls.length, 1, '到期必须重查');
	});

	test('★ 恶意结论同样进缓存（TTL 内不重复打网络，仍返回 blocked）', async () => {
		const first = makeFetch({ payload: { results: [{ vulns: [{ id: 'MAL-1' }] }] } });
		let now = 0;
		const opts = { fetchImpl: first.fetchImpl, now: () => now };
		assert.strictEqual((await checkPackagesAgainstOsv([{ name: 'bad', ecosystem: 'npm' }], opts)).status, 'blocked');
		assert.strictEqual((await checkPackagesAgainstOsv([{ name: 'bad', ecosystem: 'npm' }], opts)).status, 'blocked');
		assert.strictEqual(first.calls.length, 1);
	});

	test('★ batch 查询：一次请求查多个包，且查询体只带包名（不带版本 —— 避免"当时安全"的假象）', async () => {
		const { fetchImpl, calls } = makeFetch({ payload: { results: [{}, {}] } });
		await checkInstallCommandsAgainstOsv(['pip install a>=1.0', 'npx -y b@2.3.4'], { fetchImpl });
		assert.strictEqual(calls.length, 1, '应合并为一次 batch');
		assert.deepStrictEqual(queriedNames(calls[0].body), ['PyPI:a', 'npm:b'], '版本必须被剥掉');
	});

	test('★ 混装（一个干净 + 一个恶意）⇒ overall blocked，且只报恶意的那个', async () => {
		const { fetchImpl } = makeFetch({
			payload: { results: [{}, { vulns: [{ id: 'MAL-9' }] }] },
		});
		const v = await checkPackagesAgainstOsv([
			{ name: 'good', ecosystem: 'npm' }, { name: 'bad', ecosystem: 'npm' },
		], { fetchImpl });
		assert.strictEqual(v.status, 'blocked');
		assert.deepStrictEqual(v.hits.map(h => h.name), ['bad']);
	});
});
