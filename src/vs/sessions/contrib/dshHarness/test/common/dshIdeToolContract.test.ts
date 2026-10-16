/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh-ide 工具的**参数契约**测试：插件源码（`dsh-plugins/vssaros-ide`）⇄ VsSaros 侧的校验与预算。
 *
 * 为什么需要（真事故，不是假想）：`browser` 的 schema 声明了
 * `url / ref / text / key / direction / amount / append`，但 `execute` 只转交了 `op` ⇒ 所有带副作用的
 * 动作 op 到达 IDE 侧必然报"缺参数"，**整族动作事实上不可用**。而这在编译期与既有的单测里都看不出来：
 * 那些单测测的是 VsSaros 侧的 `executeIdeCapability`，而**两侧各自都是对的**——错的是中间那次转交。
 *
 * 同类的第二处：本侧等待预算写死 20s，而 VsSaros 侧的同意窗口是 60s ⇒ 用户还在读确认框，Host 侧已超时，
 * 模型拿到的是"renderer 没有回执"这种把排查方向带偏的错误。
 *
 * 所以这里驱动**真实的插件模块**（`apply()` + 假桥），把每次 `callIDE` 的参数与预算抓下来断言：
 * ① schema 声明的每个键都必须被转交（少一个 = 那个参数在 VsSaros 侧永远是缺的）；
 * ② 本侧预算必须**严格晚于**渲染侧预算（`ideRequestTimeoutMs`，同仓库直接导入，不抄第二份真值）；
 * ③ 需用户确认的 op，预算必须大于同意窗口（窗口值从 VsSaros 源码里读）；
 * ④ `browser.type` 的"清空"语义：`text: ''` 是有意义的值，必须如实转交而不是被过滤掉。
 *
 * 插件自身没有测试设施（模块零依赖、不引入打包），这里是它唯一的下游守卫。
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IDE_CANVAS_ACTION_OPS, ideRequestTimeoutMs } from '../../common/dshIdeCapabilities.js';

const PLUGIN_REL = 'dsh-plugins/vssaros-ide/lib/index.js';
const SERVICE_REL = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';

interface IToolProperties { readonly [key: string]: { readonly type?: string } }

interface IToolDefinition {
	readonly name: string;
	readonly parameters?: { readonly properties?: IToolProperties };
	readonly isConcurrencySafe?: (args: { op?: string } | undefined) => boolean;
	/** 第二参是 dsh 给的工具执行上下文（会话 id 在 `exec.agent.session.id`）。 */
	readonly execute: (args: Record<string, unknown>, exec?: { agent?: { session?: { id?: string } } }) => Promise<unknown>;
}

interface IBridgeCall {
	readonly method: string;
	readonly params: { readonly capability?: string; readonly sessionId?: string; readonly params?: Record<string, unknown> };
	readonly opts?: { readonly timeoutMs?: number };
}

interface IArgumentCase { readonly label: string; readonly args: Record<string, unknown> }

/** 并发标记的签名（显式命名：`assert.ok()` 的断言收窄会让"从属性取出来的函数"触发 TS7022）。 */
type ConcurrencySafe = (args: { op?: string } | undefined) => boolean;

/** 一个参数按 schema 的 `type` 取一个"能被转交"的样本值（只关心"是否被转交"，不关心取值语义）。 */
function sampleArg(schema: { readonly type?: string } | undefined): unknown {
	switch (schema?.type) {
		case 'integer': return 1;
		case 'boolean': return true;
		case 'array': return [];
		default: return 'x';
	}
}

function sampleArgs(properties: IToolProperties): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const key of Object.keys(properties)) {
		args[key] = sampleArg(properties[key]);
	}
	return args;
}

/**
 * 每个工具要跑的参数组合：带 `op` 的工具**按 op 分档**（只读 / 需用户确认），其余一次跑全部字段。
 * op 清单直接取自 VsSaros 侧的白名单，所以新增 op 会自动纳入（不会"加了 op 忘了测"）。
 */
function argumentCases(tool: IToolDefinition): IArgumentCase[] {
	const properties = tool.parameters?.properties ?? {};
	if (!('op' in properties)) {
		return [{ label: '默认', args: sampleArgs(properties) }];
	}
	const base = sampleArgs(properties);
	// ⚠ `browser` 那支已随该族整体删除（README 4.80）⇒ 本侧只剩 canvas 的 op 集。
	const ops = ['state', 'task_status', ...IDE_CANVAS_ACTION_OPS];
	return ops.map(op => ({ label: op, args: { ...base, op } }));
}

/**
 * 加载插件模块并驱动一遍 `apply()`，捕获工具定义与桥调用；`cwd` 不是仓库根时返回 `undefined`（跳过）。
 * 假 ctx 只提供插件真正用到的东西：`tools.register` / `vssarosBridge.callIDE` / `effect`。
 */
