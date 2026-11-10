#!/usr/bin/env node
// @vssaros/dsh-marketplace — **Bot 组合包全链守卫**（2026-11-09）
//
// 跑法：node dsh-plugins/vssaros-marketplace/test/run-marketplace-bot-e2e-check.mjs
// 全程离线：状态化假服务端 + 真 tar.gz + 真临时数据根，不联网、不启 Host ✓
//
// ── 这份测试同时是规格（先写测试、后实现）────────────────────────────
// 用户诉求：「上传一个 bot（含技能、工具、mcp）到商城，其他用户下载即可用」。
//
// ★ 由测试倒逼出的方案修正（覆盖上一轮「Bot = 一个 dsh 插件包」的设想）：
//   ① 商城 bundle 包是 `manifest.json` 目录镜像，dsh 插件包是 `package.json` + `dsh.bundle.patch`，
//      `inspectWorkbenchArchive` 只认后者 ⇒ 两种格式互不兼容，不能同时满足「上传本体」和「装成插件」。
//   ② 新增 `bot` kind 要改仓库外的服务端 `kinds.ts`、本仓 ~18 处 dsh + 9 处 IDE + 8 处测试守卫 ⇒ 不做。
//   ③ 因此：**复用现有 `agent` kind 的目录镜像包**，包内用 `bot.json` 声明组件，
//      由分发安装器把组件落进各自的 `<数据根>/<kind根>/`，并登记多条台账。
//   ④ `manifest.json` 会被 `installBundle` 剔除（不落盘）⇒ 组件清单必须是独立文件 `bot.json`。
//
// 四段：① 上传（闭包/凭据预检 + 摘要）② 商城显示 ③ 下载（sha256）④ 安装（分发 + 分项回执 + 级联卸载）
// ⑤ 命名空间/冲突/回执接线；⑥ P1：包级命名空间 + 依赖范围真实校验。
//
// ★ P1 定案（2026-11-09，用户拍板「默认开启」）：`bot.json` 的 `namespace` 缺省 / true
//   ⇒ 组件按 `<botId>-<name>` 落位；**只有显式 false** 才是逃生门（老包 / 固定技能名），
//   也可传短前缀自定义。开启时**必须**同步改写
//   `.agent.md` 的 skills:/tools: 引用与 `SKILL.md` 的 frontmatter name
//   —— dsh 用 frontmatter name 做技能 id，只改目录名会「装上了却只有一个技能可见」。
//   `requires` 从形状校验升级为范围语法校验 + `satisfiesRange` 纯计算；
//   查不到版本 ⇒ unknown（如实报告，不阻断），明确不满足 ⇒ incompatible（拒装）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');
const load = async (rel) => import(pathToFileURL(path.join(LIB, rel)).href);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-bot-'));
const authorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-bot-author-'));
const SLUG = 'code-reviewer-bot';
const VERSION = '1.0.0';

const { packTarGzFromMap } = await load('tar.js');
const { installBundle, uninstallBundle, sha256Of } = await load('installers.js');
const { readInstalled, upsertInstalled } = await load('installedLedger.js');
const { readMcpJson } = await load('mcpInstall.js');
const { preparePublishBundle, publishVersion } = await load('publisher.js');
const { toPackageSummary, toPackageDetail } = await load('shape.js');
const foundationMod = await load('foundationRef.js');
foundationMod.bindFoundation({
	dataRootOf: () => dataRoot,
	lockFileFor: (f) => `${f}.lock`,
	acquireFileLock: async () => async () => { },
	atomicWriteFile: async () => { },
	isPidAlive: () => false,
	escapeHtml: (s) => String(s),
	renderChips: () => '',
	renderShell: () => '',
	SHELL_CSS: '',
});
const { createMarketClient, MARKET_JWT_REF } = await load('marketClient.js');
// 实现可以还不存在 ⇒ 逐条 FAIL 而不是整个脚本 import 崩溃（TDD 红阶段要能跑完）
const botPack = await load('botPack.js').catch(() => null);

console.log('★ Bot 组合包全链守卫（上传 → 显示 → 下载 → 安装）\n');

