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

const CLIENT_INFO = { name: 'vssaros', version: '1' };

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
		const reply = await peer.request('initialize', {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: CLIENT_INFO,
		});
		const caps = reply?.agentCapabilities?.mcpCapabilities ?? {};
		this.caps = { mcpHttp: caps.http === true || caps.sse === true, loadSession: reply?.agentCapabilities?.loadSession === true };
		return peer;
	}

	/** 模型目录：一次探针 session/new，读 configOptions 里的 model 选项。 */
	async listModels({ cwd } = {}) {
		const peer = await this.ensure();
		const fallback = [{ id: 'default', name: 'CLI default' }];
		try {
			const reply = await peer.request('session/new', { cwd: cwd ?? process.cwd(), mcpServers: [] }, { timeout: 10_000 });
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
	async openSession({ cwd, mcp, resumeId } = {}) {
		const peer = await this.ensure();
		if (mcp && !this.caps.mcpHttp) throw new Error('NOT_SUPPORTED: 该 CLI 不支持 MCP over HTTP，拿不到团队工具');
		const mcpServers = mcp ? [{
			type: 'http', name: 'vssaros', url: mcp.url,
			headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }],
		}] : [];
		const params = { cwd: cwd ?? process.cwd(), mcpServers };
		let reply;
		if (resumeId && this.caps.loadSession) {
			reply = await peer.request('session/load', { ...params, sessionId: resumeId })
				.catch(() => peer.request('session/new', params));
		} else {
			reply = await peer.request('session/new', params);
		}
		const cliSessionId = String(reply?.sessionId ?? '');
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
