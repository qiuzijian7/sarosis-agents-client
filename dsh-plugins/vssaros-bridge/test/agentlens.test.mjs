// @vssaros/dsh-bridge — AgentLens 上报单测（零依赖：node --test 直跑）
// 跑法：node --test dsh-plugins/vssaros-bridge/test/agentlens.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	readConfig, buildPayload, createAgentLensListener,
} from '../lib/agentlens.js';

const cfg = (overrides = {}) => ({
	...readConfig({ VSSAROS_AGENTLENS_ENABLED: '1' }),
	userId: 'zijianqiu',
	...overrides,
});

function attrsOf(payload) {
	return new Map(payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.map(a => [a.key, a.value]));
}

function messages() {
	return [
		{ role: 'user', content: [{ type: 'text', text: '第一个问题' }] },
		{ role: 'assistant', content: [{ type: 'text', text: '上一个回答' }] },
		{ role: 'user', content: [{ type: 'text', text: '再问一次' }] },
	];
}

function options() {
	return {
		sessionId: 'session-abc',
		provider: 'codebuddy',
		model: 'claude-opus-4.6',
		purpose: 'chat',
		maxTokens: 8192,
		system: '你是 VsSaros 助手',
		messages: messages(),
		tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object' } }],
	};
}

async function drain(stream) {
	const out = [];
	for await (const chunk of stream) { out.push(chunk); }
	return out;
}

test('readConfig：默认接入 VsSaros 空间，环境变量可覆盖与关停', () => {
	const base = readConfig({});
	assert.equal(base.enabled, true);
	assert.equal(base.space, 'VsSaros');
	assert.equal(base.appName, 'VsSaros');
	assert.match(base.apiKey, /^21443#apm-log-/);
	assert.match(base.baseUrl, /trace-llm\.zhiyan\.tencent-cloud\.net:4318$/);

	const overridden = readConfig({
		VSSAROS_AGENTLENS_ENABLED: '0',
		VSSAROS_AGENTLENS_API_KEY: 'other-key',
		VSSAROS_AGENTLENS_BASE_URL: 'http://127.0.0.1:4318',
		VSSAROS_AGENTLENS_TRACE_CONTENT: 'false',
	});
	assert.equal(overridden.enabled, false);
	assert.equal(overridden.apiKey, 'other-key');
	assert.equal(overridden.baseUrl, 'http://127.0.0.1:4318');
	assert.equal(overridden.traceContent, false);
	assert.equal(createAgentLensListener(overridden, () => {}), undefined);
});

test('llm/stream：chunk 原样透传，产出一条合规的 LLM span', async () => {
	const calls = [];
	const post = (url, headers, body) => {
		calls.push({ url, headers, payload: JSON.parse(body) });
		return { status: 200, body: '' };
	};
	const listener = createAgentLensListener(cfg(), post);
	assert.ok(listener);
	const chunks = [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: '你好' },
		{ type: 'text-delta', index: 0, text: '，世界' },
		{ type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 300, cacheReadTokens: 180 } },
		{ type: 'finish', reason: { kind: 'stop' } },
	];
	const inner = (async function* () { for (const c of chunks) { yield c; } })();
	const seen = await drain(listener(options(), () => inner));
	assert.deepEqual(seen, chunks, '只观察、不改 chunk');

	assert.equal(calls.length, 1);
	assert.match(calls[0].url, /\/v1\/traces$/);
	assert.equal(calls[0].headers.Authorization, `Bearer ${cfg().apiKey}`);
	const payload = calls[0].payload;
	const resource = new Map(payload.resourceSpans[0].resource.attributes.map(a => [a.key, a.value.stringValue]));
	assert.equal(resource.get('service.name'), 'VsSaros');
	assert.equal(resource.get('tps.tenant.id'), cfg().apiKey);
	assert.equal(resource.get('vssaros.space'), 'VsSaros');

	const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
	assert.match(span.traceId, /^[0-9a-f]{32}$/);
	assert.match(span.spanId, /^[0-9a-f]{16}$/);
	assert.equal(span.kind, 2, '唯一 LLM 调用必须是 SERVER 入口');
	assert.equal(span.status.code, 1);
	assert.match(span.startTimeUnixNano, /^\d{19}$/);
	assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));

	const a = attrsOf(payload);
	assert.equal(a.get('gen_ai.span.kind').stringValue, 'LLM');
	assert.equal(a.get('gen_ai.request.model').stringValue, 'claude-opus-4.6');
	assert.equal(a.get('gen_ai.session.id').stringValue, 'session-abc');
	assert.equal(a.get('gen_ai.user.id').stringValue, 'zijianqiu');
	assert.equal(a.get('gen_ai.prompts.0.role').stringValue, 'system');
	assert.equal(a.get('gen_ai.prompts.3.content').stringValue, '再问一次');
	assert.equal(a.get('input.value').stringValue, '再问一次');
	assert.equal(a.get('output.value').stringValue, '你好，世界');
	assert.equal(a.get('gen_ai.completion.0.content').stringValue, '你好，世界');
	assert.equal(a.get('gen_ai.completion.0.finish_reason').stringValue, 'stop');
	assert.equal(a.get('gen_ai.request.functions.0.name').stringValue, 'read_file');
	assert.equal(a.get('gen_ai.usage.input_tokens').intValue, '280', 'dsh inputTokens 不含 cacheRead ⇒ 用 total-output');
	assert.equal(a.get('gen_ai.usage.output_tokens').intValue, '20');
	assert.equal(a.get('gen_ai.usage.total_tokens').intValue, '300');
	assert.equal(a.get('gen_ai.usage.cache_read.input_tokens').intValue, '180');
	assert.match(a.get('gen_ai.response.time_to_first_token').intValue, /^\d+$/);
});

