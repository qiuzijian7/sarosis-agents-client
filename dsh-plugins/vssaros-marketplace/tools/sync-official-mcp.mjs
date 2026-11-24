#!/usr/bin/env node
/**
 * 把「Epic 官方 Unreal MCP」登记进 VsSaros 商城（dsh 侧）。
 *
 * 为什么单独一个脚本（不塞进 sync-dsb-mcp.mjs 的 SOURCE）：
 *   商城现有 MCP 商品里，134 个来自 Cline（github-source 仓库型）、38 个来自 DS Bot
 *   （远程 https 端点，sync-dsb-mcp.mjs），另有 jl-codes-unreal-5-mcp 这个**社区 fork**。
 *   Epic 官方 Unreal MCP 不属于以上任何一类：它是**本机 loopback 端点** —— MCP server 内嵌
 *   在 Unreal Editor 进程里，只监听 127.0.0.1:8000/mcp，无认证。塞进 DS Bot 清单会打上
 *   「dsb-」前缀与「来源：DeepSeek-Bot catalog」的错误出处，还会缺品牌图标资产。
 *
 * 商品只登记连接配置，**不安装编辑器 / 引擎插件**（部署前提完整写在 description 里，
 * 不制造「装了连不上」的商品）。走 bundle 通道 publishVersion()：包内只有
 * `<slug>/config.json`，安装侧 registerMcpServer → toMcpEntry 把它写成
 * `<数据根>/mcp.json` 的 servers[<slug>]：
 *   { disabled:false, type:'http', url:'http://127.0.0.1:8000/mcp' }
 * vssaros-mcp 的 parseMcpServers 归一化成 streamable-http 后运行时挂载；该条目没有 headers
 * ⇒ 直连、不经过凭据网关，因此不受网关「只放行 https 上游」那条约束（loopback http 可用）。
 *
 * 与本项目自带的 unreal_* 工具集（HTTP REST Bridge，默认 127.0.0.1:8765）端口不同，可并存。
 *
 * 图标（tools/official-mcp-icons.json）：128×128 透明 PNG 的 base64，与 dsb-marks-png.json
 * 同口径 —— 服务端 /api/v1/covers 白名单不收 svg，且 data: URI 在真机图标块里会落成
 * 乱码 ⇒ 只能上传自持 PNG，再把 icon 写成绝对 http URL。图形是 Unreal Engine 官方 U 标
 * （Simple Icons `unrealengine`，CC0 矢量复刻），墨色 #18181B 与 DS Bot 那批品牌图标一致。
 *
 * 用法（在 dsh-plugins/vssaros-marketplace 下执行）：
 *   node tools/sync-official-mcp.mjs --dry            # 只列计划（不写服务器）
 *   node tools/sync-official-mcp.mjs                  # 登记（幂等：已存在则跳过）
 *   node tools/sync-official-mcp.mjs --icons --dry    # 预览图标回填
 *   node tools/sync-official-mcp.mjs --icons          # 上传官方 logo 并回填 icon 字段
 *
 * 前置：~/.vssaros-dev/dsh-home/.credentials.yaml（或 ~/.vssaros/dsh-home/）里有
 *       VSSAROS_TOF_TICKET_DSH + VSSAROS_TOF_IDENTITY_DSH；内网可达
 *       MARKET_ENDPOINT（默认 http://21.91.158.20:3040）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');
const ENDPOINT = (process.env.MARKET_ENDPOINT || 'http://21.91.158.20:3040').replace(/\/+$/, '');
const DRY = process.argv.includes('--dry');
const ICONS = process.argv.includes('--icons');

/** 服务端自持封面 URL（isImageIcon 只认 https?://；data: URI 在真机会落成乱码）。 */
const iconUrlOf = slug => ENDPOINT + '/covers/' + slug + '.png';
/** 128×128 透明 PNG 的 base64 —— 只在 --icons 时读，脚本单独拷走也能照常登记。 */
function iconAssets() {
	return JSON.parse(fs.readFileSync(path.join(HERE, 'official-mcp-icons.json'), 'utf8'));
}

