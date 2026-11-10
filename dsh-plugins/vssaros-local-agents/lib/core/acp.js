// ACP（Agent Client Protocol）驱动：stdio JSON-RPC 2.0（P1）。
//
// 一个进程服务多个 CLI session。adapter 通过 events(sessionId) 消费归一化事件：
//   text / thought / activity / usage / permission / done / error
// CLI 自己的工具调用只以 activity 行回显；团队工具的调用由回环 MCP 走 dsh loop。
import { spawn } from 'node:child_process';
import { cleanEnv, findExecutable, searchDirs } from './discover.js';
import { JsonRpcPeer } from './jsonrpc.js';
import { linesOf } from './ndjson.js';
import { EventQueue } from './queue.js';
import { isAbsolute, resolve } from 'node:path';

const CLIENT_INFO = { name: 'vssaros', version: '1' };

/** 附加根条数上限（与桥侧 MAX_WORKSPACE_CONTEXT_ROOTS 同口径 ✓）。 */
export const MAX_ACP_ADDITIONAL_DIRECTORIES = 64;

/** 本客户端支持的最新 ACP MAJOR 版本。 */
export const ACP_PROTOCOL_VERSION = 2;
/** ACP v2 版本不匹配的 JSON-RPC 错误码（initialize 失败后允许在同一连接重发 ✓）。 */
export const ACP_UNSUPPORTED_PROTOCOL_VERSION = -32022;

/**
 * P1-8（2026-11-10）：构造 initialize 参数。
 * ★ version=2 时**双写 v1 字段**（`clientCapabilities` / `clientInfo`）与 v2 字段
 *   （`capabilities` / `info`）：v2 agent 用 v2 形状；v1 agent 按规范选 1 并**忽略**它
 *   解析不了的 v2 参数，仍读 v1 字段 ⇒ 一次请求同时接上两代 agent ✓。
 * ★ version=1 ⇒ 与改造前逐字相同（老实现不遵守"选低版本"时的回退路径）。
 */
export function acpInitializeParams(version = ACP_PROTOCOL_VERSION) {
	const params = {
		protocolVersion: version,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		clientInfo: CLIENT_INFO,
	};
	if (version >= 2) {
		params.capabilities = {};
		params.info = { name: CLIENT_INFO.name, version: CLIENT_INFO.version };
	}
	return params;
}

/** 协商出的协议版本：回执没给版本号的老 agent 按 v1 处理。 */
export function acpProtocolVersionOf(reply, requestedVersion = ACP_PROTOCOL_VERSION) {
	const selected = Number.isInteger(reply?.protocolVersion) ? reply.protocolVersion : 1;
	return Math.min(Math.max(selected, 1), requestedVersion);
}

/** resume 方法：v2 只要声明 `capabilities.session` 就 MUST 支持 `session/resume`；v1 看 loadSession。 */
export function acpResumeMethodOf(reply, requestedVersion = ACP_PROTOCOL_VERSION) {
	if (acpProtocolVersionOf(reply, requestedVersion) >= 2) {
		return reply?.capabilities?.session ? 'session/resume' : null;
	}
	return reply?.agentCapabilities?.loadSession === true ? 'session/load' : null;
}

/** MCP over HTTP：v2 `session.mcp.http` / v1 `mcpCapabilities.http|sse`（v2 明确不再认 sse）。 */
export function acpMcpHttpCapable(reply, requestedVersion = ACP_PROTOCOL_VERSION) {
	if (acpProtocolVersionOf(reply, requestedVersion) >= 2) {
		return Boolean(reply?.capabilities?.session?.mcp?.http);
	}
	const caps = reply?.agentCapabilities?.mcpCapabilities ?? {};
	return caps.http === true || caps.sse === true;
}

