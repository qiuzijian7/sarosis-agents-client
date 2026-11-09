#!/usr/bin/env node
// llm-adapter-contract.test.mjs — dsh `LlmAdapter` 契约探针（doc/dsb-capability-compat-design.md §6.6）
//
// 目的：本地 Agent CLI 方案要把 CLI 伪装成一个 dsh 模型路由（LlmAdapter）。
// 外部实现按 dsh 0.2.2-rc.1 写，本产品随包是 0.2.1-rc.2 —— 本探针在**真实随包 runtime**
// 上钉住 seam，防止「照着新版本 API 写完才发现跑不起来」或日后 runtime 升级悄悄破坏契约。
//
// 断言三层：
//   ① 静态契约：GenerateOptions / StreamChunk / registerAdapter / replace 的字段与本方案假设一致；
//   ② 注册契约：真 LlmRuntime 上 registerAdapter → listProviders → replace → disposer 全链路；
//   ③ 流式契约：runtime.stream() 能把请求打到 adapter，且 adapter 发出的 chunk 被原样送出。
//
// 跑法：node dsh-plugins/test/llm-adapter-contract.test.mjs
// 环境变量：DSH_RUNTIME_NM 覆盖运行时 node_modules（默认依次找仓库内置 → dev 数据根）。
// 找不到 runtime 时明确 SKIP（干净检出没有随包 runtime，不算回归）。
//
// 本文件不放在任何 dsh 插件目录内 ⇒ 不触发 check-plugin-files / check-plugins-tracked 的插件清单扫描。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fails = [];
let passed = 0;
const ok = (message) => { passed++; console.log(`  ✓ ${message}`); };
const bad = (message, error) => {
	fails.push(message);
	console.error(`  ✗ ${message}${error ? ` — ${String(error?.message ?? error).split('\n')[0]}` : ''}`);
};
const check = (message, fn) => {
	try { fn(); ok(message); } catch (error) { bad(message, error); }
};
const checkAsync = async (message, fn) => {
	try { await fn(); ok(message); } catch (error) { bad(message, error); }
};

/** 找到一份含 dsh-llm 的 runtime node_modules；返回 undefined 表示本机没有可验证的 runtime。 */
function resolveRuntimeNm() {
	const candidates = [];
	if (process.env.DSH_RUNTIME_NM) candidates.push(process.env.DSH_RUNTIME_NM);
	const roots = [join(repo, 'dsh-runtime'), join(homedir(), '.vssaros-dev', 'dsh-runtime')];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		const versions = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name).sort().reverse();
		for (const version of versions) candidates.push(join(root, version, 'node_modules'));
	}
	return candidates.find((nm) => existsSync(join(nm, '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')));
}

const nm = resolveRuntimeNm();
if (!nm) {
	console.log('SKIP: 本机没有含 @deepseek-ai/dsh-llm 的 dsh runtime（干净检出或尚未安装）；设 DSH_RUNTIME_NM 可显式指定。');
	process.exit(0);
}
console.log(`运行时：${nm}`);

const llmDir = join(nm, '@deepseek-ai', 'dsh-llm', 'lib');
const mod = await import(pathToFileURL(join(llmDir, 'index.js')).href);
const LlmAdapter = mod.LlmAdapter;
const LlmRuntime = mod.default;
const typesText = readFileSync(join(llmDir, 'types', 'types.d.ts'), 'utf8');
const indexTypes = readFileSync(join(llmDir, 'types', 'index.d.ts'), 'utf8');