// ── 造包素材 ────────────────────────────────────────────────────────
const BOT_JSON = {
	schemaVersion: 1,
	botId: SLUG,
	presetId: `vssaros-${SLUG}`,
	source: 'custom',
	model: '',
	skills: ['review-checklist'],
	tools: ['read', 'glob', 'grep', 'mcp__review-tools__*'],
	mcpServers: ['review-tools'],
	requires: { '@deepseek-ai/dsh': '>=0.2.1' },
};
const AGENT_MD = '---\nname: 代码审阅员\ndescription: 审阅改动\nrole: 代码审阅\nsource: custom\nskills: review-checklist\ntools: read, glob, grep, mcp__review-tools__*\n---\n\n你是代码审阅员。\n';
const SKILL_MD = '---\nname: review-checklist\ndescription: 代码审阅检查清单\n---\n\n逐项检查。\n';
const MCP_CONFIG = JSON.stringify({
	transport: 'stdio', command: 'node', args: ['server.js'],
	env: { REVIEW_TOKEN: '${env:REVIEW_TOKEN}' },
}, null, 2);

/** 造一份作者本地的 bot 资源目录；overrides 可替换/删除任意文件。 */
function makeBotDir(name, overrides = {}) {
	// preparePublishBundle 按 `<数据根>/<kind根>/<localId>` 找源目录 ⇒ 必须落在 agents/ 下
	const dir = path.join(authorRoot, 'agents', name);
	fs.mkdirSync(path.join(dir, 'skills', 'review-checklist'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'mcp', 'review-tools'), { recursive: true });
	const base = {
		'.agent.md': AGENT_MD,
		// botId 必须等于目录名（= localId = 商城 slug），否则发布预检会先拒
		'bot.json': JSON.stringify({ ...BOT_JSON, botId: name }, null, 2),
		'skills/review-checklist/SKILL.md': SKILL_MD,
		'mcp/review-tools/config.json': MCP_CONFIG,
		'mcp/review-tools/server.js': 'console.log("mcp server");\n',
		'manifest.json': JSON.stringify({ name: '代码审阅 Bot', description: '含技能/工具/MCP', tags: ['bot'] }, null, 2),
	};
	for (const [rel, content] of Object.entries({ ...base, ...overrides })) {
		if (content === null) { continue; }
		const dest = path.join(dir, rel);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, content);
	}
	return dir;
}

/** 状态化假服务端：建包 / 传版本 / 列表 / 详情 / 下载，全部走同一个仓储。 */
function fakeServer() {
	const packages = new Map();
	const blobs = new Map();
	const calls = [];
	const json = (body, status = 200) => ({ status, text: JSON.stringify(body) });
	const handler = (entry) => {
		const url = new URL(entry.url);
		const p = url.pathname;
		const method = entry.method;
		if (method === 'POST' && /\/packages$/.test(p)) {
			const body = JSON.parse(String(entry.body || '{}'));
			const pkg = {
				id: body.slug, slug: body.slug, kind: body.kind, name: body.name,
				description: body.description ?? '', latest_version: '', author_name: 'author',
				category: body.category ?? '', icon: '', cover: '', tags: body.tags ?? [],
				status: 'active', distribution_type: 'bundle', distribution_meta: null,
				visibility: 'public', featured: false, versions: [],
			};
			if (!packages.has(body.slug)) { packages.set(body.slug, pkg); }
			return json({ id: body.slug }, 201);
		}
		const rawUpload = method === 'POST' && /\/versions\/raw$/.test(p);
		if (rawUpload) {
			const m = p.match(/\/packages\/([^/]+)\/versions\/raw$/);
			const slug = decodeURIComponent(m[1]);
			const gz = Buffer.from(entry.body);
			// manifest 是发布端内存产物（不落作者目录）⇒ 由测试显式喂给假服务端，
			// 与 publishVersion 内部那份确定性打包的结果同源。
			const manifest = server.manifest ?? {};
			const version = manifest.version || VERSION;
			blobs.set(`${slug}@${version}`, gz);
			const pkg = packages.get(slug);
			pkg.latest_version = version;
			// ★ 故意**不**冗余 `pkg.bot`：真服务端 kinds.ts 不在这个仓库，
			//   列表要显示摘要只能靠建包时传的 tags（或详情页的 versions[].manifest.bot）。
			//   假服务端若私自冗余 bot 字段，②-3 会变成「只有假环境才绿」的假绿。
			pkg.versions.unshift({
				id: `${slug}-${version}`, version, changelog: '', sha256: sha256(gz),
				asset_size: gz.length, is_latest: true, manifest,
			});
			return json({ ok: true }, 201);
		}
		if (method === 'GET' && /\/versions\/[^/]+\/download$/.test(p)) {
			const m = p.match(/\/packages\/([^/]+)\/versions\/([^/]+)\/download$/);
			return { status: 200, buffer: blobs.get(`${decodeURIComponent(m[1])}@${decodeURIComponent(m[2])}`) };
		}
		if (method === 'GET' && /\/packages\?/.test(entry.url)) {
			const kind = url.searchParams.get('kind');
			const items = [...packages.values()].filter(x => !kind || x.kind === kind);
			return json({ items, total: items.length, page: 1, pageSize: 50 });
		}
		if (method === 'GET' && /\/packages\/[^/]+$/.test(p)) {
			const slug = decodeURIComponent(p.split('/').pop());
			return json(packages.get(slug) ?? {});
		}
		return json({ token: 'fake-jwt' });
	};
	const fetchImpl = async (url, init = {}) => {
		calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
		const res = handler({ url: String(url), method: init.method ?? 'GET', body: init.body });
		const buf = res.buffer ? Buffer.from(res.buffer) : undefined;
		return {
			ok: (res.status ?? 200) < 400,
			status: res.status ?? 200,
			text: async () => res.text ?? '',
			arrayBuffer: async () => Uint8Array.from(buf ?? Buffer.alloc(0)).buffer,
		};
	};
	const server = { packages, blobs, calls, fetchImpl, manifest: null };
	return server;
}