/** initialize 回执 → 运行期能力集合（纯函数，守卫可直接断言 ✓）。 */
export function acpCapabilitiesOf(reply, requestedVersion = ACP_PROTOCOL_VERSION) {
	const resumeMethod = acpResumeMethodOf(reply, requestedVersion);
	return {
		protocolVersion: acpProtocolVersionOf(reply, requestedVersion),
		mcpHttp: acpMcpHttpCapable(reply, requestedVersion),
		resumeMethod,
		loadSession: resumeMethod === 'session/load',
		additionalDirectories: acpAdditionalDirectoriesCapable(reply),
	};
}

/** 是否值得用 v1 参数重发 initialize（老实现可能不遵守"选低版本"而直接报错 ✗）。 */
export function acpIsVersionRejection(error) {
	const code = error?.code ?? error?.error?.code;
	return code === ACP_UNSUPPORTED_PROTOCOL_VERSION
		|| /unsupported protocol version|protocol version/i.test(String(error?.message ?? ''));
}

/**
 * 能力协商：ACP v1 的 `agentCapabilities.sessionCapabilities.additionalDirectories`
 * （OpenCode 的形态）与 v2 的 `capabilities.session.additionalDirectories` 都认；
 * 没声明 ⇒ **不传字段**（老 agent 可能严格拒未知字段，RFD 明确要求 gate on capability ✓）。
 */
export function acpAdditionalDirectoriesCapable(reply) {
	return Boolean(
		reply?.agentCapabilities?.sessionCapabilities?.additionalDirectories
		|| reply?.capabilities?.session?.additionalDirectories,
	);
}

/** 构造 session/new|load|resume|fork 的公共参数；`capable=false` ⇒ 与改动前逐字相同 ✓。 */
export function acpSessionParams({ cwd, mcpServers = [], roots = [], capable = false }) {
	const params = { cwd: cwd ?? process.cwd(), mcpServers };
	if (!capable) { return params; }
	const primaryKey = resolve(String(params.cwd)).toLowerCase();
	const extras = [];
	const seen = new Set();
	for (const item of Array.isArray(roots) ? roots : []) {
		const path = typeof item === 'string'
			? item.trim()
			: (item && typeof item.path === 'string' ? item.path.trim() : '');
		if (!path || !isAbsolute(path)) { continue; }
		const key = resolve(path).toLowerCase();
		if (key === primaryKey || seen.has(key)) { continue; }
		seen.add(key);
		extras.push(path);
		if (extras.length >= MAX_ACP_ADDITIONAL_DIRECTORIES) { break; }
	}
	if (extras.length) { params.additionalDirectories = extras; }
	return params;
}

export function textOf(content) {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content.filter((part) => part && part.type === 'text').map((part) => String(part.text ?? '')).join('');
	}
	if (content && typeof content === 'object' && content.type === 'text') return String(content.text ?? '');
	return '';
}

function planText(entries) {
	if (!Array.isArray(entries)) return '';
	return entries.map((entry) => `${entry?.status ?? ''} ${String(entry?.content ?? '')}`.trim()).join('\n');
}

function describeCall(call) {
	return String(call?.title ?? call?.kind ?? call?.toolCallId ?? 'tool call');
}

export class AcpEngine {
	constructor(route, spec, deps = {}) {
		this.route = route;
		this.spec = spec;
		this._spawnProcess = deps.spawnProcess ?? spawn;
		this._findExecutable = deps.findExecutable ?? ((command) => findExecutable(command, searchDirs()));
		this._cleanEnv = deps.cleanEnv ?? cleanEnv;
		this._child = undefined;
		this._peer = undefined;
		this._sessions = new Map();
		this.caps = {};
		this._disposed = false;
	}