// ── ① 静态契约 ───────────────────────────────────────────────────────────
console.log('\n== ① 静态契约');
check('导出 LlmAdapter：默认方法齐备、stream 为抽象（子类必须覆写）', () => {
	assert.equal(typeof LlmAdapter, 'function');
	for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing',
		'imageRequestTarget', 'listModels', 'resolveModel', 'prepareCall']) {
		assert.equal(typeof LlmAdapter.prototype[method], 'function', `基类缺默认实现 ${method}`);
	}
	// abstract 只存在于类型层：运行时基类没有 stream，实现方必须自己给。
	assert.equal(LlmAdapter.prototype.stream, undefined);
	class Child extends LlmAdapter {
		async *stream() { yield { type: 'finish', reason: { kind: 'stop' } }; }
	}
	assert.ok(new Child() instanceof LlmAdapter);
});
check('导出 LlmRuntime（default）且带 registerAdapter', () => {
	assert.equal(typeof LlmRuntime, 'function');
	assert.equal(typeof LlmRuntime.prototype.registerAdapter, 'function');
	assert.equal(typeof LlmRuntime.prototype.stream, 'function');
	assert.equal(typeof LlmRuntime.prototype.listProviders, 'function');
});
check('types/index.d.ts 声明 registerAdapter 与 replace 的原子换路由', () => {
	assert.match(indexTypes, /registerAdapter\(providers: string\[\], adapter: LlmAdapter\): AdapterRegistrationHandle/);
	assert.match(indexTypes, /interface AdapterRegistrationHandle/);
	assert.match(indexTypes, /replace\(providers: string\[\]/);
	assert.match(indexTypes, /export declare abstract class LlmAdapter/);
});
check('GenerateOptions 带齐本地 Agent 依赖的字段', () => {
	const body = typesText.match(/export interface GenerateOptions \{([\s\S]*?)\n\}/)?.[1] ?? '';
	for (const field of [
		'provider: string', 'model: string', 'messages: RequestMessage[]',
		'system?: string', 'tools?: ToolSchema[]', 'signal?: AbortSignal',
		'sessionId?', 'purpose?',
	]) assert.ok(body.includes(field), `GenerateOptions 缺 ${field}`);
	assert.match(body, /purpose\?: 'compaction' \| 'session-title'/);
});
check('StreamChunk 覆盖 7 种 chunk（block-start → finish）', () => {
	const body = typesText.match(/export type StreamChunk = \{([\s\S]*?)\n\};/)?.[1] ?? '';
	for (const type of [
		"'block-start'", "'text-delta'", "'reasoning-delta'", "'tool-call-delta'",
		"'block-end'", "'usage'", "'finish'",
	]) assert.ok(body.includes(`type: ${type}`), `StreamChunk 缺 ${type}`);
});

// ── ② 注册契约（真 LlmRuntime） ──────────────────────────────────────────
console.log('\n== ② 注册契约');

/** 方案里 LocalAgentAdapter 的最小等价物：只发一段文本，不做任何 I/O。 */
class ProbeAdapter extends LlmAdapter {
	constructor() {
		super();
		this.seenOptions = undefined;
	}
	providerInfo(provider) { return { id: provider, name: `Probe ${provider}` }; }
	providerRetryPolicy() { return undefined; }
	imageRequestPricing() { return undefined; }
	async listModels(provider) { return [{ provider, id: 'default', name: 'CLI default' }]; }
	async resolveModel(provider, model) {
		return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 200_000 } };
	}
	async *stream(options) {
		this.seenOptions = options;
		const text = 'probe-ok';
		yield { type: 'block-start', index: 0, blockType: 'text' };
		yield { type: 'text-delta', index: 0, text };
		yield { type: 'block-end', index: 0, block: { type: 'text', text } };
		yield { type: 'finish', reason: { kind: 'stop' } };
	}
}

