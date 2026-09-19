/*---------------------------------------------------------------------------------------------
 *  Unreal Engine 工具（unreal_*）
 *
 *  让 LLM 直接驱动本机 Unreal Editor：执行编辑器内 Python、自省 unreal API、
 *  导出对象属性、触发构建、检索 AssetRegistry。
 *
 *  实现上只是 BunnySeek 插件 bridge 的 HTTP 客户端 —— 插件在编辑器进程内暴露
 *  `/bridge/*` 端点（默认 http://127.0.0.1:8765），本模块把工具调用转成对应的
 *  HTTP 请求。因此**不需要知道插件装在哪**，跨机器无需任何路径配置。
 *
 *  前置条件：Unreal Editor 已启动且启用 BunnySeekAgent 插件（依赖 Python Editor
 *  Script Plugin + EditorScriptingUtilities）。bridge 不可达时工具返回可读错误
 *  而不是抛异常 —— LLM 据此可自行判断要让使用者打开编辑器。
 *--------------------------------------------------------------------------------------------*/

import { IToolDefinition, IToolResultContent } from '../../../common/providers.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';

export const UNREAL_HEALTH_TOOL_NAME = 'unreal_health';
export const UNREAL_EXEC_TOOL_NAME = 'unreal_exec';
export const UNREAL_WAIT_TOOL_NAME = 'unreal_wait';
export const UNREAL_HELP_TOOL_NAME = 'unreal_help';
export const UNREAL_DUMP_TOOL_NAME = 'unreal_dump';
export const UNREAL_BUILD_TOOL_NAME = 'unreal_build';
export const UNREAL_FIND_ASSET_TOOL_NAME = 'unreal_find_asset';

/** 默认 bridge 地址。 */
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8765';

/**
 * 无参工具的 inputSchema。
 *
 * 不能写 `{ type: 'object', properties: {} }`：部分模型/网关（IOA）要求 object
 * 至少带一个属性，否则整份 schema 被判为不兼容。与 codebaseTools / workflowTools
 * / kanbanTools 等既有工具保持同一约定。
 */
const NO_PARAMS_SCHEMA: IToolDefinition['inputSchema'] = {
	type: 'object',
	properties: { _no_params: { type: 'boolean', description: 'No parameters needed' } },
};

/** 各工具的默认超时（毫秒）。exec/build 耗时长，health/help 应快速失败。 */
const TIMEOUT_MS: Readonly<Record<string, number>> = {
	[UNREAL_HEALTH_TOOL_NAME]: 5_000,
	[UNREAL_EXEC_TOOL_NAME]: 120_000,
	[UNREAL_WAIT_TOOL_NAME]: 1_800_000,
	[UNREAL_HELP_TOOL_NAME]: 30_000,
	[UNREAL_DUMP_TOOL_NAME]: 60_000,
	[UNREAL_BUILD_TOOL_NAME]: 900_000,
	[UNREAL_FIND_ASSET_TOOL_NAME]: 60_000,
};

