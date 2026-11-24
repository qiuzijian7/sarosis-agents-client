#!/usr/bin/env node
/**
 * 把 DeepSeek-Bot `connectors/catalog.js` 的远程 MCP 服务批量登记进 vssaros 商城。
 *
 * 为什么需要独立脚本：商城现有 134 个 MCP 商品来自 Cline MCP Marketplace 的
 * **GitHub 仓库型**（`github-source` distribution），而 DS Bot 这批是**纯远程 URL 端点**。
 * `publishDistribution` 只认 npm / github-release / github-source ⇒ 不能登记 URL；
 * 且 `locateInstallRoot()` 对 `github-source` 的 MCP 会抛「没有安装根」⇒ 装也装不了。
 * 所以这里走 **bundle 通道** `publishVersion()`：每个服务一个 `<dataRoot>/mcp/<slug>/config.json`，
 * 打包上传，安装侧由 `registerMcpServer → toMcpEntry` 写进 `mcp.json`，
 * 再由 vssaros-mcp 的运行时挂载 + 本地凭据网关消费。
 *
 * 凭据口径（重要，不制造「装了连不上」的商品）：
 *   · auth=none  ⇒ 免登录，装完即可用；
 *   · auth=oauth ⇒ config.json 里只写 `${env:MCP_<ID>_TOKEN}` 引用，用户用 mcp_secret
 *                  自备 OAuth token；缺变量时 parseMcpServers 如实跳过并给出原因；
 *   · auth=key   ⇒ Amap 走 query 参数 `${env:MCP_AMAP_KEY}`，网关转发时解析。
 * 任何明文凭据都不进 config.json / 商城包。
 *
 * 用法（在 dsh-plugins/vssaros-marketplace 下执行）：
 *   node tools/sync-dsb-mcp.mjs --dry                    # 只列计划（不写服务器）
 *   node tools/sync-dsb-mcp.mjs --dry --limit 3
 *   node tools/sync-dsb-mcp.mjs --limit 2               # 试跑 2 个
 *   node tools/sync-dsb-mcp.mjs                         # 全量 38 个
 *   node tools/sync-dsb-mcp.mjs --only notion,slack     # 指定 id
 *   node tools/sync-dsb-mcp.mjs --icons --dry           # 预览图标回填
 *   node tools/sync-dsb-mcp.mjs --icons                 # 把 38 个 DS Bot 品牌图标写入 icon 字段
 *
 * 前置：~/.vssaros-dev/dsh-home/.credentials.yaml 里有 VSSAROS_TOF_TICKET_DSH
 *       + VSSAROS_TOF_IDENTITY_DSH（票据单独用会被网关拒，必须带身份 fallback）；
 *       内网可达 MARKET_ENDPOINT（默认 http://21.6.92.5:3040）。
 * 幂等：先拉服务端已有 slug，存在的跳过（不覆盖别人的商品、不叠版本）。
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DSB_MARKS_SVG } from './dsb-marks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');
const ENDPOINT = (process.env.MARKET_ENDPOINT || 'http://21.6.92.5:3040').replace(/\/+$/, '');
/**
 * ★ 2026-11-10 修复「图标显示错误」：原先写 data:image/svg+xml base64，
 * 真机卡片上落成了 base64 中段乱码字母（长文本在 44px 图标块里居中截断）。
 * 商城前端 isImageIcon() 对所有版本都认 https?:// ⇒ 改成服务端自持 PNG 的绝对 URL。
 * 服务端 /api/v1/covers 白名单不含 svg ⇒ 用 dsb-marks-png.json（浏览器光栅化的透明 PNG）。
 */