const server = fakeServer();
const credentials = {
	resolve: async (ref) => (ref === MARKET_JWT_REF ? { value: 'fake-jwt' } : undefined),
	set: async () => { }, unset: async () => { },
};
const market = createMarketClient({ credentials, config: {}, fetchImpl: server.fetchImpl });

// ═══ ① 上传 ═══════════════════════════════════════════════════════
console.log('── ① 上传 ──');
const goodDir = makeBotDir('good');
server.lastPrepared = goodDir;
let prepared = null;
try {
	prepared = await preparePublishBundle({ dataRoot: authorRoot, kind: 'agent', localId: 'good', version: VERSION, meta: { name: '代码审阅 Bot' } });
} catch (e) { prepared = { error: e }; }
// 用真实 SLUG 再打一份（发布要求 manifest.id === slug）
const realDir = makeBotDir(SLUG);
server.lastPrepared = realDir;
let realPrepared = null;
try {
	realPrepared = await preparePublishBundle({ dataRoot: authorRoot, kind: 'agent', localId: SLUG, version: VERSION, meta: { name: '代码审阅 Bot' } });
} catch (e) { realPrepared = { error: e }; }

check('①-1 agent 目录镜像包能打包，且包内带独立的 bot.json',
	!!realPrepared && !realPrepared.error && realPrepared.files?.some(f => f.path === 'bot.json'));
check('①-2 发布预检产出 manifest.bot 组件摘要（技能/工具/MCP 数量）',
	realPrepared?.manifest?.bot?.skills === 1
	&& realPrepared?.manifest?.bot?.tools === BOT_JSON.tools.length
	&& realPrepared?.manifest?.bot?.mcpServers === 1,
	JSON.stringify(realPrepared?.manifest?.bot ?? null));
check('①-3 闭包校验：bot.json 声明的每个技能在包内有 SKILL.md 实体',
	!!botPack?.validateBotPack && (() => {
		try { botPack.validateBotPack(realPrepared.files, BOT_JSON); return true; } catch { return false; }
	})());
{
	const brokenDir = makeBotDir('broken', { 'skills/review-checklist/SKILL.md': null });
	let rejected = false;
	try { await preparePublishBundle({ dataRoot: authorRoot, kind: 'agent', localId: 'broken', version: VERSION }); }
	catch (e) { rejected = /技能|skill/i.test(String(e.message ?? e)); }
	check('①-4 缺技能实体 ⇒ 发布被拒（不产出「装了半个」的包）', rejected);
}
{
	const leakDir = makeBotDir('leak', {
		'mcp/review-tools/config.json': JSON.stringify({ transport: 'stdio', command: 'node', env: { TOKEN: 'sk-live-abc123secret' } }),
	});
	let rejected = false;
	try { await preparePublishBundle({ dataRoot: authorRoot, kind: 'agent', localId: 'leak', version: VERSION }); }
	catch (e) { rejected = /凭据|密钥|token|secret/i.test(String(e.message ?? e)); }
	check('①-5 凭据扫描：MCP 配置里的真实 token ⇒ 发布被拒', rejected);
}
server.manifest = realPrepared?.manifest ?? null;
let published = null;
try {
	published = await publishVersion({
		market, dataRoot: authorRoot, kind: 'agent', localId: SLUG, version: VERSION,
		changelog: 'first bot pack', meta: { name: '代码审阅 Bot' },
	});
} catch (e) { published = { error: e }; }
check('①-6 上传：建包 + 传本体，服务端存下 gz 与 sha256',
	!!published && !published.error && server.calls.some(c => c.method === 'POST' && /\/packages$/.test(c.url))
	&& server.calls.some(c => c.method === 'POST' && /\/versions\/raw$/.test(c.url))
	&& server.blobs.has(`${SLUG}@${VERSION}`)
	&& server.packages.get(SLUG)?.versions?.[0]?.sha256 === sha256(server.blobs.get(`${SLUG}@${VERSION}`)),
	JSON.stringify(published?.error?.message ?? published));

