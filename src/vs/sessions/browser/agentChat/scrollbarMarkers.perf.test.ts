/*---------------------------------------------------------------------------------------------
 *  Performance regression test: refreshScrollMarkers 不得随历史条数产生
 *  O(N) 次强制同步布局（forced reflow）。
 *
 *  背景（2026-09-17 用户报「聊天历史多了，发送新消息卡顿」）：
 *  原实现逐个 user 消息执行 `el.querySelector([data-msg-id])`（属性选择器全子树
 *  扫描）+ 读取 `offsetTop`（强制布局），且读与随后的 appendChild(写) 逐轮交错，
 *  导致第 i 轮读完布局立即被自己写脏，第 i+1 轮再读时触发整容器 reflow。
 *  N 条 user 消息 ⇒ N 次强制重排。
 *
 *  修复后：单次 querySelectorAll 建 Map 索引 + 两阶段（先只读收集几何，再用
 *  DocumentFragment 批量写入）⇒ 强制布局次数降为常数级。
 *
 *  本测试用 jsdom 驱动真实 ScrollbarController，统计 offsetTop / offsetHeight /
 *  scrollHeight 这些**会触发同步布局**的属性的读取次数作为代理指标。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { ScrollbarController } from './scrollbarController.js';
import type { IScrollbarHost } from './scrollbarController.js';
import type { IAgentChatMessage } from './agentChatTypes.js';

/** 构造 N 条 user + assistant 交替消息，模拟长会话历史。 */
function buildMessages(userCount: number): IAgentChatMessage[] {
	const messages: IAgentChatMessage[] = [];
	for (let i = 0; i < userCount; i++) {
		messages.push({
			id: `user-${i}`,
			role: 'user',
			content: `用户第 ${i} 条消息内容`,
			timestamp: 0,
		});
		messages.push({
			id: `assistant-${i}`,
			role: 'assistant',
			content: `助手第 ${i} 条回复内容`,
			timestamp: 0,
		});
	}
	return messages;
}

/**
 * 在全局 jsdom 环境中铺设与 messages 对应的 .chat-message 节点，
 * 并对会触发同步布局的几何属性打点计数。
 *
 * 注意：计数打点在 globalThis.document 所用的 prototype 上（而非新建的
 * JSDOM 实例），这样才能统计到被测代码在同一环境中的属性读取。
 */
