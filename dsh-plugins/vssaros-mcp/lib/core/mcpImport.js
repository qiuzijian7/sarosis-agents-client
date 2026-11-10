// @vssaros/dsh-mcp — 从 Claude Desktop / Cursor / VS Code 的 MCP 配置迁移进来。
//
// 照上游 DS Bot `connectors/index.js:563-610` 的两个纪律：
//   ① **只读扫描**：源文件一个字节都不改；文件不存在/坏 JSON 是常态（多数人只装了其中一两个 app），静默跳过；
//   ② **扫描结果不给凭据值**：只返回 env / headers 的**键名**，值只在用户显式 `apply` 时才写进 mcp.json。
// 与本项目口径对齐：写 `servers`（不是 `mcpServers`）、条目带 `type`、stdio 显式 `approved:false`、
// sse 与残留 `${...}` 占位符一律跳过、同名不覆盖、其它顶层键原样保留。
//
// 纯逻辑（不碰 fs / 不读进程环境作为默认行为）⇒ 守卫可用内存 fixture 完整跑。

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

/** 与 `planMcpInstall` 的 serverName 约束同形（由 ⑧ 守卫钉住）。 */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const PLACEHOLDER_RE = /\$\{[^}]*\}/;

/** 三个来源与跨平台路径；参数化是为了守卫能测 win32/darwin/linux 三条分支。 */
export function importSourcePaths({ env = process.env, home = homedir(), os = platform() } = {}) {
	const appData = os === 'win32' ? (env.APPDATA || join(home, 'AppData', 'Roaming')) : null;
	const claude = os === 'darwin'
		? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
		: os === 'win32' ? join(appData, 'Claude', 'claude_desktop_config.json')
			: join(home, '.config', 'Claude', 'claude_desktop_config.json');
	const vscode = os === 'darwin'
		? join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
		: os === 'win32' ? join(appData, 'Code', 'User', 'mcp.json')
			: join(home, '.config', 'Code', 'User', 'mcp.json');
	return [
		{ source: 'claude', key: 'mcpServers', path: claude },
		{ source: 'cursor', key: 'mcpServers', path: join(home, '.cursor', 'mcp.json') },
		{ source: 'vscode', key: 'servers', path: vscode },
	];
}

/** 只读扫描。`read` 可注入；返回内部用的 `spec`，但**不要直接把它交给模型/页面**（用 toImportView 脱敏）。 */
export async function scanImportSources({ sources, read = readFile, paths = importSourcePaths() } = {}) {
	const items = [];
	const wanted = Array.isArray(sources) && sources.length ? new Set(sources.map(String)) : null;
	for (const src of paths) {
		if (wanted && !wanted.has(src.source)) { continue; }
		let parsed;
		try { parsed = JSON.parse(await read(src.path, 'utf8')); }
		catch { continue; }
		const servers = parsed?.[src.key];
		if (!servers || typeof servers !== 'object' || Array.isArray(servers)) { continue; }
		for (const [name, spec] of Object.entries(servers)) {
			if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { continue; }
			items.push({ source: src.source, key: `${src.source}:${name}`, name, spec });
		}
	}
	return items;
}

export function transportOf(spec = {}) {
	const type = String(spec?.type ?? '').toLowerCase();
	if (type === 'sse') { return 'sse'; }
	if (type === 'http' || typeof spec.url === 'string' || typeof spec.serverUrl === 'string') { return 'http'; }
	if (type === 'stdio' || typeof spec.command === 'string') { return 'stdio'; }
	return '';
}

/** URL 里的 query 常带 API key ⇒ 只留 origin + pathname。 */
function safeTarget(text) {
	try {
		const url = new URL(text);
		return `${url.origin}${url.pathname}${url.search ? '?<redacted>' : ''}`;
	} catch { return String(text ?? '').slice(0, 200); }
}

/** 给模型/页面的脱敏视图：只有键名，没有值。 */
export function toImportView(items = []) {
	return items.map(item => {
		const spec = item.spec ?? {};
		const target = typeof spec.url === 'string' || typeof spec.serverUrl === 'string'
			? safeTarget(spec.url ?? spec.serverUrl)
			: [spec.command, ...(Array.isArray(spec.args) ? spec.args : [])].filter(x => typeof x === 'string').join(' ');
		return {
			key: item.key,
			source: item.source,
			name: item.name,
			transport: transportOf(spec),
			target: String(target ?? '').slice(0, 200),
			envKeys: Object.keys(spec.env ?? {}),
			headerKeys: Object.keys(spec.headers ?? {}),
		};
	});
}

/**
 * 组装导入后的 mcp.json（纯函数，不写盘）。
 * `picked` 是 `source:name` 数组；不传 = 全选。返回 `{ next, added, skipped }`。
 */
export function planImport({ items = [], picked, raw = {} } = {}) {
	const wanted = Array.isArray(picked) && picked.length ? new Set(picked.map(String)) : null;
	const legacy = raw?.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers) ? raw.mcpServers : {};
	const current = raw?.servers && typeof raw.servers === 'object' && !Array.isArray(raw.servers) ? raw.servers : {};
	const servers = { ...legacy, ...current };
	const added = [];
	const skipped = [];
	const skip = (name, reason) => skipped.push({ name, reason });
	for (const item of items) {
		if (wanted && !wanted.has(item.key)) { continue; }
		const spec = item.spec ?? {};
		const transport = transportOf(spec);
		if (!MCP_SERVER_NAME_RE.test(item.name)) { skip(item.key, `名字不满足 dsh 的 [A-Za-z0-9_-]{1,32}：${item.name}`); continue; }
		if (servers[item.name]) { skip(item.key, 'mcp.json 里已有同名服务器（不覆盖）'); continue; }
		if (transport === 'sse') { skip(item.key, 'sse 传输 dsh 侧不支持'); continue; }
		if (!transport) { skip(item.key, '既没有 command 也没有 url/serverUrl'); continue; }
		const url = typeof spec.url === 'string' ? spec.url : typeof spec.serverUrl === 'string' ? spec.serverUrl : undefined;
		const command = typeof spec.command === 'string' ? spec.command : undefined;
		const args = Array.isArray(spec.args) ? spec.args.filter(x => typeof x === 'string') : [];
		const env = spec.env && typeof spec.env === 'object' && !Array.isArray(spec.env) ? spec.env : null;
		const headers = spec.headers && typeof spec.headers === 'object' && !Array.isArray(spec.headers) ? spec.headers : null;
		const values = [url, command, ...args, ...Object.values(env ?? {}), ...Object.values(headers ?? {})]
			.filter(value => typeof value === 'string');
		if (values.some(value => PLACEHOLDER_RE.test(value))) { skip(item.key, '配置里有无法解析的 ${...} 占位符'); continue; }
		if (transport === 'stdio' && !command) { skip(item.key, 'stdio 缺 command'); continue; }
		if (transport === 'http' && !url) { skip(item.key, 'http 缺 url'); continue; }
		servers[item.name] = transport === 'stdio'
			? { type: 'stdio', approved: false, command, args, ...(env ? { env } : {}) }
			: { type: 'http', url, ...(headers ? { headers } : {}) };
		added.push(item.name);
	}
	const next = { ...raw, servers };
	delete next.mcpServers;
	return { next, added, skipped };
}
