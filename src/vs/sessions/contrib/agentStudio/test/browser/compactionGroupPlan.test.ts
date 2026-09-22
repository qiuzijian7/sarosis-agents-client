/*---------------------------------------------------------------------------------------------
 *  compactionGroupPlan.test.ts — 压缩收纳计划（方案 C）+ 接线断言
 *
 *  钉住的回归（2026-09-22 用户选定方案 C「收纳手风琴」）：
 *   · `/compact` 后历史**毫无变化**（边界被整条丢弃 ✗）⇒ 用户无法知道"模型从哪条起看不见"；
 *   · **不可信边界绝不能收纳** ✗✓ —— 那种边界本就被 sliceAtCompactionBoundary 过滤掉，
 *     模型仍看得见全部历史；UI 若折叠起来就是在撒谎（真机「153 条 → 129 token」事故 ✓）；
 *   · 多次压缩只认**最后一条可信**边界 ✓，更早的只计数、绝不重复渲染成多个组 ✗。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/compactionGroupPlan.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	planCompactionGroup,
	isCompactionBoundaryMessage,
	isValidBoundaryMessage,
} from '../../common/compactionGroupPlan.js';
import { extractCompactionSummary } from '../../common/historyCompaction.js';
// ⚠ 相对路径层级：本文件在 contrib/agentStudio/test/browser/ ⇒ 回到 sessions 需 **4** 级 ✓
import { coalesceCompactionGroups } from '../../../../browser/agentChat/agentChatTypes.js';

// ─── 假件（判据照抄真件 ✗✓：内容格式必须含真件的固定分隔标记 `已压缩为以下摘要：` ✓）──
const SEP = '已压缩为以下摘要：';
const SUMMARY_BODY = '· 目标：把 orders 删除改为软删除（保留审计）\n· 已改：orders.repo.ts 与 3 处调用点';

/** 一条普通消息 ✓ */
const m = (id: string, ts = 1000, content = `msg-${id}`) => ({ id, content, timestamp: ts });

/**
 * 一条压缩边界 ✓（可信 = tokensSaved > 0 且摘要字符量不被判饥饿 ✓）。
 * `summaryChars` 显式给出 ⇒ 与真件一致（插入侧记录的精确值 ✓ 优先于现场计算 ✓）。
 */
const boundary = (id: string, opts: {
	tokensSaved?: number;
	summaryChars?: number;
	originalCount?: number;
	body?: string;
} = {}) => ({
	id,
	timestamp: 5000,
	content: `[上下文压缩] 此前的对话历史（${opts.originalCount ?? 30} 条消息）已压缩为以下摘要：${opts.body ?? SUMMARY_BODY}`,
	metadata: {
		type: 'compaction',
		tokensSaved: opts.tokensSaved ?? 1234,
		summaryChars: opts.summaryChars ?? 900,
		originalCount: opts.originalCount ?? 30,
		compressedCount: 1,
	},
});

/** 一条"饥饿"边界（真机事故形态：153 条消息只换回 129 token ✓） */
const starvedBoundary = (id: string) => ({
	id,
	timestamp: 5000,
	content: `[上下文压缩] 此前的对话历史（153 条消息）已压缩为以下摘要：无`,
	metadata: { type: 'compaction', tokensSaved: 24836, summaryChars: 0, originalCount: 153, compressedCount: 1 },
});

