/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VsSaros 的 MCP 配置（`~/.vssaros/mcp.json`，上游 `mcp.json` 格式）→ dsh MCP 行 的纯逻辑。
 *
 * **为什么是"启动时生成覆盖层"而不是"插件运行时挂载"（实测结论，2026-10-10）**：
 * - `@deepseek-ai/dsh-mcp-client` 的形态是**一个服务器一个组合行**（`apply(ctx, config)`，导出一个 `Config`），
 *   没有提供服务给别的插件运行时注册服务器；
 * - `ctx.pluginManager` 只能启停**已存在的行**（`listPlugins` / `setPluginEnabled` / `setBundleEnabled` /
 *   `installBundle` / `removeBundle`），**没有 addRow/insertRow**；
 * - 所以"增删即时生效"无从实现——加行只能靠文件层（bundle patch / profile patch / `--patch` 覆盖层）。
 * 本文件负责把 MCP 配置变成一份 `--patch` 覆盖层，与 bridge / kanban 两个覆盖层同机制：Host 每次启动
 * 重新生成 → MCP 配置改动**重启 Host 后**生效（VsSaros 已有「重启 Host」按钮）。
 *
 * 覆盖层里每行都是 `@deepseek-ai/dsh-mcp-client`（dsh 自带包，无需安装），行 id 为 `mcp-<serverName>`。
 */

/** 一个可挂载的 MCP 服务器（已归一化到 dsh 的字段口径）。 */
export interface IDshMcpServerSpec {
	/** dsh 的工具命名空间 `<serverName>`：`mcp__<serverName>__<tool>`（`[A-Za-z0-9_-]{1,32}`）。 */
	readonly serverName: string;
	readonly transport: 'stdio' | 'streamable-http';
	/** stdio：可执行文件 / 参数 / 额外环境变量 / 工作目录。 */
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	/** streamable-http：端点与额外请求头。 */
	readonly url?: string;
	readonly headers?: Readonly<Record<string, string>>;
}

export interface IDshMcpSkip {
	/** 配置里的服务器名。 */
	readonly name: string;
	/** 跳过原因（用户可见，别只说"不支持"）。 */
	readonly reason: string;
}

export interface IDshMcpParseResult {
	readonly servers: readonly IDshMcpServerSpec[];
	readonly skipped: readonly IDshMcpSkip[];
}

/** dsh 的 serverName 约束（`dsh-mcp-client` 的字段说明）。 */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 被 VsSaros/上游 `mcp.json` 允许、但 dsh 侧没有对应传输的类型。 */
const UNSUPPORTED_TRANSPORTS: Readonly<Record<string, string>> = {
	sse: 'dsh 的 dsh-mcp-client 只支持 stdio 与 streamable-http，不支持 sse',
};

/**
 * `${env:VAR}` / `${VAR}` 变量替换（上游 `mcp.json` 支持）；`process.env` 里没有的变量保留原样，
 * 由调用方按"仍有未解析占位符"处理（见 `parseMcpServers` 的 `${workspaceFolder}` 说明）。
 */
function substituteEnv(text: string, env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>): string {
	return text.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name: string) => {
		const value = env[name];
		return typeof value === 'string' ? value : full;
	});
}

// （字符串映射/数组的解析都在 parseMcpServers 内的 resolveMap / resolveList，需要访问 env 与跳过原因，
//   所以不抽成模块级函数。）

/**
 * 解析 `mcp.json` 文本。
 *
 * 归一化规则（逐条都有实测依据或上游 schema 依据）：
 * - `type: 'stdio'` → `transport: 'stdio'`（`command` 必有，缺则跳过）；
 * - `type: 'http'` → `transport: 'streamable-http'`（`url` 必有，缺则跳过）；
 * - `type: 'sse'` → **跳过并说明**（dsh 无该传输）；
 * - 服务器名必须满足 dsh 的 `[A-Za-z0-9_-]{1,32}`，否则跳过（dsh 会在加载时报"later one fails"这类错，
 *   我们提前挡掉并给出可操作的提示）；
 * - `${env:X}` 用传入的 env 替换（默认 `process.env`）；**残留任何 `${...}` 一律跳过**——尤其
 *   `${workspaceFolder}`：dsh 侧拿到的是工作区目录，而我们只有工作区 id，替换不了，宁可跳过也不把它
 *   当字面量传给服务器进程（那会变成"服务器莫名起不来"）。
 */
