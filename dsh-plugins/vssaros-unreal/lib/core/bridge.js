/**
 * Unreal bridge 的 HTTP 客户端（零依赖）——逐条移植自
 * `src/vs/sessions/contrib/agentStudio/browser/providers/tool/unrealTools.ts`。
 *
 * 那个模块是 renderer 侧的，因而有一段"CORS 绕行"（打包版 origin `vscode-file://vscode-app`
 * 直连会被拦 ⇒ 优先走主进程 `vscode:webFetch`）。**Host 是 Node，没有 CORS** ⇒ 这里只有一条路：
 * 全局 `fetch`。除此之外逐条照搬：端点、载荷、超时表、失败文案模板（模型是照着那些文案自我纠偏的）。
 *
 * ⚠ 失败**不抛异常**：连接不通、HTTP 错误、超时都转成**可读文本**返回 —— 工具失败应当是模型能
 * 自行判断（"编辑器没开？"）并继续的信息，而不是让整轮对话崩掉。
 */

/** 默认 bridge 地址。真源：`unrealTools.ts:28`。 */
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8765';

export const UNREAL_HEALTH_TOOL_NAME = 'unreal_health';
export const UNREAL_EXEC_TOOL_NAME = 'unreal_exec';
export const UNREAL_WAIT_TOOL_NAME = 'unreal_wait';
export const UNREAL_HELP_TOOL_NAME = 'unreal_help';
export const UNREAL_DUMP_TOOL_NAME = 'unreal_dump';
export const UNREAL_BUILD_TOOL_NAME = 'unreal_build';
export const UNREAL_FIND_ASSET_TOOL_NAME = 'unreal_find_asset';

/** 各工具的默认超时（毫秒）。真源：`unrealTools.ts:33-41`（**七条逐条一致** ✓）。 */
export const TIMEOUT_MS = {
	[UNREAL_HEALTH_TOOL_NAME]: 5_000,
	[UNREAL_EXEC_TOOL_NAME]: 120_000,
	[UNREAL_WAIT_TOOL_NAME]: 1_800_000,
	[UNREAL_HELP_TOOL_NAME]: 30_000,
	[UNREAL_DUMP_TOOL_NAME]: 60_000,
	[UNREAL_BUILD_TOOL_NAME]: 900_000,
	[UNREAL_FIND_ASSET_TOOL_NAME]: 60_000,
};

/**
 * 哪些工具**会改编辑器状态**（⇒ 注册时必须挂审批闸 `tools/pre-execute` ⇒ `ask` ✓）。
 *
 * 2026-10-13：三个执行类工具已下移到 Host（此前"只注册只读四个"的口径作废 ✗）。它们能在编辑器里
 * 跑任意 Python、动 C++ 构建 ⇒ 属"有用户可见副作用"那一类 ✓ ⇒ 权限靠**闸**守，而不是靠"不提供" ✗。
 */
export const WRITE_TOOL_NAMES = [UNREAL_EXEC_TOOL_NAME, UNREAL_WAIT_TOOL_NAME, UNREAL_BUILD_TOOL_NAME];

/** 结构化 JSON 统一序列化；字符串原样透出（bridge 自己生成的报告本就是给人看的）。真源：`:54-63`。 */
export function formatPayload(payload) {
	if (typeof payload === 'string') {
		return payload;
	}
	try {
		return JSON.stringify(payload, null, 2);
	} catch {
		return String(payload);
	}
}

/**
 * 调用一个 `/bridge/*` 端点，返回**文本**（永不对"桥不可达/HTTP 错误/超时"抛异常）。
 * 真源：`unrealTools.ts:80-157`。
 */
