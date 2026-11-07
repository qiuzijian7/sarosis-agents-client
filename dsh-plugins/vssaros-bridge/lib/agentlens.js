// @vssaros/dsh-bridge — AgentLens（智研 LLM 监控）OTLP trace 上报
//
// 文档（iWiki）：
//   /p/4018603004 产品介绍 · /p/4021074599 Node SDK 上报 · /p/4013780362 接入地址配置
//   /p/4016237678 span attribute · /p/4018154692 其他语言（OTLP 原生）上报
//   /p/4021484202 CodeBuddy EventMessage → LLM Span 字段映射
//
// 为什么不用 `@tencent/zhiyan-llm-otel-sdk`：它只自动采集 OpenAI SDK，而 VsSaros 的
// 模型调用走 dsh 的 `llm/stream` 抽象（多 provider、代码块流）；并且本插件没有
// dependencies、只有 lib 随包分发 ⇒ 这里按 OTLP/HTTP JSON 协议直接发 LLM span
// （零依赖、不进构建链、不受浏览器 CORS 影响，Host 是 Node 进程）。
//
// 粒度：一次 `llm/stream` 调用 = 一条独立 trace，入口是 SERVER(kind=2) 的 LLM span
// （文档「如果链路中只有一个 LLM 调用，则该 LLM Span 也需要设置为 SERVER 类型」）。
// 后续要串 AGENT/CHAIN/TOOL 子 span 时，把同一回合内的调用共用 rec.traceId 即可。
//
// ⚠ 上报永远不能影响模型流：只观察 chunk、异步发 HTTP、失败只节流打一行日志。
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';

/** 办公网 / DevCloud / 公网的上报地址；IDC/OA 可用 http://trace-llm.zhiyan.woa.com:4318。 */
const DEFAULTS = Object.freeze({
	enabled: true,
	apiKey: '21443#apm-log-c8gcgc1bdaa5e76a#21894_201055___apm',
	baseUrl: 'https://trace-llm.zhiyan.tencent-cloud.net:4318',
	appName: 'VsSaros',
	space: 'VsSaros',
	traceContent: true,
	maxAttrChars: 8 * 1024,
	timeoutMs: 5000,
});

const SCOPE_NAME = 'vssaros-agentlens';
const SCOPE_VERSION = '1.0.0';

function boolOf(value, fallback) {
	if (value === undefined || value === null || value === '') { return fallback; }
	return !/^(0|false|no|off)$/i.test(String(value));
}

function intOf(value, fallback, min, max) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** 全部配置都有环境变量出口；默认值就是本次接入的 VsSaros 空间与密钥。 */
export function readConfig(env = process.env) {
	return {
		enabled: boolOf(env.VSSAROS_AGENTLENS_ENABLED, DEFAULTS.enabled),
		apiKey: String(env.VSSAROS_AGENTLENS_API_KEY || env.ZHIYAN_LLM_API_KEY || DEFAULTS.apiKey),
		baseUrl: String(env.VSSAROS_AGENTLENS_BASE_URL || env.ZHIYAN_LLM_BASE_URL || DEFAULTS.baseUrl),
		appName: String(env.VSSAROS_AGENTLENS_APP_NAME || DEFAULTS.appName),
		space: String(env.VSSAROS_AGENTLENS_SPACE || DEFAULTS.space),
		userId: String(env.VSSAROS_AGENTLENS_USER_ID || env.USERNAME || env.USER || ''),
		traceContent: boolOf(env.VSSAROS_AGENTLENS_TRACE_CONTENT ?? env.ZHIYAN_LLM_TRACE_CONTENT, DEFAULTS.traceContent),
		maxAttrChars: intOf(env.VSSAROS_AGENTLENS_MAX_ATTR_CHARS, DEFAULTS.maxAttrChars, 1024, 128 * 1024),
		timeoutMs: intOf(env.VSSAROS_AGENTLENS_TIMEOUT_MS, DEFAULTS.timeoutMs, 500, 60_000),
	};
}