// ═══ ② 商城显示 ═══════════════════════════════════════════════════
console.log('── ② 商城显示 ──');
let listed = null; let detail = null;
try {
	listed = await market.list({ kind: 'agent' });
	detail = await market.detail(SLUG);
} catch { /* 下面逐条断言 */ }
const summary = listed?.items?.[0] ? toPackageSummary(listed.items[0]) : null;
const shapedDetail = detail ? toPackageDetail(detail) : null;
check('②-1 列表能筛到这个 Bot 包', listed?.total === 1 && listed?.items?.[0]?.slug === SLUG);
check('②-2 详情页能读到 versions[].manifest.bot 组件摘要',
	shapedDetail?.versions?.[0]?.manifest?.bot?.skills === 1);
check('②-3 列表卡片形状也带 bot 摘要（与详情同源，不出现「列表没有、详情有」）',
	summary?.bot?.skills === 1, JSON.stringify(summary?.bot ?? null));
{
	const clientSrc = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
	check('②-4 页面真的渲染组件摘要（不是只存进 manifest 没人显示）',
		/manifest\.bot|botSummary|组件摘要/.test(clientSrc));
}
const createCall = server.calls.find(c => c.method === 'POST' && /\/packages$/.test(c.url));
check('②-5 发布端把组件摘要写进 tags（零服务端改动也能让列表显示）',
	(() => {
		try { return JSON.parse(String(createCall?.body ?? '{}')).tags.some(t => /^bot:\d+\/\d+\/\d+$/.test(String(t))); }
		catch { return false; }
	})());
check('②-6 列表形状在无服务端冗余字段时从 tags 兜底解析出摘要',
	toPackageSummary({ kind: 'agent', slug: SLUG, tags: ['bot:1/4/1'] })?.bot?.skills === 1
	&& toPackageSummary({ kind: 'agent', slug: SLUG, tags: ['bot:1/4/1'] })?.bot?.tools === 4);

// ═══ ③ 下载 ═══════════════════════════════════════════════════════
console.log('── ③ 下载 ──');
let downloaded = null;
try { downloaded = await market.download(`/packages/${SLUG}/versions/${VERSION}/download`); } catch { /* 下面断言 */ }
const uploadedGz = server.blobs.get(`${SLUG}@${VERSION}`);
check('③-1 能从商城下载包本体，字节与上传一致',
	!!downloaded && !!uploadedGz && downloaded.equals(uploadedGz));
check('③-2 服务端登记的 sha256 与包体一致',
	server.packages.get(SLUG)?.versions?.[0]?.sha256 === sha256Of(downloaded ?? Buffer.alloc(0)));
check('③-3 下载的是商城 bundle 本体（非外部源登记）',
	summary?.distributionType === 'bundle');
{
	const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-bot-badhash-'));
	let rejected = false;
	try {
		await installBundle({ dataRoot: otherRoot, kind: 'agent', storeId: SLUG, version: VERSION, gzBuffer: downloaded, expectedSha256: '0'.repeat(64) });
	} catch { rejected = true; }
	check('③-4 sha256 对不上 ⇒ 拒绝安装且不落盘', rejected && !fs.existsSync(path.join(otherRoot, 'agents', SLUG)));
	fs.rmSync(otherRoot, { recursive: true, force: true });
}