const profile = mkdtempSync(join(tmpdir(), 'vssaros-llm-probe-'));
let ctx;
let runtime;
try {
	// 走官方 boot，拿到真实的 ctx.llm（而不是手搓 mock）。
	const bootEntry = join(nm, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
	writeFileSync(join(profile, 'cordis.yml'), [
		'- id: llm',
		'  name: "@deepseek-ai/dsh-llm"',
		'',
	].join('\n'));
	const { boot } = await import(pathToFileURL(bootEntry).href);
	ctx = await boot('rc:llm-adapter-probe', join(profile, 'cordis.yml'), undefined, undefined,
		pathToFileURL(nm + '/').href);
	runtime = ctx.llm;
	await checkAsync('官方 boot 起真实 llm 服务', async () => {
		assert.ok(runtime, 'ctx.llm 未提供');
		assert.equal(typeof runtime.registerAdapter, 'function');
	});
} catch (error) {
	// 退化路径：boot 不可用（例如该 runtime 未带 app-boot）时直接构造服务，仍验证同一份实现。
	console.log(`  · boot 不可用，改用直接构造：${String(error?.message ?? error).split('\n')[0]}`);
	const { Context } = await import(pathToFileURL(join(nm, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href);
	ctx = new Context();
	runtime = new LlmRuntime(ctx);
}

const PROBE_ROUTE = 'vssaros-probe';
const adapter = new ProbeAdapter();
let handle;
await checkAsync('registerAdapter 注册路由并出现在 listProviders()', async () => {
	handle = runtime.registerAdapter([PROBE_ROUTE], adapter);
	assert.equal(typeof handle, 'function');
	assert.equal(typeof handle.replace, 'function');
	assert.deepEqual(runtime.listProviders().map((p) => p.id), [PROBE_ROUTE]);
});
await checkAsync('replace() 原子增减路由（含空数组）', async () => {
	handle.replace([PROBE_ROUTE, 'vssaros-probe-2']);
	assert.deepEqual(runtime.listProviders().map((p) => p.id), [PROBE_ROUTE, 'vssaros-probe-2']);
	handle.replace([]);
	assert.deepEqual(runtime.listProviders(), []);
	handle.replace([PROBE_ROUTE]);
	assert.deepEqual(runtime.listProviders().map((p) => p.id), [PROBE_ROUTE]);
});
await checkAsync('重复注册同名路由被拒（DUPLICATE_ADAPTER）', async () => {
	const other = new ProbeAdapter();
	let duplicate;
	try { duplicate = runtime.registerAdapter([PROBE_ROUTE], other); }
	catch (error) { assert.match(String(error?.code ?? error?.message ?? error), /DUPLICATE_ADAPTER/); return; }
	duplicate?.();
	assert.fail('重复注册没有被拒绝');
});
await checkAsync('listModels() 经 runtime 读到 adapter 目录', async () => {
	const models = await runtime.listModels(PROBE_ROUTE);
	assert.equal(models.length, 1);
	assert.equal(models[0].id, 'default');
});

// ── ③ 流式契约 ───────────────────────────────────────────────────────────
console.log('\n== ③ 流式契约');
await checkAsync('runtime.stream() 打到 adapter 且原样送出 chunk', async () => {
	const controller = new AbortController();
	const options = {
		provider: PROBE_ROUTE,
		model: 'default',
		messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
		system: 'probe system',
		tools: [],
		signal: controller.signal,
	};
	const chunks = [];
	for await (const chunk of runtime.stream(options)) chunks.push(chunk);
	assert.deepEqual(chunks.map((chunk) => chunk.type),
		['block-start', 'text-delta', 'block-end', 'finish']);
	assert.equal(chunks[1].text, 'probe-ok');
	assert.equal(chunks[3].reason.kind, 'stop');
});
await checkAsync('adapter 收到的 GenerateOptions 保留请求字段', async () => {
	const seen = adapter.seenOptions;
	assert.ok(seen, 'adapter.stream 没被调用');
	assert.equal(seen.provider, PROBE_ROUTE);
	assert.equal(seen.model, 'default');
	assert.equal(seen.system, 'probe system');
	assert.ok(seen.signal instanceof AbortSignal);
	assert.ok(Array.isArray(seen.messages));
	assert.ok(Array.isArray(seen.tools));
});

await checkAsync('disposer 撤销路由后不再可见', async () => {
	handle();
	assert.deepEqual(runtime.listProviders(), []);
	assert.throws(() => handle.replace([PROBE_ROUTE]), /REGISTRATION_DISPOSED|disposed/i);
});

// ── ④ 零依赖 adapter（插件实现形态） ─────────────────────────────────────
// 仓库根没有 @deepseek-ai/dsh-llm，插件源码若静态 import 会让 check-plugin-files
// 的「入口能真正 import」变红。runtime 对 adapter 是 duck-typing，所以插件用普通对象即可。
console.log('\n== ④ 零依赖 duck-typed adapter');
const PLAIN_ROUTE = 'vssaros-probe-plain';
const plain = {
	calls: [],
	providerInfo(provider) { return { id: provider, name: `Plain ${provider}` }; },
	providerRetryPolicy() { return undefined; },
	async listModels(provider) { return [{ provider, id: 'default', name: 'CLI default' }]; },
	async resolveModel(provider, model) {
		return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 200_000 } };
	},
	async prepareCall(provider, model, signal) {
		const modelInfo = await this.resolveModel(provider, model, signal);
		return { model: modelInfo, stream: (options) => this.stream(options) };
	},
	async *stream(options) {
		this.calls.push(options);
		yield { type: 'block-start', index: 0, blockType: 'text' };
		yield { type: 'text-delta', index: 0, text: 'plain-ok' };
		yield { type: 'block-end', index: 0, block: { type: 'text', text: 'plain-ok' } };
		yield { type: 'finish', reason: { kind: 'stop' } };
	},
};
let plainHandle;
await checkAsync('普通对象（不继承 LlmAdapter）可注册并完整服务一次 stream', async () => {
	plainHandle = runtime.registerAdapter([PLAIN_ROUTE], plain);
	const chunks = [];
	for await (const chunk of runtime.stream({
		provider: PLAIN_ROUTE, model: 'default',
		messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
	})) chunks.push(chunk);
	assert.deepEqual(chunks.map((chunk) => chunk.type),
		['block-start', 'text-delta', 'block-end', 'finish']);
	assert.equal(chunks[1].text, 'plain-ok');
	assert.equal(plain.calls.length, 1);
});
await checkAsync('duck-typed adapter 同样可热换路由并干净撤销', async () => {
	plainHandle.replace([PLAIN_ROUTE, 'vssaros-probe-plain-2']);
	assert.equal(runtime.listProviders().length, 2);
	plainHandle();
	assert.deepEqual(runtime.listProviders(), []);
});

// ── 清理 ────────────────────────────────────────────────────────────────
try { ctx?.fiber?.dispose?.(); } catch { /* 探针不因清理失败变红 */ }
rmSync(profile, { recursive: true, force: true });

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) {
	for (const failure of fails) console.error(`  - ${failure}`);
	process.exitCode = 1;
}
