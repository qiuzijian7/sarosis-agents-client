/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * `@vssaros/dsh-unreal`：把 `unreal_*` 族下移到 Host（README 4.68）。
 *
 * 钉三类东西：
 * 1. **移植不走样**：工具名 / 端点 / 默认地址 / 超时表 / 四条失败文案前缀，逐条比对真源
 *    `agentStudio/browser/providers/tool/unrealTools.ts` —— 模型是照着那些文案自我纠偏的。
 * 2. **只读口径不许放宽**：Host 侧只注册 health / help / dump / find_asset；exec / wait / build
 *    **不在**（VsSaros 侧对它们也是硬拒）。
 * 3. **真的能跑**：对**假 bridge**（本地 HTTP）走一遍四个工具，含那个真机踩过的坑
 *    —— 桥端不认识 `search_term`，转发时必须映射成 `name_contains`（真机日志 1790077760068）。
 */

const CORE_BRIDGE = 'dsh-plugins/vssaros-unreal/lib/core/bridge.js';
const PLUGIN_INDEX = 'dsh-plugins/vssaros-unreal/lib/index.js';
// ★ 2026-10-13：IDE 侧那份 legacy 实现（`…/providers/tool/unrealTools.ts`）**已整体删除** ✗
// ⇒ 本套件不再有"真源文件"可比，改用下面的**黄金表**（见测试 ①）。

/**
 * 七个工具的黄金契约（名字 / 端点 / 超时 / 必填参数 ✓）—— 冻结自 IDE 侧真源
 * `unrealTools.ts`（2026-10-13 删除前逐条抄录 ✓）。
 *
 * 为什么必须有它 ✗：插件是"Host 直连本机 bridge"的实现 ✓，端点/超时/参数名任何一处被改动都**不会**
 * 有编译错误 ✓ —— 表现是运行期 404 / 超时被掐断 / 模型参数对不上（当年 `search_term` 那个坑 ✓）。
 * 黄金表就是把这些契约"钉成可断言的数字"，改一个就红 ✓（与 p3-38 的黄金表同一手法 ✓）。
 */
const GOLDEN = [
	{ name: 'unreal_health', endpoint: '/bridge/health', timeoutMs: 5_000, required: undefined },
	{ name: 'unreal_exec', endpoint: '/bridge/exec', timeoutMs: 120_000, required: ['code'] },
	{ name: 'unreal_wait', endpoint: '/bridge/wait_probe', timeoutMs: 1_800_000, required: undefined },
	{ name: 'unreal_help', endpoint: '/bridge/help', timeoutMs: 30_000, required: undefined },
	{ name: 'unreal_dump', endpoint: '/bridge/dump', timeoutMs: 60_000, required: ['code'] },
	{ name: 'unreal_build', endpoint: '/bridge/build', timeoutMs: 900_000, required: ['mode'] },
	{ name: 'unreal_find_asset', endpoint: '/bridge/find_asset', timeoutMs: 60_000, required: undefined },
] as const;

const abs = (rel: string): string => path.join(process.cwd(), rel);
const readIf = (rel: string): string | undefined => (fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), 'utf8') : undefined);
const load = async <T>(rel: string): Promise<T> => await import(pathToFileURL(abs(rel)).href) as T;

interface IRegisteredTool {
	readonly name: string;
	readonly description?: string;
	readonly parameters?: Record<string, unknown>;
	readonly output?: { readonly schema?: unknown; readonly render?: unknown };
	/** 官方 `tools/call-timeout-policy` 读它定预算（长耗时工具必须自报，见 `lib/index.js`）。 */
	readonly timeoutMs?: number;
	isConcurrencySafe?: (args: Record<string, unknown>) => boolean;
	execute: (params: Record<string, unknown>, exec?: unknown) => Promise<unknown>;
}

interface IBridgeCore {
	readonly DEFAULT_BRIDGE_URL: string;
	readonly TIMEOUT_MS: Readonly<Record<string, number>>;
	readonly UNREAL_TOOLS: readonly { name: string; endpoint: string; parameters: { required?: readonly string[] } }[];
	callBridge(options: { bridgeUrl?: () => string | undefined }, endpoint: string, body: Record<string, unknown> | undefined, toolName: string, signal?: AbortSignal): Promise<string>;
}

