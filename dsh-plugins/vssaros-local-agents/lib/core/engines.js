// 本地 Agent CLI 的引擎表与路由命名（P0）。
//
// 一个 route = dsh 的一个「模型 provider」。Bot 在 .agent.md / 会话里选
// `vssaros-codex-cli/default` 时，LlmRuntime 会把这次模型调用交给我们注册的
// adapter，由 adapter 去 spawn 对应的 CLI。
//
// P0 只支持「NDJSON / stream-json 文本流」两类：够验证整条 seam，又不需要
// ACP 握手与回环 MCP 工具桥（那是 P1）。所有命令都用数组参数、不走 shell。

export const ROUTE_PREFIX = 'vssaros-';

export const ENGINES = {
	'vssaros-codex-cli': {
		name: 'Codex CLI',
		command: 'codex',
		kind: 'codex-json',
		args: ['exec', '--json', '--skip-git-repo-check', '-'],
		versionArgs: ['--version'],
		signIn: 'codex login',
		models: [{ id: 'default', name: 'CLI default' }],
	},
	'vssaros-claude-code': {
		name: 'Claude Code',
		command: 'claude',
		kind: 'claude-stream-json',
		args: ['-p', '--output-format', 'stream-json', '--verbose'],
		versionArgs: ['--version'],
		signIn: 'claude',
		models: [
			{ id: 'default', name: 'CLI default' },
			{ id: 'opus', name: 'Opus' },
			{ id: 'sonnet', name: 'Sonnet' },
			{ id: 'haiku', name: 'Haiku' },
		],
	},
	// P1：ACP over stdio JSON-RPC，支持 MCP-over-HTTP 的 CLI 能回调 dsh 团队工具。
	'vssaros-opencode': {
		name: 'OpenCode', command: 'opencode', kind: 'acp', args: ['acp'],
		versionArgs: ['--version'], signIn: 'opencode auth login',
		models: [{ id: 'default', name: 'CLI default' }],
	},
	'vssaros-kimi-cli': {
		name: 'Kimi CLI', command: 'kimi', kind: 'acp', args: ['acp'],
		versionArgs: ['--version'], signIn: 'kimi login',
		models: [{ id: 'default', name: 'CLI default' }],
	},
	'vssaros-hermes-cli': {
		name: 'Hermes Agent', command: 'hermes', kind: 'acp', args: ['acp'],
		versionArgs: ['--version'], signIn: 'hermes login',
		models: [{ id: 'default', name: 'CLI default' }],
	},
	'vssaros-gemini-cli': {
		name: 'Gemini CLI', command: 'gemini', kind: 'acp', args: ['--acp'],
		versionArgs: ['--version'], signIn: 'gemini',
		models: [{ id: 'default', name: 'CLI default' }],
	},
};

/** 自定义 ACP agent 的 route。P0 只保留命名与校验，驱动在 P1 接。 */
export function customRoute(id) {
	return `${ROUTE_PREFIX}acp-${id}`;
}

export function isLocalAgentRoute(route) {
	return typeof route === 'string'
		&& (Object.hasOwn(ENGINES, route) || route.startsWith(`${ROUTE_PREFIX}acp-`));
}

/** 用户填的自定义 agent：命令必须是程序名 / 绝对路径 / ~ 开头，不许带参数与空格。 */
export function validateCustom(agent) {
	const problems = [];
	const name = String(agent?.name ?? '').trim();
	const command = String(agent?.command ?? '').trim();
	if (!name) problems.push('名称不能为空');
	if (name.length > 40) problems.push('名称不能超过 40 字');
	if (!command) problems.push('命令不能为空');
	if (/[\s\0\n\r]/.test(command)) problems.push('命令不能含空格或换行（参数请单独填）');
	if (!/^(?:[A-Za-z0-9._-]+|[A-Za-z]:[\\/][^\s]+|\/[^\s]+|~[\\/][^\s]+)$/.test(command)) {
		problems.push('命令必须是程序名、绝对路径或 ~/… 路径');
	}
	const args = agent?.args;
	if (args !== undefined) {
		if (!Array.isArray(args)) problems.push('args 必须是数组');
		else if (args.some((value) => typeof value !== 'string' || /[\0\n\r]/.test(value))) {
			problems.push('args 只能是不含 NUL / 换行的字符串');
		}
	}
	return problems;
}

/** 把内置表 + 自定义 agent 合成 route → spec 的表。 */
export function engineTable(custom = []) {
	const table = { ...ENGINES };
	for (const agent of Array.isArray(custom) ? custom : []) {
		if (!agent || !agent.id || validateCustom(agent).length) continue;
		const id = String(agent.id);
		table[customRoute(id)] = {
			name: String(agent.name ?? id).slice(0, 40),
			command: String(agent.command).trim(),
			kind: 'acp',
			args: Array.isArray(agent.args) ? [...agent.args] : [],
			versionArgs: ['--version'],
			signIn: '',
			models: [{ id: 'default', name: 'CLI default' }],
			custom: true,
		};
	}
	return table;
}
