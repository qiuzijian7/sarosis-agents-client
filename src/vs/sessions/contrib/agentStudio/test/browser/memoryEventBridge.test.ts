/*---------------------------------------------------------------------------------------------
 *  MemoryEventBridge 专属行为基线（2026-09-22 阶段④-g P1/D-2 ✓）
 *
 *  为什么需要它 ✗✓：`memoryEventBridge.ts`（167 行 ✓）把 provider 的**全局**记忆事件桥到
 *  各会话的 `onDelta`，四条约定**每条都对应一次真机事故** ✓（串台 / 重复卡片 / 假"已保存" / 订阅泄漏）✓，
 *  但原本只经「服务级端到端基线」间接覆盖 ✗ ⇒ 改动路由或去重可能**静默不红** ✗✓。
 *
 *  ⚠ 断言全部**先读实现再写** ✓（连续两轮的假红教训 ✓）。四条要钉死的语义 ✓：
 *   ① `ensure()` **幂等** ✓；② 事件按 `data.sessionId` **精确路由** ✓（缺失才退化 ✓）；
 *   ③ 双层去重 ✓（`noticeId` 集合 + 无 noticeId 的卡片按 `memoryType` **5 秒窗口** ✓）；
 *   ④ `contentLength === 0` ⇒ 发 `remove: true`，**绝不显示"已保存"** ✓✓；
 *   ⑤ `dispose()` **必须真正消费**三个 unsub ✓（该字段曾只赋值不读取 ⇒ 订阅泄漏 ✗）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { MemoryEventBridge } from '../../browser/memoryEventBridge.js';

interface IHarness {
	bridge: MemoryEventBridge;
	/** 收到的 delta：`key` = 路由到的 `agentId::sessionId` ✓ */
	deltas: Array<{ key: string; delta: any }>;
	/** 主动触发一次「记忆已写入」事件 ✓ */
	emitWritten(agentId: string, data: any): void;
	emitFailed(agentId: string, data: any): void;
	emitSkill(event: any): void;
	unsubCount(): number;
	writtenSubscribes: number;
	/**
	 * 模拟**宿主销毁**：把它那边的 onDelta 路由全部撤掉 ✓。
	 * ⚠ 必须照抄真实语义 ✗✓：桥**自身没有** disposed 守卫 ✓，它依赖「provider 守约停止回调」+
	 *   「宿主路由已消失」这两件事 ✓ ⇒ 假件若不撤路由，就比真宿主更宽松 ⇒ 会造出假红 ✗。
	 */
	detachRouting(): void;
}

function makeHarness(opts: { withWritten?: boolean; withFailed?: boolean; withEvent?: boolean } = {}): IHarness {
	const withWritten = opts.withWritten !== false;
	const deltas: Array<{ key: string; delta: any }> = [];
	let writtenCb: any = null;
	let failedCb: any = null;
	let skillCb: any = null;
	let unsubs = 0;
	let writtenSubscribes = 0;

	const provider: any = {};
	if (withWritten) {
		provider.onMemoryWritten = (cb: any) => { writtenSubscribes++; writtenCb = cb; return () => { unsubs++; }; };
	}
	if (opts.withFailed !== false && withWritten) {
		provider.onMemoryWriteFailed = (cb: any) => { failedCb = cb; return () => { unsubs++; }; };
	}
	if (opts.withEvent) {
		provider.onEvent = (_evt: string, cb: any) => { skillCb = cb; return () => { unsubs++; }; };
	}

	/** ⚠ 照抄宿主语义 ✓：按 `agentId(+sessionId)` 路由；不同会话 ⇒ **不同** handler ✗✓（串台靶子 ✓）。 */
	const handlers = new Map<string, (d: any) => void>();
	let routingDetached = false;   // 宿主销毁后：路由不再存在 ⇒ 必须返回 undefined ✓（照抄真语义 ✗✓）
	const deps: any = {
		getActiveMemoryProvider: () => provider,
		getOnDeltaForAgent: (agentId: string, sessionId?: string) => {
			if (routingDetached) { return undefined; }
			const key = sessionId === undefined ? agentId : `${agentId}::${sessionId}`;
			if (!handlers.has(key)) { handlers.set(key, (delta: any) => { deltas.push({ key, delta }); }); }
			return handlers.get(key);
		},
	};

	const bridge = new MemoryEventBridge(deps);
	return {
		bridge, deltas,
		emitWritten: (agentId, data) => writtenCb?.(agentId, data),
		emitFailed: (agentId, data) => failedCb?.(agentId, data),
		emitSkill: (event) => skillCb?.(event),
		unsubCount: () => unsubs,
		detachRouting: () => { routingDetached = true; handlers.clear(); },
		get writtenSubscribes() { return writtenSubscribes; },
	};
}

