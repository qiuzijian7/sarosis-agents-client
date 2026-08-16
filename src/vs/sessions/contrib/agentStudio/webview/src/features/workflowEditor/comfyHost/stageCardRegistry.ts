/*---------------------------------------------------------------------------------------------
 *  stageCardRegistry — ComfyTV stage 卡片的**声明式注册表**。
 *
 *  移植自 ComfyTV `src/composables/stages/stageRegistry.ts`。ComfyTV 用四张表
 *  （RICH_STAGE_CARDS / STAGE_CARD_PROPS / RICH_STAGE_MIN_HEIGHTS /
 *  FLEX_FILL_STAGES）把「哪个节点用哪个卡片、多高、隐藏哪些区块」全部数据化，
 *  于是 `mountStage()` 只有一行分派：
 *      const Card = RICH_STAGE_CARDS[node.comfyClass] ?? StageCard
 *
 *  本项目此前把这些信息硬编码成 nodeCard.tsx 里 26 个
 *  `const isXxx = meta.nodeType === 'ComfyTV.XxxStage'` 加深层 `&&` 条件链，
 *  新增一个 stage 需要改 5 处以上。本模块把可数据化的部分先抽出来：
 *
 *   - `STAGE_EDITOR_KIND`   : 节点类 → 内嵌编辑器种类（替代 isXxx 布尔群）
 *   - `STAGE_HIDDEN_FIELDS` : 节点类 → 由内嵌编辑器接管、不再渲染通用控件的字段
 *                             （替代 8 个散落的 XXX_HIDDEN_FIELDS Set）
 *   - `STAGE_MIN_HEIGHTS`   : 节点类 → 卡片最小高度（对齐 RICH_STAGE_MIN_HEIGHTS）
 *   - `STAGE_CARD_FLAGS`    : 节点类 → 区块隐藏开关（对齐 STAGE_CARD_PROPS）
 *
 *  全部为纯数据 + 纯函数，可单测，且**新增 stage 只改本文件**。
 *--------------------------------------------------------------------------------------------*/

/** 内嵌编辑器种类。'none' = 只用通用控件渲染。 */
export type StageEditorKind =
	| 'none'
	| 'mask'        // Erase / Inpaint —— MaskPainter
	| 'crop'        // CropStage —— CropEditor
	| 'transform'   // Rotate / Mirror —— TransformEditor
	| 'outpaint'
	| 'gridSplit'
	| 'colorGrade'
	| 'kenBurns'
	| 'multiangle'
	| 'panorama'
	| 'relight'
	| 'material';

/**
 * 节点类 → 内嵌编辑器种类。ComfyTV 的 RICH_STAGE_CARDS 等价物（本项目暂不做
 * 组件级拆分，先把「哪个节点有哪个编辑器」这层数据化）。
 */
export const STAGE_EDITOR_KIND: Record<string, StageEditorKind> = {
	'ComfyTV.CropStage': 'crop',
	'ComfyTV.RotateStage': 'transform',
	'ComfyTV.MirrorStage': 'transform',
	'ComfyTV.OutpaintStage': 'outpaint',
	'ComfyTV.GridSplitStage': 'gridSplit',
	'ComfyTV.ColorGradeStage': 'colorGrade',
	'ComfyTV.KenBurnsStage': 'kenBurns',
	'ComfyTV.MultiangleStage': 'multiangle',
	'ComfyTV.PanoramaStage': 'panorama',
	'ComfyTV.RelightStage': 'relight',
	'ComfyTV.MaterialStage': 'material',
};

/**
 * 由内嵌编辑器接管的字段 —— 这些字段**不再**渲染成通用 INT/BOOLEAN/COMBO 控件
 * （否则同一个参数出现两套 UI）。对齐 ComfyTV「专用卡片自带 UI」的效果。
 */
export const STAGE_HIDDEN_FIELDS: Record<string, readonly string[]> = {
	'ComfyTV.RotateStage': ['angle'],
	'ComfyTV.MirrorStage': ['horizontal', 'vertical'],
	'ComfyTV.CropStage': ['x', 'y', 'width', 'height'],
	'ComfyTV.OutpaintStage': ['pad_left', 'pad_top', 'pad_right', 'pad_bottom', 'feathering'],
	'ComfyTV.GridSplitStage': ['rows', 'cols', 'border', 'outer_border', 'selected_index'],
	'ComfyTV.ColorGradeStage': ['grade_state'],
	'ComfyTV.MultiangleStage': ['horizontal_angle', 'vertical_angle', 'zoom', 'prompt'],
	'ComfyTV.PanoramaStage': ['workflow', 'direction', 'prompt'],
	'ComfyTV.RelightStage': ['main_prompt'],
	'ComfyTV.MaterialStage': ['material_state'],
};

/**
 * 卡片最小高度（graph 单位）。对齐 ComfyTV RICH_STAGE_MIN_HEIGHTS —— 带 3D /
 * 大预览区的编辑器需要更高的初始高度，否则首帧内容被裁掉（用户只能看到图像
 * 顶部一条）。未列出的节点用 DEFAULT_STAGE_MIN_HEIGHT。
 */
export const STAGE_MIN_HEIGHTS: Record<string, number> = {
	'ComfyTV.CropStage': 460,
	// Rotate/Mirror 的完整版式（对齐 ComfyTV 参考卡片）是：
	//   预览 280 + 状态行 16 + 控件 30~60 + CONTEXT 20
	//   + OUTPUT 标题 18 + OUTPUT 大图 ~200 + ACTIONS 6 按钮 ~90
	// 旧值 280/260 是「只有预览+控件」时代的估算，现在会让首帧把 OUTPUT 与
	// ACTIONS 裁掉（要等高度反馈多轮才撑开，肉眼可见跳变）。
	'ComfyTV.RotateStage': 640,
	'ComfyTV.MirrorStage': 620,
	'ComfyTV.OutpaintStage': 500,
	'ComfyTV.GridSplitStage': 520,
	'ComfyTV.ColorGradeStage': 560,
	'ComfyTV.MultiangleStage': 640,
	'ComfyTV.PanoramaStage': 560,
	'ComfyTV.RelightStage': 640,
	'ComfyTV.MaterialStage': 640,
};

