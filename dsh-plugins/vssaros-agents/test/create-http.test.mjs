// @vssaros/dsh-agents — 创建 Bot 的 **HTTP 级**集成测试（2026-11-09）
//   跑法：node dsh-plugins/vssaros-agents/test/create-http.test.mjs
//
// 为什么需要这一层：静态断言与纯函数单测都测不到「apply() 有没有真的把路由挂上」以及
//   「create 的回包到底长什么样」。参考 vssaros-scheduler 的 run-scheduler-host-check.mjs：
//   用假 ctx 真跑 apply()，再用假 req/res 打一次 POST，验落盘 + 状态码 + 回包字段。
//
// ⚠ 假 ctx 只提供「能让 apply 走到底」的最小服务面；effect 回调里的可选服务失败只记录、
//   不判失败（那是 dsh 运行期服务，不属于本测试范围）。真正的断言只落在 /api/agents 路由上。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'vssaros-agents-http-'));
const agentsRoot = join(tmp, 'agents');
const builtinRoot = join(tmp, 'builtin');
mkdirSync(join(builtinRoot, 'coder'), { recursive: true });

const routes = [];
const thrown = [];
const noop = () => undefined;
const ctx = {
	tools: { register: () => noop, get: () => undefined },
	webServer: { register: (r) => { routes.push(r); return noop; }, port: 7000, host: '127.0.0.1' },
	connection: { requestRejection: () => 0, authenticatedUrl: (u) => u },
	// 下面这些只为让 inject 的 deps 检查通过；回调里的调用失败由 effect 收集，不阻塞路由注册。
	sessionProjections: {}, systemPrompt: {}, sessionController: {}, llm: {},
	agents: {}, sessionQuery: {}, workspaceRegistry: {}, agentPresets: {},
	vssarosFoundation: { dataRootOf: () => tmp },
	vssarosWorkItems: null,
	logger: () => ({ info: noop, warn: noop, error: noop }),
	on: () => noop,
	effect: (fn) => { try { return fn(); } catch (e) { thrown.push('effect: ' + e.message); return undefined; } },
	inject: (deps, cb) => {
		for (const d of deps) { if (!ctx[d]) { return; } }
		try { cb(ctx); } catch (e) { thrown.push('inject: ' + e.message); }
	},
	provide: noop,
	get: (name) => ctx[name],
};

// index.js 里有直接 console.warn 的计时日志（假 ctx 的 logger no-op 挡不住）⇒ 静音；
// 结论仍用 console.log 输出，断言失败项照常可见。
const quiet = () => undefined;
console.warn = quiet;
console.info = quiet;
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href);
mod.apply(ctx, { dataRoot: tmp, agentsRoot, agentsBuiltinRoot: builtinRoot });
const route = routes.find((r) => String(r.path || '').startsWith('/x/agents'));

let pass = 0;
const fails = [];
const checkAsync = async (n, fn) => {
	try { await fn(); pass += 1; }
	catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); }
};

/** 假 req 必须实现 async iterable（readJsonBody 用 `for await (const chunk of req)`）。 */
async function post(body) {
	const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b ?? ''; } };
	const payload = Buffer.from(JSON.stringify(body));
	const req = {
		method: 'POST', url: '/x/agents/api/agents', headers: {},
		async *[Symbol.asyncIterator]() { yield payload; },
		destroy() { },
	};
	await route.handler(req, res);
	let json = null;
	try { json = JSON.parse(res.body); } catch { /* 下面按 code/body 断言 */ }
	return { ...res, json };
}

await checkAsync('apply() 真的挂上了 /x/agents 前缀路由', async () => {
	assert.ok(route && typeof route.handler === 'function', `routes=${routes.map((r) => r.path).join(',')}`);
	assert.equal(route.kind, 'prefix');
});

await checkAsync('POST {action:"validate"} ⇒ 200 + errors/warnings/agentMd（前端提交前的权威判据）', async () => {
	const r = await post({ action: 'validate', draft: { name: '审计 bot', id: 'audit-bot' } });
	assert.equal(r.code, 200, r.body);
	assert.ok(Array.isArray(r.json?.errors));
	assert.ok(Array.isArray(r.json?.warnings));
	assert.ok(r.json.warnings.some((w) => String(w).includes('人格正文')));
	assert.match(r.json.agentMd, /name: 审计 bot/);
});

await checkAsync('POST {action:"create"} ⇒ 200、回包带 registered、.agent.md 真的落盘', async () => {
	const r = await post({ action: 'create', draft: { name: '发布 bot', id: 'release-bot', persona: '你负责发布。' } });
	assert.equal(r.code, 200, r.body);
	assert.equal(r.json?.id, 'release-bot');
	assert.equal(typeof r.json?.registered, 'boolean', '前端靠它判断是不是假成功');
	const file = join(agentsRoot, 'release-bot', '.agent.md');
	assert.equal(existsSync(file), true);
	assert.match(readFileSync(file, 'utf8'), /你负责发布。/);
});

await checkAsync('同步失败时回包带原因字段的契约：registered 为 false 时不许客户端提示成功', async () => {
	// 假 ctx 没有 preset 注册表 ⇒ 走「跳过 sync」分支，registered 必然是 false；
	// 这条钉住的是「HTTP 层必须如实回 registered」，而不是模拟一次真的同步失败。
	const r = await post({ action: 'create', draft: { name: '未注册 bot', id: 'unregistered-bot' } });
	assert.equal(r.code, 200, r.body);
	assert.equal(r.json?.registered, false);
});

await checkAsync('POST 同名 id ⇒ 409（只新建不覆盖）', async () => {
	const r = await post({ action: 'create', draft: { name: '另一个', id: 'release-bot' } });
	assert.equal(r.code, 409, r.body);
	assert.match(readFileSync(join(agentsRoot, 'release-bot', '.agent.md'), 'utf8'), /name: 发布 bot/);
});

await checkAsync('POST 内置根同 id ⇒ 409，且不在自定义根写盘（不许劫持内置 agent）', async () => {
	const r = await post({ action: 'create', draft: { name: '劫持', id: 'coder' } });
	assert.equal(r.code, 409, r.body);
	assert.equal(existsSync(join(agentsRoot, 'coder')), false);
});

await checkAsync('POST 非法字段 ⇒ 400（不是 500，也不能静默 200）', async () => {
	const r = await post({ action: 'create', draft: { name: '坏', id: 'con' } });
	assert.equal(r.code, 400, r.body);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`create-http: ${pass} passed, ${fails.length} failed`);
for (const f of fails) { console.log(`  ✗ ${f}`); }
if (thrown.length) { console.log(`  (假 ctx 可选服务副作用 ${thrown.length} 条，已按设计忽略)`); }
process.exitCode = fails.length ? 1 : 0;
// apply() 会装若干定时器/监听器（IM 入站、房间轮询）；测试进程不该被它们挂住。
process.exit(fails.length ? 1 : 0);
