/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「需要你操作」提示的**纯逻辑**（2026-09-12 用户需求）：
 *   聊天框的工作流卡片里，需要用户交互的卡（变量收集 / AskUser / ImagePicker / 节点配置
 *   表单）要**高亮边框**并**右下角弹出通知条**，否则长对话里用户会以为「工作流卡住不动」✗。
 *
 * 本文件只做「从消息列表里挑出待办」这一件事（无 DOM、无副作用）→ 可单测 ✓；
 * DOM/动画由 `agentChatPanel.workflowCards.ts` + `media/agentChat.css` 消费。
 *
 * ⚠ `selector` 必须与 `agentChat.css` 里的 `.pending` 选择器**逐字一致** ——
 *   点通知条「去选择」时用它 `querySelector` 定位第一张待交互卡 ✗。
 */

/** 一条待用户操作的交互项。 */
export interface IPendingInteraction {
	/** 去重/签名用（`kind:交互id`，交互 id 本身是 `${executionId}:${nodeId}`）。 */
	readonly id: string;
	/** 通知条描述行里的类型名（同类多项只列一次）。 */
	readonly label: string;
	/** 目标卡的选择器（点击「去选择」时滚动定位）。 */
	readonly selector: string;
}

/**
 * 从消息列表收集**全部待用户操作**的交互项（纯函数）。
 *
 * 覆盖四类「工作流暂停等用户」的卡 —— 它们的待办状态字段各不相同（历史原因），
 * 这里统一收敛，新增交互类型时**只改这里** ✓：
 *   · `collectVariables[].status === 'pending'`（变量收集）
 *   · `askUsers[].status === 'pending'`（提问）
 *   · `pickerSelects[].status === 'pending'`（选图）
 *   · `nodeInteractions[].status === 'pending'`（节点配置表单）
 *
 * ★ 注意各类型「已处理」的取值不同：AskUser/Picker 用 `answered`，NodeInteraction
 *   用 `submitted`，CollectVars 用 `submitted` —— 因此判定统一写成「等于 pending」，
 *   而不是枚举「已完成」✗（漏一种就会把已处理的卡当成待办、通知条永不消失 ✗✗）。
 */
export function collectPendingInteractions(
	messages: ReadonlyArray<{
		collectVariables?: Record<string, { id: string; status: string }>;
		askUsers?: ReadonlyArray<{ id: string; status: string }>;
		pickerSelects?: ReadonlyArray<{ id: string; status: string }>;
		nodeInteractions?: ReadonlyArray<{ id: string; status: string; title?: string }>;
	}>,
): IPendingInteraction[] {
	const pending: IPendingInteraction[] = [];
	for (const msg of messages) {
		for (const cv of Object.values(msg.collectVariables ?? {})) {
			if (cv.status === 'pending') {
				pending.push({ id: `cv:${cv.id}`, label: '填写工作流变量', selector: '.collect-vars-card.pending' });
			}
		}
		for (const a of (msg.askUsers ?? [])) {
			if (a.status === 'pending') {
				pending.push({ id: `ask:${a.id}`, label: '回答问题', selector: '.askuser-card.pending' });
			}
		}
		for (const p of (msg.pickerSelects ?? [])) {
			if (p.status === 'pending') {
				pending.push({ id: `pick:${p.id}`, label: '选择图像', selector: '.picker-card.pending' });
			}
		}
		for (const n of (msg.nodeInteractions ?? [])) {
			if (n.status === 'pending') {
				pending.push({ id: `ni:${n.id}`, label: `填写「${n.title ?? '节点'}」配置`, selector: '.ni-card.pending' });
			}
		}
	}
	return pending;
}

/** 待办集合签名（`id` 排序拼接）——集合变化时才重建通知条内容 ✓。 */
export function pendingInteractionsSignature(pending: ReadonlyArray<IPendingInteraction>): string {
	return pending.map(p => p.id).sort().join('|');
}

/** 通知条标题（项数）。 */
export function pendingNoticeTitle(count: number): string {
	return `工作流暂停，需要你操作（${count} 项）`;
}

/** 通知条描述行：去重后的类型清单（同类多项只列一次 ✓）。 */
export function pendingNoticeDesc(pending: ReadonlyArray<IPendingInteraction>): string {
	return [...new Set(pending.map(p => p.label))].join(' · ');
}