suite('MemoryEventBridge — 记忆事件桥四条不可退化约定 ✓', () => {

	test('★ `ensure()` 幂等 ✓：重复调用只建立**一次**订阅（否则同一事件会重复显示 ✗✓）', () => {
		const h = makeHarness();
		h.bridge.ensure();
		h.bridge.ensure();
		h.bridge.ensure();
		assert.strictEqual(h.writtenSubscribes, 1,
			`provider 只应被订阅 1 次（实际 ${h.writtenSubscribes} ✗ —— 重复订阅 ⇒ 每事件多张卡片 ✗✓）`);
	});

	test('★ 旧 provider（无 `onMemoryWritten`）⇒ 不桥接、不抛 ✓；`dispose()` 也安全 ✓', () => {
		const h = makeHarness({ withWritten: false });
		assert.doesNotThrow(() => { h.bridge.ensure(); h.bridge.dispose(); h.bridge.dispose(); },
			'不支持事件订阅的旧 provider 必须安全回退 ✓（抛错会中断 sendMessage 起步阶段 ✗✓）');
		assert.strictEqual(h.deltas.length, 0, '不得凭空产生事件 ✓');
	});

	test('★★★ **串台防护**：带 `data.sessionId` 的事件必须精确路由到 `agentId::sessionId` ✓✓', () => {
		const h = makeHarness();
		h.bridge.ensure();
		h.emitWritten('a1', { sessionId: 's1', noticeId: 'n1', contentLength: 5, memoryType: 'fact' });
		assert.strictEqual(h.deltas.length, 1, '事件必须被投递 ✓');
		assert.strictEqual(h.deltas[0].key, 'a1::s1',
			`必须落到 **s1** 的会话流（实际 ${h.deltas[0].key} ✗✓ —— 落错会话即"A 的记忆写进 B 的聊天框" ✗）`);

		// 同 agent、不同会话 ⇒ 必须各自精确 ✓（这正是多会话并发下的串台靶子 ✓）
		h.emitWritten('a1', { sessionId: 's2', noticeId: 'n2', contentLength: 7, memoryType: 'fact' });
		assert.strictEqual(h.deltas[1].key, 'a1::s2', '第二个会话必须收到属于自己的那条 ✓');
		assert.deepStrictEqual(h.deltas.map(d => d.key), ['a1::s1', 'a1::s2'],
			'两条事件不得交叉投递 ✓');
	});

	test('★★ `sessionId` 缺失时才退化为「同 agent 最近活跃流」✓（退化不等于把 sessionId 变成 undefined 字符串 ✗）', () => {
		const h = makeHarness();
		h.bridge.ensure();
		h.emitWritten('a1', { noticeId: 'n1', contentLength: 3, memoryType: 'fact' });
		assert.strictEqual(h.deltas.length, 1);
		assert.strictEqual(h.deltas[0].key, 'a1',
			'缺 sessionId 时必须按 **agentId** 路由（实际带上了伪 sessionId ✗✓）');
	});

	test('★★★ `contentLength === 0` ⇒ 只发 `remove: true` 撤销 pending 卡片，**绝不显示"已保存"** ✓✓', () => {
		const h = makeHarness();
		h.bridge.ensure();
		h.emitWritten('a1', { sessionId: 's1', noticeId: 'n1', contentLength: 0, memoryType: 'fact' });
		assert.strictEqual(h.deltas.length, 1, '必须发出一条撤销事件（不发 ⇒ pending 卡片永远转圈 ✗✓）');
		const d = h.deltas[0].delta;
		assert.strictEqual(d.metadata.remove, true, '必须带 `remove: true` ✓');
		assert.strictEqual(d.content, '', '内容必须为空 ✓');
		assert.ok(!String(d.content).includes('已保存'),
			'★ 空写入**绝不能**显示"已保存" ✗✓✓（本桥存在的理由就是消灭这类假信号 ✓）');
		// 连 `contentLength` 缺失（undefined）也必须走撤销分支 ✓（falsy ⇒ 同一条路径 ✓）
		h.emitWritten('a1', { sessionId: 's1', noticeId: 'n2', memoryType: 'fact' });
		assert.strictEqual(h.deltas[1].delta.metadata.remove, true, '`contentLength` 缺失同样必须撤销 ✓');
	});

	test('★★ `noticeId` 集合去重 ✓：同一条写入重复上报只显示一次 ✓（且 label 用真实 memoryType ✓）', () => {
		const h = makeHarness();
		h.bridge.ensure();
		h.emitWritten('a1', { sessionId: 's1', noticeId: 'dup', contentLength: 12, memoryType: 'semantic' });
		h.emitWritten('a1', { sessionId: 's1', noticeId: 'dup', contentLength: 12, memoryType: 'semantic' });
		h.emitWritten('a1', { sessionId: 's1', noticeId: 'dup', contentLength: 12, memoryType: 'semantic' });
		assert.strictEqual(h.deltas.length, 1,
			`同 noticeId 必须只显示一次（实际 ${h.deltas.length} ✗✓ —— 重复卡片是用户可见缺陷 ✗）`);
		const d = h.deltas[0].delta;
		assert.strictEqual(d.type, 'memory_written', '类型必须是写入完成 ✓');
		assert.strictEqual(d.content, 'Semantic 已保存 12字',
			`label 必须取**真实 memoryType**（实际「${d.content}」✗✓ —— 曾硬编码 "Working" ⇒ 标签撒谎 ✗）`);
		assert.strictEqual(d.metadata.noticeId, 'dup');
	});

	test('★ 写入完成的 label 映射与兜底 ✓（未知类型用原值 ✓、缺失用 Working ✓）', () => {
		const h = makeHarness();
		h.bridge.ensure();
		h.emitWritten('a1', { sessionId: 's1', noticeId: 'n1', contentLength: 1, memoryType: 'bug' });
		h.emitWritten('a1', { sessionId: 's1', noticeId: 'n2', contentLength: 1, memoryType: 'custom_type' });
		h.emitWritten('a1', { sessionId: 's1', noticeId: 'n3', contentLength: 1 });
		assert.strictEqual(h.deltas[0].delta.content, 'Bug 已保存 1字', '已知类型必须走映射表 ✓');
		assert.strictEqual(h.deltas[1].delta.content, 'custom_type 已保存 1字', '未知类型必须回退为原值 ✓');
		assert.strictEqual(h.deltas[2].delta.content, 'Working 已保存 1字', '缺失类型回退 Working ✓');
	});

	test('★★★ 无 `noticeId` 的提取卡片：`working`/`short_term` **跳过** ✓、其余按 `memoryType` **5 秒窗口**去重 ✓', () => {
		const h = makeHarness();
		h.bridge.ensure();
		// hook 触发的 working 写入与 per-iteration 写入重复 ⇒ 必须跳过（否则同一件事显示两次 ✗✓）
		h.emitWritten('a1', { sessionId: 's1', memoryType: 'working', contentLength: 5 });
		h.emitWritten('a1', { sessionId: 's1', memoryType: 'short_term', contentLength: 5 });
		assert.strictEqual(h.deltas.length, 0,
			'working / short_term 无 noticeId 时必须**跳过** ✗✓（hook 触发的重复写入 ✓）');

		h.emitWritten('a1', { sessionId: 's1', memoryType: 'fact', contentLength: 5 });
		assert.strictEqual(h.deltas.length, 1, '其他类型必须显示提取卡片 ✓');
		assert.strictEqual(h.deltas[0].delta.type, 'memory_extracted');
		assert.strictEqual(h.deltas[0].delta.content, 'Fact 已提取');
		assert.strictEqual(h.deltas[0].delta.metadata.status, 'saved', '提取完成必须标 saved ✓');

		// 一次提取常写多条 fact ⇒ 5 秒窗口内同类型只显示一次 ✓
		h.emitWritten('a1', { sessionId: 's1', memoryType: 'fact', contentLength: 5 });
		h.emitWritten('a1', { sessionId: 's1', memoryType: 'fact', contentLength: 5 });
		assert.strictEqual(h.deltas.length, 1,
			`同类型 5 秒内必须只显示 1 张卡（实际 ${h.deltas.length} ✗✓ —— 一次提取写 N 条 fact 会刷屏 ✗）`);
		// 不同类型不受影响 ✓（窗口按 memoryType 分桶 ✓）
		h.emitWritten('a1', { sessionId: 's1', memoryType: 'bug', contentLength: 5 });
		assert.strictEqual(h.deltas.length, 2, '不同类型必须能立刻显示 ✓（窗口是 per-type ✓）');
	});

	test('★ 写入失败：有 `noticeId` 才提示 ✓、无 `noticeId` 不打扰 ✓', () => {
		const h = makeHarness();
		h.bridge.ensure();
		h.emitFailed('a1', { sessionId: 's1', noticeId: 'f1', error: 'disk full' });
		assert.strictEqual(h.deltas.length, 1, '失败必须可见（fail-visible ✗✓ —— 静默失败会让用户以为记住了 ✓）');
		assert.strictEqual(h.deltas[0].delta.type, 'memory_write_failed');
		assert.ok(String(h.deltas[0].delta.content).includes('disk full'), '必须带上错误原因 ✓');
		h.emitFailed('a1', { sessionId: 's1', error: 'disk full' });
		assert.strictEqual(h.deltas.length, 1, '无 noticeId 时不得打扰用户（没有 pending 卡片可挂 ✓）');
	});

	test('★★ 技能提取事件：只在 provider 支持 `onEvent` 时桥接 ✓，且带 `⚡ 技能已沉淀` 与可点击元数据 ✓', () => {
		const h = makeHarness({ withEvent: true });
		h.bridge.ensure();
		h.emitSkill({ agentId: 'a1', data: { skillId: 'sk1', title: '批量改名' } });
		assert.strictEqual(h.deltas.length, 1);
		const d = h.deltas[0].delta;
		assert.strictEqual(d.type, 'skill_extracted');
		assert.ok(String(d.content).includes('⚡ 技能已沉淀') && String(d.content).includes('批量改名'),
			`内容必须含技能标题（实际「${d.content}」✗）`);
		assert.deepStrictEqual(d.metadata, { skillId: 'sk1', title: '批量改名', agentId: 'a1', clickable: true },
			'技能卡片必须可点击（false ⇒ 用户点不开技能详情 ✗✓）');
		h.emitSkill({ agentId: 'a1', data: {} });
		assert.ok(String(h.deltas[1].delta.content).includes('未知技能'), '缺标题必须兜底为「未知技能」✓');

		// 不支持 onEvent 的 provider ⇒ 不得抛 ✓
		const h2 = makeHarness();
		h2.bridge.ensure();
		assert.doesNotThrow(() => h2.emitSkill({ agentId: 'a1', data: {} }),
			'无 onEvent 的 provider 必须安全（技能桥接是可选能力 ✓）');
	});

	test('★★★ `dispose()` 必须**真正消费** unsub：三个订阅全退、之后的事件**不得**再产生 delta ✓✓', () => {
		const h = makeHarness({ withEvent: true });
		h.bridge.ensure();
		h.emitWritten('a1', { sessionId: 's1', noticeId: 'before', contentLength: 1, memoryType: 'fact' });
		assert.strictEqual(h.deltas.length, 1, 'dispose 之前必须正常工作 ✓');

		h.bridge.dispose();
		assert.strictEqual(h.unsubCount(), 3,
			`written/failed/skill 三个 unsub 都必须被调用（实际 ${h.unsubCount()} ✗✓ —— _unsub 曾只赋值不读取 ⇒ 订阅泄漏 ✗）`);
		h.bridge.dispose();
		assert.strictEqual(h.unsubCount(), 3, '重复 dispose 必须幂等（不得重复调用 unsub ✗）');

		// ⚠ 关键 ✓：桥**自身没有** disposed 守卫 ✓，它依赖「宿主销毁后 onDelta 路由已消失」✓
		//   ⇒ 假件必须照抄这一点（`detachRouting` ✓，否则比真宿主宽松 ⇒ 假红 ✗）。
		//   即便 provider 仍持有回调（真实 provider 不一定立刻停止 ✗），也不得再投递给 UI ✓。
		h.detachRouting();
		const before = h.deltas.length;
		h.emitWritten('a1', { sessionId: 's1', noticeId: 'after', contentLength: 1, memoryType: 'fact' });
		h.emitFailed('a1', { sessionId: 's1', noticeId: 'after', error: 'x' });
		h.emitSkill({ agentId: 'a1', data: { skillId: 'sk', title: 't' } });
		assert.strictEqual(h.deltas.length, before,
			'dispose 后**不得**再投递 delta ✓（路由已消失 ⇒ 泄漏探针在此处才会响 ✓）');
	});
});