const PNG_ASSETS = JSON.parse(fs.readFileSync(path.join(HERE, 'dsb-marks-png.json'), 'utf8'));
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
/** 复刻 DS Bot 每个 item 的品牌图标：上传自持 PNG，icon 写绝对 http URL。 */
const ICONS = argv.includes('--icons');
const LIMIT = (() => {
	const i = argv.indexOf('--limit');
	const n = i >= 0 ? Number(argv[i + 1]) : 0;
	return Number.isFinite(n) && n > 0 ? n : 0;
})();
const ONLY = (() => {
	const i = argv.indexOf('--only');
	return i >= 0 ? new Set(String(argv[i + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean)) : null;
})();

// ── 数据源：DS Bot connectors/catalog.js 的 38 个远程 MCP（mail 是 IMAP/SMTP，非 MCP ⇒ 排除）──
// 字段：[id, name, category, about, url, auth]
const SOURCE = [
	['github', 'GitHub', 'dev', 'Repositories, issues, and pull requests', 'https://api.githubcopilot.com/mcp/', 'oauth'],
	['notion', 'Notion', 'docs', 'Pages, databases, and wiki content', 'https://mcp.notion.com/mcp', 'oauth'],
	['linear', 'Linear', 'work', 'Issues, projects, and cycles', 'https://mcp.linear.app/mcp', 'oauth'],
	['atlassian', 'Atlassian', 'work', 'Jira issues and Confluence pages', 'https://mcp.atlassian.com/v1/mcp', 'oauth'],
	['sentry', 'Sentry', 'dev', 'Errors, traces, and releases', 'https://mcp.sentry.dev/mcp', 'oauth'],
	['stripe', 'Stripe', 'commerce', 'Payments, invoices, and customers', 'https://mcp.stripe.com', 'oauth'],
	['paypal', 'PayPal', 'commerce', 'Orders, payments, and invoices', 'https://mcp.paypal.com/mcp', 'oauth'],
	['square', 'Square', 'commerce', 'Payments, orders, and catalog', 'https://mcp.squareup.com/mcp', 'oauth'],
	['cloudflare', 'Cloudflare', 'dev', 'Workers, DNS, and account resources', 'https://bindings.mcp.cloudflare.com/mcp', 'oauth'],
	['vercel', 'Vercel', 'dev', 'Projects, deployments, and logs', 'https://mcp.vercel.com', 'oauth'],
	['supabase', 'Supabase', 'data', 'Databases, tables, and project settings', 'https://mcp.supabase.com/mcp', 'oauth'],
	['neon', 'Neon', 'data', 'Postgres databases and branches', 'https://mcp.neon.tech/mcp', 'oauth'],
	['figma', 'Figma', 'design', 'Design files, components, and comments', 'https://mcp.figma.com/mcp', 'oauth'],
	['canva', 'Canva', 'design', 'Designs, folders, and exports', 'https://mcp.canva.com/mcp', 'oauth'],
	['intercom', 'Intercom', 'work', 'Conversations, contacts, and articles', 'https://mcp.intercom.com/mcp', 'oauth'],
	['monday', 'monday.com', 'work', 'Boards, items, and workflows', 'https://mcp.monday.com/mcp', 'oauth'],
	['webflow', 'Webflow', 'design', 'Sites, pages, and CMS content', 'https://mcp.webflow.com/mcp', 'oauth'],
	['wix', 'Wix', 'design', 'Sites, pages, and site content', 'https://mcp.wix.com/mcp', 'oauth'],
	['netlify', 'Netlify', 'dev', 'Sites, deploys, and forms', 'https://netlify-mcp.netlify.app/mcp', 'oauth'],
	['airtable', 'Airtable', 'data', 'Bases, tables, and records', 'https://mcp.airtable.com/mcp', 'oauth'],
	['dropbox', 'Dropbox', 'docs', 'Files and folders', 'https://mcp.dropbox.com/mcp', 'oauth'],
	['zapier', 'Zapier', 'work', 'Zaps and app actions', 'https://mcp.zapier.com/api/mcp/mcp', 'oauth'],
	['clickup', 'ClickUp', 'work', 'Tasks, lists, and docs', 'https://mcp.clickup.com/mcp', 'oauth'],
	['todoist', 'Todoist', 'work', 'Tasks and projects', 'https://ai.todoist.net/mcp', 'oauth'],
	['miro', 'Miro', 'design', 'Boards and whiteboard items', 'https://mcp.miro.com/', 'oauth'],
	['attio', 'Attio', 'work', 'CRM records, lists, and notes', 'https://mcp.attio.com/mcp', 'oauth'],
	['postman', 'Postman', 'dev', 'Collections, requests, and workspaces', 'https://mcp.postman.com/mcp', 'oauth'],
	['asana', 'Asana', 'work', 'Tasks, projects, and workspaces', 'https://mcp.asana.com/v2/mcp', 'oauth'],
	['box', 'Box', 'docs', 'Files, folders, and metadata', 'https://mcp.box.com', 'oauth'],
	['hubspot', 'HubSpot', 'work', 'Contacts, deals, and tickets', 'https://mcp.hubspot.com/', 'oauth'],
	['slack', 'Slack', 'work', 'Channels and messages', 'https://mcp.slack.com/mcp', 'oauth'],
	['huggingface', 'Hugging Face', 'data', 'Models, datasets, and Spaces', 'https://huggingface.co/mcp', 'none'],
	['exa', 'Exa', 'search', 'Web search for agents', 'https://mcp.exa.ai/mcp', 'none'],
	['deepwiki', 'DeepWiki', 'docs', 'Documentation for public code repositories', 'https://mcp.deepwiki.com/mcp', 'none'],
	['context7', 'Context7', 'docs', 'Library documentation and code examples', 'https://mcp.context7.com/mcp', 'none'],
	['mslearn', 'Microsoft Learn', 'docs', 'Microsoft product documentation', 'https://learn.microsoft.com/api/mcp', 'none'],
	['cloudflare-docs', 'Cloudflare Docs', 'docs', 'Cloudflare product documentation', 'https://docs.mcp.cloudflare.com/mcp', 'none'],
	['amap', 'Amap', 'search', 'Maps, places, and routes in China', 'https://mcp.amap.com/mcp', 'key'],
];

const envNameOf = (id, field) => 'MCP_' + id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase() + '_' + field;

function specOf([id, name, category, about, url, auth]) {
	const tokenRef = '${env:' + envNameOf(id, 'TOKEN') + '}';
	const keyRef = '${env:' + envNameOf(id, 'KEY') + '}';
	const config = { version: '1.0.0', transport: 'http', url };
	if (auth === 'oauth') { config.headers = { Authorization: 'Bearer ' + tokenRef }; }
	if (auth === 'key') { config.query = { key: keyRef }; }
	if (id === 'github') {
		config.headers = { ...(config.headers ?? {}), 'X-MCP-Toolsets': 'context,repos,issues,pull_requests' };
	}
	const credNote = auth === 'none'
		? '免登录：安装后即可连接，无需任何凭据。'
		: auth === 'key'
			? '需要 API key：请用 mcp_secret 设置该服务的 key 字段（对应 ' + keyRef + '），或直接在 <数据根>/mcp-secrets.json 配置。'
			: '需要 OAuth token：本项目尚未提供浏览器授权流程，请用 mcp_secret 自备 token（对应 ' + tokenRef + '）；未设置时 mcp.json 会如实标为未配置，不会静默连接失败。';
	const description = about + '\n\n远程 MCP 端点：' + url + '\n' + credNote
		+ '\n来源：DeepSeek-Bot connectors/catalog.js（' + auth + '）';
	return {
		// slug 全局唯一（跨 kind），且服务端对历史删除的 slug 仍保留版本记录
		// ⇒ 用 dsb- 前缀避免与商城 7024 个已有包撞名，也标明来源便于批量管理/回滚。
		id, slug: 'dsb-' + id, name, category, auth, url, config,
		meta: {
			name,
			category: 'MCP',
			description,
			tags: ['dsb-connector', 'remote-mcp', auth],
		},
	};
}

const {
	createMarketClient, MARKET_JWT_REF, TOF_LOCAL_TICKET_REF, TOF_IDENTITY_REF,
} = await import(pathToFileURL(path.join(LIB, 'marketClient.js')).href);
const { publishVersion } = await import(pathToFileURL(path.join(LIB, 'publisher.js')).href);

/** 与 sync-cline-mcp.mjs 同款：yaml 的 key 要映射成客户端固定 ref。 */
function loadTofCredentials() {
	const file = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '',
		'.vssaros-dev', 'dsh-home', '.credentials.yaml');
	const store = new Map();
	if (!fs.existsSync(file)) { return store; }
	const text = fs.readFileSync(file, 'utf8');
	const grab = key => {
		const m = new RegExp(key + '[ \\t]*:[ \\t]*(.+)$', 'm').exec(text);
		return m ? m[1].trim().replace(/^['"]/, '').replace(/['"]$/, '') : undefined;
	};
	const ticket = grab('VSSAROS_TOF_TICKET_DSH');
	const identity = grab('VSSAROS_TOF_IDENTITY_DSH');
	if (ticket) { store.set(TOF_LOCAL_TICKET_REF, ticket); }
	if (identity) { store.set(TOF_IDENTITY_REF, identity); }
	return store;
}

const kv = loadTofCredentials();
const credentials = {
	resolve: async ref => (kv.has(ref) ? { value: kv.get(ref) } : undefined),
	set: async (ref, value) => { kv.set(ref, value); },
	unset: async ref => { kv.delete(ref); },
};
const market = createMarketClient({ credentials, config: { marketEndpoint: ENDPOINT }, log: () => {} });

/** 服务端现有 kind=mcp 的 slug 集合（分页），避免覆盖已有商品。 */
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
console.log(`商城现有 MCP 商品 ${existing.size} 个；DS Bot 远程 MCP ${SOURCE.length} 个；mode=${DRY ? 'DRY' : 'WRITE'}`);

let targets = SOURCE.map(specOf).filter(s => !ONLY || ONLY.has(s.id));
const skipped = targets.filter(s => existing.has(s.slug));
targets = targets.filter(s => !existing.has(s.slug));
if (LIMIT) { targets = targets.slice(0, LIMIT); }
console.log(`已有跳过 ${skipped.length} 个；本次待登记 ${targets.length} 个`);

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-dsb-mcp-'));
let ok = 0;
const failures = [];
try {
	for (const spec of targets) {
		const dir = path.join(dataRoot, 'mcp', spec.slug);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(spec.config, null, 2));
		if (DRY) {
			console.log(`  DRY ${spec.slug.padEnd(22)} ${spec.auth.padEnd(6)} ${spec.url}`);
			continue;
		}
		try {
			const r = await publishVersion({
				market, dataRoot, kind: 'mcp', localId: spec.slug, version: '1.0.0',
				changelog: '来自 DeepSeek-Bot connectors/catalog.js 的远程 MCP 端点',
				meta: spec.meta,
			});
			ok++;
			console.log(`  OK  ${spec.slug.padEnd(22)} v${r.version} bytes=${r.bytes}`);
		} catch (e) {
			failures.push({ id: spec.slug, error: String(e?.message ?? e).slice(0, 240) });
			console.error(`  FAIL ${spec.slug}: ${String(e?.message ?? e).slice(0, 200)}`);
		}
	}
} finally {
	fs.rmSync(dataRoot, { recursive: true, force: true });
}

// ── 图标回填：每个 item 用 DS Bot 同款品牌图标（SVG → 透明 PNG → 自持 URL）──
// ★ 不用 data URI：真机上长 base64 被图标块当作短文本居中截断，显示成乱码字母。
//   绝对 http URL 是商城前端所有版本都认的图片形态（isImageIcon: /^(https?:\/\/|data:image\/)/）。
// 幂等：先 GET 详情比对，icon 相同就跳过，不重复上传/写库。
let iconsOk = 0;
const iconFailures = [];
if (ICONS) {
	let coverToken = '';
	if (!DRY) { coverToken = await market.login(); }
	for (const spec of SOURCE.map(specOf).filter(s => !ONLY || ONLY.has(s.id))) {
		const png = PNG_ASSETS[spec.id];
		if (!png || !DSB_MARKS_SVG[spec.id]) {
			iconFailures.push({ id: spec.slug, error: '缺少 SVG/PNG 图标资产' });
			continue;
		}
		const iconUrl = ENDPOINT + '/covers/' + spec.slug + '.png';
		if (DRY) { console.log(`  ICON DRY ${spec.slug.padEnd(22)} ${iconUrl}`); continue; }
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
			console.log(`  ICON OK  ${spec.slug.padEnd(22)} ${iconUrl}`);
		} catch (e) {
			iconFailures.push({ id: spec.slug, error: String(e?.message ?? e).slice(0, 240) });
			console.error(`  ICON FAIL ${spec.slug}: ${String(e?.message ?? e).slice(0, 200)}`);
		}
	}
}

console.log(`\n结果：登记成功 ${ok} / 登记失败 ${failures.length} / 跳过(已存在) ${skipped.length}；图标写入 ${iconsOk} / 图标失败 ${iconFailures.length}`);
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); }
if (iconFailures.length) { console.log(JSON.stringify(iconFailures, null, 2)); }
if (!DRY && (failures.length || iconFailures.length)) { process.exitCode = 1; }