// ═══ ④ 安装 ═══════════════════════════════════════════════════════
console.log('── ④ 安装 ──');
let installResult = null;
try {
	installResult = await installBundle({
		dataRoot, kind: 'agent', storeId: SLUG, version: VERSION,
		gzBuffer: downloaded, expectedSha256: sha256Of(downloaded ?? Buffer.alloc(0)),
	});
} catch (e) { installResult = { error: e }; }
const agentFile = path.join(dataRoot, 'agents', SLUG, '.agent.md');
// ★ 2026-11-09 用户拍板：namespace **默认开启** ⇒ 组件统一按 <botId>-<name> 落位。
//   显式 `namespace: false` 才是逃生门（老包 / 需要固定技能名的包）。
const DEF_SKILL = SLUG + '-review-checklist';
const DEF_MCP = SLUG + '-review-tools';
const skillFile = path.join(dataRoot, 'skills', DEF_SKILL, 'SKILL.md');
const mcpFile = path.join(dataRoot, 'mcp', DEF_MCP, 'config.json');
check('④-1 Bot 定义落 <数据根>/agents/<id>/.agent.md', fs.existsSync(agentFile));
check('④-2 技能落 <数据根>/skills/<botId>-<name>/SKILL.md（不是塞在 agent 目录里）', fs.existsSync(skillFile)
	&& !fs.existsSync(path.join(dataRoot, 'agents', SLUG, 'skills')));
check('④-3 MCP 落 <数据根>/mcp/<botId>-<id>/config.json', fs.existsSync(mcpFile));
let mcpJson = null;
try { mcpJson = await readMcpJson(dataRoot); } catch { /* 下面断言 */ }
check('④-4 MCP 注册进 mcp.json 的 servers（否则装了也连不上）',
	!!mcpJson?.servers?.[DEF_MCP]);
check('④-10 未声明 namespace 的包默认带前缀，不再落在裸技能名下',
	fs.existsSync(skillFile) && !fs.existsSync(path.join(dataRoot, 'skills', 'review-checklist', 'SKILL.md')));
let ledger = [];
try { ledger = await readInstalled(dataRoot); } catch { /* 下面断言 */ }
check('④-5 台账按组件分别登记（agent + skill + mcp 至少 3 条）',
	ledger.length >= 3 && ['agent', 'skill', 'mcp'].every(k => ledger.some(e => e.kind === k)),
	JSON.stringify(ledger.map(e => `${e.kind}:${e.storeId}`)));
const receipt = installResult?.bot ?? null;
// ★ 2026-11-10：MCP 改为运行时挂载（缺省启用）⇒ 回执应是 applied；
//   `VSSAROS_MCP_RUNTIME_MOUNT=0` 回退态仍报 restart-required（由 check-capability-tools ⑨ 钉住）。
check('④-6 回执分项说明生效状态（Bot 即时 / 技能需重启 / MCP 运行时即时）',
	receipt?.bot === 'applied' && receipt?.skills === 'restart-required' && receipt?.mcp === 'applied',
	JSON.stringify(receipt));
check('④-7 凭据只留 ${env:VAR} 占位符，真实 token 不落盘',
	fs.existsSync(mcpFile) && fs.readFileSync(mcpFile, 'utf8').includes('${env:REVIEW_TOKEN}')
	&& !fs.readFileSync(mcpFile, 'utf8').includes('sk-live-'));
{
	let rejected = false;
	try {
		await installBundle({ dataRoot, kind: 'agent', storeId: SLUG, version: VERSION, gzBuffer: downloaded });
	} catch { rejected = true; }
	check('④-8 重复安装被拒（不覆盖已有组件）', rejected);
}
{
	// ⚠ 前置条件必须一起断言：技能/MCP 压根没装时「卸载后都不在」会假绿（红阶段实测踩到）。
	const before = fs.existsSync(agentFile) && fs.existsSync(skillFile) && fs.existsSync(mcpFile)
		&& !!(await readMcpJson(dataRoot)).servers?.[DEF_MCP];
	let cleaned = false;
	try {
		await uninstallBundle({ dataRoot, kind: 'agent', storeId: SLUG });
		const after = !fs.existsSync(agentFile) && !fs.existsSync(skillFile) && !fs.existsSync(mcpFile)
			&& !(await readMcpJson(dataRoot)).servers?.[DEF_MCP];
		cleaned = before && after;
	} catch { /* 下面断言 */ }
	check('④-9 卸载级联清掉 Bot / 技能 / MCP 与 mcp.json 注册项（先断言真的装上了）', cleaned);
}