/** 用假 ctx 驱动插件注册（不碰真 Host）。 */
async function loadTools(config: Record<string, unknown> = {}): Promise<IRegisteredTool[]> {
	const tools = (await loadPlugin(config)).tools;
	return tools;
}

/** 连"事件监听器"一起拿回来（验审批闸要用 ✓）。 */
async function loadPlugin(config: Record<string, unknown> = {}): Promise<{
	tools: IRegisteredTool[];
	handlers: Map<string, (exec: unknown, next: () => unknown) => unknown>;
	provided: Map<string, unknown>;
}> {
	const mod = await load<{ apply(ctx: unknown, config?: unknown): void }>(PLUGIN_INDEX);
	const tools: IRegisteredTool[] = [];
	const provided = new Map<string, unknown>();
	const handlers = new Map<string, (exec: unknown, next: () => unknown) => unknown>();
	const ctx = {
		logger: { info: () => { /* 静音 */ }, warn: () => { /* 静音 */ } },
		effect: (fn: () => unknown) => fn(),
		// 插件会 `ctx.provide('vssarosUnreal', …)`（供 `vssaros-ide` 让路，见 README 4.69）
		provide: (name: string, value: unknown) => { provided.set(name, value); },
		get: () => undefined,
		// 审批闸走官方 waterfall 事件 ⇒ 假 ctx 必须支持 `ctx.on`（否则 apply 期就抛 ✗）。
		on: (event: string, handler: (exec: unknown, next: () => unknown) => unknown) => {
			handlers.set(event, handler);
			return { dispose: () => { handlers.delete(event); } };
		},
		tools: {
			register: (tool: IRegisteredTool) => {
				// 镜像 dsh ≥ 0.2.1-alpha.1 的注册契约：`output` 必须给 `{ schema, render }`，缺了整条
				// entry **不激活**（Host 里表现为"插件像没装"；在真机上就是这么踩到的）⇒ 这里当场红。
				if (!tool.output || typeof tool.output.schema !== 'object' || typeof tool.output.render !== 'function') {
					throw new TypeError(`tool "${tool.name}" must declare output { schema, render }`);
				}
				tools.push(tool);
				return { dispose: () => { /* noop */ } };
			},
		},
	};
	mod.apply(ctx, config);
	return { tools, handlers, provided };
}

/** 假 bridge：记录收到的每个请求（方法与 body），按路由给固定响应。 */
interface IFakeBridge {
	readonly url: string;
	readonly seen: readonly { method: string; path: string; body: unknown }[];
	readonly port: number;
	status?: number;   // 设了就让所有请求返回这个状态码（验失败文案）
	close(): Promise<void>;
}

async function startFakeBridge(): Promise<IFakeBridge> {
	const seen: { method: string; path: string; body: unknown }[] = [];
	let status = 0;
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', chunk => { raw += chunk; });
		req.on('end', () => {
			let body: unknown;
			try { body = raw === '' ? undefined : JSON.parse(raw); } catch { body = raw; }
			seen.push({ method: req.method ?? '', path: req.url ?? '', body });
			if (status) {
				res.writeHead(status, { 'content-type': 'text/plain' });
				res.end('boom from fake bridge');
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			// 把收到的 body 回显回去 ⇒ 断言"转发出去的参数长什么样"（`find_asset` 那个坑全靠它）
			res.end(JSON.stringify({ route: req.url, project: 'ProbeProject', echoed: body ?? null }));
		});
	});
	const port = await new Promise<number>(resolve => {
		server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
	});
	return {
		port,
		url: `http://127.0.0.1:${port}`,
		get seen() { return seen; },
		get status() { return status; },
		set status(v: number) { status = v; },
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	};
}