suite('压缩收纳计划（方案 C 手风琴）', () => {

	test('★★★ 无可信边界 ⇒ **绝不收纳**（视图原样 ✓ 这是"不撒谎"的底线 ✓）', () => {
		const none = planCompactionGroup([m('a'), m('b')]);
		assert.strictEqual(none.hasGroup, false);
		assert.strictEqual(none.validBoundaryIndex, -1);

		// 完全没有边界 ⇒ 不改变数组（连引用都不必换 ✓）
		const arr: any[] = [m('a'), m('b')];
		assert.deepStrictEqual(coalesceCompactionGroups(arr), arr);

		// 空 / undefined 安全 ✓
		assert.strictEqual(planCompactionGroup(undefined).hasGroup, false);
		assert.strictEqual(planCompactionGroup([]).hasGroup, false);
	});

	test('★★★ 可信边界（下标 3 / 共 10 条）⇒ 收纳前 3 条 + 边界，尾部 6 条原样 ✓', () => {
		const list = [
			m('u1'), m('a1'), m('u2'),
			boundary('bd1'),
			m('a2'), m('u3'), m('a3'), m('u4'), m('a4'), m('u5'),
		];
		const plan = planCompactionGroup(list);
		assert.strictEqual(plan.hasGroup, true);
		assert.strictEqual(plan.validBoundaryIndex, 3);
		assert.strictEqual(plan.archiveEnd, 4, '收纳区间含边界自身 ✓');
		assert.strictEqual(plan.invalidBoundary, false);
		assert.ok(plan.group);
		assert.strictEqual(plan.group!.count, 3, '「已压缩 N 条」**不含**边界消息 ✓（边界由组自身代表 ✓）');
		// ★ 2026-09-22 追加要求「压缩后从聊天框移除被压缩内容」⇒ **默认移除模式** ✓✓：
		//   原文不留在内存（`archived` 空 ✓）⇒ 这 3 条消息对象、其 `parts` 派生与 markdown 资源
		//   立即可回收 ✓；`removedCount` 记录实际移除几条（含区间内已失效的历史边界 ✓）✓。
		assert.strictEqual(plan.group!.archivedKept, false, '默认必须是**移除模式** ✓（性能优先 ✓）');
		assert.strictEqual(plan.group!.archived.length, 0, '移除模式 ⇒ **不得持有原文** ✗✓');
		assert.strictEqual(plan.group!.removedCount, 4, '移除了区间内全部 4 条（3 普通 + 1 边界 ✓）');
		// 保留模式（调试/对照 ✓）必须仍能拿到原文 ⇒ **两条路都有单测** ✓
		const kept = planCompactionGroup(list, { keepArchived: true });
		assert.strictEqual(kept.group!.archivedKept, true);
		assert.strictEqual(kept.group!.archived.length, 3, '保留模式：归档 = 边界的 3 条 ✓（边界本身不进组体 ✓）');
		assert.strictEqual(plan.group!.summary.startsWith('· 目标：把 orders 删除改为软删除'), true,
			'摘要必须剥离固定前缀（extractCompactionSummary 唯一真源 ✓）');
		assert.strictEqual(plan.group!.tokensSaved, 1234);
		assert.strictEqual(plan.group!.summaryChars, 900);
		assert.strictEqual(plan.group!.staleBoundaryCount, 0);
	});

	test('★★ 合成分组消息：role=system / content=摘要 / id **稳定**（折叠状态可跨 rebuild 保留 ✓）', () => {
		const list = [m('u1'), m('a1'), boundary('bd1'), m('a2')];
		const out = coalesceCompactionGroups(list);
		assert.strictEqual(out.length, 2, '前 3 条 → 1 条合成分组 + 尾部 1 条 ✓');
		assert.strictEqual(out[0].role, 'system');
		assert.strictEqual(out[0].compactionGroup !== undefined, true);
		assert.strictEqual(out[0].content, planCompactionGroup(list).group!.summary);
		assert.strictEqual(out[0].id, coalesceCompactionGroups(list)[0].id, 'id 必须稳定 ✓（否则每次 rebuild 都折叠回去 ✗）');
		assert.strictEqual(out[1].id, 'a2', '尾部顺序不变 ✓');
	});

	test('★★★ 不可信边界 ⇒ **不收纳** + 标警告（模型其实仍看得见全部历史 ✓）', () => {
		// ① 摘要饥饿（真机事故形态：153 条 → 129 token ✓）
		const starved = [m('u1'), m('a1'), m('u2'), starvedBoundary('bd-starved')];
		const p1 = planCompactionGroup(starved);
		assert.strictEqual(p1.validBoundaryIndex, -1, '饥饿摘要必须判不可信（判据真源 = historyCompaction ✓）');
		assert.strictEqual(p1.hasGroup, false, '**不得**收纳 ✗✓ —— 否则就是谎称"历史已被摘要承载"');
		assert.strictEqual(p1.invalidBoundary, true, '必须标记为无效边界 ⇒ 视图渲染警告提示行 ✓');
		assert.deepStrictEqual(coalesceCompactionGroups(starved as any), starved, '数组原样 ✓（边界仍留着 ⇒ 渲染成提示行 ✓）');

		// ② tokensSaved <= 0（真机 sess_ms5kriv8_0j6atj 的 -73 ✓）
		const negative = [m('u1'), m('a1'), boundary('bd-neg', { tokensSaved: -73 })];
		const p2 = planCompactionGroup(negative);
		assert.strictEqual(p2.hasGroup, false, 'tokensSaved<=0 ⇒ 不收纳 ✓（没省 token 却销毁上下文 ✗）');
		assert.strictEqual(p2.invalidBoundary, true);
	});

	test('★★★ 多次压缩：只认**最后一条可信**边界，更早的只计数、绝不嵌套 ✓', () => {
		const list = [
			m('u1'), m('a1'),
			boundary('bd-old'),      // 更早的边界（已被最新摘要覆盖 ✓）
			m('u2'), m('a2'),
			boundary('bd-new'),
			m('a3'),
		];
		const plan = planCompactionGroup(list, { keepArchived: true });   // 本用例要看归档内容 ⇒ 保留模式 ✓
		assert.strictEqual(plan.hasGroup, true);
		assert.strictEqual(plan.archiveEnd, 6, '收纳到**最新**边界（含 ✓）');
		assert.strictEqual(plan.group!.staleBoundaryCount, 1, '更早的边界只计数 ✓');
		assert.strictEqual(plan.group!.count, 4, '普通消息 4 条（u1/a1/u2/a2 ✓ 两个边界都不计 ✓）');

		// ⚠ 关键：归档区间里那条更早的边界必须**降级**（剥掉边界标记 ✓）⇒ 展开后不会嵌套出第二个组 ✗✓
		const archivedBoundary = plan.group!.archived.filter(isCompactionBoundaryMessage);
		assert.strictEqual(archivedBoundary.length, 0, '归档内不得残留任何边界标记 ✓（它已 downgrade 为普通消息 ✓）');
		assert.strictEqual(plan.group!.archived.some(x => x.id === 'bd-old'), true, '但它仍留在组体里可被看到 ✓（历史痕迹不丢 ✓）');
	});

	test('★★ 混合态：尾部无效 + 更早可信 ⇒ **仍收纳**且标无效（视图两处都表达 ✓）', () => {
		const list = [m('u1'), m('a1'), boundary('bd-ok'), m('a2'), starvedBoundary('bd-bad')];
		const plan = planCompactionGroup(list);
		assert.strictEqual(plan.hasGroup, true, '可信边界照常收纳 ✓');
		assert.strictEqual(plan.archiveEnd, 3);
		assert.strictEqual(plan.invalidBoundary, true, '同时标出"尾部那条边界无效" ✓（它在尾部 ⇒ 渲染为警告行 ✓）');
		assert.strictEqual(plan.group!.count, 2);
	});

	test('★ 边界位于首位 ⇒ 不建空组（无可收纳内容 ✓）', () => {
		const plan = planCompactionGroup([boundary('bd0'), m('a1'), m('u2')]);
		assert.strictEqual(plan.hasGroup, false, '空组只会白占位置 ✓');
		assert.strictEqual(plan.validBoundaryIndex, 0);
		assert.strictEqual(plan.invalidBoundary, false, '边界本身是可信的（不是无效 ✓）');
	});

	test('★ summaryChars 缺失 ⇒ 现场剥离计算（与有效性判据同源 ✓）', () => {
		// ⚠ 摘要必须**足够长**才可信 ✗✓：删掉 `summaryChars` 后判据退化为"现场计算字符量"，
		//   正文若太短会被判饥饿 ⇒ **不收纳** ⇒ 根本拿不到 group（本轮首条假红的成因 ✓）。
		const longBody = `${SUMMARY_BODY}\n${'z'.repeat(320)}`;
		const b = boundary('bd-x', { body: longBody });
		delete (b.metadata as any).summaryChars;
		const plan = planCompactionGroup([m('u1'), m('a1'), b]);
		assert.ok(plan.hasGroup, '正文足够长 ⇒ 删掉 summaryChars 仍应判可信 ✓');
		assert.strictEqual(plan.group!.summaryChars, extractCompactionSummary(b.content).length);
		assert.ok(plan.group!.summaryChars >= 300, '现场计算值必须达到饥饿门槛 ✓');
	});

	test('★ 时间范围：取归档区间的最早/最晚（缺失时间戳 ⇒ 不显示 ✓）', () => {
		const list = [m('u1', 300), m('a1', 100), boundary('bd1'), m('a2', 900)];
		const plan = planCompactionGroup(list);
		assert.strictEqual(plan.group!.fromTime, 100);
		assert.strictEqual(plan.group!.toTime, 300, 'to = 归档内最大时间戳（不含边界自身 ✗ —— 边界不进组体 ✓）');
	});

	test('★★★ 真机量级：移除后**输出数组不再引用任何原文** ✓✓（这就是 UI 性能的落点 ✓）', () => {
		// 场景：200 条历史的会话，压缩点在第 150 条之后 → 应只剩「1 条分组 + 50 条尾部」
		const list: any[] = [];
		for (let i = 0; i < 150; i++) { list.push(m(`m${i}`, 1000 + i)); }
		// ⚠ 摘要必须过饥饿门槛 ✗✓：门槛 = max(300, min(150×8, 1200)) = **1200** ⇒ 900 会被判
		//   "摘要饥饿" ⇒ 边界不可信 ⇒ 不收纳 ⇒ 本用例首跑拿到 201 条（实测踩到 ✓ —— 又一次
		//   "假件必须照抄真件" ✓）。
		list.push(boundary('bd-big', { originalCount: 150, summaryChars: 1500 }));
		for (let i = 150; i < 200; i++) { list.push(m(`m${i}`, 1000 + i)); }

		const out = coalesceCompactionGroups(list);
		assert.strictEqual(out.length, 51, `1 条分组 + 50 条尾部（实际 ${out.length} ✗）`);
		assert.strictEqual(out[0].compactionGroup!.count, 150, '被移除/压缩的是 150 条 ✓');
		assert.strictEqual(out[0].compactionGroup!.archived.length, 0, '**不得**持有这 150 条 ✗✓');
		// 关键：输出里不得再出现任何被移除消息的 id（⇒ 面板 `_messages` 与内存里都没有它们 ✓）
		const retained = new Set(out.map(x => x.id));
		const leaked = list.slice(0, 150).filter(x => retained.has(x.id));
		assert.deepStrictEqual(leaked, [], '被移除的消息**一个都不能**留在输出里 ✗✓（否则内存没省 ✓）');
	});
});