// ═══ ⑤ 命名空间 / 冲突 / 回执接线 ═══════════════════════════════════
console.log('── ⑤ 命名空间与回执 ──');
const nsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-bot-ns-'));
try {
	await installBundle({ dataRoot: nsRoot, kind: 'agent', storeId: SLUG, version: VERSION, gzBuffer: downloaded });
} catch { /* 下面逐条断言 */ }
const nsLedger = await readInstalled(nsRoot);
check('⑤-1 台账里每个组件条目带 owner（本包），级联卸载才知道哪些是自己的',
	nsLedger.filter(e => e.owner === SLUG).length >= 3,
	JSON.stringify(nsLedger.map(e => `${e.kind}:${e.storeId}:${e.owner ?? '-'}`)));
{
	// 别的包先占了同一个（已加前缀的）组件名 ⇒ 第二个 Bot 包必须拒，且报错指明占用者
	const conflictRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-bot-conflict-'));
	fs.mkdirSync(path.join(conflictRoot, 'skills', DEF_SKILL), { recursive: true });
	fs.writeFileSync(path.join(conflictRoot, 'skills', DEF_SKILL, 'SKILL.md'), SKILL_MD);
	await upsertInstalled(conflictRoot, { kind: 'skill', storeId: DEF_SKILL, version: '9.9.9', owner: 'other-bot' });
	let msg = '';
	try {
		await installBundle({ dataRoot: conflictRoot, kind: 'agent', storeId: SLUG, version: VERSION, gzBuffer: downloaded });
	} catch (e) { msg = String(e?.message ?? e); }
	check('⑤-2 同名技能被别的包占用 ⇒ 拒绝并指出占用者（不静默覆盖）',
		/占用|owner|other-bot/.test(msg), msg);
	fs.rmSync(conflictRoot, { recursive: true, force: true });
}
{
	// 组件 owner 不是本包 ⇒ 卸载 Bot 不许误删它
	await upsertInstalled(nsRoot, { kind: 'skill', storeId: DEF_SKILL, version: '9.9.9', owner: 'other-bot' });
	try { await uninstallBundle({ dataRoot: nsRoot, kind: 'agent', storeId: SLUG }); } catch { /* 下面断言 */ }
	check('⑤-3 卸载只清 owner 属于自己的组件（别人的同名技能保留）',
		fs.existsSync(path.join(nsRoot, 'skills', DEF_SKILL, 'SKILL.md')));
}
check('⑤-4 bot.json 的 requires 形状被校验（字符串/数组不许冒充依赖表）',
	!!botPack?.validateBotPack && (() => {
		try { botPack.validateBotPack(realPrepared.files, { ...BOT_JSON, requires: 'bad' }); return false; }
		catch { return true; }
	})());
{
	const indexSrc = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
	const clientSrc = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
	check('⑤-5 runLocalWrite 把 Bot 分项回执透出给前端（不是只留在 installBundle 里）',
		/installed\.bot/.test(indexSrc));
	check('⑤-6 安装提示按回执如实说明「需重启 / 待配置环境变量」',
		/res\.bot/.test(clientSrc));
}
fs.rmSync(nsRoot, { recursive: true, force: true });

