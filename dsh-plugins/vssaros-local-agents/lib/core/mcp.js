// 回环 MCP Server（Streamable HTTP + SSE），把 dsh 团队工具喂给本地 CLI（P1）。
//
// 闭环：CLI 调 MCP `tools/call` → 本 server 用 SSE 挂住 HTTP 请求 → adapter 把它作为
// 普通 dsh tool-call chunk 发出 → dsh loop 执行工具（含审批）→ 下一轮 role:'tool'
// 结果回灌 → settle() 在同一条 SSE 流上写最终 JSON-RPC 响应 → CLI 继续这一轮。
//
// 安全：只听 127.0.0.1 随机端口，每实例一个 32 字节 bearer token；坏 token 401。
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const APPROVE_TOOL = 'approve_agent_action';

/** 挑剔的 CLI 不接受 $ref / oneOf / const：压成最朴素的 object schema。 */
export function flattenSchema(schema) {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
		return { type: 'object', properties: {} };
	}
	const out = {};
	for (const [key, value] of Object.entries(schema)) {
		if (['$ref', '$defs', 'definitions', 'const', 'additionalProperties'].includes(key)) continue;
		if (['oneOf', 'anyOf', 'allOf'].includes(key)) {
			const first = Array.isArray(value) ? value.find((entry) => entry && typeof entry === 'object') : undefined;
			if (first) Object.assign(out, flattenSchema(first));
			continue;
		}
		if (key === 'properties' && value && typeof value === 'object') {
			out.properties = {};
			for (const [name, prop] of Object.entries(value)) out.properties[name] = flattenSchema(prop);
			continue;
		}
		if (key === 'items' && value && typeof value === 'object') {
			out.items = flattenSchema(value);
			continue;
		}
		out[key] = value;
	}
	if (!out.type) out.type = 'object';
	return out;
}

export class LoopbackMcp {
	/**
	 * @param tools () => ToolSchema[]（{ name, description, parameters }）
	 * @param onCall ({ name, arguments, callId }) => void
	 */
	constructor({ tools = () => [], onCall = () => {}, keepAliveMs = 20_000, serverName = 'vssaros-local-agents' } = {}) {
		this._tools = tools;
		this._onCall = onCall;
		this._keepAliveMs = keepAliveMs;
		this._serverName = serverName;
		this._token = randomBytes(32).toString('hex');
		this._calls = new Map();
		this._server = undefined;
		this.url = undefined;
	}

	get token() { return this._token; }

	async start() {
		if (this.url) return { url: this.url, token: this._token };
		const server = createServer((req, res) => { void this._handle(req, res); });
		await new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		this._server = server;
		this.url = `http://127.0.0.1:${server.address().port}/mcp`;
		return { url: this.url, token: this._token };
	}

	async _handle(req, res) {
		const unauthorized = () => {
			res.writeHead(401, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }));
		};
		if (req.headers.authorization !== `Bearer ${this._token}`) return unauthorized();
		if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
		let raw = '';
		try {
			for await (const chunk of req) {
				raw += String(chunk);
				if (raw.length > 1024 * 1024) throw new Error('body too large');
			}
		} catch { res.writeHead(400); res.end(); return; }
		let body;
		try { body = JSON.parse(raw); } catch {
			res.writeHead(400);
			res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } }));
			return;
		}
		const messages = Array.isArray(body) ? body : [body];
		// CLI 的响应 / 通知（无 method）不期待应答。
		const calls = messages.filter((message) => message && typeof message.method === 'string' && message.method === 'tools/call');
		if (calls.length) { this._serveCall(calls[0], res); return; }
		const responses = messages
			.filter((message) => message && typeof message.method === 'string')
			.map((message) => this._answer(message))
			.filter(Boolean);
		if (!responses.length) { res.writeHead(202); res.end(); return; }
		const payload = Array.isArray(body) ? responses : responses[0];
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(payload));
	}

	_answer(message) {
		const id = message.id ?? null;
		const wrap = (result, error) => error
			? { jsonrpc: '2.0', id, error }
			: { jsonrpc: '2.0', id, result };
		switch (message.method) {
			case 'initialize':
				return wrap({
					protocolVersion: message.params?.protocolVersion ?? MCP_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: this._serverName, version: '1' },
				});
			case 'ping':
				return wrap({});
			case 'tools/list':
				return wrap({
					tools: (this._tools() ?? []).map((tool) => ({
						name: tool.name,
						description: String(tool.description ?? ''),
						inputSchema: flattenSchema(tool.parameters),
					})),
				});
			case 'notifications/initialized':
			case 'notifications/cancelled':
				return null;
			default:
				return wrap(undefined, { code: -32601, message: `unsupported method ${message.method}` });
		}
	}

	_serveCall(message, res) {
		const callId = `mcp-${randomUUID()}`;
		const progressToken = message.params?._meta?.progressToken ?? callId;
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			'connection': 'keep-alive',
		});
		let progress = 0;
		const timer = setInterval(() => {
			if (res.writableEnded) return;
			res.write('data: ' + JSON.stringify({
				jsonrpc: '2.0', method: 'notifications/progress',
				params: { progressToken, progress: ++progress * this._keepAliveMs, message: 'waiting for the tool result' },
			}) + '\n\n');
		}, this._keepAliveMs);
		timer.unref?.();
		const settle = (result) => {
			if (res.writableEnded) return;
			clearInterval(timer);
			this._calls.delete(callId);
			res.write('data: ' + JSON.stringify({
				jsonrpc: '2.0', id: message.id ?? null,
				result: {
					content: [{ type: 'text', text: String(result?.text ?? '') }],
					isError: result?.isError === true,
				},
			}) + '\n\n');
			res.end();
		};
		this._calls.set(callId, { settle, res });
		try {
			this._onCall({
				name: String(message.params?.name ?? ''),
				arguments: message.params?.arguments ?? {},
				callId,
			});
		} catch (error) {
			settle({ isError: true, text: String(error?.message ?? error) });
		}
	}

	/** 由 adapter 在拿到 dsh tool result 时调用。 */
	settle(callId, result) {
		this._calls.get(callId)?.settle(result);
	}

	failAll(error) {
		const text = String(error?.message ?? error);
		for (const [, entry] of [...this._calls]) entry.settle({ isError: true, text });
		this._calls.clear();
	}

	get pendingCount() { return this._calls.size; }

	close() {
		this.failAll(new Error('local agent server closed'));
		try { this._server?.close(); } catch { /* closed */ }
		this._server = undefined;
		this.url = undefined;
	}
}
