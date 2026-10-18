/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 聊天页**此前完全没人测**的两组控件（2026-10-14 补；盘点见 `dshPageCommandWiring.test.ts` 的文件头）：
 *
 *   ① **审批卡**（`lib/client.approval.js`）—— 「拒绝 / 允许一次」，安全敏感；它**不走页面桥**，
 *      而是接 dsh 原生审批流（`pending.answer('rejected' | 'allowed-once')`）⇒ 页面桥那条链的守卫
 *      （`dshPageCommandWiring.test.ts`）**盖不到它**，必须单独钉 ✗。
 *   ② **设置菜单**（`lib/client.settings.js`）—— 「换皮样式」「用量页脚」「导出对话到剪贴板」
 *      「重命名会话…」四行 + ⚙ chip 的开合与菜单互斥；其中重命名走 `client.sessionLabel.js` 暴露的
 *      `state.renameSession`（不是页面桥）⇒ 同样需要自己的守卫。
 *   ③ **工作区 chip 的切换通路**（`lib/client.workspace.js`，2026-10-14 补）—— 它原来页面**自己**调
 *      `ctx.uiWorkspace.openWorkspace`，正是协议注释里 `switchWorktree` 明写"不能这么干"的那条 ✗
 *      （页面换了选择、宿主 slot.sessionId 还指着旧会话 ⇒ 分叉）⇒ 改成经 `bridge.switchWorktree(path)`。
 *      这组钉的就是"**必须经宿主** + 桥过旧时**如实拒绝、不回落到分叉**"。
 *
 * 测法沿用 `dshChatSurfaceHeader.test.ts`：迷你 createElement + 假 react（hook 按调用序存值、可 flush）
 * + 假 ctx/shell，**真装载 chunk、真执行 install、真点按钮**（只对源码形态的断言放最后一组）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs --only dshChatSurfaceControls
 */

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';

const LIB = 'dsh-plugins/vssaros-chat-surface/lib';