async function loadPlugin(): Promise<{ readonly tools: IToolDefinition[]; readonly calls: IBridgeCall[] } | undefined> {
	const source = path.join(process.cwd(), PLUGIN_REL);
	if (!fs.existsSync(source)) {
		return undefined;
	}
	const mod = await import(pathToFileURL(source).href) as { apply: (ctx: unknown, config?: unknown) => void };
	const tools: IToolDefinition[] = [];
	const calls: IBridgeCall[] = [];
	const ctx = {
		tools: {
			register: (definition: IToolDefinition) => {
				tools.push(definition);
				return () => { /* disposer：测试里不需要 */ };
			},
		},
		vssarosBridge: {
			callIDE: async (method: string, params: IBridgeCall['params'], opts: IBridgeCall['opts']) => {
				calls.push({ method, params, opts });
				return {};
			},
		},
		effect: (fn: () => unknown) => fn(),
	};
	mod.apply(ctx, {});
	return { tools, calls };
}

/** 跑一个工具的一次参数组合，返回它发出的那次桥调用（没有发出则断言失败）。 */
async function callOf(plugin: { tools: IToolDefinition[]; calls: IBridgeCall[] }, tool: IToolDefinition, args: Record<string, unknown>): Promise<{ call: IBridgeCall; inner: Record<string, unknown> }> {
	plugin.calls.length = 0;
	await tool.execute(args);
	const call = plugin.calls.at(-1);
	assert.ok(call, `${tool.name}: 没有发出任何桥调用（参数：${JSON.stringify(args)}）`);
	// unreal 的工具把参数放在 `params.args` 下（与 VsSaros 侧同一份形状），其余在 params 顶层。
	const inner = { ...(call.params.params ?? {}), ...((call.params.params as { args?: Record<string, unknown> })?.args ?? {}) };
	return { call, inner };
}

/** 同意窗口（毫秒）：从 VsSaros 源码里读，避免把它抄成第二份真值。 */
function readConsentWindowMs(): number {
	const source = path.join(process.cwd(), SERVICE_REL);
	if (!fs.existsSync(source)) {
		return -1; // 调用方按"读不到就不做这条断言"处理
	}
	const match = /IDE_CONSENT_TIMEOUT_MS\s*=\s*([\d_]+)/.exec(fs.readFileSync(source, 'utf8'));
	assert.ok(match, `${SERVICE_REL} 里找不到 IDE_CONSENT_TIMEOUT_MS —— 常量被改名了？这条断言需要跟着改`);
	return Number(match[1].replace(/_/g, ''));
}

const isConsentOp = (capability: string, op: string | undefined): boolean => op !== undefined
	&& capability === 'canvas' && (IDE_CANVAS_ACTION_OPS as readonly string[]).includes(op);