export function parseMcpServers(
	text: string,
	env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): IDshMcpParseResult {
	const servers: IDshMcpServerSpec[] = [];
	const skipped: IDshMcpSkip[] = [];
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch (e) {
		return { servers: [], skipped: [{ name: '(整个文件)', reason: `mcp.json 不是合法 JSON：${(e as Error)?.message ?? e}` }] };
	}
	const entries = (root as { servers?: unknown })?.servers;
	if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
		return { servers: [], skipped: [{ name: '(整个文件)', reason: 'mcp.json 里没有 servers 对象' }] };
	}
	const seen = new Set<string>();
	for (const [name, raw] of Object.entries(entries as Record<string, unknown>)) {
		const skip = (reason: string) => skipped.push({ name, reason });
		if (!SERVER_NAME_RE.test(name)) {
			skip(`服务器名不满足 dsh 的 [A-Za-z0-9_-]{1,32}：${name}`);
			continue;
		}
		if (seen.has(name)) {
			skip('重名（dsh 侧重名会导致后续那条加载失败）');
			continue;
		}
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			skip('配置不是对象');
			continue;
		}
		const config = raw as Record<string, unknown>;
		const type = typeof config.type === 'string' ? config.type : '';
		const unsupported = UNSUPPORTED_TRANSPORTS[type];
		if (unsupported) {
			skip(unsupported);
			continue;
		}
		/** 占位符解析：解析不了就返回 undefined（调用方跳过该服务器，不把 `${...}` 当字面量传出去）。 */
		const resolve = (value: string): string | undefined => {
			const substituted = substituteEnv(value, env);
			return substituted.includes('${') ? undefined : substituted;
		};
		/** 字符串映射（env / headers）：逐值解析，任何一个解析不了就整条跳过。 */
		const resolveMap = (raw: unknown, what: string): { map?: Record<string, string>; bad?: string } => {
			if (raw === undefined) {
				return {};
			}
			if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
				return { bad: `${what} 不是对象` };
			}
			const map: Record<string, string> = {};
			for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
				if (typeof value !== 'string') {
					continue;
				}
				const resolved = resolve(value);
				if (resolved === undefined) {
					return { bad: `${what}.${key} 的值里有无法解析的占位符（如 \${workspaceFolder}）` };
				}
				map[key] = resolved;
			}
			return Object.keys(map).length ? { map } : {};
		};
		/** 字符串数组（args）：同上。 */
		const resolveList = (raw: unknown, what: string): { list?: string[]; bad?: string } => {
			if (raw === undefined) {
				return {};
			}
			if (!Array.isArray(raw)) {
				return { bad: `${what} 不是数组` };
			}
			const list: string[] = [];
			for (const item of raw) {
				if (typeof item !== 'string') {
					continue;
				}
				const resolved = resolve(item);
				if (resolved === undefined) {
					return { bad: `${what} 里有无法解析的占位符（如 \${workspaceFolder}）` };
				}
				list.push(resolved);
			}
			return list.length ? { list } : {};
		};

		if (type === 'stdio' || (!type && typeof config.command === 'string')) {
			const command = typeof config.command === 'string' ? resolve(config.command.trim()) : undefined;
			if (command === undefined) {
				skip(typeof config.command === 'string' ? `command 里有无法解析的占位符：${config.command}` : 'stdio 服务器缺 command');
				continue;
			}
			const argsResult = resolveList(config.args, 'args');
			if (argsResult.bad) {
				skip(argsResult.bad);
				continue;
			}
			const envResult = resolveMap(config.env, 'env');
			if (envResult.bad) {
				skip(envResult.bad);
				continue;
			}
			const cwd = typeof config.cwd === 'string' ? resolve(config.cwd) : undefined;
			if (typeof config.cwd === 'string' && cwd === undefined) {
				skip(`cwd 里有无法解析的占位符：${config.cwd}`);
				continue;
			}
			servers.push({
				serverName: name,
				transport: 'stdio',
				command,
				...(argsResult.list ? { args: argsResult.list } : {}),
				...(envResult.map ? { env: envResult.map } : {}),
				...(cwd ? { cwd } : {}),
			});
			seen.add(name);
			continue;
		}
		if (type === 'http') {
			const url = typeof config.url === 'string' ? resolve(config.url.trim()) : undefined;
			if (url === undefined) {
				skip(typeof config.url === 'string' ? `url 里有无法解析的占位符：${config.url}` : 'http 服务器缺 url');
				continue;
			}
			const headersResult = resolveMap(config.headers, 'headers');
			if (headersResult.bad) {
				skip(headersResult.bad);
				continue;
			}
			servers.push({
				serverName: name,
				transport: 'streamable-http',
				url,
				...(headersResult.map ? { headers: headersResult.map } : {}),
			});
			seen.add(name);
			continue;
		}
		skip(`未识别的 type：${type || '(缺省)'}（dsh 侧只认 stdio / http）`);
	}
	return { servers, skipped };
}