/** 对齐 ComfyTV GENERIC_STAGE_MIN_HEIGHT。 */
export const DEFAULT_STAGE_MIN_HEIGHT = 380;

/** 区块隐藏开关（对齐 ComfyTV STAGE_CARD_PROPS 的 hideOutput 等）。 */
export interface StageCardFlags {
	hideOutput?: boolean;
	hidePrompt?: boolean;
	hideContext?: boolean;
	hideActions?: boolean;
}

export const STAGE_CARD_FLAGS: Record<string, StageCardFlags> = {
	// loader 类节点的「输出」就是载入的素材本身，OUTPUT 区重复展示无意义。
	'ComfyTV.TextLoaderStage': { hideOutput: true },
};

// ── 纯查询函数（供 nodeCard 使用；未注册的节点走安全默认值）─────────────

export function stageEditorKind(nodeType: string | undefined): StageEditorKind {
	if (!nodeType) { return 'none'; }
	return STAGE_EDITOR_KIND[nodeType] ?? 'none';
}

/** 该节点由内嵌编辑器接管的字段集合（用于过滤通用控件）。 */
export function stageHiddenFields(nodeType: string | undefined): ReadonlySet<string> {
	if (!nodeType) { return EMPTY_SET; }
	const list = STAGE_HIDDEN_FIELDS[nodeType];
	return list ? new Set(list) : EMPTY_SET;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

export function stageMinHeight(nodeType: string | undefined): number {
	if (!nodeType) { return DEFAULT_STAGE_MIN_HEIGHT; }
	return STAGE_MIN_HEIGHTS[nodeType] ?? DEFAULT_STAGE_MIN_HEIGHT;
}

/**
 * @param isPicker 该节点是否为 `*PickerStage`。picker 的 Pool 网格**本身**就是
 *   它的产物展示（且高亮了当前选中项），再画一个 OUTPUT 区会把同一张图显示
 *   两遍 —— 用户看到的就是"picker 产生了 2 个同样的图片"。故 picker 一律
 *   hideOutput；ACTIONS 不受影响（走 `hasOutputContent`，与本开关解耦）。
 *   用参数而非往 STAGE_CARD_FLAGS 里逐个登记，是因为 picker 家族
 *   （Image/Video/AudioPickerStage）由后缀判定，登记表会漏。
 */
export function stageCardFlags(nodeType: string | undefined, isPicker?: boolean): StageCardFlags {
	const base = nodeType ? (STAGE_CARD_FLAGS[nodeType] ?? {}) : {};
	if (isPicker || (nodeType ?? '').endsWith('PickerStage')) {
		return { ...base, hideOutput: true };
	}
	return base;
}

/** 是否有内嵌编辑器（等价于旧的 isFullEditor / isEditorNode 判定）。 */
export function hasStageEditor(nodeType: string | undefined): boolean {
	return stageEditorKind(nodeType) !== 'none';
}

// ── CONTEXT 摘要（对齐 ComfyTV contextSummaryOf / slotCategory）─────────

/** slot 的语义类别。用于把 `images.image0` / `image1` 之类归并成人类可读摘要。 */
export type SlotCategory = 'image' | 'mask' | 'video' | 'audio' | 'text' | 'other';

/**
 * 从 slot 名或端口类型推断语义类别。纯函数。
 * 对齐 ComfyTV `slotCategory()` —— ComfyTV 用 `images.image0` 这类带命名空间的
 * key，本项目用端口名 + PortType，两者都归一到同一套类别。
 */
export function slotCategory(nameOrType: string): SlotCategory {
	const s = nameOrType.toLowerCase();
	// mask 必须先判：'mask' 里不含 'image'，但某些命名如 'image_mask' 两者都含，
	// 语义上应归为 mask。
	if (s.includes('mask')) { return 'mask'; }
	if (s.includes('image') || s.includes('img')) { return 'image'; }
	if (s.includes('video')) { return 'video'; }
	if (s.includes('audio')) { return 'audio'; }
	if (s.includes('text') || s.includes('prompt') || s.includes('string')) { return 'text'; }
	return 'other';
}

const CATEGORY_LABEL: Record<SlotCategory, [string, string]> = {
	image: ['image', 'images'],
	mask: ['mask', 'masks'],
	video: ['video', 'videos'],
	audio: ['audio', 'audio'],
	text: ['text', 'texts'],
	other: ['input', 'inputs'],
};

/**
 * 把已连接的 slot 列表聚合成 CONTEXT 摘要文案，如 `2 images, 1 mask`。
 * 对齐 ComfyTV `contextSummaryOf()`。纯函数，空列表返回空串。
 */
export function contextSummary(slots: readonly string[]): string {
	if (slots.length === 0) { return ''; }
	const counts = new Map<SlotCategory, number>();
	for (const s of slots) {
		const c = slotCategory(s);
		counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	// 固定顺序输出，避免 Map 迭代顺序带来的抖动。
	const order: SlotCategory[] = ['image', 'mask', 'video', 'audio', 'text', 'other'];
	const parts: string[] = [];
	for (const c of order) {
		const n = counts.get(c);
		if (!n) { continue; }
		const [one, many] = CATEGORY_LABEL[c];
		parts.push(`${n} ${n === 1 ? one : many}`);
	}
	return parts.join(', ');
}
