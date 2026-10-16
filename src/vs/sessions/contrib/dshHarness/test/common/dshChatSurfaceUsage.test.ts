/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh 回合页脚（chat-surface 的 `client.usage.js`）的**纯逻辑**与链路契约。
 *
 * 为什么这么测：这个 chunk 是 dsh 客户端模块（`window.__ModuleLoader__.load`），只能在页面里
 * 装载，仓库里没有它的运行时 harness ⇒ 两段：
 *  ① 用假 `window.__ModuleLoader__` 取出 factory 并直接跑它导出的 `__test` 纯函数（数值口径）；
 *  ② 源码级断言链路契约（DOM 事件名必须与协议常量一致、浮层六行/三段条/图例齐全）——
 *     与 `agentChatPanel.footerPills.test.ts` 读源码断言的既有做法同法。
 */

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { DSH_PAGE_CREDIT_EVENT, DSH_PAGE_IPC_CREDIT } from '../../common/dshPageBridgeProtocol.js';

const USAGE_REL = 'dsh-plugins/vssaros-chat-surface/lib/client.usage.js';
const PRELOAD_REL = 'src/vs/sessions/contrib/dshHarness/electron-browser/preload-dshView.ts';

/** 读仓库内文件（测试从仓库根跑 ⇒ 路径相对 cwd ✓，与 footerPills / wsSwitchDiag 同法 ✓）。 */
function read(rel: string): string {
	const abs = join(process.cwd(), rel);
	assert.ok(existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
	return readFileSync(abs, 'utf8');
}

/** 取出 chunk 的模块导出（只读 `__test`，不调用 install ⇒ 不需要真 react / ctx）。 */
function loadChunkExports(source: string): Record<string, any> {
	let definition: any;
	const fakeWindow = { __ModuleLoader__: { load: (d: any) => { definition = d; } } };
	// 该 chunk 是 IIFE 风格脚本，只写 `window.__ModuleLoader__.load({...})`。
	new Function('window', source)(fakeWindow);
	assert.ok(definition && typeof definition.factory === 'function', 'chunk 必须经 window.__ModuleLoader__.load 注册 factory');
	const reactStub = { createElement: () => null, useState: () => [null, () => undefined], useEffect: () => undefined, Fragment: {} };
	return definition.factory((id: string) => {
		if (id === 'react') {
			return reactStub;
		}
		throw new Error(`unexpected require: ${id}`);
	});
}

/** 装载 chunk 并真的执行 `install()`，拿回注册进 slot 的组件与纯逻辑辅助。 */
function makeHarness(): { exports: Record<string, any>; render: (props: Record<string, unknown>) => any; setReactHooks: (r: Record<string, any>) => void } {
	let definition: any;
	const fakeWindow = { __ModuleLoader__: { load: (d: any) => { definition = d; } } };
	new Function('window', read(USAGE_REL))(fakeWindow);
	const reactRef: { current: Record<string, any> } = { current: {} };
	const reactStub: Record<string, any> = {
		Fragment: 'Fragment',
		createElement: makeElement,
		useState: () => [null, () => undefined],
		useEffect: () => undefined,
	};
	reactRef.current = reactStub;
	// 转发式 react 替身：chunk 在 factory 期就 `require("react")` 一次，所以必须让**方法调用**
	// 转发到当下那份实现（`setReactHooks` 换掉后才生效）——快照式返回会让替换无效。
	const reactProxy: Record<string, any> = {
		get Fragment() { return reactRef.current.Fragment; },
		createElement: (...args: unknown[]) => reactRef.current.createElement(...args),
		useState: (...args: unknown[]) => reactRef.current.useState(...args),
		useEffect: (...args: unknown[]) => reactRef.current.useEffect(...args),
	};
	const chunkExports: Record<string, any> = definition.factory((id: string) => {
		if (id === 'react') { return reactProxy; }
		throw new Error(`unexpected require: ${id}`);
	});
	let component: any;
	const ctx = {
		slots: {
			inject: (_slot: string, factory: () => unknown) => { factory(); },
			register: (_spec: unknown, comp: any) => { component = comp; return () => undefined; },
		},
	};
	// 页面里 `document` 恒存在（install 要挂积分事件的 DOM 监听），Node 里给一个最小替身。
	const g = globalThis as { document?: unknown };
	g.document = g.document ?? {
		addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => undefined,
	};
	const shellState: { error?: string } = {};
	chunkExports.install(ctx, { state: shellState });
	assert.strictEqual(shellState.error, undefined, `install 不应报错：${shellState.error}`);
	assert.ok(typeof component === 'function', 'install 必须把回合页脚注册进 turnTail 槽');
	return {
		exports: chunkExports,
		setReactHooks: (r: Record<string, any>) => { reactRef.current = r; },
		render: (props: Record<string, unknown>) => component(props),
	};
}

/**
 * 迷你 `createElement`：元素型 type 记成普通对象；**函数组件直接调用**（= React 的行为，
 * 否则浮层组件的内容根本不会出现在树里，断言只能测到"节点存在"）。
 */
function makeElement(type: unknown, props: unknown, ...children: unknown[]): any {
	const next = { ...(props ?? {}), children } as Record<string, unknown>;
	return typeof type === 'function' ? (type as (p: unknown) => unknown)(next) : { type, props: props ?? {}, children };
}

/**
 * 带「按 hook 调用序存值」的假 react（驱动 useState 状态迁移 ⇒ 能模拟 hover）。
 * `cursor` 每次渲染前归零，但 `hooks` **跨渲染保留**（= React 的 state 槽语义）。
 */
function statefulReact(store: { hooks: unknown[]; cursor: number }): Record<string, any> {
	return {
		Fragment: 'Fragment',
		createElement: makeElement,
		useEffect: () => { store.cursor++; },
		useState: (init: unknown) => {
			const at = store.cursor++;
			if (store.hooks.length <= at) {
				store.hooks[at] = typeof init === 'function' ? (init as () => unknown)() : init;
			}
			return [store.hooks[at], (next: unknown) => {
				store.hooks[at] = typeof next === 'function' ? (next as (p: unknown) => unknown)(store.hooks[at]) : next;
			}];
		},
	};
}

/** 从假 react 树里找页脚 chips（返回 `[{ text, props }]`）。 */
function pillsOf(tree: any): { text: string; props: any }[] {
	const out: { text: string; props: any }[] = [];
	const visit = (node: any): void => {
		if (!node || typeof node !== 'object') { return; }
		if (node.props && node.props['data-vssaros-turn-usage']) {
			for (const child of node.children ?? []) {
				if (child && child.props) {
					out.push({ text: String(child.children?.[1] ?? ''), props: child.props });
				}
			}
		}
		for (const child of node.children ?? []) { visit(child); }
	};
	visit(tree);
	return out;
}

/** 用户截图（2026-10-11）里的真实一回合读数。 */
const SAMPLE_USAGE = {
	inputTokens: 8_078_234, uncachedInputTokens: 38_938, cacheReadTokens: 8_039_296,
	cacheWriteTokens: 0, reasoningTokens: 29_481, outputTokens: 48_277, totalTokens: 8_126_511,
};

suite('chat-surface 回合用量（缓存命中率与积分归属）', () => {
	const t = loadChunkExports(read(USAGE_REL)).__test;

	test('summarizeTurnUsage：字段归整 + 回复内容 = 输出 − 思考过程', () => {
		const u = t.summarizeTurnUsage(SAMPLE_USAGE);
		assert.strictEqual(u.prompt, 8_078_234);
		assert.strictEqual(u.cacheRead, 8_039_296);
		assert.strictEqual(u.uncached, 38_938);
		assert.strictEqual(u.cacheWrite, 0);
		assert.strictEqual(u.output, 48_277);
		assert.strictEqual(u.reasoning, 29_481);
		assert.strictEqual(u.total, 8_126_511);
		assert.strictEqual(u.content, 18_796, '回复内容必须是输出减去思考过程');
	});

	test('缺字段与零值必须区分（`—` vs `0`；不产出 `name: undefined` 之外的假读数）', () => {
		const u = t.summarizeTurnUsage({ totalTokens: 10 });
		assert.strictEqual(u.cacheRead, null, '没上报缓存字段 ⇒ null（显示 —）');
		assert.strictEqual(u.cacheWrite, null);
		assert.strictEqual(u.output, null);
		assert.strictEqual(u.content, null);
		assert.strictEqual(t.formatTokenValue(u.cacheRead), '—');
		assert.strictEqual(t.formatTokenValue(0), '0', '0 是真实读数，不能显示成 —');
		assert.strictEqual(t.summarizeTurnUsage(undefined), null);
	});

	test('没有 inputTokens 时输入总量由 命中+写入+未命中 派生（与官方三项求和同式）', () => {
		const u = t.summarizeTurnUsage({ cacheReadTokens: 5, cacheWriteTokens: 2, uncachedInputTokens: 3 });
		assert.strictEqual(u.prompt, 10);
	});

	test('缓存命中率：命中 / 输入总量，1 位小数（与截图 99.5% 一致）', () => {
		assert.strictEqual(t.cacheHitRateText(8_039_296, 8_078_234), '99.5%');
		assert.strictEqual(t.cacheHitRateText(10, 10), '100%', '全命中给 100%');
		assert.strictEqual(t.cacheHitRateText(0, 100), '0.0%', '一次都没命中是有效读数');
	});

	test('★★ 部分命中绝不四舍五入成 100%（官方 formatCacheHitPercent 的同一条诚实性）', () => {
		const text = t.cacheHitRateText(9_999, 10_000);
		assert.notStrictEqual(text, '100.0%', '1 位小数会给出 100.0% ⇒ 必须提高精度');
		assert.strictEqual(text, '99.99%');
	});

	test('输入量缺失/为零 ⇒ 命中率 null（显示 —，不是 0%）', () => {
		assert.strictEqual(t.cacheHitRateText(null, 100), null);
		assert.strictEqual(t.cacheHitRateText(5, null), null);
		assert.strictEqual(t.cacheHitRateText(0, 0), null);
	});

	test('三段条宽度：命中 + 写入 + 未命中 = 100%', () => {
		const seg = t.hitRateSegments({ prompt: 100, cacheRead: 80, cacheWrite: 5 });
		assert.deepStrictEqual(seg, { read: 80, write: 5, miss: 15 });
		assert.strictEqual(t.hitRateSegments({ prompt: 0, cacheRead: 0 }), null, '没有输入量 ⇒ 不出条');
	});

	suite('积分样本按回合时间窗归属（creditInWindow）', () => {
		const s = (at: number, credit?: number, extra: Record<string, unknown> = {}) => ({
			route: 'vssaros-codebuddy', model: 'hy4-preview-ioa', at,
			...(credit === undefined ? {} : { credit }), ...extra,
		});
		const win = (over: Record<string, unknown> = {}) => ({ start: 100, end: 250, provider: null, model: null, ...over });

		test('窗口内求和、窗口外不计', () => {
			assert.deepStrictEqual(t.creditInWindow([s(100, 1), s(200, 2), s(300, 4)], win()), { credit: 3, responses: 2 });
		});

		test('有响应但都没有 credit 字段 ⇒ credit 仍为 null（与"积分 0"必须区分）', () => {
			assert.deepStrictEqual(t.creditInWindow([s(120)], win()), { credit: null, responses: 1 });
		});

		test('显式 credit 0 计入（0 是真读数）', () => {
			assert.deepStrictEqual(t.creditInWindow([s(120, 0)], win()), { credit: 0, responses: 1 });
		});

		test('provider/model 不符的其它会话请求被排除（主进程只能广播）', () => {
			const w = win({ model: 'hy4-preview-ioa', provider: 'vssaros-codebuddy' });
			assert.deepStrictEqual(t.creditInWindow([s(120, 5, { model: 'other-model' })], w), { credit: null, responses: 0 });
			assert.deepStrictEqual(t.creditInWindow([s(120, 5, { route: 'vssaros-ollama' })], w), { credit: null, responses: 0 });
			assert.deepStrictEqual(t.creditInWindow([s(120, 5)], w), { credit: 5, responses: 1 });
		});

		test('回合未结束（end=null）时后续样本都算在内', () => {
			assert.deepStrictEqual(t.creditInWindow([s(100, 1), s(9_999, 2)], win({ end: null })), { credit: 3, responses: 2 });
		});

		test('脏样本被忽略', () => {
			assert.deepStrictEqual(t.creditInWindow([null, {}, { route: 'x' }, s(150, 1)] as any, win()), { credit: 1, responses: 1 });
		});

		test('normalizeCreditSample：缺 route/at 一律拒绝（脏数据不进样本池）', () => {
			assert.deepStrictEqual(t.normalizeCreditSample({ route: 'vssaros-codebuddy', at: 7 }),
				{ route: 'vssaros-codebuddy', model: null, credit: null, at: 7 });
			assert.strictEqual(t.normalizeCreditSample({ route: 'vssaros-codebuddy' }), null);
			assert.strictEqual(t.normalizeCreditSample({ at: 7 }), null);
			assert.strictEqual(t.normalizeCreditSample(null), null);
		});
	});

	suite('链路契约（源码级）', () => {
		const source = read(USAGE_REL);
		const preload = read(PRELOAD_REL);

		test('页面监听的 DOM 事件名与协议常量一致（改一处必红）', () => {
			assert.ok(source.includes(`"${DSH_PAGE_CREDIT_EVENT}"`),
				`client.usage.js 必须监听 ${DSH_PAGE_CREDIT_EVENT}（常量改了这里也要改）`);
			assert.ok(source.includes('document.addEventListener'),
				'必须真的注册监听（否则主进程推来的样本没人接）');
		});

		test('preload 的通道/事件字面量与协议常量一致（preload 不能 import 本模块）', () => {
			assert.ok(preload.includes(`'${DSH_PAGE_IPC_CREDIT}'`), `preload 必须转发 ${DSH_PAGE_IPC_CREDIT}`);
			assert.ok(preload.includes(`'${DSH_PAGE_CREDIT_EVENT}'`), `preload 必须派发 ${DSH_PAGE_CREDIT_EVENT}`);
		});

		test('浮层六行 + 命中率条 + 图例齐全（与原生 tokenPopup 同口径）', () => {
			for (const label of ['Token 消耗明细', '缓存命中', '缓存未命中', '缓存写入', '思考过程', '回复内容', '缓存命中率']) {
				assert.ok(source.includes(label), `浮层缺少「${label}」行`);
			}
			for (const label of ['命中', '写入', '未命中']) {
				assert.ok(source.includes(label), `图例缺少「${label}」`);
			}
			assert.ok(source.includes('hitRateSegments'), '命中率条必须按三段宽度绘制');
		});
	});

	suite('页面渲染（假 react 树驱动一次真实渲染）', () => {
		const TURN = { turn: 1, start: { time: 1_000 }, end: { time: 13_000 } };
		const makeState = (routes?: { provider: string; model: string }) => ({
			nodes: {
				values: () => [{
					kind: 'turn-tail',
					data: { turn: 1, tokenUsage: routes ? { ...SAMPLE_USAGE, routes: [routes] } : { ...SAMPLE_USAGE } },
				}],
			},
			legacy: {},
		});
		const render = (harness: any, state: unknown) => harness.render({ turn: TURN, useChat: (sel: any) => sel(state) });
		const CB = { provider: 'vssaros-codebuddy', model: 'hy4-preview-ioa' };

		test('四个 chip：耗时 / tokens / 缓存命中率 / 积分（命中率与截图一致 99.5%）', () => {
			const h = makeHarness();
			h.exports.__test.pushCreditSample({ route: 'vssaros-codebuddy', model: 'hy4-preview-ioa', credit: 1.25, at: 5_000 });
			const texts = pillsOf(render(h, makeState(CB))).map(p => p.text);
			assert.deepStrictEqual(texts, ['12s', '8126.5k', '99.5%', '积分 1.25']);
		});

		test('积分归属：窗口外 / 其它 provider 模型的样本都不计入', () => {
			const h = makeHarness();
			h.exports.__test.pushCreditSample({ route: 'vssaros-codebuddy', model: 'hy4-preview-ioa', credit: 1.25, at: 5_000 });
			h.exports.__test.pushCreditSample({ route: 'vssaros-codebuddy', model: 'hy4-preview-ioa', credit: 9, at: 60_000 });
			h.exports.__test.pushCreditSample({ route: 'vssaros-ollama', model: 'qwen3:14b', credit: 7, at: 6_000 });
			const pills = pillsOf(render(h, makeState(CB)));
			assert.strictEqual(pills.find(p => p.text.startsWith('积分'))?.text, '积分 1.25');
		});

		test('响应里没有 credit 字段 ⇒ 显示「积分 —」（与"积分 0"区分）', () => {
			const h = makeHarness();
			h.exports.__test.pushCreditSample({ route: 'vssaros-codebuddy', model: 'hy4-preview-ioa', at: 5_000 });
			const pills = pillsOf(render(h, makeState(CB)));
			assert.strictEqual(pills.find(p => p.text.startsWith('积分'))?.text, '积分 —');
		});

		test('hover 缓存命中率 chip 才出「Token 消耗明细」浮层（六行 + 命中率栏）', () => {
			const h = makeHarness();
			const store = { hooks: [] as unknown[], cursor: 0 };
			h.setReactHooks(statefulReact(store));
			const state = makeState(CB);
			const doRender = () => { store.cursor = 0; return render(h, state); };
			let tree = doRender();
			// 用浮层根节点的类名判定（"Token 消耗明细" 也出现在 chip 的 title 里，不能当标记）。
			assert.ok(!JSON.stringify(tree).includes('vssaros-token-popup'), '未 hover 时不得渲染浮层');
			const cachePill = pillsOf(tree).find(p => p.text === '99.5%');
			assert.ok(cachePill?.props.onMouseEnter, '命中率 chip 必须挂 hover 处理');
			cachePill!.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 40 }) } });
			const flat = JSON.stringify(doRender());
			for (const label of ['Token 消耗明细', '总计', '输入', '缓存命中', '缓存未命中', '缓存写入', '输出', '思考过程', '回复内容', '缓存命中率']) {
				assert.ok(flat.includes(label), `浮层缺少「${label}」`);
			}
		});

		test('数据未到时 chip 常驻：0 占位 + 「缓存 —」「积分 —」（与原生面板同口径）', () => {
			const h = makeHarness();
			const empty = { nodes: { values: () => [] }, legacy: {} };
			const tree = h.render({ turn: { turn: 9, start: { time: Date.now() } }, useChat: (sel: any) => sel(empty) });
			assert.deepStrictEqual(pillsOf(tree).map(p => p.text), ['0s', '0', '缓存 —', '积分 —']);
		});
	});

	suite('实时更新（单回合运行中）', () => {
		const CB_STEP = { provider: 'vssaros-codebuddy', model: 'hy4-preview-ioa' };
		const step = (input: number, read: number, output: number, reasoning: number) => ({
			inputTokens: input, cacheReadTokens: read, uncachedInputTokens: input - read,
			outputTokens: output, reasoningTokens: reasoning, totalTokens: input + output, routes: [CB_STEP],
		});

		test('运行中耗时随 now 增长（组件里由秒级 ticker 驱动刷新）', () => {
			const turn = { turn: 1, start: { time: 1_000 } };
			const a = t.deriveTurnFooter({ turn, stepUsages: [], samples: [], now: 4_000 });
			const b = t.deriveTurnFooter({ turn, stepUsages: [], samples: [], now: 9_000 });
			assert.strictEqual(a.running, true);
			assert.strictEqual(a.ms, 3_000);
			assert.strictEqual(b.ms, 8_000, '同一回合内耗时必须随 now 增长');
			assert.strictEqual(t.formatTurnMs(a.ms), '3s');
		});

		test('★★ 运行中 tokens/命中率按 assistant 步骤 usage 实时累加（每轮 LLM 调用后上涨）', () => {
			const turn = { turn: 1, start: { time: 1_000 } };
			const one = t.deriveTurnFooter({ turn, stepUsages: [step(100, 80, 10, 4)], samples: [], now: 2_000 });
			const two = t.deriveTurnFooter({ turn, stepUsages: [step(100, 80, 10, 4), step(200, 150, 20, 6)], samples: [], now: 2_000 });
			assert.strictEqual(one.tokens, 110);
			assert.strictEqual(two.tokens, 330, '第二步完成后 tokens 必须上涨');
			assert.strictEqual(two.usage.prompt, 300);
			assert.strictEqual(two.hitRateText, '76.7%', '命中率随流式数字一起变（230/300）');
			assert.strictEqual(two.usage.reasoning, 10);
			assert.strictEqual(two.usage.content, 20);
			assert.notStrictEqual(two.usageKey, one.usageKey, 'usageKey 必须变化 ⇒ 才会触发重渲染');
		});

		test('回合结束后改用 turn-tail 的权威汇总（不再用逐步求和）', () => {
			const turn = { turn: 1, start: { time: 1_000 }, end: { time: 5_000 } };
			const tailUsage = { inputTokens: 300, cacheReadTokens: 230, uncachedInputTokens: 70, outputTokens: 30, totalTokens: 330 };
			const info = t.deriveTurnFooter({ turn, tailUsage, stepUsages: [{ totalTokens: 110 }], samples: [], now: 9_999 });
			assert.strictEqual(info.running, false);
			assert.strictEqual(info.tokens, 330, '结束后用 tail 的权威值');
			assert.strictEqual(info.ms, 4_000, '结束后耗时取 start/end，不随 now 变');
		});

		test('运行中积分窗口上端开区间 ⇒ 边跑边计入', () => {
			const turn = { turn: 1, start: { time: 1_000 } };
			const samples = [{ route: 'vssaros-codebuddy', model: 'hy4-preview-ioa', credit: 1.5, at: 9_000 }];
			const info = t.deriveTurnFooter({ turn, stepUsages: [], samples, now: 9_500 });
			assert.strictEqual(info.credit, 1.5);
			assert.strictEqual(info.creditResponses, 1);
		});

		test('没有 start/end 时回落 legacy.turnTimings 的耗时', () => {
			const info = t.deriveTurnFooter({ turn: { turn: 3 }, stepUsages: [], samples: [], legacyMs: 2_500, now: 1 });
			assert.strictEqual(info.ms, 2_500);
		});
	});
});