// ═══ ⑥ P1：包级命名空间 + 依赖范围真实校验 ══════════════════════════
// 目标：「其他用户下载即可用」在**多个包共存**时也成立 —— 两个包都用 `review-checklist`
// 不该互相撞名；`requires` 不能只验形状然后假装依赖已满足。
console.log('── ⑥ 命名空间与依赖 ──');
const NS_ID = 'ns-reviewer-bot';
const NS_ID2 = 'other-reviewer-bot';
const NS_SKILL = NS_ID + '-review-checklist';
const NS_MCP = NS_ID + '-review-tools';
function botFilesFor(botId, extra = {}) {
	const bot = { ...BOT_JSON, botId, ...extra };
	return [
		{ path: '.agent.md', data: Buffer.from(AGENT_MD) },
		{ path: 'bot.json', data: Buffer.from(JSON.stringify(bot)) },
		{ path: 'skills/review-checklist/SKILL.md', data: Buffer.from(SKILL_MD) },
		{ path: 'mcp/review-tools/config.json', data: Buffer.from(MCP_CONFIG) },
		{ path: 'mcp/review-tools/server.js', data: Buffer.from('// server\n') },
	];
}
{
	const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-bot-plain-'));
	try {
		await installBundle({ dataRoot: plainRoot, kind: 'agent', storeId: SLUG, version: VERSION, files: botFilesFor(SLUG, { namespace: false }) });
	} catch { /* 下面断言 */ }
	check('⑥-1 显式 namespace:false 仍是逃生门：落位保持裸名（老包 / 固定技能名兼容）',
		fs.existsSync(path.join(plainRoot, 'skills', 'review-checklist', 'SKILL.md'))
		&& !fs.existsSync(path.join(plainRoot, 'skills', DEF_SKILL)));
	fs.rmSync(plainRoot, { recursive: true, force: true });
}
{
	const defaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-bot-default-'));
	try {
		await installBundle({ dataRoot: defaultRoot, kind: 'agent', storeId: SLUG, version: VERSION, files: botFilesFor(SLUG) });
	} catch { /* 下面断言 */ }
	check('⑥-16 未声明 namespace ⇒ 默认按 <botId>- 前缀落位',
		fs.existsSync(path.join(defaultRoot, 'skills', DEF_SKILL, 'SKILL.md'))
		&& !fs.existsSync(path.join(defaultRoot, 'skills', 'review-checklist', 'SKILL.md')));
	fs.rmSync(defaultRoot, { recursive: true, force: true });
}
check('⑥-18 缺省与 namespace:true 的前缀完全一致；显式 false 才是空前缀（不许两条路径漂移）',
	!!botPack?.componentIdMap
	&& botPack.componentIdMap({ ...BOT_JSON, botId: NS_ID }).prefix
		=== botPack.componentIdMap({ ...BOT_JSON, botId: NS_ID, namespace: true }).prefix
	&& botPack.componentIdMap({ ...BOT_JSON, botId: NS_ID, namespace: false }).prefix === '');
{
	// 迁移：老包（显式 false，裸名落位）升级到默认开启的新版本 ⇒ 裸名组件必须被清掉，
	// 否则数据根里同时留着两份技能（dsh 里还同名）+ 一条指向旧目录的 MCP 行。
	const migRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-bot-migrate-'));
	try {
		await installBundle({ dataRoot: migRoot, kind: 'agent', storeId: SLUG, version: '0.9.0', files: botFilesFor(SLUG, { namespace: false }) });
	} catch { /* 下面断言 */ }
	const oldSkill = path.join(migRoot, 'skills', 'review-checklist', 'SKILL.md');
	const hadOld = fs.existsSync(oldSkill);
	try {
		await installBundle({ dataRoot: migRoot, kind: 'agent', storeId: SLUG, version: VERSION, files: botFilesFor(SLUG), upgrade: true });
	} catch { /* 下面断言 */ }
	check('⑥-17 老包升级到默认开启 ⇒ 裸名旧组件被清理、新组件就位（不残留 / 不重复注册 MCP）',
		hadOld && !fs.existsSync(oldSkill)
		&& fs.existsSync(path.join(migRoot, 'skills', DEF_SKILL, 'SKILL.md'))
		&& !(await readMcpJson(migRoot)).servers?.['review-tools']
		&& !!(await readMcpJson(migRoot)).servers?.[DEF_MCP]);
	fs.rmSync(migRoot, { recursive: true, force: true });
}
const p1Root = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-bot-p1-'));
let p1Res = null;
try {
	p1Res = await installBundle({
		dataRoot: p1Root, kind: 'agent', storeId: NS_ID, version: VERSION,
		files: botFilesFor(NS_ID, { namespace: true }),
	});
} catch (e) { p1Res = { error: e }; }
check('⑥-2 namespace:true ⇒ 技能落 <数据根>/skills/<botId>-<skill>/',
	fs.existsSync(path.join(p1Root, 'skills', NS_SKILL, 'SKILL.md')));
let p1Mcp = null;
try { p1Mcp = await readMcpJson(p1Root); } catch { /* 下面断言 */ }
check('⑥-3 namespace:true ⇒ MCP 落 <botId>-<server>/ 且 mcp.json 用同一 key',
	fs.existsSync(path.join(p1Root, 'mcp', NS_MCP, 'config.json')) && !!p1Mcp?.servers?.[NS_MCP]);
const p1Md = fs.existsSync(path.join(p1Root, 'agents', NS_ID, '.agent.md'))
	? fs.readFileSync(path.join(p1Root, 'agents', NS_ID, '.agent.md'), 'utf8') : '';
check('⑥-4 .agent.md 的 skills: 同步改写为新 id（否则 Bot 找不到自己的技能）',
	p1Md.includes('skills: ' + NS_SKILL) && !/skills:\s*review-checklist/.test(p1Md));
check('⑥-5 .agent.md 的 tools: 里 mcp__<server>__* 同步改写',
	p1Md.includes('mcp__' + NS_MCP + '__*') && !p1Md.includes('mcp__review-tools__'));
let p1Bot = null;
try { p1Bot = JSON.parse(fs.readFileSync(path.join(p1Root, 'agents', NS_ID, 'bot.json'), 'utf8')); } catch { /* 下面断言 */ }
check('⑥-6 落盘 bot.json 记录实际落位 id，供级联卸载反查',
	p1Bot?.installedComponents?.skills?.[0] === NS_SKILL
	&& p1Bot?.installedComponents?.mcpServers?.[0] === NS_MCP);