	async ensure() {
		if (this._peer) return this._peer;
		if (this._disposed) throw new Error(`ACP 引擎 ${this.route} 已释放`);
		const binary = this._findExecutable(this.spec.command);
		if (!binary) throw new Error(`找不到 ${this.spec.command}；请先安装并登录该 CLI`);
		const child = this._spawnProcess(binary, [...this.spec.args], {
			env: this._cleanEnv(),
			stdio: ['pipe', 'pipe', 'inherit'],
			windowsHide: true,
		});
		this._child = child;
		const peer = new JsonRpcPeer({
			sendLine: (line) => { if (child.stdin?.writable) child.stdin.write(`${line}\n`); },
			onNotification: (method, params) => this._onNotification(method, params),
			onRequest: (method, params) => this._onRequest(method, params),
		});
		this._peer = peer;
		void (async () => {
			try {
				for await (const line of linesOf(child.stdout)) peer.handleLine(line);
			} finally {
				peer.failAll(new Error(`ACP 进程 ${this.spec.command} 已退出`));
				for (const session of this._sessions.values()) session.events.push({ type: 'error', error: 'CLI 进程已退出' });
			}
		})();
		// ★ 请求本客户端支持的最新版本（2）；v1 agent 按规范选 1 并忽略不认识的 v2 字段 ✓。
		//   少数老实现不遵守"选低版本"而直接报错 ⇒ 在同一连接上用 v1 形状重发一次
		//   （规范：initialize 失败后连接仍未初始化，允许重发；重发也失败则抛**原始**错误）。
		let reply;
		try {
			reply = await peer.request('initialize', acpInitializeParams(ACP_PROTOCOL_VERSION));
		} catch (error) {
			if (!acpIsVersionRejection(error)) { throw error; }
			reply = await peer.request('initialize', acpInitializeParams(1)).catch(() => { throw error; });
		}
		this.caps = acpCapabilitiesOf(reply, ACP_PROTOCOL_VERSION);
		return peer;
	}

	/** 模型目录：一次探针 session/new，读 configOptions 里的 model 选项。 */
	async listModels({ cwd, roots } = {}) {
		const peer = await this.ensure();
		const fallback = [{ id: 'default', name: 'CLI default' }];
		try {
			const params = acpSessionParams({ cwd, roots, capable: this.caps.additionalDirectories, mcpServers: [] });
			const reply = await peer.request('session/new', params, { timeout: 10_000 });
			const modelOption = (reply?.configOptions ?? []).find((option) => option?.configId === 'model');
			const options = Array.isArray(modelOption?.options) ? modelOption.options : [];
			const listed = options
				.map((option) => ({ id: String(option.value ?? option.id ?? ''), name: String(option.name ?? option.value ?? '') }))
				.filter((option) => option.id && option.id !== 'default');
			return [...fallback, ...listed];
		} catch {
			return fallback;
		}
	}