export interface UnrealToolContext {
	register: (descriptor: { definition: IToolDefinition; handler: (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<IToolResultContent[] | { content: IToolResultContent[] }> }) => void;
	logService: ILogService;
	/** bridge 基址；缺省用 DEFAULT_BRIDGE_URL。 */
	getBridgeUrl?: () => string | undefined;
}

/**
 * 把 bridge 的响应格式化成 LLM 友好的文本。
 * 结构化 JSON 统一序列化，字符串原样透出（bridge 自己生成的报告本就是给人看的）。
 */
function formatPayload(payload: unknown): string {
	if (typeof payload === 'string') {
		return payload;
	}
	try {
		return JSON.stringify(payload, null, 2);
	} catch {
		return String(payload);
	}
}

function textResult(text: string): IToolResultContent[] {
	return [{ type: 'text', text }];
}

export function registerUnrealTools(ctx: UnrealToolContext): void {
	const bridgeBaseUrl = (): string => {
		const configured = ctx.getBridgeUrl?.()?.trim();
		return (configured || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
	};

	/**
	 * 调用一个 /bridge/* 端点。
	 * 连接失败与 HTTP 错误都转成普通文本结果 —— 工具失败应当是可恢复的信息，
	 * 而不是让整轮对话崩掉的异常。
	 */
	const callBridge = async (
		endpoint: string,
		body: Record<string, unknown> | undefined,
		toolName: string,
		signal?: AbortSignal,
	): Promise<IToolResultContent[]> => {
		const base = bridgeBaseUrl();
		const url = `${base}${endpoint}`;
		const timeoutMs = TIMEOUT_MS[toolName] ?? 60_000;

		// 合并调用方 signal 与工具自身超时，避免长耗时工具挂死。
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener('abort', onAbort, { once: true });

		try {
			const response = await fetch(url, {
				method: body === undefined ? 'GET' : 'POST',
				headers: body === undefined
					? { 'Accept': 'application/json' }
					: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});

			const raw = await response.text();
			if (!response.ok) {
				return textResult(
					`[Unreal] ${toolName} failed: bridge returned HTTP ${response.status}.\n${raw}`
				);
			}
			try {
				return textResult(formatPayload(JSON.parse(raw)));
			} catch {
				return textResult(raw);
			}
		} catch (err) {
			const aborted = err instanceof Error && err.name === 'AbortError';
			if (aborted && signal?.aborted) {
				return textResult(`[Unreal] ${toolName} cancelled.`);
			}
			if (aborted) {
				return textResult(
					`[Unreal] ${toolName} timed out after ${Math.round(timeoutMs / 1000)}s.`
				);
			}
			return textResult(
				`[Unreal] ${toolName} cannot reach the Unreal bridge at ${base} (${err instanceof Error ? err.message : String(err)}).\n`
				+ `Open Unreal Editor with the BunnySeekAgent plugin enabled (Python Editor Script Plugin + EditorScriptingUtilities), then retry. `
				+ `If your editor listens on another port, make the bridge URL match.`
			);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		}
	};

	const register = (
		name: string,
		description: string,
		inputSchema: IToolDefinition['inputSchema'],
		endpoint: string,
		buildBody: (args: Record<string, unknown>) => Record<string, unknown> | undefined,
	) => {
		ctx.register({
			definition: { name, description, inputSchema },
			handler: async (args: Record<string, unknown>, signal?: AbortSignal) =>
				callBridge(endpoint, buildBody(args), name, signal),
		});
	};

	register(
		UNREAL_HEALTH_TOOL_NAME,
		'Check that the Unreal Editor bridge is reachable. Returns status, project name, pid and uptime. Call this first if any other unreal_* tool fails.',
		// 空 properties {} 会被 IOA 网关判为不兼容（某些模型要求 object 至少有一个
		// 属性），此处与 codebaseTools / workflowTools 等保持一致的 `_no_params` 约定。
		NO_PARAMS_SCHEMA,
		'/bridge/health',
		() => undefined,
	);

	register(
		UNREAL_EXEC_TOOL_NAME,
		'Execute Python inside the Unreal Editor\'s embedded interpreter on the GameThread. State persists across calls (Jupyter-style); the last bare expression\'s repr is echoed. `unreal` is pre-imported. '
		+ 'NEVER sleep or busy-wait here — that blocks the GameThread and freezes the editor; use unreal_wait instead.',
		{
			type: 'object',
			properties: {
				code: {
					type: 'string',
					description: 'Python source to execute inside the editor. May span multiple statements.',
				},
				reset: {
					type: 'boolean',
					description: 'If true, discard all globals from previous calls before running.',
				},
				timeout_seconds: {
					type: 'integer',
					description: 'Hard timeout in seconds; default 60.',
					minimum: 1,
				},
			},
			required: ['code'],
		},
		'/bridge/exec',
		args => ({
			code: args.code,
			...(args.reset !== undefined ? { reset: args.reset } : {}),
			...(args.timeout_seconds !== undefined ? { timeout_seconds: args.timeout_seconds } : {}),
		}),
	);

	register(
		UNREAL_WAIT_TOOL_NAME,
		'Wait for an async Unreal condition WITHOUT blocking the GameThread. Provide `condition` (a Python expression polled until truthy) and/or `log_pattern` (a regex matched against new log lines). Whichever is satisfied first wins.',
		{
			type: 'object',
			properties: {
				condition: {
					type: 'string',
					description: 'Python expression evaluated in the unreal_exec namespace; waits until truthy.',
				},
				log_pattern: {
					type: 'string',
					description: 'Regex matched against newly appended project log lines.',
				},
				timeout: {
					type: 'number',
					description: 'Total wait budget in seconds; default 300, max 1800.',
				},
				poll_interval: {
					type: 'number',
					description: 'Seconds between probes; default 2.',
				},
			},
		},
		'/bridge/wait_probe',
		args => ({
			...(args.condition !== undefined ? { condition: args.condition } : {}),
			...(args.log_pattern !== undefined ? { log_pattern: args.log_pattern } : {}),
			...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
			...(args.poll_interval !== undefined ? { poll_interval: args.poll_interval } : {}),
		}),
	);

	register(
		UNREAL_HELP_TOOL_NAME,
		'Introspect the `unreal` Python module in the editor: docstring, members and method signatures for a dotted symbol path. Pass an empty symbol to describe the top-level module. '
		+ 'Use `filter` on large classes — they have hundreds of members and will flood your context. Call this BEFORE unreal_exec when unsure of an API shape.',
		{
			type: 'object',
			properties: {
				symbol: {
					type: 'string',
					description: 'Dotted path relative to the unreal module; empty string returns the top-level summary.',
				},
				filter: {
					type: 'string',
					description: 'Case-insensitive substring matched against member names.',
				},
			},
		},
		'/bridge/help',
		args => ({
			...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
			...(args.filter !== undefined ? { filter: args.filter } : {}),
		}),
	);

	register(
		UNREAL_DUMP_TOOL_NAME,
		'Recursively dump every reachable editor property of a UE object/struct as JSON, using reflection metadata (catches nested USTRUCTs that hand-written get_editor_property loops miss). '
		+ 'Give Python code whose LAST statement is the expression to dump.',
		{
			type: 'object',
			properties: {
				code: {
					type: 'string',
					description: 'Python code; its last statement must be the expression to dump.',
				},
				depth: {
					type: 'integer',
					description: 'Recursion depth for nested values.',
				},
			},
			required: ['code'],
		},
		'/bridge/dump',
		args => ({
			code: args.code,
			...(args.depth !== undefined ? { depth: args.depth } : {}),
		}),
	);

	register(
		UNREAL_BUILD_TOOL_NAME,
		'Trigger a build in the Unreal Editor. mode=\'live_coding\' compiles and hot-reloads C++ changes; mode=\'ubt\' runs a full UnrealBuildTool build.',
		{
			type: 'object',
			properties: {
				mode: {
					type: 'string',
					description: "'live_coding' for a fast C++ hot reload, 'ubt' for a full build.",
					enum: ['live_coding', 'ubt'],
				},
			},
			required: ['mode'],
		},
		'/bridge/build',
		args => ({ mode: args.mode }),
	);

	register(
		UNREAL_FIND_ASSET_TOOL_NAME,
		'Search the Unreal AssetRegistry for assets by name or path.',
		{
			type: 'object',
			properties: {
				search_term: {
					type: 'string',
					description: 'Name or path substring to search for.',
				},
				name: { type: 'string', description: 'Asset name filter.' },
				path: { type: 'string', description: 'Package path filter, e.g. /Game/BluePrints.' },
				class_names: {
					type: 'array',
					items: { type: 'string' },
					description: 'Restrict results to these asset classes.',
				},
				max_results: { type: 'integer', description: 'Cap on the number of hits returned.' },
			},
		},
		'/bridge/find_asset',
		args => ({
			...(args.search_term !== undefined ? { search_term: args.search_term } : {}),
			...(args.name !== undefined ? { name: args.name } : {}),
			...(args.path !== undefined ? { path: args.path } : {}),
			...(args.class_names !== undefined ? { class_names: args.class_names } : {}),
			...(args.max_results !== undefined ? { max_results: args.max_results } : {}),
		}),
	);

	ctx.logService.info('[UnrealTools] Registered unreal_* tools (7)');
}