function read(rel: string): string {
	const abs = join(process.cwd(), rel);
	assert.ok(existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
	return readFileSync(abs, 'utf8');
}

/** 迷你 createElement：函数组件直接调用（= React 行为），否则记成普通对象（可遍历 props/children ✓）。 */
function makeElement(type: unknown, props: unknown, ...children: unknown[]): any {
	const next = { ...(props ?? {}), children } as Record<string, unknown>;
	return typeof type === 'function' ? (type as (p: unknown) => unknown)(next) : { type, props: props ?? {}, children };
}

/** 假 react：hook 按调用序存值；`useEffect` 立即执行一次（= 挂载后跑 effect）；清理函数不调用（同 header 测试 ✓）。 */
function makeReact(store: { hooks: unknown[]; cursor: number; dirty: boolean }): Record<string, any> {
	return {
		Fragment: 'Fragment',
		createElement: makeElement,
		useRef: () => ({ current: null }),
		useEffect: (fn: () => unknown) => {
			store.cursor++;
			try { fn(); } catch { /* 环境缺失时忽略（与真实 React 报错无关） */ }
		},
		useState: (init: unknown) => {
			const at = store.cursor++;
			if (store.hooks.length <= at) {
				store.hooks[at] = typeof init === 'function' ? (init as () => unknown)() : init;
			}
			return [store.hooks[at], (next: unknown) => {
				store.hooks[at] = typeof next === 'function' ? (next as (p: unknown) => unknown)(store.hooks[at]) : next;
				store.dirty = true;
			}];
		},
	};
}

/** 装载 chunk 并**真的执行 install()**；返回导出、每次注册的 spec/组件与"渲染 + flush"函数。 */
function loadChunk(rel: string, ctx: Record<string, any>, shell: Record<string, unknown>) {
	let definition: any;
	new Function('window', read(rel))({ __ModuleLoader__: { load: (d: any) => { definition = d; } } });
	const store = { hooks: [] as unknown[], cursor: 0, dirty: false };
	const react = makeReact(store);
	const mod: Record<string, any> = definition.factory((id: string) => {
		if (id === 'react') { return react; }
		throw new Error(`unexpected require: ${id}`);
	});
	const registrations: { slot: string; spec: any; component: any }[] = [];
	let currentSlot = '';
	const fullCtx = {
		...ctx,
		slots: {
			inject: (slot: string, factory: () => unknown) => { currentSlot = slot; factory(); },
			register: (spec: any, component: any) => { registrations.push({ slot: currentSlot, spec, component }); return () => undefined; },
		},
	};
	mod.install(fullCtx, { ...shell, bridge: ctx.__bridge });
	const render = (slotIndex: number, props: Record<string, unknown> = {}) => {
		// `any`：假树没有类型（与 header/usage 测试同口径 —— 那些地方每处都得写 `as any` ✓，这里收敛成一处）
		let tree: any = null;
		for (let pass = 0; pass < 3; pass++) {           // effect 里 setState 时重渲染（最多 3 轮）
			store.cursor = 0;
			store.dirty = false;
			tree = registrations[slotIndex].component({ ...props });
			if (!store.dirty) { break; }
		}
		return tree;
	};
	return { exports: mod, registrations, render };
}

function findByAttr(node: any, attr: string, value?: string): any {
	if (!node || typeof node !== 'object') { return null; }
	const props = node.props || {};
	if (props[attr] !== undefined && (value === undefined || String(props[attr]) === value)) { return node; }
	for (const child of node.children ?? []) {
		const hit = findByAttr(child, attr, value);
		if (hit) { return hit; }
	}
	return null;
}

function findAll(node: any, attr: string, out: any[] = []): any[] {
	if (!node || typeof node !== 'object') { return out; }
	if ((node.props || {})[attr] !== undefined) { out.push(node); }
	for (const child of node.children ?? []) { findAll(child, attr, out); }
	return out;
}

/** 按**按钮文案**找按钮（审批卡/菜单行都是 `type: 'button'` + 文案在 children 里）。 */
function buttonByText(tree: any, text: string): any {
	return findAll(tree, 'type').find(n => JSON.stringify(n.children ?? []).includes(text));
}

/**
 * 假 DOM（settings 要 `querySelector` / `documentElement.dataset` / clipboard / chat flow 正文）。
 *
 * ⚠ 整个用例体（含 `render`！）都必须在这个作用域里跑：`skinOn()` / `usageOn()` 在**渲染期间**读
 * `document` ⇒ 只把 `loadChunk` 包起来的话，后面 `render` 会 `Cannot read properties of undefined` ✗。
 * 异步用例也覆盖：返回 thenable 时等它落定再还原 ✓。
 */
function withDom<T>(hooks: { chatFlowText?: string; onWriteText?: (t: string) => void }, fn: () => T | Promise<T>): T | Promise<T> {
	const anyGlobal = globalThis as any;
	const prevDoc = anyGlobal.document;
	const prevNav = anyGlobal.navigator;
	const tag = { media: '' };
	const flow = hooks.chatFlowText === undefined ? null : { innerText: hooks.chatFlowText };
	const doc: any = {
		documentElement: { dataset: {} as Record<string, string> },
		body: { innerText: hooks.chatFlowText ?? '' },
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		dispatchEvent: () => true,
		querySelector: (sel: string) => (sel.includes('data-vssaros-skin') ? tag : sel.includes('data-chat-flow') ? flow : null),
	};
	anyGlobal.document = doc;
	try {
		Object.defineProperty(anyGlobal, 'navigator', {
			value: { clipboard: { writeText: (t: string) => { hooks.onWriteText?.(t); return Promise.resolve(); } } },
			configurable: true, writable: true,
		});
	} catch { /* 装不上时下面导出用例会以真实报错暴露（不静默当"过了" ✓） */ }
	const restore = () => {
		anyGlobal.document = prevDoc;
		try { Object.defineProperty(anyGlobal, 'navigator', { value: prevNav, configurable: true, writable: true }); } catch { /* 还原失败不影响用例 */ }
	};
	try {
		const out = fn();
		return (out && typeof (out as Promise<T>).then === 'function') ? (out as Promise<T>).finally(restore) : out;
	} catch (err) {
		restore();
		throw err;
	}
}

const tick = () => new Promise(r => setTimeout(r, 0));

suite('聊天页控件 · 审批卡（client.approval.js，此前零覆盖）', () => {

	/** 造一个假 pendingInteraction（dsh 原生审批对象的最小面）。 */
	function makePending(over: Record<string, unknown> = {}) {
		const answers: string[] = [];
		return {
			pending: {
				kind: 'approval', key: 'k-1', toolName: 'bash', answerable: true,
				answer: (outcome: string) => { answers.push(outcome); return Promise.resolve(); },
				...over,
			},
			answers,
		};
	}

	function mount(state: Record<string, unknown> = {}) {
		return loadChunk(`${LIB}/client.approval.js`, {}, { state });
	}

	test('★ 注册在 conversation.composer、priority 0（升序先于官方）且 select 只接管审批', () => {
		const state: Record<string, unknown> = {};
		const h = mount(state);
		assert.strictEqual(h.registrations.length, 1);
		const reg = h.registrations[0];
		assert.strictEqual(reg.slot, 'conversation.composer', '官方审批 UI 就是这个槽（chain 槽）');
		assert.strictEqual(reg.spec.priority, 0, 'priority 必须比官方小 ⇒ 才能遮蔽官方卡');
		assert.strictEqual(reg.spec.name, 'conversation.composer');
		// select：**只在**审批时接管（否则其它 pendingInteraction 会被我们吞掉 ✗）
		const p = { kind: 'approval', key: 'k', toolName: 't', answerable: true, answer: () => undefined };
		assert.strictEqual(reg.spec.select({ pendingInteraction: p }), p, '审批 ⇒ 接管');
		assert.strictEqual(reg.spec.select({ pendingInteraction: { kind: 'question' } }), null, '非审批 ⇒ 让给官方');
		assert.strictEqual(reg.spec.select({ pendingInteraction: undefined }), null);
		assert.strictEqual(reg.spec.select({}), null);
		assert.strictEqual(state.approvalCard, true, '生效要如实标记（诊断/测试依赖它）');
	});

	test('渲染：带 data-approval-key + 「⚠ 需要授权」+ 工具名 + reason', () => {
		const { pending } = makePending({ reason: 'rm -rf /tmp/x' });
		const h = mount();
		const tree = h.render(0, { matched: pending });
		assert.strictEqual(tree.props['data-vssaros-approval'], '1', '要有可定位标记（e2e 依赖）');
		assert.strictEqual(tree.props['data-approval-key'], 'k-1', 'key 要透出（对账/去重依赖）');
		const text = JSON.stringify(tree);
		assert.ok(text.includes('⚠ 需要授权'), '标题固定文案');
		assert.ok(text.includes('工具 bash 请求授权'), '要说清是哪个工具在要权限');
		assert.ok(text.includes('rm -rf /tmp/x'), 'reason 要原样显示（用户据此判断）');
	});

	test('reason 回落链：reason → displayReason.zh → displayReason.en；都没有则不渲染那行', () => {
		const a = mount().render(0, { matched: makePending({ reason: undefined, displayReason: { zh: '中文理由', en: 'en reason' } }).pending });
		assert.ok(JSON.stringify(a).includes('中文理由'), '中文优先');
		const b = mount().render(0, { matched: makePending({ reason: undefined, displayReason: { en: 'en reason' } }).pending });
		assert.ok(JSON.stringify(b).includes('en reason'), '没有中文时用英文');
		const c = mount().render(0, { matched: makePending({ reason: undefined, displayReason: undefined }).pending });
		assert.ok(!JSON.stringify(c).includes('undefined'), '没有理由时不许渲染出 undefined 文案 ✗');
	});

	test('点「允许一次」⇒ answer("allowed-once")，随后按钮禁用且不会重复提交', () => {
		const { pending, answers } = makePending();
		const h = mount();
		const tree = h.render(0, { matched: pending });
		buttonByText(tree, '允许一次').props.onClick();
		assert.deepStrictEqual(answers, ['allowed-once'], '必须走 dsh 原生审批流（不是页面桥）');
		const after = h.render(0, { matched: pending });
		assert.strictEqual(buttonByText(after, '允许一次').props.disabled, true, '提交后必须禁用（防重复点）');
		assert.strictEqual(buttonByText(after, '拒绝').props.disabled, true, '另一枚也一起禁用（同一决策只能交一次）');
		buttonByText(after, '允许一次').props.onClick();
		assert.deepStrictEqual(answers, ['allowed-once'], '已答过再点不许再提交 ✓');
	});

	test('点「拒绝」⇒ answer("rejected")', () => {
		const { pending, answers } = makePending({ toolName: 'write' });
		const h = mount();
		buttonByText(h.render(0, { matched: pending }), '拒绝').props.onClick();
		assert.deepStrictEqual(answers, ['rejected']);
	});

	test('★ answerable=false（不可答的审批）⇒ 点了**什么都不发**，且不假装禁用', () => {
		const { pending, answers } = makePending({ answerable: false });
		const h = mount();
		const tree = h.render(0, { matched: pending });
		buttonByText(tree, '允许一次').props.onClick();
		buttonByText(tree, '拒绝').props.onClick();
		assert.deepStrictEqual(answers, [], '不可答时不得提交（否则会向 dsh 发一个非法决策 ✗）');
		const after = h.render(0, { matched: pending });
		assert.strictEqual(buttonByText(after, '允许一次').props.disabled, false,
			'没提交就没"已答"⇒ 不许把按钮画成禁用以外的假状态（保持可点但无效果）');
	});

	test('answer 失败 ⇒ 恢复可点（不把用户卡死在"已答"）', async () => {
		const { pending } = makePending({
			answer: () => Promise.reject(new Error('bridge down')),
		});
		const h = mount();
		buttonByText(h.render(0, { matched: pending }), '允许一次').props.onClick();
		assert.strictEqual(buttonByText(h.render(0, { matched: pending }), '允许一次').props.disabled, true, '先乐观禁用');
		await tick();
		const after = h.render(0, { matched: pending });
		assert.strictEqual(buttonByText(after, '允许一次').props.disabled, false, '失败要放开，用户可以重试 ✓');
	});
});

suite('聊天页控件 · 设置菜单（client.settings.js，此前零覆盖）', () => {

	/**
	 * 在假 DOM 里挂载设置菜单，并**把整个用例体放进同一个 DOM 作用域**（渲染期就会读 `document` ✓）。
	 * 异步用例直接 `return` 里面的 promise（`withDom` 会等它落定再还原 DOM ✓）。
	 */
	function withSettings<T>(
		hooks: { chatFlowText?: string; onWriteText?: (t: string) => void },
		body: (h: ReturnType<typeof loadChunk>, state: Record<string, unknown>) => T | Promise<T>,
		opts: { state?: Record<string, unknown>; menus?: Record<string, any> } = {},
	): T | Promise<T> {
		const state = opts.state ?? {};
		return withDom(hooks, () => {
			const h = loadChunk(`${LIB}/client.settings.js`, {}, { state, ...(opts.menus ? { menus: opts.menus } : {}) });
			return body(h, state);
		}) as T | Promise<T>;
	}

	/** 打开菜单 + 取第 N 行（每次重新渲染拿最新树 ✓）。 */
	function row(h: ReturnType<typeof loadChunk>, key: string) {
		return findAll(h.render(0, {}), 'data-vssaros-setting').find((n: any) => n.props['data-vssaros-setting'] === key);
	}

	test('★ 注册在 header utilities（id/order 固定）+ 默认即开启换皮与用量页脚', () => withSettings({}, (h, state) => {
		assert.strictEqual(h.registrations.length, 1);
		assert.strictEqual(h.registrations[0].slot, 'conversation.session.header.utilities', '⚙ 属于右侧动作组');
		assert.strictEqual(h.registrations[0].spec.id, 'vssaros-settings');
		assert.strictEqual(h.registrations[0].spec.order, -2, 'order -2 ⇒ 排在最右（官方 … 在它右边）');
		assert.strictEqual(state.settingsChip, true);
		assert.strictEqual(state.skinEnabled, true, '安装即开换皮（默认外观由我们接管 ✓）');
		assert.strictEqual(state.usageFooterVisible, true);
		assert.strictEqual((globalThis as any).document.documentElement.dataset.vssarosHideUsage, undefined, '默认不隐藏用量页脚');
	}));

	test('点 ⚙ chip ⇒ 弹出菜单：四行设置 + 开合状态如实（aria-expanded）', () => withSettings({}, h => {
		const chip = findByAttr(h.render(0, {}), 'data-vssaros-settings-chip');
		assert.ok(chip, '必须有 ⚙ chip');
		assert.strictEqual(chip.props['aria-expanded'], false, '初始收起');
		chip.props.onClick();
		const tree = h.render(0, {});
		assert.strictEqual(findByAttr(tree, 'data-vssaros-settings-chip').props['aria-expanded'], true, '点开要如实回显');
		const rows = findAll(tree, 'data-vssaros-setting').map((n: any) => n.props['data-vssaros-setting']);
		assert.deepStrictEqual(rows, ['skin', 'usage', 'export', 'rename'], '四行：换皮/用量/导出/重命名');
		assert.ok(JSON.stringify(tree).includes('Model Providers'), '未接通的项要如实标注（不做假入口 ✓）');
	}));

	test('「换皮样式」⇒ 关/开我们注入的样式表（media="not all" 是无损关法）+ state 如实', () => withSettings({}, (h, state) => {
		findByAttr(h.render(0, {}), 'data-vssaros-settings-chip').props.onClick();
		row(h, 'skin').props.onClick();
		const tag = (globalThis as any).document.querySelector('style[data-vssaros-skin]');
		assert.strictEqual(tag.media, 'not all', '关掉整张皮肤表（可瞬时还原 ✓）');
		assert.strictEqual(state.skinEnabled, false);
		row(h, 'skin').props.onClick();
		assert.strictEqual(tag.media, '', '再点回开');
		assert.strictEqual(state.skinEnabled, true);
	}));

	test('「用量页脚」⇒ 根元素 dataset 开关 + state 如实（皮肤层据此隐藏）', () => withSettings({}, (h, state) => {
		findByAttr(h.render(0, {}), 'data-vssaros-settings-chip').props.onClick();
		row(h, 'usage').props.onClick();
		assert.strictEqual((globalThis as any).document.documentElement.dataset.vssarosHideUsage, '1');
		assert.strictEqual(state.usageFooterVisible, false);
		row(h, 'usage').props.onClick();
		assert.strictEqual((globalThis as any).document.documentElement.dataset.vssarosHideUsage, undefined, '再点要真的删掉属性（不是设成 "0"）');
		assert.strictEqual(state.usageFooterVisible, true);
	}));

	test('「导出对话到剪贴板」⇒ 复制带标题的 Markdown（连续空行折成一段）+ 提示', () => {
		const written: string[] = [];
		return withSettings({ chatFlowText: '第一段\n\n\n\n第二段  ', onWriteText: t => written.push(t) }, async h => {
			findByAttr(h.render(0, {}), 'data-vssaros-settings-chip').props.onClick();
			row(h, 'export').props.onClick();
			await tick();
			assert.deepStrictEqual(written, ['# dsh 会话导出\n\n第一段\n\n第二段'], '标题 + 正文（3 个以上连续换行折成 1 个空行）');
			assert.ok(JSON.stringify(h.render(0, {})).includes('已复制到剪贴板'), '成功要给一句反馈（否则用户不知道点了没）');
		});
	});

	test('导出时没有正文 ⇒ 不碰剪贴板，并把原因显示出来（不静默）', () => {
		const written: string[] = [];
		return withSettings({ chatFlowText: '   ', onWriteText: t => written.push(t) }, async h => {
			findByAttr(h.render(0, {}), 'data-vssaros-settings-chip').props.onClick();
			row(h, 'export').props.onClick();
			await tick();
			assert.deepStrictEqual(written, [], '空内容不该写剪贴板（会覆盖用户剪切板 ✗）');
			assert.ok(JSON.stringify(h.render(0, {})).includes('没有可导出的内容'), '失败原因要显示在菜单里');
		});
	});

	test('「重命名会话…」⇒ 行内输入框（带当前标题）→ 确定 ⇒ renameSession(sessionId, 新名) + 已重命名', () => {
		const calls: string[] = [];
		return withSettings({}, async h => {
			findByAttr(h.render(0, {}), 'data-vssaros-settings-chip').props.onClick();
			row(h, 'rename').props.onClick();
			const input = findByAttr(h.render(0, {}), 'placeholder');
			assert.ok(input, '点重命名要出现输入框（页面侧入口，不依赖宿主 quick input）');
			assert.strictEqual(input.props.value, '旧名', '初始值 = 当前会话标题');
			input.props.onChange({ target: { value: '新名' } });
			buttonByText(h.render(0, {}), '确定').props.onClick();
			await tick();
			assert.deepStrictEqual(calls, ['s-a:新名'], '走 sessionLabel 暴露的同一份实现（不是页面桥 ✗）');
			assert.ok(JSON.stringify(h.render(0, {})).includes('已重命名'));
		}, {
			state: {
				sessionId: 's-a', sessionTitle: '旧名',
				renameSession: (id: string, name: string) => { calls.push(`${id}:${name}`); return Promise.resolve(); },
			},
		});
	});

	test('rename 部件未装载 / 失败 ⇒ 明确提示，不静默', async () => {
		await withSettings({}, async h => {
			findByAttr(h.render(0, {}), 'data-vssaros-settings-chip').props.onClick();
			row(h, 'rename').props.onClick();
			buttonByText(h.render(0, {}), '确定').props.onClick();
			await tick();
			assert.ok(JSON.stringify(h.render(0, {})).includes('重命名不可用'), '缺部件要说清，不能"点了没反应"');
		}, { state: { sessionId: 's-a', sessionTitle: 'x' } });   // 没有 renameSession

		await withSettings({}, async h => {
			findByAttr(h.render(0, {}), 'data-vssaros-settings-chip').props.onClick();
			row(h, 'rename').props.onClick();
			buttonByText(h.render(0, {}), '确定').props.onClick();
			await tick();
			assert.ok(JSON.stringify(h.render(0, {})).includes('dsh 拒绝'), '失败原因要显示（不许吞掉 ✗）');
		}, {
			state: { sessionId: 's-a', sessionTitle: 'x', renameSession: () => Promise.reject(new Error('dsh 拒绝')) },
		});
	});

	test('打开菜单时做互斥（closeOthers + 注册自己的关闭回调）', () => {
		const events: string[] = [];
		let closeSelf: (() => void) | undefined;
		return withSettings({}, h => {
			findByAttr(h.render(0, {}), 'data-vssaros-settings-chip').props.onClick();
			h.render(0, {});   // 重渲染才会跑 effect（互斥在 effect 里做）✓
			assert.deepStrictEqual(events, ['close:vssaros-settings', 'register:vssaros-settings'],
				'开菜单要按同一 id 收别人 + 登记自己（多菜单叠加会被裁 ✗）');
			closeSelf?.();
			const tree = h.render(0, {});
			assert.ok(!findAll(tree, 'data-vssaros-setting').length, '被别的菜单"关掉"后菜单要真的收起来');
			assert.strictEqual(findByAttr(tree, 'data-vssaros-settings-chip').props['aria-expanded'], false);
		}, {
			menus: {
				closeOthers: (id: string) => { events.push(`close:${id}`); },
				register: (id: string, cb: () => void) => { events.push(`register:${id}`); closeSelf = cb; return () => undefined; },
			},
		});
	});
});

suite('聊天页控件 · 工作区 chip 的切换通路（client.workspace.js；2026-10-14 补）', () => {

	/**
	 * 挂载工作区 chip（注册序 0 = `order -30`）并**真点**菜单里的行。
	 *
	 * `ctx.uiWorkspace` 在正常路径里**不该被碰**（那是分叉写法 ✗）⇒ 每个用例都给它记一笔，
	 * 断言"没被调用"本身就是这条契约的一半 ✓。
	 */
	function withChip<T>(
		opts: { bridge?: Record<string, any>; uiWorkspace?: Record<string, any>; items?: any[] },
		body: (h: ReturnType<typeof loadChunk>, state: Record<string, unknown>) => T | Promise<T>,
	): T | Promise<T> {
		const state: Record<string, unknown> = {};
		const items = opts.items ?? [
			{ workspaceId: 'ws-1', path: '/repo/one', title: '仓一', sessionIds: ['s1', 's9'] },
			{ workspaceId: 'ws-2', path: '/repo/two', title: '仓二', sessionIds: ['s2'] },
		];
		const h = loadChunk(`${LIB}/client.workspace.js`, {
			__bridge: opts.bridge ?? {},
			uiWorkspace: opts.uiWorkspace ?? {},
			get: (name: string) => (name === 'workspaces'
				? { list: { getSnapshot: () => ({ items }), subscribe: () => () => undefined } }
				: undefined),
		}, { state, menus: { closeOthers: () => undefined, register: () => () => undefined } });
		return body(h, state);
	}

	/** 打开菜单 + 取某个工作区行（每次重新渲染拿最新树 ✓；本会话 = `s1` ⇒ 当前工作区是 `ws-1`）。 */
	function row(h: ReturnType<typeof loadChunk>, workspaceId: string) {
		findByAttr(h.render(0, { sessionId: 's1' }), 'data-vssaros-context-chip').props.onClick();
		const found = findAll(h.render(0, { sessionId: 's1' }), 'data-vssaros-context-item')
			.find((n: any) => n.props['data-vssaros-context-item'] === 'workspace:' + workspaceId);
		assert.ok(found, `菜单里应有工作区 ${workspaceId}`);
		return found;
	}

	/**
	 * 再点一次 chip 把菜单开回来。
	 * ⚠ 失败/被拒时 `switchToWorkspace` 会 `setOpen(false)`，而提示行**只在菜单里渲染** ⇒
	 *   直接渲染当前树是**看不到原因**的（第一版就栽在这：三条断言全红 ✗）。
	 *   这也是真实 UX：用户重新点开菜单才看得见原因（与 worktree chip 一致 ✓）。
	 */
	function reopened(h: ReturnType<typeof loadChunk>) {
		findByAttr(h.render(0, { sessionId: 's1' }), 'data-vssaros-context-chip').props.onClick();
		return h.render(0, { sessionId: 's1' });
	}

	test('★ 切工作区**必须经宿主**：走 `bridge.switchWorktree(path)`，且**不**直接调 `ctx.uiWorkspace.openWorkspace`', async () => {
		const calls: string[] = [];
		await withChip({
			bridge: { switchWorktree: (path: string) => { calls.push(`bridge:${path}`); return Promise.resolve(); } },
			uiWorkspace: { openWorkspace: (id: string) => { calls.push(`page:${id}`); return Promise.resolve(); } },
		}, async (h, state) => {
			row(h, 'ws-2').props.onClick();
			await tick();
			assert.deepStrictEqual(calls, ['bridge:/repo/two'],
				'页面私自 openWorkspace 只会换页面选择、宿主 slot.sessionId 仍指旧会话 ⇒ 两边分叉 ✗'
				+ '（协议注释里 `switchWorktree` 那条就是为这件事写的 ✓）');
			assert.strictEqual(state.contextSwitches, 1, '成功要如实计数（诊断/测试依赖它）');
		});
	});

	test('点**当前**工作区 ⇒ 无动作（幂等：不白跑一次 `session.start`）', async () => {
		const calls: string[] = [];
		await withChip({ bridge: { switchWorktree: (p: string) => { calls.push(p); return Promise.resolve(); } } }, async h => {
			row(h, 'ws-1').props.onClick();
			await tick();
			assert.deepStrictEqual(calls, []);
		});
	});

	test('★ 桥过旧（没有 `switchWorktree`）⇒ **如实拒绝**，不回落到"只切页面选择"', async () => {
		const calls: string[] = [];
		await withChip({
			bridge: {},
			uiWorkspace: { openWorkspace: (id: string) => { calls.push(id); return Promise.resolve(); } },
		}, async h => {
			row(h, 'ws-2').props.onClick();
			await tick();
			assert.deepStrictEqual(calls, [], '明知会分叉还照做 ✗：宁可说清"不支持"（与 worktree chip 同一处理 ✓）');
			assert.ok(JSON.stringify(reopened(h)).includes('页面桥过旧'),
				'拒绝要把原因显示在菜单里（不能"点了没反应" ✗）');
		});
	});

	test('工作区读不到目录（`path` 为空）⇒ 说清原因，**不发请求**（宿主那边 cwd 是必需的）', async () => {
		const calls: string[] = [];
		await withChip({
			bridge: { switchWorktree: (p: string) => { calls.push(p); return Promise.resolve(); } },
			items: [
				{ workspaceId: 'ws-1', path: '/repo/one', title: '仓一', sessionIds: ['s1'] },
				{ workspaceId: 'ws-2', title: '仓二', sessionIds: ['s2'] },   // 没有 path
			],
		}, async h => {
			row(h, 'ws-2').props.onClick();
			await tick();
			assert.deepStrictEqual(calls, []);
			assert.ok(JSON.stringify(reopened(h)).includes('读不到目录'),
				'要说清是哪个工作区的问题（不猜、不半截做 ✗）');
		});
	});

	test('宿主失败 ⇒ 原因显示在菜单里（不吞 ✗），且**不**记成功', async () => {
		await withChip({
			bridge: { switchWorktree: () => Promise.reject(new Error('session.start 失败：cwd 不存在')) },
		}, async (h, state) => {
			row(h, 'ws-2').props.onClick();
			await tick();
			assert.ok(JSON.stringify(reopened(h)).includes('cwd 不存在'), '失败原因要原样带出来');
			assert.strictEqual(state.contextSwitches, undefined, '失败不能记成成功 ✓');
		});
	});

	test('菜单文案如实写明"切换 = 新建或接管会话"，并且**不承诺动窗口工作区**（两侧独立 ✗ 假话）', () => {
		withChip({ bridge: {} }, h => {
			const tree = (() => {
				findByAttr(h.render(0, { sessionId: 's1' }), 'data-vssaros-context-chip').props.onClick();
				return h.render(0, { sessionId: 's1' });
			})();
			const text = JSON.stringify(tree);
			assert.ok(text.includes('新建或接管会话'),
				'语义代价必须写在菜单里（宿主会在目标目录 session.start / 接管一个会话 ✓）');
			assert.ok(text.includes('不动'),
				'必须明说"IDE 的窗口工作区不动" —— 用户要求的正是这条（2026-10-17）');
			assert.ok(!text.includes('切换工作区'),
				'不许再出现"切换工作区"这种会让人以为整窗跟着换的说法 ✗');
		});
	});
});

/**
 * hero（空白会话屏）里的工作区入口 —— 方案 A（2026-10-16；mockup `doc/dsh-workspace-entry-single-mockup.html`）。
 *
 * 现场（用户截图报「工作区 UI 重复了，使用一个即可，但是要有 add workspace 功能」）：hero 那一行的三个位置
 * 是官方**写死**的（`dsh-client-ui-conversation/lib/client.js:16256` 的 `heroWorkspaceRow`）＝
 *   [官方 WorkspaceChip] → `conversation.hero.workspace`（官方浮层）→ `conversation.hero.agentPreset`（我们接管）
 * 15 日把 worktree chip 换成"工作区 + worktree 合并入口"之后，最后那格里也成了一枚**工作区**入口
 * ⇒ 与官方那枚并排重复 ✗（合并前那里是 🌿 worktree，语义不同 ⇒ 没人报重复）。官方那枚是写死的组件
 * （走不了 slot ⇒ 遮蔽不了）⇒ 只能从我们这侧改。
 *
 * 方案 A：hero 仍只出**官方那枚 chip**；我们的合并面板注册到官方**浮层槽** `conversation.hero.workspace`
 * （priority -10 遮蔽 `WorkspacePickFlow`）⇒ 一枚 chip、点开却是我们的面板（工作区 + worktree + 添加工作区）✓。
 * 本套钉四件事：① 遮蔽注册形态 + hero 里**不再有我们自己的 chip**；② 当前项判据（hero 用官方 `selectedId`，
 * 不能用会话归属 ✗）；③ 两个表面的点击语义各自正确（hero 工作区行 = 官方 `onPick`；worktree 行 = 必须经宿主）；
 * ④ 「添加工作区」的通路与失败如实化（不新增桥命令、不假装能加）。
 */
suite('聊天页控件 · hero 工作区入口（遮蔽官方浮层 + 添加工作区；2026-10-16）', () => {

	/** 宿主推送（worktree 来自推送，不在 ctx 里）。 */
	const PUSH = JSON.stringify([
		{ path: 'G:\\Repo', name: 'main', branch: 'main', isMain: true },
		{ path: 'G:\\Repo-wt\\feature-auth', name: 'feature-auth', branch: 'worktree/feature-auth', isMain: false },
	]);
	const WS_ITEMS = [
		{ workspaceId: 'ws-1', path: 'G:\\Repo', title: '仓一', sessionIds: ['s-a'] },
		{ workspaceId: 'ws-2', path: 'G:\\Repo-wt\\feature-auth', title: '仓二', sessionIds: ['s-b'] },
	];

	/**
	 * 装 chunk 并**真执行 install**：`ctx.get` 同时供 workspaces / sessions / remote.directoryPicker
	 * （三个都走**运行时可选取** —— 不进 inject，宿主缺哪个都不会让整块皮肤不 apply ✓）。
	 * `document` 桩：worktree 走 dataset ✓（同步用例与 async 用例都覆盖：返回 thenable 时等它落定再还原）。
	 */
	function mount(opts: { bridge?: Record<string, any>; picker?: any; create?: (input: any) => Promise<any>; pushed?: string },
		body: (h: any, state: Record<string, unknown>) => unknown): unknown {
		const state: Record<string, unknown> = { sessionId: 's-a' };
		const doc: any = {
			documentElement: { dataset: { vssarosWorktrees: opts.pushed ?? PUSH } },
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		};
		const prev = (globalThis as any).document;
		(globalThis as any).document = doc;
		const restore = () => { (globalThis as any).document = prev; };
		const h = loadChunk(`${LIB}/client.workspace.js`, {
			__bridge: opts.bridge ?? {},
			get: (name: string) => {
				if (name === 'workspaces') {
					return {
						list: { getSnapshot: () => ({ items: WS_ITEMS }), subscribe: () => () => undefined },
						create: opts.create,
					};
				}
				if (name === 'sessions') {
					// cwd 刻意与所有推送项都不同 ⇒ 没有"当前 worktree"（否则那行会被禁用、点不动 ✗）
					return { list: { getSnapshot: () => ({ byId: { 's-a': { cwd: 'G:\\Elsewhere' } } }), subscribe: () => () => undefined } };
				}
				if (name === 'remote.directoryPicker') { return opts.picker; }
				return undefined;
			},
		}, { state, menus: { closeOthers: () => undefined, register: () => () => undefined } });
		let out: unknown;
		try { out = body(h, state); } catch (e) { restore(); throw e; }
		if (out && typeof (out as any).then === 'function') {
			return (out as Promise<unknown>).then(v => { restore(); return v; }, e => { restore(); throw e; });
		}
		restore();
		return out;
	}

	/** hero 槽 = 本 chunk 的**第 2 条**注册 ⇒ 一律 `render(1)` ✓（第 1 条永远是 header 入口）。 */
	function heroTree(h: any, props: Record<string, unknown> = {}, onPick?: (id: string) => void, onClose?: () => void): any {
		return h.render(1, {
			open: true, selectedId: 'ws-1', anchorRef: { current: null },
			onPick: onPick ?? (() => undefined), onClose: onClose ?? (() => undefined),
			...props,
		});
	}
	/** Promise 链（pick → create → 计数）跑完：多等几轮 microtask/timer ✓。 */
	async function settle(): Promise<void> { for (let i = 0; i < 5; i++) { await tick(); } }

	test('★ 注册：header 仍是第一条、hero 槽是 priority -10 的**遮蔽**注册；hero 里不再有我们自己的 chip', () => {
		mount({}, h => {
			assert.deepStrictEqual(h.registrations.map((r: any) => r.slot),
				['conversation.session.header.actions', 'conversation.hero.workspace'],
				'hero 只能靠**浮层槽**介入 —— 官方那枚 WorkspaceChip 写死在 heroWorkspaceRow 里（不是 slot）✗');
			assert.strictEqual(h.registrations[1].spec.priority, -10,
				'负 priority 才能让官方 WorkspacePickFlow 让位（同槽按 priority 取先 ✓）');
			const tree = heroTree(h);
			assert.ok(findByAttr(tree, 'data-vssaros-context-hero'),
				'零尺寸壳要**常驻**：hero 屏没有我们自己的 chip ⇒ 宿主自证靠这个标记认出"我们的入口到过这一屏" ✓');
			assert.strictEqual(findByAttr(tree, 'data-vssaros-context-chip'), null,
				'hero 里**不许**再出现我们自己的 chip —— 那正是与官方那枚重复的来源 ✗（就是用户截图那两枚）');
		});
		// 负对照（按**注册形态**采集：注释里提旧通道名是允许的 ✓）
		const ws = read(`${LIB}/client.workspace.js`);
		const preset = read(`${LIB}/client.preset.js`);
		assert.ok(!/shell\.heroWorktreeChip\s*=/.test(ws), '跨 chunk 传组件那条通道必须删除（留着就是第二枚 chip 回来 ✗）');
		assert.ok(!/createElement\(worktreeChip/.test(preset), 'hero 装配里不许再渲染 worktree chip ✗');
	});

	test('hero 面板：没打开只有自证壳；打开后按**官方给的 selectedId** 判当前工作区（不能用会话归属 ✗）', () => {
		mount({}, h => {
			const closed = heroTree(h, { open: false });
			assert.strictEqual(findAll(closed, 'role').filter((n: any) => n.props.role === 'menu').length, 0,
				'没打开就不许出菜单（面板常驻挂载只是为了保住 note/query，不是让它一直显示 ✓）');
			const open = heroTree(h);
			const items = findAll(open, 'data-vssaros-context-item');
			const cur = items.find((n: any) => n.props['data-vssaros-context-item'] === 'workspace:ws-1');
			const other = items.find((n: any) => n.props['data-vssaros-context-item'] === 'workspace:ws-2');
			assert.ok(cur && other, '两个数据源的行都要列出来');
			assert.strictEqual(cur.props.style.background, 'var(--dsw-alias-bg-layer-2, transparent)',
				'hero 里"当前工作区"的权威是官方给的 selectedId（空白屏还没有会话 ⇒ 用 sessionIds 会永远读不到 ✓）');
			assert.strictEqual(other.props.style.background, 'transparent', '非当前项不许画成选中态');
		});
	});

	test('★ hero 点工作区行 ⇒ **经宿主切换**（`switchWorktree(主根)`）—— 2026-10-17 口径变更', async () => {
		// 翻案史（先读再改）：
		//   · 2026-10-16：hero 那行改成"只官方 `onPick`、不经宿主"，理由是别当场建空会话把人踢出 hero；
		//   · **2026-10-17 用户报"聊天框里仍然切不了工作区"**，真机日志实证（README 5.149）：那屏正是 hero，
		//     用户连点 4 次、IDE 窗口每次 15ms 就切过去了，而聊天框**零变化**（`hero-pick`×4、`rebinds:0`）
		//     ⇒ "只切窗口/只选中"在用户那里就等于"切不了" ✗✗ ⇒ 现在与 header 同口径：**经宿主真的切** ✓。
		//   ⚠ 唯一保留：组行**连主根都读不到**时才回落到官方 `onPick`（header 套件里有专门用例 ✓）。
		const picked: string[] = [];
		const switches: string[] = [];
		await mount({ bridge: { switchWorktree: (p: string) => { switches.push(p); return Promise.resolve(); } } }, async (h: any) => {
			const tree = heroTree(h, {}, id => picked.push(id));
			findAll(tree, 'data-vssaros-context-item')
				.find((n: any) => n.props['data-vssaros-context-item'] === 'workspace:ws-2').props.onClick();
			await settle();
			assert.deepStrictEqual(switches, ['G:\\Repo-wt\\feature-auth'],
				'经宿主在**主根**起/接管会话（与 header 同一条命令 ⇒ 点了真的切过去 ✓）');
			assert.deepStrictEqual(picked, ['ws-2'],
				'★ 顺带对齐官方选中态：hero 屏上那枚是**官方**的（我们只挂浮层）⇒ 不对齐就可能是"切了但 UI 没刷新" ✗ '
				+ '（切换本身仍走宿主 —— 上面那条 switches 断言才是主证据 ✓）');
		});
	});

	test('★ hero 点 worktree 行 ⇒ 必须经宿主 `bridge.switchWorktree(path)`（onPick 只认 workspaceId ✓）', async () => {
		const picked: string[] = [];
		const switches: string[] = [];
		await mount({ bridge: { switchWorktree: (p: string) => { switches.push(p); return Promise.resolve(); } } }, async (h: any) => {
			const tree = heroTree(h, {}, id => picked.push(id));
			findAll(tree, 'data-vssaros-context-item')
				.find((n: any) => n.props['data-vssaros-context-item'] === 'worktree:G:\\Repo').props.onClick();
			await settle();
			assert.deepStrictEqual(switches, ['G:\\Repo'], '经宿主切（宿主要在目标目录接管其专属会话 ✓）');
			assert.deepStrictEqual(picked, [], 'worktree 行不是"选工作区" ⇒ 不许走 onPick ✗');
		});
	});

	test('★ hero「添加工作区…」⇒ directoryPicker.pick() + workspaces.create({path})（不新增桥命令），成功后采纳即选中', async () => {
		const made: any[] = [];
		const picked: string[] = [];
		await mount({
			bridge: {},
			picker: { pick: () => Promise.resolve({ ok: true, value: { path: 'G:\\NewRepo' } }) },
			create: (input: any) => { made.push(input); return Promise.resolve({ workspaceId: 'ws-new' }); },
		}, async (h: any, state: Record<string, unknown>) => {
			findByAttr(heroTree(h, {}, id => picked.push(id)), 'data-vssaros-context-add').props.onClick();
			await settle();
			assert.deepStrictEqual(made, [{ path: 'G:\\NewRepo' }],
				'与官方 `createWorkspace: (input) => workspaces.create(input)` **同一条链**（不新增桥命令 ✓）');
			assert.deepStrictEqual(picked, ['ws-new'], 'hero：采纳即选中（与官方 adoptDirectory → onPick 同语义 ✓）');
			assert.strictEqual(state.contextAdds, 1, '成功要如实计数（诊断依赖它 ✓）');
		});
	});

	test('★ 没有目录选择器 ⇒ 如实说清、不记成功；header 里添加成功后**不**自动切会话（只提示）', async () => {
		// ① hero：宿主没装 directoryPicker（服务不进 inject ⇒ 只能运行时取 ✓）
		await mount({ bridge: {} }, async (h: any, state: Record<string, unknown>) => {
			findByAttr(heroTree(h), 'data-vssaros-context-add').props.onClick();
			await settle();
			assert.ok(JSON.stringify(heroTree(h)).includes('没有目录选择器'),
				'要说清为什么加不了（不能"点了没反应" ✗）');
			assert.strictEqual(state.contextAdds, undefined, '没成功不许记成功 ✓');
		});
		// ② header：同样的行，成功后只提示、不换会话
		const switches: string[] = [];
		const made: any[] = [];
		await mount({
			bridge: { switchWorktree: (p: string) => { switches.push(p); return Promise.resolve(); } },
			picker: { pick: () => Promise.resolve({ ok: true, value: { path: 'G:\\NewRepo' } }) },
			create: (input: any) => { made.push(input); return Promise.resolve({ workspaceId: 'ws-new' }); },
		}, async (h: any) => {
			findByAttr(h.render(0, { sessionId: 's-a' }), 'data-vssaros-context-chip').props.onClick();
			findByAttr(h.render(0, { sessionId: 's-a' }), 'data-vssaros-context-add').props.onClick();
			await settle();
			assert.deepStrictEqual(made, [{ path: 'G:\\NewRepo' }]);
			assert.deepStrictEqual(switches, [],
				'添加**不许**顺带换会话（否则"添加工作区"变成一个会踢人的动作 ✗）');
			assert.ok(JSON.stringify(h.render(0, { sessionId: 's-a' })).includes('已添加工作区'),
				'结果要就地可见（用户据此决定要不要切过去 ✓）');
		});
	});
});