const p1SkillMd = fs.existsSync(path.join(p1Root, 'skills', NS_SKILL, 'SKILL.md'))
	? fs.readFileSync(path.join(p1Root, 'skills', NS_SKILL, 'SKILL.md'), 'utf8') : '';
check('⑥-14 技能 SKILL.md 的 name 也同步命名空间化（否则 dsh 用 frontmatter name 做 id ⇒ 两包仍撞名）',
	new RegExp('^name:\\s*' + NS_SKILL + '\\s*$', 'm').test(p1SkillMd));
try {
	await installBundle({
		dataRoot: p1Root, kind: 'agent', storeId: NS_ID2, version: VERSION,
		files: botFilesFor(NS_ID2, { namespace: true }),
	});
} catch { /* 下面断言 */ }
check('⑥-7 两个不同 Bot 包用同名技能 + namespace ⇒ 都能装成功（下载即可用）',
	fs.existsSync(path.join(p1Root, 'skills', NS_SKILL, 'SKILL.md'))
	&& fs.existsSync(path.join(p1Root, 'skills', NS_ID2 + '-review-checklist', 'SKILL.md')));
try { await uninstallBundle({ dataRoot: p1Root, kind: 'agent', storeId: NS_ID }); } catch { /* 下面断言 */ }
check('⑥-8 卸载按实际落位 id 清理：不残留、也不误删另一个包',
	!fs.existsSync(path.join(p1Root, 'skills', NS_SKILL, 'SKILL.md'))
	&& fs.existsSync(path.join(p1Root, 'skills', NS_ID2 + '-review-checklist', 'SKILL.md'))
	&& !(await readMcpJson(p1Root)).servers?.[NS_MCP]);
check('⑥-9 非法 namespace 值被发布预检拒掉',
	!!botPack?.validateBotPack && (() => {
		try {
			botPack.validateBotPack(botFilesFor(NS_ID, { namespace: 'BAD/../' }),
				{ ...BOT_JSON, botId: NS_ID, namespace: 'BAD/../' });
			return false;
		} catch { return true; }
	})());
check('⑥-10 satisfiesRange 支持 ^ / ~ / 比较区间 / ||，不可解析返回 null',
	!!botPack?.satisfiesRange
	&& botPack.satisfiesRange('1.9.0', '^1.2.3') === true
	&& botPack.satisfiesRange('2.0.0', '^1.2.3') === false
	&& botPack.satisfiesRange('1.2.9', '~1.2.3') === true
	&& botPack.satisfiesRange('1.3.0', '~1.2.3') === false
	&& botPack.satisfiesRange('0.3.0', '>=0.2.1 <0.4.0') === true
	&& botPack.satisfiesRange('0.5.0', '>=0.2.1 <0.4.0') === false
	&& botPack.satisfiesRange('1.0.0', 'not-a-range') === null);
check('⑥-11 依赖不满足 ⇒ ok:false；查不到的如实标 unknown（不假装满足）',
	!!botPack?.checkBotRequires
	&& botPack.checkBotRequires({ requires: { foo: '^2.0.0' } }, { foo: '1.0.0' }).ok === false
	&& botPack.checkBotRequires({ requires: { foo: '^2.0.0' } }, { foo: '1.0.0' }).results[0].state === 'incompatible'
	&& botPack.checkBotRequires({ requires: { bar: '>=1.0.0' } }, {}).results[0].state === 'unknown');
check('⑥-12 非法版本范围在发布预检就被拒（不是留到安装时装不上）',
	!!botPack?.validateBotPack && (() => {
		try {
			botPack.validateBotPack(botFilesFor(NS_ID), { ...BOT_JSON, botId: NS_ID, requires: { x: 'not-a-range' } });
			return false;
		} catch { return true; }
	})());
check('⑥-13 安装回执如实列出依赖状态（不把 unknown 说成已满足）',
	p1Res?.requires?.results?.some(r => r.state === 'unknown') === true);
{
	const indexSrc = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
	const clientSrc = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
	check('⑥-15 依赖状态一路透到前端提示（unknown 不许伪装成已满足）',
		/installed\.requires/.test(indexSrc) && /res\.botRequires/.test(clientSrc));
}
fs.rmSync(p1Root, { recursive: true, force: true });

fs.rmSync(dataRoot, { recursive: true, force: true });
fs.rmSync(authorRoot, { recursive: true, force: true });
console.log(`\n[bot-e2e] ${pass} passing / ${fails.length} failing`);
for (const f of fails) { console.log(`  ✗ ${f}`); }
process.exit(fails.length ? 1 : 0);
