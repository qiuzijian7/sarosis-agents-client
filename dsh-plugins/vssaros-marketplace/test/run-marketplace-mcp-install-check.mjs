#!/usr/bin/env node
// @vssaros/dsh-marketplace — 商城 MCP item「装得上 + 用得了」全量守卫（2026-11-13）
//
// 背景：用户装了 GitHub MCP 后既没弹认证、也用不了。既有守卫只验到「mcp.json 里多了一行」，
//   从来没验过这一行能不能变成一次成功的 MCP 调用 —— 「安装成功」被等同于「可用」。
//
// 守什么（遍历商城上架脚本里的**全部** MCP item，条数不写死，新增商品自动纳入）：
//   ① 真源完整性：从 tools/sync-dsb-mcp.mjs 静态提取 SOURCE/specOf 纯数据段（不执行联网上架脚本）
//   ② 安装成功：造真 tar.gz → installBundle → OSV 预检 → registerMcpServer → 台账 → resolveInstalledVersions
//   ③ 可用性判定：装出来的 mcp.json 交给 vssaros-mcp 的 parseMcpServers()，每个 item 必须
//      要么 ready、要么有明确 skipped 原因；免登录的必须直接 ready；需凭据的不许谎报可用
//   ④ 真正可用：按 mcp-secret 补齐凭据后全部 ready，且经本地凭据网关真发一次 tools/list 拿到合法响应
//   ⑤ 哨兵 / 反向突变 / 卸载 / stdio 分支：证明守卫不是恒真的摆设
//
// 不打外网、不启 Host、不读用户真实凭据；唯一的 HTTP 是 127.0.0.1 上的假上游。
// 跑法：node dsh-plugins/vssaros-marketplace/test/run-marketplace-mcp-install-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');
const TOOLS = path.resolve(HERE, '..', 'tools');
const MCP_CORE = path.resolve(HERE, '..', '..', 'vssaros-mcp', 'lib', 'core');
const imp = p => import(pathToFileURL(p).href);

const { packTarGzFromMap } = await imp(path.join(LIB, 'tar.js'));
const { installBundle } = await imp(path.join(LIB, 'installers.js'));
const { upsertInstalled } = await imp(path.join(LIB, 'installedLedger.js'));
const { resolveInstalledVersions } = await imp(path.join(LIB, 'installedState.js'));
const {
	checkMcpConfigOsv, readMcpJson, readMcpPackageConfig, registerMcpServer,
	removeMcpCompletely, mcpJsonPath, writeMcpJson,
} = await imp(path.join(LIB, 'mcpInstall.js'));
const { parseMcpServers, mcpStateView } = await imp(path.join(MCP_CORE, 'mcpConfig.js'));
const { secretsAsEnv } = await imp(path.join(MCP_CORE, 'mcpSecrets.js'));
const { createMcpGateway } = await imp(path.join(MCP_CORE, 'mcpGateway.js'));

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};
const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-mcp-e2e-'));
const mcpTextOf = root => fs.readFileSync(mcpJsonPath(root), 'utf8');

console.log('★ 商城 MCP item「安装成功 + 可正常使用」全量守卫\n');