function setupDom(userCount: number) {
	const doc = globalThis.document;
	const win = globalThis.window as unknown as typeof globalThis;

	// 每个用例用独立的容器，避免跨用例互相污染
	const messagesContainer = doc.createElement('div');
	messagesContainer.className = 'chat-messages';

	const customScrollbar = doc.createElement('div');
	const track = doc.createElement('div');

	const messages = buildMessages(userCount);
	for (const msg of messages) {
		const el = doc.createElement('div');
		el.className = `chat-message ${msg.role}`;
		el.setAttribute('data-msg-id', msg.id);
		messagesContainer.appendChild(el);
	}

	// 布局读取计数（代理指标：值 = 触发同步布局的属性读取次数）
	let layoutReads = 0;
	// ±± 强制同步布局（forced reflow）计数 ±±
	// 浏览器行为：DOM 写入使布局失效（dirty），随后任一次几何属性**读取**会
	// 触发一次真实 reflow 并清除 dirty。因此「读取总次数」无法区分实现优劣
	// ——真正的代价是 reflow 次数，它取决于**读与写是否交错**：
	//   旧实现：读(offsetTop) → 写(appendChild) → 读 → 写 … ⇒ N 次 reflow
	//   新实现：读×N（dirty 只清一次）→ 写×N ⇒ 1 次 reflow
	// 故这里同时统计 layoutReads（属性读取）与 forcedReflows（强制重排）。
	let forcedReflows = 0;
	let layoutDirty = true;
	const countLayoutReads = (proto: object, prop: string) => {
		const original = Object.getOwnPropertyDescriptor(proto, prop);
		if (!original?.get) { return; }
		Object.defineProperty(proto, prop, {
			configurable: true,
			get() {
				layoutReads++;
				if (layoutDirty) { forcedReflows++; layoutDirty = false; }
				return original.get!.call(this);
			},
		});
	};

	// jsdom 不做真实布局：offsetTop/offsetHeight/scrollHeight 恒为 0，
	// 会让 refreshScrollMarkers 在 `trackHeight <= 0 || scrollHeight <= 0`
	// 处提前 return，测不到目标路径。这里显式给出稳定的非零几何值，
	// 使被测代码走完整分支。
	//
	// ⚠ 顺序要求：必须先铺好这些「实例自有属性」再安装计数代理，否则
	// 实例属性会遮蔽 prototype 上的计数 getter，导致计数恒为 0（假阳性）。
	Object.defineProperty(track, 'offsetHeight', {
		configurable: true,
		get() {
			layoutReads++;
			if (layoutDirty) { forcedReflows++; layoutDirty = false; }
			return 600;
		},
	});
	Object.defineProperty(messagesContainer, 'scrollHeight', {
		configurable: true,
		get() {
			layoutReads++;
			if (layoutDirty) { forcedReflows++; layoutDirty = false; }
			return 10000;
		},
	});
	// 每条消息给一个递增的 offsetTop，模拟真实排布
	for (const [index, el] of Array.from(
		messagesContainer.querySelectorAll<HTMLElement>('.chat-message'),
	).entries()) {
		Object.defineProperty(el, 'offsetTop', {
			configurable: true,
			get() {
				layoutReads++;
				if (layoutDirty) { forcedReflows++; layoutDirty = false; }
				return index * 120;
			},
		});
	}

	// 拦截 DOM 写入：任何 appendChild/remove 都使布局失效（置脏）。
	// 这是让 forcedReflows 能反映「读写交错」的关键——被测代码每插入一个
	// marker 就置脏一次，若它紧接着又去读几何属性，就会计入一次强制重排。
	const markDirtyOnWrite = (proto: object, method: string) => {
		const original = (proto as Record<string, unknown>)[method] as (...args: unknown[]) => unknown;
		if (typeof original !== 'function') { return; }
		(proto as Record<string, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
			layoutDirty = true;
			return original.apply(this, args);
		};
	};
	markDirtyOnWrite(win.Node.prototype, 'appendChild');
	markDirtyOnWrite(win.Node.prototype, 'insertBefore');
	markDirtyOnWrite(win.Element.prototype, 'remove');

	// 计数代理：装在实例自有属性之后，避免被遮蔽
	countLayoutReads(win.HTMLElement.prototype, 'offsetTop');
	countLayoutReads(win.HTMLElement.prototype, 'offsetHeight');
	countLayoutReads(win.Element.prototype, 'scrollHeight');

	const host = {
		isSending: false,
		isDraggingScrollbar: false,
		streamJustEnded: false,
		unreadCount: 0,
		messages,
		messagesContainer,
		customScrollbar,
		scrollbarThumb: null,
		scrollbarTrack: track,
		scrollbarPopup: null,
		scrollbarPopupPreview: null,
		scrollToBottomBtn: null,
		scrollBadge: null,
		onScrollToMessage: () => { /* noop */ },
	} as unknown as IScrollbarHost;

	return {
		host,
		getLayoutReads: () => layoutReads,
		getForcedReflows: () => forcedReflows,
		customScrollbar,
		messagesContainer,
	};
}