/** 官方 / 第一方 MCP 清单。以后新增同类条目在这里加一条即可，登记逻辑不用改。 */
const OFFICIAL_MCP = [
	{
		slug: 'unreal-official-mcp',
		name: 'Unreal 官方 MCP（UE 5.8）',
		icon: iconUrlOf('unreal-official-mcp'),
		tags: ['official-mcp', 'first-party', 'local-http', 'unreal', 'ue5.8', 'none'],
		config: {
			version: '1.0.0',
			transport: 'http',
			url: 'http://127.0.0.1:8000/mcp',
		},
		description: [
			'Epic 官方随 Unreal Engine 5.8 提供的 Unreal MCP 插件（引擎内标识 ModelContextProtocol）。',
			'MCP server 内嵌在 Unreal Editor 进程里，以标准 MCP（Streamable HTTP / JSON-RPC）暴露数百个按 Toolset 分组的编辑器能力：场景与 Actor、材质实例、资产、Slate 检查、自动化测试等，默认由 Tool Search 折叠控制上下文体积。',
			'',
			'本机 MCP 端点：http://127.0.0.1:8000/mcp',
			'免登录：官方插件没有认证层，只绑定 127.0.0.1，安装后无需任何凭据；请勿把该端口暴露到公网。',
			'',
			'★ 安装前请在本机准备好（本商品只登记连接配置，不安装 Unreal Editor 或引擎插件）：',
			'  1. 使用 Unreal Engine 5.8 或更高版本；',
			'  2. 在编辑器插件管理里启用 Unreal MCP（ModelContextProtocol）与 All Toolsets；',
			'  3. 开启 Auto Start Server，或在编辑器控制台执行 ModelContextProtocol.StartServer；',
			'  4. 保持编辑器运行，且 8000 端口未被占用。',
			'编辑器未启动 / 插件未启用时会连接失败，可在连接器里先停用本条目。',
			'',
			'与本项目自带的 unreal_* 工具集（HTTP REST Bridge，默认 127.0.0.1:8765）端口不同，可同时启用：官方 MCP 面向任意 MCP 客户端、工具粒度细；unreal_* 是 7 个通用执行 / 内省原语。',
			'Epic 将该插件标注为 Experimental，API 与数据格式可能变更。',
			'来源：Epic Unreal Engine 5.8 ModelContextProtocol 插件；本项目 docs/Unreal工具使用说明.html §6。',
		].join('\n'),
	},
];

const {
	createMarketClient, MARKET_JWT_REF, TOF_LOCAL_TICKET_REF, TOF_IDENTITY_REF,
} = await import(pathToFileURL(path.join(LIB, 'marketClient.js')).href);
const { publishVersion } = await import(pathToFileURL(path.join(LIB, 'publisher.js')).href);