// ── ① 真源：静态提取商城上架脚本的纯数据段 ────────────────────────────────
// sync-dsb-mcp.mjs 顶层会连服务端 publishVersion ⇒ 不能 import。
// 但 `const SOURCE = [ … specOf() }` 到第一个 `const {`（动态 import 那段）之间是纯数据 + 纯函数。
const scriptText = fs.readFileSync(path.join(TOOLS, 'sync-dsb-mcp.mjs'), 'utf8');
const start = scriptText.indexOf('const SOURCE = [');
const end = scriptText.indexOf('\nconst {', start);
const chunk = start >= 0 && end > start ? scriptText.slice(start, end) : '';
const pure = chunk.length > 0
	&& chunk.includes('function specOf')
	&& !/await import|publishVersion|fetch\(|process\.env/.test(chunk);

let SOURCE = [];
let specOf = null;
try {
	const built = new Function(chunk + '\nreturn { SOURCE, specOf, envNameOf };')();
	SOURCE = built.SOURCE;
	specOf = built.specOf;
} catch (e) {
	console.error(`  提取上架脚本纯数据段失败：${String(e?.message ?? e)}`);
}
check('① 从商城上架脚本提取到全部 MCP item 定义（纯数据段，不执行联网脚本）',
	pure && Array.isArray(SOURCE) && SOURCE.length > 0 && typeof specOf === 'function',
	`SOURCE=${Array.isArray(SOURCE) ? SOURCE.length : 'n/a'} pure=${pure}`);
if (!pure || !Array.isArray(SOURCE) || !SOURCE.length || typeof specOf !== 'function') {
	console.log(`\n[marketplace mcp install] ${pass} passing / ${fails.length} failing`);
	process.exit(1);
}

const specs = SOURCE.map(specOf);
const byAuth = auth => specs.filter(s => s.auth === auth);
const slugs = new Set(specs.map(s => s.slug));

check('① 三种认证形态都被覆盖（none / oauth / key），slug 唯一、url 全 https',
	byAuth('none').length > 0 && byAuth('oauth').length > 0 && byAuth('key').length > 0
	&& slugs.size === specs.length
	&& specs.every(s => /^https:\/\//.test(s.url) && /^[A-Za-z0-9_-]{1,32}$/.test(s.slug)));
const plainSecret = specs.find(s => JSON.stringify(s.config).match(/(TOKEN-|ghp_|sk-[A-Za-z0-9]{8})/));
check('① 商品 config.json 不含任何明文凭据（只有 ${env:...} 引用）', !plainSecret,
	plainSecret ? plainSecret.slug : '');

// ── ② 逐条走真实安装链：落盘 → OSV → 注册 → 台账 ──────────────────────────
const dataRoot = mkRoot();
const fakeOsv = {
	isOsvEnabled: () => true,
	checkStdioEntriesAgainstOsv: async () => ({ status: 'ok' }),
	buildOsvBlockedMessage: () => 'fake OSV blocked',
};
const installErrors = [];
for (const spec of specs) {
	try {
		const gz = packTarGzFromMap({
			'manifest.json': JSON.stringify({ kind: 'mcp', id: spec.slug, version: '1.0.0', files: ['config.json'] }),
			'config.json': JSON.stringify(spec.config, null, 2),
		});
		await installBundle({ dataRoot, kind: 'mcp', storeId: spec.slug, version: '1.0.0', gzBuffer: gz });
		const { config } = await readMcpPackageConfig(dataRoot, spec.slug);
		const verdict = await checkMcpConfigOsv(fakeOsv, config);
		if (verdict.status === 'blocked') { throw new Error(verdict.message); }
		await registerMcpServer(dataRoot, spec.slug, config);
		await upsertInstalled(dataRoot, { kind: 'mcp', storeId: spec.slug, version: '1.0.0' });
	} catch (e) {
		installErrors.push(`${spec.slug}: ${String(e?.message ?? e)}`);
	}
}
check(`② 全部 ${specs.length} 个 item 都安装成功（造包→落盘→OSV→注册→台账）`,
	installErrors.length === 0, installErrors.slice(0, 3).join(' | '));

const entries = (await readMcpJson(dataRoot)).servers ?? {};
check('② mcp.json 每条注册项形状正确（disabled / type / url 与商品一致）',
	specs.every(s => {
		const e = entries[s.slug];
		return e && e.disabled === false && e.type === 'http' && e.url === s.url;
	}) && Object.keys(entries).length === specs.length,
	`entries=${Object.keys(entries).length}/${specs.length}`);
check('② 凭据形态按 auth 分流：oauth→headers、key→query、none→都没有',
	specs.every(s => {
		const e = entries[s.slug] ?? {};
		if (s.auth === 'oauth') { return /\$\{env:MCP_[A-Z0-9_]+_TOKEN\}/.test(e.headers?.Authorization ?? ''); }
		if (s.auth === 'key') { return /\$\{env:MCP_[A-Z0-9_]+_KEY\}/.test(e.query?.key ?? ''); }
		return !e.headers && !e.query;
	}));
const installedMap = await resolveInstalledVersions(dataRoot);
check('② 每个 item 都被「已安装」判定认到（目录 + mcp.json 注册项都在，不谎报）',
	specs.every(s => installedMap.get(`mcp:${s.slug}`) === '1.0.0'));

// OSV 判 blocked 时必须中止，不能把有风险的包写成「已装」。
const blockedOsv = {
	isOsvEnabled: () => true,
	checkStdioEntriesAgainstOsv: async () => ({ status: 'blocked' }),
	buildOsvBlockedMessage: () => 'fake OSV blocked',
};
const blockedVerdict = await checkMcpConfigOsv(blockedOsv, specs[0].config);
check('② OSV 判 blocked ⇒ 明确阻断（带可展示原因），不静默放行',
	blockedVerdict.status === 'blocked' && !!blockedVerdict.message);

// ── ③ 可用性判定：装完的 mcp.json 能不能被运行时挂载 ─────────────────────
const mcpText = mcpTextOf(dataRoot);
const noCred = parseMcpServers(mcpText, {});
const readyNames = new Set(noCred.servers.map(s => s.serverName));
const skipByName = new Map(noCred.skipped.map(s => [s.name, s]));

check('③ 每个 item 都必须被明确判定（ready 或有原因的 skipped），不许静默丢失',
	specs.every(s => readyNames.has(s.slug) || (skipByName.has(s.slug) && !!skipByName.get(s.slug).reason)),
	`ready=${noCred.servers.length} skipped=${noCred.skipped.length} items=${specs.length}`);
check('③ 免登录 item 装完直接 ready（无需任何额外配置）',
	byAuth('none').length > 0 && byAuth('none').every(s => readyNames.has(s.slug)));
check('③ 需 OAuth token 的 item 缺凭据时如实标不可用，绝不谎报 ready',
	byAuth('oauth').length > 0 && byAuth('oauth').every(s =>
		skipByName.has(s.slug) && /占位符|凭据|环境变量/.test(skipByName.get(s.slug).reason)));
// 现状如实记录：parseMcpServers 只校验 headers，query 型凭据要等网关转发时才解析。
// 解析层会把 key 型算成 ready ⇒ 由 ④ 的网关层断言保证「缺 key 时明确 400，不把 ${...} 传出去」。
check('③ key 型（query 凭据）解析层判 ready，凭据校验下沉到网关（现状如实记录）',
	byAuth('key').length > 0 && byAuth('key').every(s => readyNames.has(s.slug)));

// 哨兵：证明「缺凭据必须被标不可用」这条判据不是恒真。
const sentinel = JSON.parse(mcpText);
sentinel.servers['sentinel-missing'] = {
	type: 'http', url: 'https://example.invalid/mcp',
	headers: { Authorization: 'Bearer ${env:DEFINITELY_MISSING_X}' },
};
const sentinelParsed = parseMcpServers(JSON.stringify(sentinel), {});
check('③ 哨兵：无法解析的占位符确实会被 skip（判据不是恒真）',
	sentinelParsed.skipped.some(s => s.name === 'sentinel-missing' && /占位符/.test(s.reason)));

// ── ④ 补齐 mcp-secret 后：全部 ready + 真发一次 tools/list ────────────────
const secrets = { version: 1, secrets: {} };
for (const s of specs) {
	if (s.auth === 'oauth') { secrets.secrets[s.id] = { token: 'TOKEN-' + s.id }; }
	if (s.auth === 'key') { secrets.secrets[s.id] = { key: 'KEY-' + s.id }; }
}
const credEnv = secretsAsEnv(secrets, {});
const withCred = parseMcpServers(mcpText, credEnv);
check('④ 按 mcp-secret 补齐凭据后全部 item ready（skipped 为空）',
	withCred.servers.length === specs.length && withCred.skipped.length === 0,
	`ready=${withCred.servers.length}/${specs.length} skipped=${withCred.skipped.length}`);
check('④ ready 项都是 streamable-http、url 与商品一致、token 已解析成真值',
	withCred.servers.every(s => {
		const spec = specs.find(x => x.slug === s.serverName);
		return spec && s.transport === 'streamable-http' && s.url === spec.url
			&& !JSON.stringify(s).includes('${');
	}));
check('④ 凭据真值仍不落 mcp.json（只有 ${env:...} 引用）',
	!/TOKEN-|KEY-/.test(mcpText) && mcpText.includes('${env:MCP_GITHUB_TOKEN}'));
check('④ mcpStateView 的 ready 计数与商品数一致',
	mcpStateView(withCred).counts.ready === specs.length);

const seen = [];
const upstream = createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) { chunks.push(c); }
	seen.push({ headers: req.headers, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
	res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
	res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'ping' }] } }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${upstream.address().port}/mcp`;

const gw = createMcpGateway({ env: credEnv, allowInsecure: true });
await gw.listen();
for (const s of specs) {
	const e = entries[s.slug] ?? {};
	gw.register(s.slug, { url: baseUrl, headers: e.headers ?? {}, query: e.query ?? {} });
}
const callErrors = [];
for (const s of specs) {
	const clientConfig = { url: gw.urlFor(s.slug), headers: gw.headers() };
	try {
		const before = seen.length;
		const res = await fetch(clientConfig.url, {
			method: 'POST',
			headers: { ...clientConfig.headers, 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		});
		const body = await res.json();
		const rec = seen.at(-1);
		const shapeOk = res.status === 200 && body?.result?.tools?.length === 1
			&& seen.length === before + 1 && rec?.body?.includes('tools/list');
		const credOk = s.auth === 'oauth'
			? rec?.headers?.authorization === `Bearer TOKEN-${s.id}`
			: s.auth === 'key'
				? String(rec?.url ?? '').includes(`key=KEY-${s.id}`)
				: rec?.headers?.authorization === undefined;
		const isolated = !JSON.stringify(clientConfig).includes('TOKEN-')
			&& !JSON.stringify(clientConfig).includes('KEY-');
		if (!shapeOk || !credOk || !isolated) {
			callErrors.push(`${s.slug}: status=${res.status} shape=${shapeOk} cred=${credOk} isolated=${isolated}`);
		}
	} catch (e) {
		callErrors.push(`${s.slug}: ${String(e?.message ?? e)}`);
	}
}
check(`④ 补齐凭据后，全部 ${specs.length} 个 item 都经凭据网关真调 tools/list 成功`,
	callErrors.length === 0, callErrors.slice(0, 3).join(' | '));

// 缺凭据时网关必须明确拒绝，且不把 ${env:...} 原样透给上游（③ 里 key 型被判 ready 的兜底）。
const gwEmpty = createMcpGateway({ env: {}, allowInsecure: true });
await gwEmpty.listen();
const oauthSpec = byAuth('oauth')[0];
const keySpec = byAuth('key')[0];
gwEmpty.register(oauthSpec.slug, { url: baseUrl, headers: entries[oauthSpec.slug].headers, query: {} });
gwEmpty.register(keySpec.slug, { url: baseUrl, headers: {}, query: entries[keySpec.slug].query });
const emptyStatuses = [];
for (const s of [oauthSpec, keySpec]) {
	const r = await fetch(gwEmpty.urlFor(s.slug), {
		method: 'POST', headers: { ...gwEmpty.headers(), 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
	});
	emptyStatuses.push(r.status);
}
check('④ 缺凭据 ⇒ 网关明确 400 拒绝，不把 ${env:...} 原样传给上游',
	emptyStatuses.every(st => st === 400), emptyStatuses.join(','));
await gwEmpty.close();
await gw.close();
await new Promise(resolve => upstream.close(resolve));

// ── ⑤ 回归钉子：反向突变 / 卸载 / stdio 分支 / 编排层接线 ──────────────────
const mutatedChunk = chunk.replace("auth === 'oauth'", "auth === '__never__'");
let mutatedGithub;
try {
	const built = new Function(mutatedChunk + '\nreturn { SOURCE, specOf };')();
	mutatedGithub = built.SOURCE.map(built.specOf).find(s => s.id === 'github');
} catch { /* 下面按 undefined 判红 */ }
check('⑤ 反向突变：把 specOf 的 oauth 分支改掉 ⇒ ② 的凭据形态判据确实变红',
	mutatedChunk !== chunk
	&& !!specs.find(s => s.id === 'github')?.config?.headers?.Authorization
	&& !mutatedGithub?.config?.headers?.Authorization);

const gh = specs.find(s => s.id === 'github');
await removeMcpCompletely(dataRoot, gh.slug);
const afterRemove = (await readMcpJson(dataRoot)).servers ?? {};
const mapAfter = await resolveInstalledVersions(dataRoot);
check('⑤ 卸载后注册项清掉，且不再被判为已安装',
	!afterRemove[gh.slug] && !mapAfter.has(`mcp:${gh.slug}`));

// stdio 型商城 MCP 是另一类 item：装完必须等用户批准，不能静默起本机进程。
{
	const root = mkRoot();
	const cfg = { version: '1.0.0', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] };
	const gz = packTarGzFromMap({
		'manifest.json': JSON.stringify({ kind: 'mcp', id: 'local-github', version: '1.0.0', files: ['config.json'] }),
		'config.json': JSON.stringify(cfg),
	});
	await installBundle({ dataRoot: root, kind: 'mcp', storeId: 'local-github', version: '1.0.0', gzBuffer: gz });
	const { config } = await readMcpPackageConfig(root, 'local-github');
	const entry = await registerMcpServer(root, 'local-github', config);
	check('⑤ stdio 型 item 装完标 approved:false（不起本机进程）',
		entry.approved === false && entry.type === 'stdio');
	const beforeApprove = parseMcpServers(mcpTextOf(root), {});
	check('⑤ stdio 未批准 ⇒ needs-approval（明确等授权，不是 error、更不是静默 ready）',
		beforeApprove.servers.length === 0 && beforeApprove.skipped[0]?.state === 'needs-approval');
	const raw = await readMcpJson(root);
	raw.servers['local-github'].approved = true;
	await writeMcpJson(root, raw);
	const afterApprove = parseMcpServers(mcpTextOf(root), {});
	check('⑤ 用户批准后正常挂载（可以正常使用）',
		afterApprove.servers.length === 1 && afterApprove.skipped.length === 0);
	fs.rmSync(root, { recursive: true, force: true });
}

const idx = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
const wired = s => s.includes('await assertMcpConfigSafe(config)')
	&& s.includes('registerMcpServer(dataRoot, slug, config)');
check('⑤ 编排层仍接了 OSV 预检 + 注册（反向突变判据变红）',
	wired(idx) && !wired(idx.replace('registerMcpServer(dataRoot, slug, config)', 'void 0')));

fs.rmSync(dataRoot, { recursive: true, force: true });
console.log(`\n[marketplace mcp install] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