export async function callBridge(options, endpoint, body, toolName, signal) {
	const base = (options?.bridgeUrl?.()?.trim() || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
	const url = `${base}${endpoint}`;
	const timeoutMs = TIMEOUT_MS[toolName] ?? 60_000;

	// 合并调用方 signal 与工具自身超时，避免长耗时工具挂死。
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	signal?.addEventListener('abort', onAbort, { once: true });

	// 无 body ⇒ GET（health 就是这条）；有 body ⇒ POST。
	const method = body === undefined ? 'GET' : 'POST';
	const headers = body === undefined
		? { 'Accept': 'application/json' }
		: { 'Accept': 'application/json', 'Content-Type': 'application/json' };
	const bodyText = body === undefined ? undefined : JSON.stringify(body);

	try {
		const response = await fetch(url, { method, headers, body: bodyText, signal: controller.signal });
		const raw = await response.text();

		if (!response.ok) {
			// ★ 回传「实际发送的参数」（真机日志 1790077760068：模型靠它从 search_term 自我纠偏到
			//   桥端认识的 name_contains ✓）。
			const sentEcho = bodyText ? `\nSent body: ${bodyText.slice(0, 800)}` : '';
			return `[Unreal] ${toolName} failed: bridge returned HTTP ${response.status} ${response.statusText}.\n${raw}${sentEcho}`;
		}
		try {
			return formatPayload(JSON.parse(raw));
		} catch {
			return raw;
		}
	} catch (err) {
		const aborted = err instanceof Error && err.name === 'AbortError';
		if (aborted && signal?.aborted) {
			return `[Unreal] ${toolName} cancelled.`;
		}
		if (aborted) {
			return `[Unreal] ${toolName} timed out after ${Math.round(timeoutMs / 1000)}s.`;
		}
		return `[Unreal] ${toolName} cannot reach the Unreal bridge at ${base} (${err instanceof Error ? err.message : String(err)}).\n`
			+ `Open Unreal Editor with the BunnySeekAgent plugin enabled (Python Editor Script Plugin + EditorScriptingUtilities), then retry. `
			+ `If your editor listens on another port, make the bridge URL match.`;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
}

// ─── 各工具的端点与载荷（真源：`unrealTools.ts:173-353` 的 register 调用）─────────────
// `buildBody` 逐条照搬：**参数名与桥端一致**（当年 `search_term` 那个坑就出在这里）。

export const UNREAL_TOOLS = [
	{
		name: UNREAL_HEALTH_TOOL_NAME,
		description: 'Check that the Unreal Editor bridge is reachable. Returns status, project name, pid and uptime. Call this first if any other unreal_* tool fails.',
		parameters: { type: 'object', properties: {} },
		endpoint: '/bridge/health',
		buildBody: () => undefined,
	},
	{
		name: UNREAL_HELP_TOOL_NAME,
		description: 'Introspect the `unreal` Python module in the editor: docstring, members and method signatures for a dotted symbol path. Pass an empty symbol to describe the top-level module. '
			+ 'Use `filter` on large classes — they have hundreds of members and will flood your context. Call this BEFORE unreal_exec when unsure of an API shape.',
		parameters: {
			type: 'object',
			properties: {
				symbol: { type: 'string', description: 'Dotted path relative to the unreal module; empty string returns the top-level summary.' },
				filter: { type: 'string', description: 'Case-insensitive substring matched against member names.' },
			},
		},
		endpoint: '/bridge/help',
		buildBody: args => ({
			...(args?.symbol !== undefined ? { symbol: args.symbol } : {}),
			...(args?.filter !== undefined ? { filter: args.filter } : {}),
		}),
	},
	{
		name: UNREAL_DUMP_TOOL_NAME,
		description: 'Recursively dump every reachable editor property of a UE object/struct as JSON, using reflection metadata (catches nested USTRUCTs that hand-written get_editor_property loops miss). '
			+ 'Give Python code whose LAST statement is the expression to dump.',
		parameters: {
			type: 'object',
			properties: {
				code: { type: 'string', description: 'Python code; its last statement must be the expression to dump.' },
				depth: { type: 'integer', description: 'Recursion depth for nested values.' },
			},
			required: ['code'],
		},
		endpoint: '/bridge/dump',
		buildBody: args => ({
			code: args.code,
			...(args?.depth !== undefined ? { depth: args.depth } : {}),
		}),
	},
	{
		name: UNREAL_FIND_ASSET_TOOL_NAME,
		description: 'Search the Unreal AssetRegistry for assets by name or path. Prefer `name_contains` / `name` / `path` (bridge-native params).',
		parameters: {
			type: 'object',
			properties: {
				name_contains: { type: 'string', description: 'Asset name substring filter (bridge-native; preferred).' },
				search_term: { type: 'string', description: 'Alias of name_contains — mapped to name_contains when forwarding.' },
				name: { type: 'string', description: 'Asset name filter.' },
				path: { type: 'string', description: 'Package path filter, e.g. /Game/BluePrints.' },
				class_names: { type: 'array', items: { type: 'string' }, description: 'Restrict results to these asset classes.' },
				max_results: { type: 'integer', description: 'Cap on the number of hits returned.' },
			},
		},
		endpoint: '/bridge/find_asset',
		buildBody: args => ({
			// name_contains 优先；只有 search_term 时映射为 name_contains（桥端不认识前者 ✗✓）
			...(args?.name_contains !== undefined ? { name_contains: args.name_contains } : {}),
			...(args?.name_contains === undefined && args?.search_term !== undefined ? { name_contains: args.search_term } : {}),
			...(args?.search_term !== undefined ? { search_term: args.search_term } : {}),
			...(args?.name !== undefined ? { name: args.name } : {}),
			...(args?.path !== undefined ? { path: args.path } : {}),
			...(args?.class_names !== undefined ? { class_names: args.class_names } : {}),
			...(args?.max_results !== undefined ? { max_results: args.max_results } : {}),
		}),
	},
	// ── 执行类三个（2026-10-13 下移到 Host ✓）：端点 / 载荷 / 文案逐字照真源 `unrealTools.ts:181-310`。
	// ⚠ 参数 schema 里**不许写 `minimum`** ✗（dsh 的受限 JSON Schema 子集里没有它 ⇒ 整条 entry 不激活）：
	//   真源 exec 的 `timeout_seconds` 带 `minimum: 1` ⇒ 范围改写在 description 里 ✓（与 kb/kanban 同处置）。
	{
		name: UNREAL_EXEC_TOOL_NAME,
		description: 'Execute Python inside the Unreal Editor\'s embedded interpreter on the GameThread. State persists across calls (Jupyter-style); the last bare expression\'s repr is echoed. `unreal` is pre-imported. '
			+ 'NEVER sleep or busy-wait here — that blocks the GameThread and freezes the editor; use unreal_wait instead.',
		parameters: {
			type: 'object',
			properties: {
				code: { type: 'string', description: 'Python source to execute inside the editor. May span multiple statements.' },
				reset: { type: 'boolean', description: 'If true, discard all globals from previous calls before running.' },
				timeout_seconds: { type: 'integer', description: 'Hard timeout in seconds; default 60, minimum 1.' },
			},
			required: ['code'],
		},
		endpoint: '/bridge/exec',
		buildBody: args => ({
			code: args.code,
			...(args?.reset !== undefined ? { reset: args.reset } : {}),
			...(args?.timeout_seconds !== undefined ? { timeout_seconds: args.timeout_seconds } : {}),
		}),
	},
	{
		name: UNREAL_WAIT_TOOL_NAME,
		description: 'Wait for an async Unreal condition WITHOUT blocking the GameThread. Provide `condition` (a Python expression polled until truthy) and/or `log_pattern` (a regex matched against new log lines). Whichever is satisfied first wins.',
		parameters: {
			type: 'object',
			properties: {
				condition: { type: 'string', description: 'Python expression evaluated in the unreal_exec namespace; waits until truthy.' },
				log_pattern: { type: 'string', description: 'Regex matched against newly appended project log lines.' },
				timeout: { type: 'number', description: 'Total wait budget in seconds; default 300, max 1800.' },
				poll_interval: { type: 'number', description: 'Seconds between probes; default 2.' },
			},
		},
		// ⚠ 端点是 `wait_probe`（真源 `unrealTools.ts:236` ✓ —— 不是 `/bridge/wait` ✗）。
		endpoint: '/bridge/wait_probe',
		buildBody: args => ({
			...(args?.condition !== undefined ? { condition: args.condition } : {}),
			...(args?.log_pattern !== undefined ? { log_pattern: args.log_pattern } : {}),
			...(args?.timeout !== undefined ? { timeout: args.timeout } : {}),
			...(args?.poll_interval !== undefined ? { poll_interval: args.poll_interval } : {}),
		}),
	},
	{
		name: UNREAL_BUILD_TOOL_NAME,
		description: 'Trigger a build in the Unreal Editor. mode=\'live_coding\' compiles and hot-reloads C++ changes; mode=\'ubt\' runs a full UnrealBuildTool build.',
		parameters: {
			type: 'object',
			properties: {
				mode: { type: 'string', description: "'live_coding' for a fast C++ hot reload, 'ubt' for a full build.", enum: ['live_coding', 'ubt'] },
			},
			required: ['mode'],
		},
		endpoint: '/bridge/build',
		buildBody: args => ({ mode: args.mode }),
	},
];
