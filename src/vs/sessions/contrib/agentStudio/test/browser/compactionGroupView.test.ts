/*---------------------------------------------------------------------------------------------
 *  compactionGroupView.test.ts — 压缩分组**视图层**单测（方案 C 的可见行为）
 *
 *  为什么必须有它：`compactionGroupView.ts` 是 260+ 行**新 DOM 代码** —— 计划函数有纯测，
 *  但"组头文案 / 懒渲染 / 展开收起 / 撤销按钮 / 不可信边界提示"全在视图侧 ✓，
 *  若只测计划函数，就会出现"算对了却画错了"的静默失效 ✗✓。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/compactionGroupView.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	createCompactionElement,
	_resetCompactionGroupStateForTest,
	type ICompactionGroupViewDeps,
// ⚠ 相对层级：本文件在 contrib/agentStudio/test/browser/ ⇒ 回 sessions 需 **4** 级 ✓
} from '../../../../browser/agentChat/compactionGroupView.js';
import type { IAgentChatMessage } from '../../../../browser/agentChat/agentChatTypes.js';
import type { ICompactionGroupMeta } from '../../common/compactionGroupPlan.js';

suite('压缩分组视图（方案 C 手风琴）', () => {

	/** 采集宿主注入的调用（照抄真实语义：断言"谁被调了、调了什么" ✓）。 */
	function makeDeps(over?: Partial<ICompactionGroupViewDeps>) {
		const calls: { archived: string[]; slash: Array<[string, string]>; anchors: number } = {
			archived: [], slash: [], anchors: 0,
		};
		const deps: ICompactionGroupViewDeps = {
			createArchivedElement: (m: IAgentChatMessage) => {
				calls.archived.push(m.id);
				const el = document.createElement('div');
				el.setAttribute('data-msg-id', m.id);
				// 归档气泡会带上动作条 ⇒ 视图必须把它们摘掉（归档区不可交互 ✓）
				const acts = document.createElement('div');
				acts.className = 'chat-msg-actions';
				el.appendChild(acts);
				return el;
			},
			getScrollHost: () => undefined,
			isAtBottom: () => false,
			refreshScrollMarkers: () => { calls.anchors++; },
			runSlashCommand: (c: string, a: string) => { calls.slash.push([c, a]); },
			...over,
		};
		return { deps, calls };
	}

	const archivedMsg = (id: string): IAgentChatMessage =>
		({ id, role: 'user', content: `c-${id}`, timestamp: 1000 }) as IAgentChatMessage;

	function groupMsg(over?: Partial<ICompactionGroupMeta>): IAgentChatMessage {
		const group: ICompactionGroupMeta = {
			id: 'compaction-group:bd1',
			count: 3,
			summary: '· 目标：软删除（保留审计）\n· 已改：3 处调用点',
			tokensSaved: 1234,
			summaryChars: 900,
			staleBoundaryCount: 0,
			fromTime: 1000,
			toTime: 3000,
			archivedKept: true,          // 手风琴用例走保留模式 ✓（移除模式另有用例 ✓）
			removedCount: 4,
			archived: [archivedMsg('u1'), archivedMsg('a1'), archivedMsg('u2')],
			...over,
		};
		return {
			id: group.id, role: 'system', content: group.summary, timestamp: 5000, compactionGroup: group,
		} as IAgentChatMessage;
	}

	/** 构造一个"不可信边界"消息（真机形态：tokensSaved = -73 ✓）。 */
	const badBoundaryMsg = (): IAgentChatMessage => ({
		id: 'bd-bad', role: 'system', content: '[上下文压缩] 此前的对话历史（153 条消息）已压缩为以下摘要：无',
		timestamp: 5000, metadata: { type: 'compaction', tokensSaved: -73, summaryChars: 0, originalCount: 153 },
	} as IAgentChatMessage);

	setup(() => _resetCompactionGroupStateForTest());

	test('★★★ 默认**收起** ⇒ 组体**不建 DOM**（懒渲染：26 条消息不该在首屏建上千节点 ✗✓）', () => {
		const { deps, calls } = makeDeps();
		const el = createCompactionElement(groupMsg(), deps)!;
		assert.ok(el, '压缩分组消息必须被接管 ✓');
		assert.ok(el.classList.contains('chat-message'), '必须保留 .chat-message ⇒ 懒加载/裁剪/滚动标记照旧 ✓');
		assert.strictEqual(el.getAttribute('data-msg-id'), 'compaction-group:bd1', 'data-msg-id 必须存在（裁剪反查下标要用 ✓）');
		const body = el.querySelector('.chat-compaction-body') as HTMLElement;
		assert.ok(body, '组体必须存在于 DOM 结构（只是不渲染内容 ✓）');
		assert.strictEqual(body.style.display, 'none', '默认收起 ✓');
		assert.strictEqual(calls.archived.length, 0, '收起态**一个归档气泡都不许建** ✗✓（DOM 预算纪律）');
		assert.strictEqual(body.dataset.rendered, '0', '必须打上"未渲染"标记 ✓（否则展开时不补渲染 ⇒ 空组 ✗✓）');
	});

	test('★★★ 组头/组脚文案：条数 + 指标 + 摘要一行 ✓（用户唯一能看懂"发生了什么"的地方 ✓）', () => {
		const { deps } = makeDeps();
		const el = createCompactionElement(groupMsg(), deps)!;
		const headText = (el.querySelector('.chat-compaction-head') as HTMLElement).textContent ?? '';
		assert.ok(headText.includes('已压缩的 3 条消息'), `组头必须写明条数（实际「${headText}」✗）`);
		assert.ok(headText.includes('摘要 900 字'), '摘要字数 chip ✓');
		assert.ok(headText.includes('省 1,234 tok'), '省 token chip 必须千分位格式化 ✓');
		assert.strictEqual(headText.includes('历史边界'), false, '无失效边界 ⇒ 不得出现该 chip ✗');
		const footText = (el.querySelector('.chat-compaction-foot') as HTMLElement).textContent ?? '';
		assert.ok(footText.includes('摘要：· 目标：软删除'), `组脚取摘要首行（实际「${footText}」✗）`);
		assert.ok(footText.includes('恢复完整历史'),
			'恢复入口必须在组脚 ✓（否则用户不敢用手动压缩 ✗；文案用「恢复完整历史」⇒ 移除模式下语义才对 ✓）');
	});

	test('★★★ 点击组头 ⇒ 展开并**补渲染**归档；再点 ⇒ 收起 ✓（状态跨重建保留 ✓）', () => {
		// ⚠ 替身必须**照抄真件**：真实面板**永远有**消息容器 ✓（返回 undefined 会让视图按设计早退、
		//   不重算滚动标记 ⇒ 假红 ✓ —— 本轮实测踩到 ✓）。jsdom 无布局 ⇒ scrollHeight 恒为 0
		//   ⇒ 这里断言的是"**调用**了补偿路径"，不是像素 ✓（像素由真机拖拽验证 ✓）。
		const { deps, calls } = makeDeps({ getScrollHost: () => document.createElement('div') });
		const el = createCompactionElement(groupMsg(), deps)!;
		const head = el.querySelector('.chat-compaction-head') as HTMLElement;
		const body = el.querySelector('.chat-compaction-body') as HTMLElement;
		assert.strictEqual(head.getAttribute('aria-expanded'), 'false', '收起态 aria-expanded=false ✓');

		// ⚠ 必须用 `.click()` 而非 `dispatchEvent(new Event(…))` ✗✓：测试环境里全局 `Event` 是
		//   **Node 的**（jsdom 只装了 document ✓）⇒ jsdom 的 dispatchEvent 会直接抛
		//   "parameter 1 is not of type 'Event'"（本轮实测踩到 ✓）。`.click()` 由 jsdom 实现，
		//   派发真 MouseEvent 且**默认冒泡** ⇒ 恰好还能验证按钮的 stopPropagation ✓✓。
		head.click();
		assert.strictEqual(body.style.display, 'block', '点击后必须展开 ✓');
		assert.strictEqual(head.getAttribute('aria-expanded'), 'true', 'aria-expanded 必须同步 ✓');
		assert.deepStrictEqual(calls.archived, ['u1', 'a1', 'u2'], '首次展开必须**补渲染**全部归档 ✓（顺序保持 ✓）');
		assert.ok(calls.anchors >= 1,
			`展开改变了高度 ⇒ **必须**重算滚动标记 ✓（实际 ${calls.anchors} 次 ✗ —— 不重算 ⇒ 滚动条缩略图/标记位置全部错位 ✗✓）`);

		// 归档区不可交互：动作条必须被摘掉 ✓
		const acts = body.querySelectorAll('.chat-msg-actions');
		assert.strictEqual(acts.length, 0, '归档气泡的动作条必须移除 ✗✓（编辑/回撤会与"已滚出视野"语义打架 ✓）');

		// ⚠ 必须用 `.click()` 而非 `dispatchEvent(new Event(…))` ✗✓：测试环境里全局 `Event` 是
		//   **Node 的**（jsdom 只装了 document ✓）⇒ jsdom 的 dispatchEvent 会直接抛
		//   "parameter 1 is not of type 'Event'"（本轮实测踩到 ✓）。`.click()` 由 jsdom 实现，
		//   派发真 MouseEvent 且**默认冒泡** ⇒ 恰好还能验证按钮的 stopPropagation ✓✓。
		head.click();
		assert.strictEqual(body.style.display, 'none', '再点必须收起 ✓');
		assert.strictEqual(calls.archived.length, 3, '收起不得重复建 DOM（也不得清掉已建的 ⇒ 再展开应复用 ✓）');
	});

	test('★★★ 折叠状态跨 rebuild 保留（组 id 稳定 ✓ 否则每次刷新都弹回收起 ✗）', () => {
		const { deps } = makeDeps();
		const first = createCompactionElement(groupMsg(), deps)!;
		(first.querySelector('.chat-compaction-head') as HTMLElement).click();
		// 模拟 rebuild（懒加载分块/裁剪后重建同一条消息 ✓）
		const again = createCompactionElement(groupMsg(), deps)!;
		assert.strictEqual((again.querySelector('.chat-compaction-body') as HTMLElement).style.display, 'block',
			'rebuild 后必须仍在**展开**态 ✓（状态按稳定组 id 记 ✓）');
	});

	test('★★★「恢复完整历史」只发 `/compact-reset` 命令 ✓ 且**不得**顺带折叠分组 ✗✓', () => {
		const { deps, calls } = makeDeps();
		const el = createCompactionElement(groupMsg(), deps)!;
		const body = el.querySelector('.chat-compaction-body') as HTMLElement;
		const undo = Array.from(el.querySelectorAll('.chat-compaction-btn'))
			.find(b => (b.textContent ?? '').includes('恢复完整历史')) as HTMLElement;
		assert.ok(undo, '必须有「恢复完整历史」按钮 ✓（移除模式下这才是用户理解的动作 ✓）');
		undo.click();
		assert.deepStrictEqual(calls.slash, [['compact-reset', '']],
			'必须复用既有 `/compact-reset` 语义 ✓（另造去边界逻辑会与常量漂移 ✗✓）');
		assert.strictEqual(body.style.display, 'none',
			'点按钮**不得**触发组头折叠 ✗✓（stopPropagation 缺失时这里会变成 block ✗）');
	});

	test('★★ 「展开摘要」按钮：就地切换全文 + 文案同步 ✓（摘要不再藏在 tooltip 里 ✓）', () => {
		const { deps } = makeDeps();
		const el = createCompactionElement(groupMsg(), deps)!;
		const full = el.querySelector('.chat-compaction-summary-full') as HTMLElement;
		const btn = Array.from(el.querySelectorAll('.chat-compaction-btn'))
			.find(b => (b.textContent ?? '').includes('展开摘要')) as HTMLElement;
		assert.strictEqual(full.style.display, 'none', '默认不展开全文 ✓');
		btn.click();
		assert.strictEqual(full.style.display, 'block', '点击后必须展开全文 ✓');
		assert.strictEqual(btn.textContent, '收起摘要', '按钮文案必须同步 ✓');
		assert.ok(full.textContent!.includes('已改：3 处调用点'), '全文必须包含摘要完整正文 ✓');
	});

	test('★★★ 不可信边界 ⇒ **绝不建分组**，只出警告行并说明"模型仍看得见全部历史" ✓✓', () => {
		const { deps } = makeDeps();
		const el = createCompactionElement(badBoundaryMsg(), deps)!;
		assert.ok(el, '无效边界也必须被接管（否则原始 `[上下文压缩]…` 文案会当普通气泡漏出来 ✗✓）');
		assert.strictEqual(el.querySelector('.chat-compaction-group'), null, '**不得**建分组 ✗✓（收纳就是在撒谎 ✓）');
		const notice = el.querySelector('.chat-compaction-notice.warn') as HTMLElement;
		assert.ok(notice, '必须是**警告态**提示行 ✓（否则用户以为已省 token ✗）');
		const text = notice.textContent ?? '';
		assert.ok(text.includes('未生效'), '必须明说"未生效" ✓');
		assert.ok(text.includes('模型仍能看到完整历史'), `必须说明模型视野未变（实际「${text}」✗✓）`);
		assert.ok(text.includes('重新压缩'), '无效边界下唯一有意义的动作 = 重试 ✓');
	});

	test('★ 有失效边界时，组头必须给出计数提示 ✓（多次压缩不重复渲染成多个组 ✓）', () => {
		const { deps } = makeDeps();
		const el = createCompactionElement(groupMsg({ staleBoundaryCount: 2 }), deps)!;
		const headText = (el.querySelector('.chat-compaction-head') as HTMLElement).textContent ?? '';
		assert.ok(headText.includes('2 处历史边界已失效'), `必须计数提示（实际「${headText}」✗）`);
		assert.strictEqual(el.querySelectorAll('.chat-compaction-group').length, 1, '只允许**一个**分组 ✗（不得嵌套 ✓）');
	});

	test('★ 非压缩消息 ⇒ 返回 undefined（调用方必须继续走常规气泡 ✗✓ 回归护栏）', () => {
		const { deps } = makeDeps();
		const plain = { id: 'x', role: 'user', content: 'hi', timestamp: 1 } as IAgentChatMessage;
		assert.strictEqual(createCompactionElement(plain, deps), undefined);
	});

	test('★ 摘要为空 / 单条时间 ⇒ 不出现空 chip 与重复时间范围 ✓', () => {
		const { deps } = makeDeps();
		const el = createCompactionElement(groupMsg({ summary: '', summaryChars: 0, tokensSaved: 0, fromTime: 1000, toTime: 1000 }), deps)!;
		const headText = (el.querySelector('.chat-compaction-head') as HTMLElement).textContent ?? '';
		assert.strictEqual(/摘要 0 字/.test(headText), false, '不得出现"摘要 0 字"噪音 chip ✗');
		assert.strictEqual(/省 0 tok/.test(headText), false, '不得出现"省 0 tok"噪音 chip ✗');
		// ⚠ 用**模式**断言而非硬编码钟点 ✗✓：1000ms 的本地钟点随时区变（本轮把 08:16 写成 10:00 ⇒ 假红 ✓）。
		const matches = headText.match(/\d\d:\d\d/g) ?? [];
		assert.strictEqual(matches.length, 1,
			`同一时刻只显示一个时间点 ✓（实际 ${JSON.stringify(matches)} ✗ —— 不得出现 "08:16 – 08:16" ✗）`);
		assert.ok((el.querySelector('.chat-compaction-foot') as HTMLElement).textContent!.includes('摘要为空'), '空摘要必须有兜底文案 ✓');
	});

	// ─── 移除模式（2026-09-22 追加要求：压缩后**从聊天框移除**被压缩内容 ✓✓）──────────

	test('★★★ 移除模式（默认）：**不建组体、不建任何归档 DOM** ✓✓ + 明说原文未丢失 ✓', () => {
		const { deps, calls } = makeDeps();
		const el = createCompactionElement(groupMsg({ archivedKept: false, archived: [] }), deps)!;
		assert.ok(el, '移除模式仍必须被接管（否则 `[上下文压缩]…` 原文会当普通气泡漏出来 ✗✓）');
		assert.strictEqual(el.querySelector('.chat-compaction-body'), null,
			'**不得**建组体 ✗✓（没有可展开的内容 ⇒ 建了就是白占 DOM ✓）');
		assert.strictEqual(calls.archived.length, 0,
			'**一个归档气泡都不许建** ✗✓（这是移除的性能落点 ✓）');
		const headText = (el.querySelector('.chat-compaction-head') as HTMLElement).textContent ?? '';
		assert.ok(headText.includes('已压缩的 3 条消息已从聊天框移除'), `组头必须写明已移除（实际「${headText}」✗）`);
		assert.ok(headText.includes('省 1,234 tok'), '指标 chip 仍必须保留 ✓（用户要知道省了多少 ✓）');
		const hint = (el.querySelector('.chat-compaction-removed-hint') as HTMLElement).textContent ?? '';
		assert.ok(hint.includes('未丢失') && hint.includes('恢复完整历史'),
			`必须给出可恢复的退路 ✓✓（否则用户以为内容丢了 ⇒ 不敢再压缩 ✗）（实际「${hint}」✗）`);
	});

	test('★★★ 移除模式组头**不可点**（无体可展 ✓），恢复按钮照常发 `/compact-reset` ✓', () => {
		const { deps, calls } = makeDeps();
		const el = createCompactionElement(groupMsg({ archivedKept: false, archived: [] }), deps)!;
		const head = el.querySelector('.chat-compaction-head') as HTMLElement;
		assert.strictEqual(head.getAttribute('role'), null, '移除模式组头不得是 button ✗✓（点了没反应会让人以为坏了 ✓）');
		assert.ok(head.classList.contains('removed'), '必须带 .removed 标记（CSS 去掉可点观感 ✓）');
		head.click();
		assert.strictEqual(calls.slash.length, 0, '点组头不得发任何命令 ✓');
		const restore = Array.from(el.querySelectorAll('.chat-compaction-btn'))
			.find(b => (b.textContent ?? '').includes('恢复完整历史')) as HTMLElement;
		restore.click();
		assert.deepStrictEqual(calls.slash, [['compact-reset', '']], '恢复必须复用既有命令 ✓');
	});

	test('★★ 数据与标志不一致（archivedKept=false 但仍有 archived）⇒ 仍落**移除模式** ✓', () => {
		const { deps, calls } = makeDeps();
		const el = createCompactionElement(groupMsg({ archivedKept: false }), deps)!;
		assert.strictEqual(el.querySelector('.chat-compaction-body'), null, '以标志为准走移除 ✓');
		assert.strictEqual(calls.archived.length, 0, '防御性：坏数据不得让移除模式失效 ✗✓');
	});
});