test('next() 返回 Promise<AsyncIterable> 时也能透传并上报', async () => {
	let posted = 0;
	const listener = createAgentLensListener(cfg(), () => { posted++; return { status: 200 }; });
	const stream = listener(options(), async () => (async function* () {
		yield { type: 'text-delta', text: 'ok' };
	})());
	assert.deepEqual(await drain(stream), [{ type: 'text-delta', text: 'ok' }]);
	assert.equal(posted, 1);
});

test('流抛错：错误原样抛出，span 标 ERROR 且仍然上报', async () => {
	let payload;
	const listener = createAgentLensListener(cfg(), (_u, _h, body) => { payload = JSON.parse(body); return { status: 200 }; });
	const stream = listener(options(), () => (async function* () {
		yield { type: 'text-delta', text: '半截' };
		throw new Error('upstream 500');
	})());
	await assert.rejects(drain(stream), /upstream 500/);
	const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
	assert.equal(span.status.code, 2);
	assert.match(span.status.message, /upstream 500/);
	assert.equal(attrsOf(payload).get('output.value').stringValue, '半截');
});

test('traceContent=false：不上报 prompt/completion 内容，仍上报模型与用量', () => {
	const rec = {
		traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_001_000, firstTokenAt: 1_700_000_000_100,
		sessionId: 's', provider: 'p', model: 'm', purpose: 'chat',
		messages: messages(), system: 'sys', tools: [], text: '秘密回答',
		usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
		finishReason: 'stop', toolCalls: [], error: '',
	};
	const payload = buildPayload(rec, cfg({ traceContent: false }));
	const a = attrsOf(payload);
	assert.equal(a.has('input.value'), false);
	assert.equal(a.has('output.value'), false);
	assert.equal(a.has('gen_ai.prompts.0.content'), false);
	assert.equal(a.has('gen_ai.completion.0.content'), false);
	assert.equal(a.get('gen_ai.usage.total_tokens').intValue, '7');
	assert.equal(a.get('gen_ai.request.model').stringValue, 'm');
});
