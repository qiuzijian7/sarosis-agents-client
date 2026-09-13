/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 节点显示名解析（2026-09-10 用户要求「阶段名称要显示为工作流中的节点的名字」）
 * —— **无依赖纯函数**，可单测。
 *
 * 背景：画布上 ComfyTV stage 节点的标题栏文字是**自动生成的机器名**
 * （`ComfyTV.StatEmojiStage-1788782920357-1`，保存为 node.name / data.label），
 * 而用户在画布 nodeCard 上看到的是 `spec.title`（如「Emoji Stage」「ImagePicker」）。
 * 卡片若直接回退 node.name → 显示机器名，与画布所见不符。
 *
 * 解析顺序：
 *   1. 候选链（data.label / data.title / node.title / node.name）中**第一个非机器名**的
 *      —— 用户手动改名（如「表情包」）在此命中；
 *   2. 候选全是机器名 → 用 stage 标题表（画布 nodeCard 的 spec.title）——与画布一致；
 *   3. 再兜底 fallback（node.name / node.id）。
 */

/**
 * 画布自动生成的机器名形态：`<前缀><类型>-<13 位时间戳>-<序号>[--dupN]`
 * （分隔符可能是 `-` 或 `_`，如 `ComfyTV.ImagePickerStage_1788248643751-2`）。
 * 「Ask User」「表情包」「Start」等人类可读名不会命中。
 */
export const MACHINE_NODE_NAME_RE = /^[A-Za-z][\w.]*[-_]\d{9,}(?:-\d+)?(?:--\w+)?$/;

/** 该字符串是否像画布自动生成的机器名（非用户命名）。 */
export function isMachineNodeName(value: unknown): boolean {
	return typeof value === 'string' && MACHINE_NODE_NAME_RE.test(value.trim());
}

/**
 * 机器名 → 尽量可读的短名（最后兜底，2026-09-11）：
 *   `ComfyTV.StatEmojiStage-1788782920357-1` → `StatEmojiStage`
 *   `Saros.AnimatedEmoji-1788866814122-1`    → `AnimatedEmoji`
 *
 * 用于标题表也查不到的类型（如 Emoji 家族是**内置工作流节点**，不在
 * COMFYTV_STAGE_META 里）——至少去掉时间戳与命名空间前缀，比整串机器名可读。
 */
export function humanizeMachineName(value: string): string {
	return value
		.replace(/[-_]\d{9,}(?:-\d+)?(?:--\w+)?$/, '')
		.replace(/^(?:ComfyTV\.|Comfy\.|Saros\.)/i, '');
}

export interface IResolveNodeDisplayNameInput {
	/** 命名候选（优先级从高到低）：data.label / data.title / node.title / node.name … */
	candidates: readonly unknown[];
	/** 原始全名（`data.stageClass` 或归一前的 type），用于查标题表。 */
	rawType?: string;
	/** 归一后 type（查不到全名时再试）。 */
	normalizedType?: string;
	/** stage 全名 → 画布可读标题（`spec.title`）。 */
	titleByType?: ReadonlyMap<string, string>;
	/** 最终兜底（通常是 node.id）。 */
	fallback: string;
}

/** 解析节点显示名（详见文件头注释）。 */
export function resolveNodeDisplayName(input: IResolveNodeDisplayNameInput): string {
	const { candidates, rawType, normalizedType, titleByType, fallback } = input;

	// 1) 用户命名优先（机器名跳过）
	for (const c of candidates) {
		if (typeof c === 'string' && c.trim() && !isMachineNodeName(c)) {
			return c.trim();
		}
	}

	// 2) 画布 nodeCard 显示的可读标题（与画布所见一致）
	if (titleByType) {
		for (const t of [rawType, normalizedType]) {
			if (!t) { continue; }
			const title = titleByType.get(t);
			if (title) { return title; }
		}
	}

	// 3) 兜底：机器名也做 humanize（去时间戳后缀 + 命名空间前缀）——Emoji 家族等
	//    内置工作流节点不在 COMFYTV_STAGE_META 里，这一步保证至少显示
	//    `StatEmojiStage` 而非 `ComfyTV.StatEmojiStage-1788782920357-1`。
	return isMachineNodeName(fallback) ? humanizeMachineName(fallback) : fallback;
}