/** 字符串化 + 截断（attribute 默认 8KB，超长会拖垮查询与上报）。 */
function clip(value, max) {
	let s;
	try {
		s = typeof value === 'string' ? value : JSON.stringify(value);
	} catch {
		s = String(value);
	}
	if (typeof s !== 'string') { s = String(s ?? ''); }
	return s.length <= max ? s : `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}

/** dsh 消息形状：`{ role, content: [{ type:'text', text }] }`；兼容纯文本与 items。 */
function textOfMessage(message) {
	if (!message) { return ''; }
	if (typeof message === 'string') { return message; }
	const content = message.content ?? message.items;
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		return content.map(part => {
			if (!part) { return ''; }
			if (typeof part === 'string') { return part; }
			if (typeof part.text === 'string') { return part.text; }
			if (typeof part.content === 'string') { return part.content; }
			return '';
		}).filter(Boolean).join('\n');
	}
	return typeof message.text === 'string' ? message.text : '';
}

/** 系统提示 + 最近 30 条消息 ⇒ gen_ai.prompts.N.*（与 CodeBuddy 映射文档同口径）。 */
function promptsOf(rec) {
	const out = [];
	const system = rec.system;
	if (typeof system === 'string' && system.trim()) {
		out.push({ role: 'system', content: system });
	} else if (Array.isArray(system)) {
		const text = textOfMessage({ content: system });
		if (text) { out.push({ role: 'system', content: text }); }
	}
	for (const message of rec.messages.slice(-30)) {
		out.push({
			role: typeof message?.role === 'string' ? message.role : 'user',
			content: textOfMessage(message),
		});
	}
	return out;
}

/** input.value：最后一条 user 消息（CodeBuddy 映射文档口径）。 */
function lastUserInput(rec) {
	for (let i = rec.messages.length - 1; i >= 0; i--) {
		if (rec.messages[i]?.role === 'user') { return textOfMessage(rec.messages[i]); }
	}
	return textOfMessage(rec.messages[rec.messages.length - 1]);
}

function putAttr(attrs, key, value, cfg) {
	if (value === undefined || value === null || value === '') { return; }
	if (typeof value === 'boolean') {
		attrs.push({ key, value: { boolValue: value } });
	} else if (typeof value === 'number' && Number.isFinite(value)) {
		attrs.push({ key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } });
	} else {
		attrs.push({ key, value: { stringValue: clip(value, cfg.maxAttrChars) } });
	}
}

/** dsh 的 usage chunk：`{ inputTokens, outputTokens, totalTokens, cacheReadTokens, … }`。 */
function putUsage(attrs, usage, put) {
	if (!usage || typeof usage !== 'object') { return; }
	const num = (...keys) => {
		for (const k of keys) {
			const v = usage[k];
			if (typeof v === 'number' && Number.isFinite(v)) { return Math.round(v); }
		}
		return undefined;
	};
	const input = num('inputTokens', 'input_tokens', 'prompt_tokens');
	const output = num('outputTokens', 'output_tokens', 'completion_tokens');
	const total = num('totalTokens', 'total_tokens');
	const cacheRead = num('cacheReadTokens', 'cache_read_input_tokens');
	const cacheWrite = num('cacheWriteTokens', 'cache_creation_input_tokens');
	// dsh 的 inputTokens 不含 cacheRead（见 chat-surface/client.usage.js）⇒ 优先 total-output。
	const prompt = total !== undefined && output !== undefined ? Math.max(0, total - output)
		: (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined)
			? (input || 0) + (cacheRead || 0) + (cacheWrite || 0)
			: undefined;
	if (prompt !== undefined) { put('gen_ai.usage.input_tokens', prompt); }
	if (output !== undefined) { put('gen_ai.usage.output_tokens', output); }
	if (total !== undefined) { put('gen_ai.usage.total_tokens', total); }
	else if (prompt !== undefined && output !== undefined) { put('gen_ai.usage.total_tokens', prompt + output); }
	if (cacheRead !== undefined) { put('gen_ai.usage.cache_read.input_tokens', cacheRead); }
	if (cacheWrite !== undefined) { put('gen_ai.usage.cache_creation.input_tokens', cacheWrite); }
}

function putTools(attrs, tools, put) {
	for (let i = 0; i < Math.min(tools.length, 20); i++) {
		const tool = tools[i];
		const name = typeof tool === 'string' ? tool : (tool?.name ?? tool?.function?.name);
		if (!name) { continue; }
		put(`gen_ai.request.functions.${i}.name`, name);
		const description = tool?.description ?? tool?.function?.description;
		if (description) { put(`gen_ai.request.functions.${i}.description`, description); }
		const parameters = tool?.parameters ?? tool?.inputSchema ?? tool?.function?.parameters;
		if (parameters) { put(`gen_ai.request.functions.${i}.parameters`, parameters); }
	}
}

/** 一条 LLM span 的完整 OTLP/HTTP JSON 负载。导出供单测断言，不做网络 IO。 */
export function buildPayload(rec, cfg) {
	const attrs = [];
	const put = (key, value) => putAttr(attrs, key, value, cfg);

	put('gen_ai.span.kind', 'LLM');
	put('gen_ai.operation.name', 'CHAT');
	put('gen_ai.system', rec.provider || 'unknown');
	put('gen_ai.framework', 'VsSaros');
	put('gen_ai.business.scenario', rec.purpose || 'chat');
	put('gen_ai.session.id', rec.sessionId || undefined);
	put('gen_ai.user.id', cfg.userId || undefined);
	put('gen_ai.request.model', rec.model || undefined);
	put('gen_ai.model_name', rec.model || undefined);
	put('gen_ai.response.model', rec.model || undefined);
	put('gen_ai.request.is_stream', true);
	if (typeof rec.maxTokens === 'number') { put('gen_ai.request.max_tokens', rec.maxTokens); }
	put('vssaros.space', cfg.space);
	put('vssaros.provider', rec.provider || undefined);
	put('vssaros.purpose', rec.purpose || undefined);

	// 首 token 耗时是纳秒 int64 ⇒ 必须走 BigInt，Date.now()*1e6 会丢精度。
	if (rec.firstTokenAt) {
		const ns = String(BigInt(Math.max(0, rec.firstTokenAt - rec.startedAt)) * 1_000_000n);
		attrs.push({ key: 'gen_ai.response.time_to_first_token', value: { intValue: ns } });
		// 单 LLM span 即入口 span ⇒ 用户视角 TTFT 也挂在这里（一条 trace 只挂一次）。
		attrs.push({ key: 'gen_ai.user.time_to_first_token', value: { intValue: ns } });
	}

	if (cfg.traceContent) {
		const prompts = promptsOf(rec);
		prompts.forEach((p, i) => {
			put(`gen_ai.prompts.${i}.role`, p.role);
			put(`gen_ai.prompts.${i}.content`, p.content);
		});
		put('input.value', lastUserInput(rec));
		put('output.value', rec.text);
		put('gen_ai.completion.0.content', rec.text);
		put('gen_ai.completion.0.role', 'assistant');
		put('gen_ai.completion.0.finish_reason', rec.finishReason || 'stop');
		rec.toolCalls.slice(0, 20).forEach((name, i) => {
			put(`gen_ai.completion.0.tool_calls.${i}.name`, name);
		});
		putTools(attrs, rec.tools, put);
	}
	putUsage(attrs, rec.usage, put);

	const span = {
		traceId: rec.traceId,
		spanId: rec.spanId,
		name: 'llm_completion',
		kind: 2, // SERVER：链路里只有这一个 LLM 调用
		startTimeUnixNano: String(BigInt(rec.startedAt) * 1_000_000n),
		endTimeUnixNano: String(BigInt(rec.endedAt || rec.startedAt) * 1_000_000n),
		attributes: attrs,
		status: rec.error ? { code: 2, message: clip(rec.error, 512) } : { code: 1 },
	};
	return {
		resourceSpans: [{
			resource: {
				attributes: [
					{ key: 'service.name', value: { stringValue: cfg.appName } },
					// 接入密钥同时是租户标识（Node SDK 文档「apiKey 作为 tps.tenant.id」）。
					{ key: 'tps.tenant.id', value: { stringValue: cfg.apiKey } },
					{ key: 'vssaros.space', value: { stringValue: cfg.space } },
				],
			},
			scopeSpans: [{ scope: { name: SCOPE_NAME, version: SCOPE_VERSION }, spans: [span] }],
		}],
	};
}

/** 零依赖 POST（不依赖全局 fetch，Node 18+ 与更老的版本都能跑）。 */
export function postJson(url, headers, body, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		let target;
		try { target = new URL(url); } catch (e) { reject(e); return; }
		const transport = target.protocol === 'https:' ? https : http;
		const req = transport.request(target, {
			method: 'POST',
			headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
		}, res => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', chunk => { if (text.length < 2048) { text += chunk; } });
			res.on('end', () => resolve({ status: res.statusCode || 0, body: text }));
		});
		req.setTimeout(timeoutMs, () => req.destroy(new Error(`AgentLens request timeout after ${timeoutMs}ms`)));
		req.on('error', reject);
		req.write(body);
		req.end();
	});
}

let lastWarnAt = 0;
let suppressedWarns = 0;
function warnOnce(message) {
	const now = Date.now();
	if (now - lastWarnAt < 60_000) { suppressedWarns++; return; }
	lastWarnAt = now;
	console.warn(`[vssaros-bridge][agentlens] ${message}${suppressedWarns ? `（另有 ${suppressedWarns} 条已抑制）` : ''}`);
	suppressedWarns = 0;
}

function report(rec, cfg, post) {
	try {
		rec.endedAt = Date.now();
		const body = JSON.stringify(buildPayload(rec, cfg));
		const url = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/traces`;
		Promise.resolve(post(url, {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${cfg.apiKey}`,
		}, body, cfg.timeoutMs))
			.then(result => {
				if (result && result.status >= 400) { warnOnce(`上报失败 HTTP ${result.status}：${clip(result.body, 300)}`); }
			})
			.catch(error => warnOnce(`上报失败：${String(error?.message ?? error)}`));
	} catch (error) {
		warnOnce(`构造 span 失败：${String(error?.message ?? error)}`);
	}
}

function collect(chunk, rec) {
	if (!chunk || typeof chunk !== 'object') { return; }
	const type = chunk.type;
	if (type === 'text-delta' && typeof chunk.text === 'string') {
		rec.firstTokenAt ||= Date.now();
		rec.text += chunk.text;
	} else if (type === 'reasoning-delta' && typeof (chunk.text ?? chunk.reasoning) === 'string') {
		rec.firstTokenAt ||= Date.now();
		rec.reasoning += chunk.text ?? chunk.reasoning;
	} else if (type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
		rec.usage = { ...(rec.usage || {}), ...chunk.usage };
	} else if (type === 'finish') {
		rec.finishReason = String(chunk.finishReason ?? chunk.reason?.kind ?? 'stop');
	} else if (type === 'error') {
		rec.error = clip(chunk.error ?? chunk.message ?? 'unknown stream error', 512);
	} else if (typeof type === 'string' && /tool/i.test(type)) {
		rec.firstTokenAt ||= Date.now();
		const name = chunk.toolName ?? chunk.name ?? chunk.tool?.name;
		if (name) { rec.toolCalls.push(String(name)); }
	}
}

function observe(result, rec, cfg, post) {
	const iterate = async function* (stream) {
		try {
			for await (const chunk of stream) {
				collect(chunk, rec);
				yield chunk;
			}
		} catch (error) {
			rec.error = rec.error || String(error?.message ?? error);
			throw error;
		} finally {
			report(rec, cfg, post);
		}
	};
	// dsh 的 waterfall 既可能返回 AsyncIterable，也可能返回 Promise<AsyncIterable>
	// （见 superagent/lib/index.js 的 meteredStream）⇒ 两种都得透传。
	if (result && typeof result[Symbol.asyncIterator] === 'function') { return iterate(result); }
	if (result && typeof result.then === 'function') {
		return (async function* () {
			let stream;
			try { stream = await result; }
			catch (error) {
				rec.error = rec.error || String(error?.message ?? error);
				report(rec, cfg, post);
				throw error;
			}
			yield* iterate(stream);
		})();
	}
	report(rec, cfg, post);
	return result;
}

/**
 * 生成 `ctx.on('llm/stream', …)` 的 waterfall listener。返回 undefined 表示未启用。
 * `post` 可注入（单测用），生产缺省走 postJson。
 */
export function createAgentLensListener(cfg = readConfig(), post = postJson) {
	if (!cfg.enabled || !cfg.apiKey || !cfg.baseUrl) { return undefined; }
	return (options, next) => {
		const rec = {
			traceId: randomBytes(16).toString('hex'),
			spanId: randomBytes(8).toString('hex'),
			startedAt: Date.now(),
			endedAt: 0,
			firstTokenAt: 0,
			sessionId: typeof options?.sessionId === 'string' ? options.sessionId : '',
			provider: typeof options?.provider === 'string' ? options.provider : '',
			model: typeof options?.model === 'string' ? options.model : '',
			purpose: typeof options?.purpose === 'string' ? options.purpose : '',
			maxTokens: typeof options?.maxTokens === 'number' ? options.maxTokens : undefined,
			messages: Array.isArray(options?.messages) ? options.messages : [],
			system: options?.system,
			tools: Array.isArray(options?.tools) ? options.tools : [],
			text: '',
			reasoning: '',
			usage: undefined,
			finishReason: '',
			toolCalls: [],
			error: '',
		};
		let result;
		try { result = next(); }
		catch (error) {
			rec.error = String(error?.message ?? error);
			report(rec, cfg, post);
			throw error;
		}
		return observe(result, rec, cfg, post);
	};
}