/** 与 sync-dsb-mcp.mjs 同款：yaml 的 key 映射成客户端固定 ref（dev / 生产两套 home 都认）。 */
function loadTofCredentials() {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
	const candidates = [
		path.join(home, '.vssaros-dev', 'dsh-home', '.credentials.yaml'),
		path.join(home, '.vssaros', 'dsh-home', '.credentials.yaml'),
	];
	const store = new Map();
	for (const file of candidates) {
		if (!fs.existsSync(file)) { continue; }
		const text = fs.readFileSync(file, 'utf8');
		const grab = key => {
			const m = new RegExp(key + '[ \\t]*:[ \\t]*(.+)$', 'm').exec(text);
			return m ? m[1].trim().replace(/^['"]/, '').replace(/['"]$/, '') : undefined;
		};
		const ticket = grab('VSSAROS_TOF_TICKET_DSH');
		const identity = grab('VSSAROS_TOF_IDENTITY_DSH');
		if (ticket) { store.set(TOF_LOCAL_TICKET_REF, ticket); }
		if (identity) { store.set(TOF_IDENTITY_REF, identity); }
		if (ticket) { break; }
	}
	return store;
}

const kv = loadTofCredentials();
const credentials = {
	resolve: async ref => (kv.has(ref) ? { value: kv.get(ref) } : undefined),
	set: async (ref, value) => { kv.set(ref, value); },
	unset: async ref => { kv.delete(ref); },
};
const market = createMarketClient({ credentials, config: { marketEndpoint: ENDPOINT }, log: () => {} });

/** 服务端现有 kind=mcp 的 slug 集合（分页），幂等：已存在就跳过，不叠版本、不覆盖别人的商品。 */
async function existingSlugs() {
	const out = new Set();
	for (let page = 1; page <= 20; page++) {
		const j = await market.request('GET', '/packages?kind=mcp&pageSize=100&page=' + page);
		const items = j?.items ?? [];
		for (const it of items) { out.add(String(it.slug)); }
		if (!items.length || (typeof j?.total === 'number' && out.size >= j.total)) { break; }
	}
	return out;
}

const existing = await existingSlugs();
const targets = OFFICIAL_MCP.filter(spec => !existing.has(spec.slug));
console.log(`商城现有 MCP 商品 ${existing.size} 个；官方 MCP 清单 ${OFFICIAL_MCP.length} 个；mode=${DRY ? 'DRY' : 'WRITE'}`);
console.log(`已有跳过 ${OFFICIAL_MCP.length - targets.length} 个；本次待登记 ${targets.length} 个`);

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-official-mcp-'));
let ok = 0;
const failures = [];
try {
	for (const spec of targets) {
		const dir = path.join(dataRoot, 'mcp', spec.slug);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(spec.config, null, 2));
		console.log(`  ${spec.slug}\n    ${JSON.stringify(spec.config)}`);
		if (DRY) { continue; }
		try {
			const r = await publishVersion({
				market, dataRoot, kind: 'mcp', localId: spec.slug, version: '1.0.0',
				changelog: 'Epic 官方 Unreal Engine 5.8 ModelContextProtocol 插件的本机 MCP 端点',
				meta: {
					name: spec.name,
					category: 'MCP',
					description: spec.description,
					tags: spec.tags,
					icon: spec.icon,
				},
			});
			ok++;
			console.log(`  OK  ${spec.slug} v${r.version} bytes=${r.bytes}`);
		} catch (e) {
			failures.push({ id: spec.slug, error: String(e?.message ?? e).slice(0, 240) });
			console.error(`  FAIL ${spec.slug}: ${String(e?.message ?? e).slice(0, 200)}`);
		}
	}
} finally {
	fs.rmSync(dataRoot, { recursive: true, force: true });
}

// ── 图标回填：官方 logo 传成服务端自持 PNG，icon 写绝对 http URL ──
// ★ 不用 data URI：真机上长 base64 会被图标块当成短文本居中截断，显示成乱码字母。
// 幂等：先 GET 详情比对，icon 相同就跳过，不重复上传/写库。
// 已存在的包走 ensurePackage 的 409 分支不会更新 meta ⇒ 图标必须靠这里显式回填。
let iconsOk = 0;
const iconFailures = [];
if (ICONS) {
	let assets = {};
	try { assets = iconAssets(); }
	catch (e) { iconFailures.push({ id: '(assets)', error: String(e?.message ?? e).slice(0, 240) }); }
	let coverToken = '';
	if (!DRY) { coverToken = await market.login(); }
	for (const spec of OFFICIAL_MCP) {
		const png = assets[spec.slug];
		const iconUrl = iconUrlOf(spec.slug);
		if (!png) {
			iconFailures.push({ id: spec.slug, error: 'official-mcp-icons.json 里缺这个 slug 的 PNG base64' });
			continue;
		}
		if (DRY) {
			console.log(`  ICON DRY ${spec.slug} ${iconUrl} bytes=${Buffer.from(png, 'base64').length}`);
			continue;
		}
		try {
			const detail = await market.request('GET', '/packages/' + encodeURIComponent(spec.slug));
			if (String(detail?.icon ?? '') === iconUrl) { console.log(`  ICON SKIP ${spec.slug}`); continue; }
			const up = await fetch(ENDPOINT + '/api/v1/covers?' + new URLSearchParams({ slug: spec.slug, ext: 'png' }), {
				method: 'POST',
				headers: { authorization: 'Bearer ' + coverToken, 'content-type': 'application/octet-stream' },
				body: Buffer.from(png, 'base64'),
				signal: AbortSignal.timeout(30_000),
			});
			const text = await up.text();
			let upUrl = '';
			try { upUrl = JSON.parse(text).url ?? ''; } catch { /* 非 JSON */ }
			if (!up.ok || !upUrl) { throw new Error(`封面上传失败 HTTP ${up.status} ${text.slice(0, 120)}`); }
			await market.updatePackage(spec.slug, { icon: iconUrl });
			iconsOk++;
			console.log(`  ICON OK  ${spec.slug} ${iconUrl}`);
		} catch (e) {
			iconFailures.push({ id: spec.slug, error: String(e?.message ?? e).slice(0, 240) });
			console.error(`  ICON FAIL ${spec.slug}: ${String(e?.message ?? e).slice(0, 200)}`);
		}
	}
}

console.log(`\n结果：登记成功 ${ok} / 登记失败 ${failures.length} / 跳过(已存在) ${OFFICIAL_MCP.length - targets.length}；图标写入 ${iconsOk} / 图标失败 ${iconFailures.length}`);
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); }
if (iconFailures.length) { console.log(JSON.stringify(iconFailures, null, 2)); }
if (!DRY && (failures.length || iconFailures.length)) { process.exitCode = 1; }
