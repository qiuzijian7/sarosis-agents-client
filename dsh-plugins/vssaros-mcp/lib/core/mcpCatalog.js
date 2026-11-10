// @vssaros/dsh-mcp — 远程 MCP 服务目录（dsh 侧真源，纯逻辑）。
//
// 为什么先只放免登录服务可安装：带 OAuth / API-key 的服务需要「本地反向网关 + secrets 存储 +
// 401 刷新」这套凭据隔离（上游 DS Bot `connectors/gateway.js` 的做法）。当前 dsh 侧没有它，
// 若允许安装，写进 mcp.json 的条目会**永远连不上**（典型的「装好了没生效」）。
// ⇒ 目录里保留这些条目供浏览（标注需凭据），但 planCatalogInstall 明确拒绝，不制造静默失败。
// 网关落地后只需把 auth 门槛放开，目录数据不必重写。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretEnvName } from './mcpSecrets.js';

const CATALOG = JSON.parse(readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), 'mcpCatalog.json'), 'utf8',
));

export const catalogVersion = CATALOG.version;
export const catalogPolicy = CATALOG.policy;

/** 只读浏览；每项附 `installable`（auth=none 才可一键安装）。 */
export function listCatalog({ query, category, installableOnly = false } = {}) {
	const q = String(query ?? '').trim().toLowerCase();
	const cat = String(category ?? '').trim().toLowerCase();
	return CATALOG.entries
		.filter(entry => !cat || entry.category === cat)
		.filter(entry => !installableOnly || entry.auth === 'none')
		.filter(entry => !q || `${entry.id} ${entry.name} ${entry.about} ${entry.category}`.toLowerCase().includes(q))
		.map(entry => ({ ...entry, installable: entry.auth === 'none' }));
}

export function catalogEntryOf(id) {
	return CATALOG.entries.find(entry => entry.id === String(id ?? '').trim());
}

/**
 * 按目录 id 组装安装计划（纯函数，不写盘）。写 `servers`、条目形如 `{type:'http',url}`、
 * 同名不覆盖、清掉历史 `mcpServers`、其它顶层键原样保留（与 planMcpInstall 同口径）。
 */
export function planCatalogInstall({ id, raw = {}, env = {} } = {}) {
	const entry = catalogEntryOf(id);
	if (!entry) {
		throw new Error(`目录里没有「${String(id ?? '')}」（用 mcp_catalog 的 list 看可用项）`);
	}
	if (entry.auth === 'oauth') {
		throw new Error(`${entry.name} 需要 OAuth 授权；目录尚未提供 discovery / DCR / PKCE / refresh 流程，不能写入永远连不上的条目。`
			+ '可改用自定义 http 条目：mcp.json 的 headers 写 ${env:MCP_<ID>_<FIELD>} 引用，再用 mcp_secret 设置真值。');
	}
	// key 型：凭据仓库已落地 ⇒ 只要对应引用可解析就放行；没设置则明确拒绝（不写永远连不上的条目）。
	const secretRef = secretEnvName(entry.id, 'key');
	if (entry.auth === 'key' && !env?.[secretRef]) {
		throw new Error(`${entry.name} 需要 API key：请先用 mcp_secret 设置 ${entry.id} 的 key 字段（对应 ${'${env:' + secretRef + '}'}）。`);
	}
	if (!/^https:\/\//i.test(entry.url)) {
		throw new Error(`${entry.name} 的端点不是 https（${entry.url}），拒绝写入。`);
	}
	const legacy = raw?.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers) ? raw.mcpServers : {};
	const current = raw?.servers && typeof raw.servers === 'object' && !Array.isArray(raw.servers) ? raw.servers : {};
	const servers = { ...legacy, ...current };
	if (servers[entry.id]) {
		throw new Error(`mcp.json 里已有「${entry.id}」（不覆盖；要改先删掉再装）。`);
	}
	const server = { type: 'http', url: entry.url };
	// headers / query 里都是 ${env:...} 模板（真值由凭据仓库与网关在转发时解析），
	// mcp.json 本身不含任何明凭据。
	if (entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)) { server.headers = entry.headers; }
	if (entry.query && typeof entry.query === 'object' && !Array.isArray(entry.query)) { server.query = entry.query; }
	servers[entry.id] = server;
	const next = { ...raw, servers };
	delete next.mcpServers;
	return { next, entry, name: entry.id };
}