suite('vssaros-unreal（unreal 族全在 Host：七个，直连本机 bridge）', () => {

	test('★ 契约与黄金表逐条一致（七个工具名 / 端点 / 默认地址 / 超时 / schema / 失败文案模板）', async () => {
		const core = await load<IBridgeCore>(CORE_BRIDGE);
		const own = readIf(CORE_BRIDGE);
		assert.ok(own, '读不到 lib/core/bridge.js');

		assert.strictEqual(core.DEFAULT_BRIDGE_URL, 'http://127.0.0.1:8765');
		// ① 名字（集合精确、顺序无关 ✓）与超时表（逐条数字 ✓）
		assert.deepStrictEqual([...core.UNREAL_TOOLS].map(t => t.name).sort(), GOLDEN.map(g => g.name).sort(),
			'工具名集合与黄金表不一致（多/少/改名都会红 ✓）');
		assert.deepStrictEqual(core.TIMEOUT_MS, Object.fromEntries(GOLDEN.map(g => [g.name, g.timeoutMs])),
			'超时表与黄金表不一致 ✗（wait 30 分钟那种长预算被调小 ⇒ 会被超时策略提前掐断）');
		// ② 端点（⚠ `/bridge/wait_probe` 不是 `/bridge/wait` ✗ —— 写错是运行期 404，静态看不出来）
		for (const g of GOLDEN) {
			const tool = core.UNREAL_TOOLS.find(t => t.name === g.name);
			assert.strictEqual(tool?.endpoint, g.endpoint, `${g.name} 的端点变了`);
		}
		// ③ schema：必填参数与黄金表一致（模型照着它填参数）
		for (const g of GOLDEN) {
			if (g.required) {
				assert.deepStrictEqual(core.UNREAL_TOOLS.find(t => t.name === g.name)?.parameters.required, [...g.required],
					`${g.name} 的必填参数变了`);
			}
		}
		// ④ ⚠ dsh 的受限参数 schema **没有 `minimum` / `maximum`** ✗（写了整条 entry 不激活 ⇒ 插件像没装）。
		//    真源 exec 的 `timeout_seconds` 就带 `minimum: 1` ⇒ 移植时必须把它改写进 description ✓。
		assert.ok(!/["']?(minimum|maximum)["']?\s*:/.test(JSON.stringify(core.UNREAL_TOOLS.map(t => t.parameters))),
			'参数 schema 里出现了 minimum/maximum ⇒ 不属于 dsh 的受限子集，整条 entry 会不激活 ✗');
		// ⑤ 失败文案模板（模型照着它们自我纠偏 ✓；模型侧行为由下面的假 bridge 端到端钉 ✓）
		for (const fragment of ['failed: bridge returned HTTP ', ' cancelled.', ' timed out after ', ' cannot reach the Unreal bridge at ']) {
			assert.ok(own!.includes(fragment), `失败文案模板变了：${fragment}`);
		}
	});

	test('★ 七个都注册；只读四个可并行、执行类三个不声明；写入类三个必须挂 ask 闸', async () => {
		const { tools, handlers } = await loadPlugin();
		assert.deepStrictEqual(tools.map(t => t.name).sort(), [
			'unreal_build', 'unreal_dump', 'unreal_exec', 'unreal_find_asset', 'unreal_health', 'unreal_help', 'unreal_wait',
		], 'Host 侧应当注册全部七个 unreal_* 工具');
		for (const name of ['unreal_health', 'unreal_help', 'unreal_dump', 'unreal_find_asset']) {
			assert.strictEqual(tools.find(t => t.name === name)?.isConcurrencySafe?.({}), true, `${name} 是只读 ⇒ 可并行`);
		}
		for (const name of ['unreal_exec', 'unreal_wait', 'unreal_build']) {
			assert.strictEqual(tools.find(t => t.name === name)?.isConcurrencySafe, undefined, `${name} 会改编辑器状态 ⇒ 默认独占`);
		}
		// 长超时必须逐工具声明（策略读 `tool.timeoutMs`；wait 30 分钟不声明会被默认值掐断 ✗）
		assert.strictEqual(tools.find(t => t.name === 'unreal_wait')?.timeoutMs, 1_800_000, 'wait 的 timeoutMs 必须是 30 分钟');

		// ★ 行为级验闸：闸真的挂在 `tools/pre-execute` 上，且**只拦执行类三个** ✓
		const gate = handlers.get('tools/pre-execute');
		assert.ok(typeof gate === 'function', '没挂官方 `tools/pre-execute` 钩子 ⇒ 执行类工具会在无询问下跑 ✗');
		const decision = (name: string): unknown => gate!({ name, args: {} }, () => ({ kind: 'allow' }));
		for (const name of ['unreal_exec', 'unreal_wait', 'unreal_build']) {
			const d = decision(name) as { kind?: string; reason?: string; displayReason?: Record<string, string> };
			assert.strictEqual(d?.kind, 'ask', `${name} 必须弹审批（ask）`);
			assert.ok((d.reason ?? '').includes('Unreal'), `${name} 的 reason 要说清在哪执行：${d.reason}`);
			assert.ok(d.displayReason?.en && d.displayReason?.zh, `${name} 的 displayReason 要双语`);
		}
		for (const name of ['unreal_health', 'unreal_help', 'unreal_dump', 'unreal_find_asset']) {
			assert.deepStrictEqual(decision(name), { kind: 'allow' }, `${name} 只读 ⇒ 不该弹窗（审批疲劳 ✗）`);
		}
	});

	test('★★ 端到端（假 bridge）：四个工具都打通，且 `search_term` 必须映射成 `name_contains`', async () => {
		const bridge = await startFakeBridge();
		try {
			const tools = await loadTools({ bridgeUrl: bridge.url });
			const byName = new Map(tools.map(t => [t.name, t]));
			const exec = async (name: string, params: Record<string, unknown> = {}) =>
				await byName.get(name)!.execute(params, {}) as string;

			// ① health（GET，无 body）
			const health = await exec('unreal_health');
			assert.ok(health.includes('ProbeProject'), `health 没读回桥端内容：${health.slice(0, 120)}`);
			assert.deepStrictEqual(bridge.seen.at(-1), { method: 'GET', path: '/bridge/health', body: undefined },
				'health 必须是 GET 且不带 body');

			// ② help：参数原样转发
			await exec('unreal_help', { symbol: 'EditorLevelLibrary', filter: 'actor' });
			assert.deepStrictEqual(bridge.seen.at(-1)?.body, { symbol: 'EditorLevelLibrary', filter: 'actor' });

			// ③ dump：`code` 原样带上
			await exec('unreal_dump', { code: 'unreal.EditorAssetLibrary', depth: 2 });
			assert.deepStrictEqual(bridge.seen.at(-1)?.body, { code: 'unreal.EditorAssetLibrary', depth: 2 });

			// ④ find_asset：**只给 search_term** ⇒ 转发出去必须**同时**有 name_contains（桥端不认识 search_term）
			const found = await exec('unreal_find_asset', { search_term: 'hero' });
			const sent = bridge.seen.at(-1)?.body as Record<string, unknown>;
			assert.strictEqual(sent?.name_contains, 'hero', `search_term 没有映射成 name_contains（桥端会 400）：${JSON.stringify(sent)}`);
			assert.ok(found.includes('hero'), `find_asset 没读回桥端内容：${found.slice(0, 120)}`);

			// ⑤ HTTP 错误：文案必须含状态码 + **回显实际发送的 body**（模型据此自我纠偏）
			bridge.status = 500;
			const failed = await exec('unreal_find_asset', { name_contains: 'x' });
			assert.ok(/^\[Unreal\] unreal_find_asset failed: bridge returned HTTP 500/.test(failed), `失败文案不符：${failed.slice(0, 160)}`);
			assert.ok(failed.includes('Sent body: '), '失败时必须回显实际发送的 body（当年就是靠它纠偏的）');
		} finally {
			await bridge.close();
		}
	});

	test('桥不可达：必须给出可读的"去开编辑器"文案，而不是抛异常', async () => {
		const bridge = await startFakeBridge();
		const url = bridge.url;
		await bridge.close();   // 端口立刻没人监听 ⇒ 连接被拒
		const tools = await loadTools({ bridgeUrl: url });
		const result = await tools.find(t => t.name === 'unreal_health')!.execute({}, {}) as string;
		assert.ok(/^\[Unreal\] unreal_health cannot reach the Unreal bridge at /.test(result),
			`不可达文案不符：${result.slice(0, 160)}`);
		assert.ok(result.includes('BunnySeekAgent'), '引导文案里应当说清要开什么');
	});
});