/** 覆盖层里的行 id：`mcp-<serverName>`（稳定、可预期，便于人工核对与将来的停用）。 */
export function mcpRowId(serverName: string): string {
	return `mcp-${serverName}`;
}

// 本文件原本零 import（纯函数）；这里只借一个纯读函数解析 profile 的 bundles，
// 方向是 dshMcpConfig → dshPluginActivation（反向无引用 ⇒ 不成环 ✓）。
import { parseProfileBundles } from './dshPluginActivation.js';

/**
 * **dsh 侧生成的 MCP 行 bundle** 的包名（`dsh-plugins/vssaros-mcp/bin/sync-rows.mjs` 用官方
 * `dsh plugin add` 登记进 `dsh.profile.bundles` 的那一条）。
 */
export const DSH_MCP_ROWS_BUNDLE_NAME = '@vssaros/dsh-mcp-rows';

/**
 * 这个 profile 是否已经把 MCP 行**交给 dsh 侧**（即登记了 {@link DSH_MCP_ROWS_BUNDLE_NAME}）？
 *
 * 为什么要问：MCP 的"配置 → 组合行"已搬去 dsh 侧（2026-10-12），但壳这里**仍会**渲染一份 `--patch`
 * 覆盖层。两条路**不能并存** —— `insert` 不是"同 id 后层胜出"，实测同时开会把同一台服务器**挂两遍**
 * （`poc/dsh-p0/scripts/p3-25-mcp-bundle-register.mjs` 记录），而 dsh 侧 `serverName` 重复会让
 * **后到者加载失败** ✗（"某台服务器莫名没挂上"的经典来源）。
 * ⇒ 登记过就**主动让路**（不写覆盖层），确保任何时刻只有一条路在生效 ✓。
 *
 * 容错：读不动/字段畸形一律当作"未登记"（⇒ 退回旧的覆盖层行为，与今天一致 ✓ 不制造新故障 ✗）。
 */
export function isDshRowsBundleRegistered(profilePackageJson: unknown): boolean {
	return parseProfileBundles(profilePackageJson).includes(DSH_MCP_ROWS_BUNDLE_NAME);
}

function yamlSingleQuoted(value: string): string {
	return `'${value.replace(/'/g, '\'\'')}'`;
}

function yamlScalar(value: string): string {
	// 纯字符串标量一律单引号：路径里的反斜杠、冒号、`#` 都不用特殊处理
	return yamlSingleQuoted(value);
}

function yamlInlineList(values: readonly string[]): string {
	return `[${values.map(yamlScalar).join(', ')}]`;
}

/**
 * 渲染 MCP 覆盖层：一个服务器一行 `@deepseek-ai/dsh-mcp-client`。
 * 行内 `id` 稳定（`mcp-<serverName>`），是为了让"这一行是谁"在 `--dump-config` 里一眼可读，也让将来
 * 想按行停用时不必猜 id。
 */
export function renderMcpOverlay(servers: readonly IDshMcpServerSpec[]): string {
	const lines: string[] = [
		'# Generated by VsSaros for one Host run from ~/.vssaros/mcp.json. Removed when the Host stops.',
		'# dsh-mcp-client is one composition row per server; changing MCP config needs a Host restart.',
	];
	// **必须只有一个 `- insert:` 块**：实测写多个顶层 insert 时加载器只认第一个（第二个服务器的行
	// 直接消失，且不报错——"某台服务器莫名没挂上"的典型来源）。所有行都挂在同一个 insert 的列表里。
	if (servers.length) {
		lines.push('- insert:');
		for (const server of servers) {
			lines.push(`    - id: ${mcpRowId(server.serverName)}`);
			lines.push("      name: '@deepseek-ai/dsh-mcp-client'");
			lines.push('      config:');
			lines.push(`        serverName: ${yamlScalar(server.serverName)}`);
			lines.push(`        transport: ${yamlScalar(server.transport)}`);
			if (server.transport === 'stdio') {
				lines.push(`        command: ${yamlScalar(server.command ?? '')}`);
				if (server.args?.length) {
					lines.push(`        args: ${yamlInlineList(server.args)}`);
				}
				if (server.env) {
					lines.push('        env:');
					for (const [key, value] of Object.entries(server.env)) {
						lines.push(`          ${key}: ${yamlScalar(value)}`);
					}
				}
				if (server.cwd) {
					lines.push(`        cwd: ${yamlScalar(server.cwd)}`);
				}
			} else {
				lines.push(`        url: ${yamlScalar(server.url ?? '')}`);
				if (server.headers) {
					lines.push('        headers:');
					for (const [key, value] of Object.entries(server.headers)) {
						lines.push(`          ${key}: ${yamlScalar(value)}`);
					}
				}
			}
		}
	}
	lines.push('');
	return lines.join('\n');
}
