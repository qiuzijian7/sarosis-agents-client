/*---------------------------------------------------------------------------------------------
 *  agentChatPanel.keyedParts.ts — Keyed Reconciliation 纯函数模块。
 *
 *  从 agentChatPanel.messages.ts 提取的 key 分配逻辑，独立可测试。
 *  每个 part 元素携带 data-part-key 属性，key 在同一 msg 生命周期内稳定：
 *    thinking → `thinking:${msgId}#tk${index}`
 *    text     → `text:${msgId}#t${index}`
 *    tool     → `tool:${toolCall.id}`
 *
 *  ⚠⚠ **不要给 `{ kind: 'subagent' }` 分配 key**（2026-08-22 更正本文件旧注释：
 *  它曾声称 `subagent → subagent:${subAgent.id}`，与实现不符，并使 3 个单测长期失败）。
 *  子代理独立 part 是**已移除的路径 B** —— 见 `agentChatTypes.ts` 的说明：子代理卡片
 *  只通过 `tool.subAgents`（卡内聚合）与 `msg.subAgents`（气泡内独立详情卡）承载，
 *  旧持久化数据里的 subagent part 由 `adaptPersistedChatMessage` 迁移掉。
 *
 *  为什么这是**陷阱**：`_createPartElement` / `_renderPartsContent` 都不为 subagent
 *  创建元素。若照旧注释「补实现」把 subagent 纳入本函数，`expected` 会 +1 而 DOM 里
 *  没有对应元素 → `_finalizeTurnPartsInPlace` 的一致性校验变成 `actual < expected`
 *  → 每次 finalize 回退整条消息全量重建 = 用户可见的闪烁（与 2026-08-22 日志
 *  1787373914386 里 `actual > expected` 同一类故障，只是方向相反）。
 *  **buildKeyedParts 的收录范围必须与 _createPartElement 的创建范围严格一致。**
 *--------------------------------------------------------------------------------------------*/
import type { IMessagePart } from './agentChatTypes.js';

/** keyed part 描述：key + part 引用 + 原始索引。 */
export interface IKeyedPart {
	key: string;
	part: IMessagePart;
	index: number;
}

/**
 * 构建有序 keyed part 列表——从 msg.parts 提取所有需要渲染的 part，
 * 跳过空 text，为每个 part 分配稳定 key。
 *
 * @param parts 消息的有序 part 列表
 * @param msgId 消息 ID（用于生成稳定 key）
 * @returns 有序 keyed part 列表（仅包含需要渲染的 part）
 */
export function buildKeyedParts(parts: readonly IMessagePart[], msgId: string): IKeyedPart[] {
	const result: IKeyedPart[] = [];

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		let key: string | null = null;

		if (part.kind === 'thinking') {
			key = `thinking:${msgId}#tk${i}`;
		} else if (part.kind === 'text') {
			if (part.text.trim().length === 0) { continue; }
			key = `text:${msgId}#t${i}`;
		} else if (part.kind === 'tool') {
			const tool = (part as any).tool;
			key = `tool:${tool?.id ?? `auto-${i}`}`;
		}

		if (key) { result.push({ key, part, index: i }); }
	}
	return result;
}

/**
 * 计算最后一个非空 text part 的 key（用于 streaming-container 标记）。
 * 无 text part 时返回 null。
 */
export function lastTextPartKey(parts: readonly IMessagePart[], msgId: string): string | null {
	let lastKey: string | null = null;
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p.kind === 'text' && p.text.trim().length > 0) {
			lastKey = `text:${msgId}#t${i}`;
		}
	}
	return lastKey;
}

/** part key 属性名 —— 单一常量，避免各处硬编码字符串。 */
export const PART_KEY_ATTR = 'data-part-key';

/**
 * 枚举 bubble 内的 part 元素 —— **唯一真源**，与 `buildKeyedParts` 配对使用。
 *
 * ## 为什么必须只取直接子元素（`:scope >`）
 * 事故（2026-08-22，日志 1787373914386，用户报「聊天框 UI 闪烁」）：
 * `_finalizeTurnPartsInPlace` 的一致性校验对比
 *     expected = buildKeyedParts(msg).length      ← 按 msg.parts 算
 *     actual   = bubble.querySelectorAll('[data-part-key]').length
 * 后者是**后代查询**，而 `webCard` / `extractCard` 曾在卡片**内部** header 上
 * 也设了同名属性（且 key 与外层 wrapper 完全相同）。于是：
 *   · `actual` 恒大于 `expected`（实测 66/64、73/66、69/67）
 *     → 校验必然失败 → **每次 finalize 都回退整条消息（102 parts）全量重建**
 *     → 这就是可见的闪烁（该 turn 打了 53 次 FullRefresh SUMMARY）；
 *   · 更隐蔽的是 `_reconcileParts` 的 `existingMap`：同 key 时**后遍历到的内层
 *     header 会覆盖外层 wrapper**，导致 diff 拿到 header 去就地更新，而 wrapper
 *     既不在 map 里、也不会被「删除残留」清掉 → 元素持续堆积。
 *
 * part 元素一律是 bubble 的**直接子元素**（`_reconcileParts` 用 `prevEl.after()` /
 * `bubble.insertBefore()` 插入，`_renderPartsContent` 用 `bubble.appendChild()`），
 * 因此 `:scope >` 既正确又能天然屏蔽任何卡片内部的同名属性 —— **不依赖「卡片内部
 * 永远不会出现 data-part-key」这一假设**（该假设已被违反过一次）。
 *
 * ⚠ 三个调用点（existingMap 收集 / 一致性校验计数 / slowpath 诊断）**必须全部**
 * 走本函数，否则「渲染判据」与「校验判据」再次漂移。
 */
export function queryPartElements(bubble: Element): HTMLElement[] {
	return filterPartElements(bubble.children) as HTMLElement[];
}

/**
 * `queryPartElements` 的纯逻辑内核 —— 从**直接子元素**里挑出带 part key 的。
 *
 * 单独导出的原因：单测环境没有 `document`（run-browser-test 是 node 环境、无 jsdom），
 * 抽出后可用轻量 stub 验证**真实的遍历与过滤逻辑**，而不是去测一个 mock。
 *
 * 用 `children` 遍历而非 `querySelectorAll(':scope > [...]')`：语义更直白、无需选择器
 * 引擎、且天然只看一层 —— 「只取直接子元素」这个关键约束在代码里一眼可见。
 */
export function filterPartElements<T extends { getAttribute(name: string): string | null }>(
	children: ArrayLike<T>,
): T[] {
	const out: T[] = [];
	for (let i = 0; i < children.length; i++) {
		const el = children[i];
		if (el && el.getAttribute(PART_KEY_ATTR) !== null) { out.push(el); }
	}
	return out;
}