suite('refreshScrollMarkers — 性能特征', () => {

	test('强制同步布局次数必须为常数级，不随历史条数线性增长', () => {
		const small = setupDom(10);
		const smallController = new ScrollbarController(small.host);
		smallController.refreshScrollMarkers();

		const large = setupDom(200);
		const largeController = new ScrollbarController(large.host);
		largeController.refreshScrollMarkers();

		const smallReflows = small.getForcedReflows();
		const largeReflows = large.getForcedReflows();

		// 强制同步布局（forced reflow）才是卡顿的真实来源：每次 reflow 都要
		// 让浏览器在关键路径上同步完成样式计算与布局。
		//   旧实现读→写→读→写交错 ⇒ reflow ≈ O(N)
		//   新实现两阶段（先只读收集、再批量写） ⇒ reflow = 常数
		console.log(
			`      [perf] 强制重排: 10 条=${smallReflows} 次, 200 条=${largeReflows} 次`
			+ `（属性读取 ${small.getLayoutReads()} / ${large.getLayoutReads()}）`,
		);
		// 断言用**绝对阈值**而非「大 vs 小」比较：后者会被跨用例的累积计数污染
		// （曾实测到小用例基数被前序调用抬高到 210，使 200 次的回归反而"通过"）。
		// 正确实现是常数次（两阶段：1 次布局 + 收尾若干次），故直接卡上限。
		assert.ok(
			largeReflows <= 8,
			`200 条历史时强制重排 ${largeReflows} 次，超过常数级上限 8 次。`
			+ `说明读与写再次交错 —— 回归为 O(N) 强制重排（每条消息一次），这正是卡顿根因。`,
		);
	});

	test('标记数量与 user 消息数量一致（行为未回退）', () => {
		const ctx = setupDom(25);
		const controller = new ScrollbarController(ctx.host);
		controller.refreshScrollMarkers();

		// 原实现对每个 user 消息创建一个 marker（offsetTop/scrollHeight 可算时）。
		// 修复后必须保持同样的标记语义。
		const markerCount = ctx.customScrollbar.querySelectorAll('.chat-scroll-marker').length;
		assert.strictEqual(markerCount, 25, `应有 25 个滚动标记，实际 ${markerCount}`);
	});

	test('重复调用不残留旧标记（幂等）', () => {
		const ctx = setupDom(15);
		const controller = new ScrollbarController(ctx.host);
		controller.refreshScrollMarkers();
		controller.refreshScrollMarkers();
		controller.refreshScrollMarkers();

		const markerCount = ctx.customScrollbar.querySelectorAll('.chat-scroll-marker').length;
		assert.strictEqual(markerCount, 15, `重复刷新后应仍为 15 个标记，实际 ${markerCount}`);
	});
});

/**
 * 2026-09-18：`scheduleRefreshScrollMarkers()`（rAF 合并版）的行为约束。
 *
 * 背景（用户报「多聊天框时切换聊天框输入框卡顿」）：`addMessage()` 原先**每条**新增
 * 消息都同步调一次 `refreshScrollMarkers()`，而流式期间 addMessage 是**成簇**到达的
 * （工具卡 / 子代理卡连续插入）⇒ 同一帧内被重复调用多次，每次都是 O(消息区 DOM)。
 * 合并后同一帧只做一次，但**不能**因此丢标记或变成一次性的。
 */
suite('scheduleRefreshScrollMarkers — rAF 合并（2026-09-18）', () => {
	/** 等 n 帧，让排入的 rAF 回调执行。 */
	const nextFrames = (n: number) => new Promise<void>(resolve => {
		const step = (left: number) => left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
		step(n);
	});

	test('同一帧内多次调度只真正刷新一次，且不丢标记', async () => {
		const ctx = setupDom(30);
		const controller = new ScrollbarController(ctx.host);
		let calls = 0;
		const original = controller.refreshScrollMarkers.bind(controller);
		controller.refreshScrollMarkers = () => { calls++; original(); };

		// 模拟流式期间成簇到达的 addMessage
		controller.scheduleRefreshScrollMarkers();
		controller.scheduleRefreshScrollMarkers();
		controller.scheduleRefreshScrollMarkers();
		assert.strictEqual(calls, 0, 'rAF 回调执行前不应同步刷新（否则等于没合并）');

		await nextFrames(2);
		assert.strictEqual(calls, 1, `同一帧 3 次调度应合并为 1 次刷新，实际 ${calls}`);
		const markerCount = ctx.customScrollbar.querySelectorAll('.chat-scroll-marker').length;
		assert.strictEqual(markerCount, 30, `合并后标记数应仍为 30，实际 ${markerCount}`);

		// 不是"只生效一次"：后续帧仍可重新调度
		controller.scheduleRefreshScrollMarkers();
		await nextFrames(2);
		assert.strictEqual(calls, 2, `后续帧应能再次刷新，实际 ${calls}`);
	});

	test('dispose 后不再执行已排入的刷新', async () => {
		const ctx = setupDom(5);
		const controller = new ScrollbarController(ctx.host);
		let calls = 0;
		controller.refreshScrollMarkers = () => { calls++; };

		controller.scheduleRefreshScrollMarkers();
		controller.dispose();
		await nextFrames(2);
		assert.strictEqual(calls, 0, `dispose 后不应再刷新（回调须被取消），实际 ${calls}`);
	});
});