// ─── 接线断言（防"实现被搬走/挪序"导致的静默失效 ✗✓）────────────────────────
suite('压缩收纳 —— 接线断言', () => {
	const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
	const TYPES = 'src/vs/sessions/browser/agentChat/agentChatTypes.ts';
	const MSGS = 'src/vs/sessions/browser/agentChat/agentChatPanel.messages.ts';
	const PANE = 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts';
	const CSS = 'src/vs/sessions/browser/agentChat/media/agentChat.css';

	test('★★ 适配层：边界过滤仍是**默认**行为（其它宿主不受影响 ✓）+ opt-in 保留 ✓', () => {
		const s = read(TYPES);
		assert.ok(s.includes('if (!opts?.keepCompactionBoundary) { return null; }'),
			'默认必须仍返回 null ⇒ 未 opt-in 的调用方行为逐字不变 ✓');
		assert.ok(s.includes('export function coalesceCompactionGroups('), '收纳函数必须存在 ✓');
	});

	test('★★★ 宿主：opt-in 传参 ✓ + 收纳在 **_backfillPlanPhase 之后**（阶段卡推导看全量 ✓）', () => {
		const s = read(PANE);
		assert.ok(s.includes('keepCompactionBoundary: true'), '宿主必须 opt-in ✓（否则方案 C 完全不生效 ✗）');
		const iBackfill = s.indexOf('this._backfillPlanPhase(adapted);', s.indexOf('private _adaptHistoryMessages'));
		const iCoalesce = s.indexOf('return coalesceCompactionGroups(adapted);', s.indexOf('private _adaptHistoryMessages'));
		assert.ok(iBackfill > 0 && iCoalesce > 0, '两者都必须存在于 _adaptHistoryMessages ✓');
		assert.ok(iBackfill < iCoalesce,
			'顺序必须是"先全量回填、后收纳" ✓✓ —— 反了会让归档区间里的 plan_enter/exit 配不上对 ⇒ 阶段卡丢失 ✗');
	});

	test('★★★ 渲染层：分组必须**接管**整条消息元素（且在常规气泡分支之前 ✓）', () => {
		const s = read(MSGS);
		const iBreaker = s.indexOf('if (compactionEl) { return compactionEl; }');
		assert.ok(iBreaker > 0, '必须存在接管分支 ✓');
		const iUser = s.indexOf('const isUser = msg.role === "user";', iBreaker - 2000);
		assert.ok(iBreaker < iUser,
			'接管必须在 `const isUser` **之前** ✓ —— 挪到后面就等于分组不再接管（静默失效 ✗✓）');
		assert.ok(s.includes("import { createCompactionElement } from './compactionGroupView.js';"),
			'渲染模块必须被 import ✓');
	});

	test('★ 样式：分组与"不可信"警告态都必须有规则 ✓', () => {
		const css = read(CSS);
		assert.ok(css.includes('.chat-compaction-group'), '分组样式 ✓');
		assert.ok(css.includes('.chat-compaction-notice.warn'), '不可信边界的警告态样式 ✓（没有它用户会误以为已压缩 ✓）');
		assert.ok(css.includes('.chat-compaction-head:focus-visible'), '整行可点 ⇒ 键盘焦点环 ✓');
	});

	test('★ 判据唯一真源：本模块**不得**自己复刻饥饿/省 token 规则 ✗✓', () => {
		const s = fs.readFileSync(path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/common/compactionGroupPlan.ts'), 'utf8');
		assert.ok(s.includes('findLastValidCompactionBoundaryIndex(asBoundaryArray(list))'), '必须委托 historyCompaction ✓');
		assert.strictEqual(s.includes('MIN_COMPACTED_SUMMARY_CHARS'), false,
			'不得引用饥饿门槛常量 ✗（复刻口径 ⇒ 两处漂移 ⇒ 一边收纳一边不切片 ✗✓）');
		assert.strictEqual(/isValidBoundaryMessage/.test(s) && /isValidCompactionBoundary\(/.test(s), true,
			'有效性只经 historyCompaction 的判据 ✓');
	});

	test('★ 有效性辅助函数与真源同判 ✓', () => {
		assert.strictEqual(isValidBoundaryMessage(boundary('x')), true);
		assert.strictEqual(isValidBoundaryMessage(starvedBoundary('x')), false);
		assert.strictEqual(isValidBoundaryMessage(m('plain')), false);
	});
});
