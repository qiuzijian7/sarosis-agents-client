/*---------------------------------------------------------------------------------------------
 *  stageSlots — 输入槽位解析与**运行前校验**。
 *
 *  移植自 ComfyTV `src/composables/stages/assetSlots.ts`。
 *
 *  ComfyTV 在点运行**之前**就把「缺哪个输入」「pin 的资产和连线冲突」算清楚并显示
 *  警告；本项目此前只能点了运行等后端报错，用户拿到的是一句无上下文的失败信息。
 *
 *  全部为纯函数（无 DOM / 无 store 依赖），可单测。
 *--------------------------------------------------------------------------------------------*/

/** 自动增长槽位的命名规律（对齐 ComfyTV AUTOGROW_*_KEY_RE）。 */
export const AUTOGROW_IMAGE_RE = /^(?:images?\.)?image(\d+)$/i;
export const AUTOGROW_VIDEO_RE = /^(?:videos?\.)?video(\d+)$/i;
export const AUTOGROW_AUDIO_RE = /^(?:audio\.)?audio(\d+)$/i;

/** 最小端口形状。 */
export interface SlotLike {
	name: string;
	type?: string;
}

/**
 * 从槽位名解析出序号（`image0` → 0）。非自动增长槽返回 undefined。纯函数。
 */
export function slotIndex(name: string): number | undefined {
	for (const re of [AUTOGROW_IMAGE_RE, AUTOGROW_VIDEO_RE, AUTOGROW_AUDIO_RE]) {
		const m = re.exec(name);
		if (m) { return Number(m[1]); }
	}
	return undefined;
}

/** 该槽位是否为图像类（用于判断能否接收 pinned 图像资产）。纯函数。 */
export function isImageSlot(slot: SlotLike): boolean {
	const t = (slot.type ?? '').toUpperCase();
	if (t.includes('IMAGE')) { return true; }
	return AUTOGROW_IMAGE_RE.test(slot.name);
}

/** 槽位是否必填。约定：名字不含 `optional`、且不是 `_opt` 后缀。 */
export function isRequiredSlot(slot: SlotLike): boolean {
	const n = slot.name.toLowerCase();
	return !n.includes('optional') && !n.endsWith('_opt');
}

export type SlotWarningKind = 'duplicate' | 'override' | 'overflow' | 'noSlots';

export interface SlotWarning {
	kind: SlotWarningKind;
	message: string;
	/** 相关槽位名（overflow / noSlots 时为空）。 */
	slot?: string;
}

/**
 * 运行前校验：算出**缺失的必填槽位**。
 *
 * @param slots        节点声明的输入槽位
 * @param wiredSlots   已通过连线满足的槽位名
 * @param pinnedCount  额外 pin 的资产数量（可覆盖前 N 个空图像槽）
 *
 * 对齐 ComfyTV `missingRequiredImageSlots`。纯函数。
 */
export function missingRequiredSlots(
	slots: readonly SlotLike[],
	wiredSlots: readonly string[],
	pinnedCount = 0,
): string[] {
	const wired = new Set(wiredSlots);
	const missing: string[] = [];
	let pinBudget = pinnedCount;
	for (const s of slots) {
		if (!isRequiredSlot(s)) { continue; }
		if (wired.has(s.name)) { continue; }
		// pinned 资产按顺序补位到空的图像槽（ComfyTV refCovered 语义）。
		if (pinBudget > 0 && isImageSlot(s)) {
			pinBudget--;
			continue;
		}
		missing.push(s.name);
	}
	return missing;
}

/**
 * pinned 资产与连线的冲突警告（对齐 ComfyTV `refSlotWarnings` 的四类）。
 *
 * - `duplicate` : 同一槽位被 pin 了多次
 * - `override`  : pin 覆盖了已有的上游连线（用户可能没意识到连线被忽略）
 * - `overflow`  : pin 的数量超过可用槽位数，多余的会被丢弃
 * - `noSlots`   : 节点没有任何图像槽，pin 完全无效
 *
 * 纯函数。
 */
export function slotWarnings(
	slots: readonly SlotLike[],
	wiredSlots: readonly string[],
	pinnedSlots: readonly string[],
): SlotWarning[] {
	const out: SlotWarning[] = [];
	const imageSlots = slots.filter(isImageSlot);
	if (pinnedSlots.length > 0 && imageSlots.length === 0) {
		out.push({ kind: 'noSlots', message: '该节点没有图像输入槽，固定的资产不会被使用' });
		return out;
	}
	const seen = new Set<string>();
	const wired = new Set(wiredSlots);
	for (const p of pinnedSlots) {
		if (seen.has(p)) {
			out.push({ kind: 'duplicate', slot: p, message: `槽位 ${p} 被重复固定，只有第一个生效` });
			continue;
		}
		seen.add(p);
		if (wired.has(p)) {
			out.push({ kind: 'override', slot: p, message: `槽位 ${p} 已有上游连线，固定的资产会覆盖它` });
		}
	}
	if (pinnedSlots.length > imageSlots.length) {
		const extra = pinnedSlots.length - imageSlots.length;
		out.push({ kind: 'overflow', message: `固定了 ${pinnedSlots.length} 个资产但只有 ${imageSlots.length} 个图像槽，多余 ${extra} 个会被忽略` });
	}
	return out;
}

/**
 * 汇总成一句可直接显示的运行前提示。无问题返回 undefined。
 * 缺失必填槽位优先于警告（前者阻断运行，后者只是提醒）。纯函数。
 */
export function preRunHint(
	slots: readonly SlotLike[],
	wiredSlots: readonly string[],
	pinnedSlots: readonly string[] = [],
	requiredSlots?: readonly string[],
): string | undefined {
	// ★ ComfyTV 的「必填」**不是**从端口列表推断的。
	//   `missingRequiredImageSlots(requiredSlots, wired, refCovered)` 里的
	//   `requiredSlots` 来自 **workflow config 的 exposed_widgets 绑定**
	//   （`imageSlotsFromConfig` 解析 `upstream_image:*[N]`）——即"当前选中的
	//   工作流真的把某个上游图槽接进了采样器"才算必填。
	//   纯文生图工作流（Local SD1.5）没有任何 upstream_image 绑定 →
	//   `requiredSlots` 为空 → **不报缺少输入**，这正是参考卡片上
	//   `text0` / `image0` 悬空却没有黄色警告的原因。
	//   本项目拿不到 workflow config，只能由调用方显式告知：
	//   - 传入 `requiredSlots`（可为空数组）→ 按 ComfyTV 语义精确判定；
	//   - 不传 → 退化到旧的 `isRequiredSlot` 名称启发式（保留给既有调用点/测试）。
	const missing = requiredSlots
		? requiredSlots.filter(name => !wiredSlots.includes(name))
		: missingRequiredSlots(slots, wiredSlots, pinnedSlots.length);
	if (missing.length > 0) {
		return `缺少输入：${missing.join('、')}`;
	}
	const warns = slotWarnings(slots, wiredSlots, pinnedSlots);
	return warns.length > 0 ? warns[0].message : undefined;
}