suite('dshHarness / dsh-ide tool contract（插件 ⇄ VsSaros 侧）', () => {

	test('★ 每个工具：schema 里声明的参数都会被转交（声明了却不转 = 静默丢参）', async () => {
		const plugin = await loadPlugin();
		if (!plugin) {
			assert.ok(true, `（跳过：找不到 ${PLUGIN_REL}——测试进程的 cwd 不是仓库根）`);
			return;
		}
		assert.ok(plugin.tools.length > 0, '插件没有注册任何工具：apply() 的入口变了？');
		for (const tool of plugin.tools) {
			const properties = tool.parameters?.properties ?? {};
			for (const testCase of argumentCases(tool)) {
				const { inner } = await callOf(plugin, tool, testCase.args);
				for (const key of Object.keys(properties)) {
					assert.ok(key in inner, `${tool.name} / ${testCase.label}：schema 声明了 \`${key}\`，但插件没转交它 ⇒ 该参数在 VsSaros 侧永远是缺的`);
				}
			}
		}
	});

	test('★ 会话透传：`exec.agent.session.id` 必须进桥调用（主进程靠它把结果投对窗口）', async () => {
		const plugin = await loadPlugin();
		if (!plugin) {
			assert.ok(true, '（跳过：cwd 不是仓库根）');
			return;
		}
		for (const tool of plugin.tools) {
			plugin.calls.length = 0;
			await tool.execute(argumentCases(tool)[0].args, { agent: { session: { id: 'sess-xyz' } } });
			const call = plugin.calls.at(-1);
			assert.ok(call, `${tool.name} 没有发出桥调用`);
			assert.strictEqual(call.params.sessionId, 'sess-xyz',
				`${tool.name} 没把会话 id 透传出去 ⇒ 多窗口下这次能力只能退回广播（结果可能落在用户没看的窗口）`);
		}
		// 拿不到 exec（老版本 dsh / 非会话上下文）⇒ **不带** sessionId：主进程据此退回广播，行为与从前一致
		const first = plugin.tools[0];
		plugin.calls.length = 0;
		await first.execute(argumentCases(first)[0].args);
		assert.strictEqual(plugin.calls.at(-1)?.params.sessionId, undefined, '拿不到会话时不该编一个出来');
	});

	// ⚠ `browser.type` 的"清空语义"用例已随该族退役（README 4.73 Step 3）：它现在归 Host 侧插件
	//   `@vssaros/dsh-browser`，同一不变量由 `dshBrowserPlugin.test.ts`（参数校验）与
	//   `dshBrowserParity.test.ts`（`type` 的空串三态与 IDE 侧逐字对照）覆盖 ✓。

	test('★★ 本侧等待预算严格晚于渲染侧（否则会盖掉主进程那条能指导排查的错误）', async () => {
		const plugin = await loadPlugin();
		if (!plugin) {
			assert.ok(true, '（跳过：cwd 不是仓库根）');
			return;
		}
		for (const tool of plugin.tools) {
			for (const testCase of argumentCases(tool)) {
				const { call, inner } = await callOf(plugin, tool, testCase.args);
				const capability = String(call.params.capability);
				const timeoutMs = Number(call.opts?.timeoutMs);
				const renderMs = ideRequestTimeoutMs(capability, inner);
				assert.ok(timeoutMs > renderMs,
					`${tool.name} / ${testCase.label}：本侧预算 ${timeoutMs}ms 没有晚于渲染侧 ${renderMs}ms ⇒ 会盖掉"renderer 没有回执 / 用户拒绝"这类更有指导性的错误`);
			}
		}
	});

	test('★★ 需用户确认的 op：预算必须大于同意窗口（窗口写在 VsSaros 侧，从源码读）', async () => {
		const plugin = await loadPlugin();
		if (!plugin) {
			assert.ok(true, '（跳过：cwd 不是仓库根）');
			return;
		}
		const consentMs = readConsentWindowMs();
		if (consentMs < 0) {
			assert.ok(true, `（跳过：找不到 ${SERVICE_REL}）`);
			return;
		}
		let checked = 0;
		for (const tool of plugin.tools) {
			for (const testCase of argumentCases(tool)) {
				const { call, inner } = await callOf(plugin, tool, testCase.args);
				const capability = String(call.params.capability);
				const op = typeof inner.op === 'string' ? inner.op : undefined;
				if (!isConsentOp(capability, op)) {
					continue;
				}
				checked++;
				const timeoutMs = Number(call.opts?.timeoutMs);
				assert.ok(timeoutMs > consentMs,
					`${tool.name} / ${op}：本侧预算 ${timeoutMs}ms 没有大于同意窗口 ${consentMs}ms ⇒ 用户还在读确认框，Host 侧已经超时`);
			}
		}
		// ⚠ 只算 canvas：`browser` 的动作集已随该族退役（README 4.73 Step 3，Host 侧插件的预算由
		//   `dshBrowserPlugin.test.ts` 覆盖）⇒ 本侧只剩 canvas 那一档。
		assert.ok(checked >= IDE_CANVAS_ACTION_OPS.length,
			`只检查到 ${checked} 个需确认的 op：op 白名单与插件侧的识别已经脱钩`);
	});

	test('★ 有副作用的 op 不与其它工具并行（并发标记按 op 给，不是一律 true）', async () => {
		const plugin = await loadPlugin();
		if (!plugin) {
			assert.ok(true, '（跳过：cwd 不是仓库根）');
			return;
		}
		// ⚠ `browser` 那两行已随该族退役（README 4.73 Step 3）；同样的并发标记由 Host 侧插件的
		//   `dshBrowserPlugin.test.ts`（`status` 可并行 / `navigate` 独占）覆盖 ✓。
		const expectations: [string, string, boolean][] = [
			['canvas', 'state', true], ['canvas', 'apply_ops', false],
		];
		for (const [name, op, expected] of expectations) {
			// 显式标注 + 先取出方法引用：不然 `assert.ok(tool?.isConcurrencySafe, …)` 的断言收窄会参与
			// 它自己的类型推断（TS7022 circular inference，annotation 是官方解法）。
			const tool: IToolDefinition | undefined = plugin.tools.find(t => t.name === name);
			const isSafe: ConcurrencySafe | undefined = tool?.isConcurrencySafe;
			assert.ok(isSafe, `${name} 没有 isConcurrencySafe`);
			assert.strictEqual(isSafe({ op }), expected,
				`${name} / ${op}：并发安全应为 ${expected}（有副作用的动作并发会互相覆盖同一份状态）`);
		}
	});

	// ⚠ "只读 Unreal 工具的预算必须长于底层超时"这条已随该族退役（README 4.73 Step 3）：现在
	//   **Host 侧插件自己就是那个 HTTP 客户端**（没有"两层预算"了），超时表与四条失败文案由
	//   `dshUnrealPlugin.test.ts` / `dshBrowserParity.test.ts` 的跨源码与对等性守卫钉住 ✓。
});