	/** 一个 dsh Session → 一个 CLI session。mcp 为 { url, token }。 */
	async openSession({ cwd, mcp, resumeId, roots } = {}) {
		const peer = await this.ensure();
		if (mcp && !this.caps.mcpHttp) throw new Error('NOT_SUPPORTED: 该 CLI 不支持 MCP over HTTP，拿不到团队工具');
		const mcpServers = mcp ? [{
			type: 'http', name: 'vssaros', url: mcp.url,
			headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }],
		}] : [];
		// v2 `session/resume` 与 v1 `session/load` 都跟 `session/new` 共用同一份参数 ⇒
		// resume 时**显式重传** cwd + 完整根列表，不依赖 agent 隐式恢复（v2 明确要求 ✓）。
		const params = acpSessionParams({ cwd, roots, capable: this.caps.additionalDirectories, mcpServers });
		const resumeMethod = this.caps.resumeMethod;
		let reply;
		if (resumeId && resumeMethod) {
			reply = await peer.request(resumeMethod, { ...params, sessionId: resumeId })
				.catch(() => peer.request('session/new', params));
		} else {
			reply = await peer.request('session/new', params);
		}
		// v2 `session/resume` 的成功响应可以不含 sessionId（规范示例为 `{}`）⇒ 用请求的 id 兜底 ✓
		const cliSessionId = String(reply?.sessionId ?? resumeId ?? '');
		if (!cliSessionId) throw new Error('ACP session/new 没有返回 sessionId');
		const session = { cliSessionId, events: new EventQueue(), toolCalls: new Map(), pendingPermissions: new Map() };
		this._sessions.set(cliSessionId, session);
		return cliSessionId;
	}

	events(cliSessionId) { return this._sessions.get(cliSessionId)?.events; }

	/** 发一轮 prompt；结果以事件推入队列，不在此处 await 整轮。
	 *  P2：`prompt` 也可直接传 ACP ContentBlock[]（含 image 块）；传字符串时行为与 P1 逐字一致。 */
	prompt(cliSessionId, prompt, { signal } = {}) {
		const peer = this._peer;
		const session = this._sessions.get(cliSessionId);
		if (!peer || !session) throw new Error(`ACP session ${cliSessionId} 不存在`);
		const blocks = Array.isArray(prompt) ? prompt : [{ type: 'text', text: String(prompt ?? '') }];
		void peer.request('session/prompt', { sessionId: cliSessionId, prompt: blocks }, { timeout: 0, signal })
			.then((reply) => session.events.push({ type: 'done', reason: reply?.stopReason ?? 'end_turn' }))
			.catch((error) => {
				if (signal?.aborted) return;
				session.events.push({ type: 'error', error: String(error?.message ?? error) });
			});
	}

	cancel(cliSessionId) {
		this._peer?.notify('session/cancel', { sessionId: cliSessionId });
	}

	/** adapter 审批完成后调用：按 optionId 回答 CLI 的权限请求。 */
	answerPermission(permissionId, optionId) {
		for (const session of this._sessions.values()) {
			const pending = session.pendingPermissions.get(permissionId);
			if (pending) {
				session.pendingPermissions.delete(permissionId);
				pending(optionId);
				return true;
			}
		}
		return false;
	}

	_onNotification(method, params) {
		if (method !== 'session/update') return;
		const session = this._sessions.get(String(params?.sessionId ?? ''));
		if (!session) return;
		const update = params?.update ?? {};
		switch (update.sessionUpdate) {
			case 'agent_message_chunk':
				session.events.push({ type: 'text', text: textOf(update.content) });
				break;
			case 'agent_thought_chunk':
				session.events.push({ type: 'thought', text: textOf(update.content) });
				break;
			case 'plan':
				session.events.push({ type: 'thought', text: planText(update.entries) });
				break;
			case 'tool_call':
			case 'tool_call_update': {
				const id = String(update.toolCallId ?? '');
				const previous = session.toolCalls.get(id) ?? {};
				const call = { ...previous };
				for (const [key, value] of Object.entries(update)) {
					if (key !== 'sessionUpdate' && value !== undefined && value !== null) call[key] = value;
				}
				const known = session.toolCalls.has(id);
				session.toolCalls.set(id, call);
				if (!known) session.events.push({ type: 'activity', text: `▸ ${describeCall(call)}` });
				break;
			}
			case 'usage_update':
				session.events.push({ type: 'usage', usage: update });
				break;
			default:
				break;
		}
	}

	async _onRequest(method, params) {
		if (method !== 'session/request_permission') throw new Error(`unsupported ACP request ${method}`);
		const session = this._sessions.get(String(params?.sessionId ?? ''));
		if (!session) throw new Error('unknown ACP session');
		const id = `perm-${Math.random().toString(36).slice(2)}`;
		const options = Array.isArray(params?.options) ? params.options : [];
		const action = describeCall({ ...session.toolCalls.get(String(params?.toolCall?.toolCallId ?? '')) });
		const optionId = await new Promise((resolve) => {
			session.pendingPermissions.set(id, resolve);
			session.events.push({ type: 'permission', id, action, options });
		});
		return optionId === null || optionId === undefined
			? { outcome: { outcome: 'cancelled' } }
			: { outcome: { outcome: 'selected', optionId } };
	}

	dispose() {
		this._disposed = true;
		this._peer?.failAll(new Error('ACP 引擎已释放'));
		for (const session of this._sessions.values()) {
			for (const pending of session.pendingPermissions.values()) pending(null);
			session.pendingPermissions.clear();
			session.events.close();
		}
		this._sessions.clear();
		try { this._child?.kill?.(); } catch { /* exited */ }
		this._child = undefined;
		this._peer = undefined;
	}
}
