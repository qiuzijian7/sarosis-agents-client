/*---------------------------------------------------------------------------------------------
 *  zoomTier — 画布缩放分级（Zoom Tier）纯逻辑 + CSS 契约。
 *
 *  三级形态（节点图坐标几何恒定，只切卡片内容形态，见 2026-09-02 mockup）：
 *    full    k ≥ 0.70   完整卡片（控件 / OUTPUT 网格 / 大预览）
 *    compact 0.35–0.70  标题(canvas 原生) + 最新输出预览 + 徽标（控件全收）
 *    thumb   k < 0.35   纯图缩略（4:3 铺满，来自 ownSnapshots 末位 image）
 *
 *  接线：
 *    - LiteGraphCanvas.syncOverlay 每帧 computeZoomTier(lc.ds.scale)，跨档时写
 *      container.dataset.tier 并 markFormHeightDirty(nodeId)（触发高度重测：
 *      thumb 收缩 / 回 full 展开——CSS 切换不引发 React 渲染，必须显式喂高度）。
 *    - nodeCard 内容包装层打 data-zone="keep"（OUTPUT）/ data-zone="thumb"（纯图层），
 *      CSS 用 :not() 白名单反转隐藏，无需逐个给控件/编辑器打标。
 *--------------------------------------------------------------------------------------------*/

export type ZoomTier = 'full' | 'compact' | 'thumb';

/**
 * ★ 缩放分级总开关（2026-09-02 用户要求关闭）。
 * false = 恒为 full 档：不写 data-tier、不注入分级 CSS、不触发高度重测——
 * 行为与该功能引入前完全一致。重新启用改 true 即可（逻辑/测试全部保留）。
 */
export const ZOOM_TIER_ENABLED = false;

/** Compact 档下限（含）。scale < 此值进入 Thumb。 */
export const ZOOM_TIER_COMPACT_MIN = 0.35;
/** Full 档下限（含）。 */
export const ZOOM_TIER_FULL_MIN = 0.7;

/** 纯函数：scale → 档位（边界含下限；负/NaN 归 thumb，防御 ds.scale 异常值）。 */
export function computeZoomTier(scale: number): ZoomTier {
	if (!Number.isFinite(scale) || scale < ZOOM_TIER_COMPACT_MIN) { return 'thumb'; }
	if (scale < ZOOM_TIER_FULL_MIN) { return 'compact'; }
	return 'full';
}

/**
 * 分级 CSS（LiteGraphCanvas init 注入一次，id=saros-zoom-tier-css）。
 *
 * 契约（nodeCard 侧依赖的 data-zone 名，改这里必须同步改 nodeCard）：
 *  - data-zone="keep"  → Compact 档仍显示（目前仅 OUTPUT 区 / GridSplit 空态）；
 *  - data-zone="thumb" → Thumb 档唯一显示的纯图层（4:3 铺满，非 absolute——
 *    absolute 会随兄弟 display:none 让包装层塌缩成 padding 高度，图被压成细条）。
 *  选择器限定 `.wf-comfy-card > div > *`（卡片根 > 内容包装层 > 直接子节点），
 *  不影响卡片外层（widgetBridge 容器 / 端口行）。
 */
export const ZOOM_TIER_CSS = [
	'/* Compact：只留 OUTPUT 保留区，控件/提示词/编辑器/动作/CONTEXT 全收 */',
	'[data-tier="compact"] .wf-comfy-card > div > *:not([data-zone="keep"]) { display: none !important; }',
	'/* Thumb：只留纯图缩略层（in-flow 4:3，随宽度撑高 → 高度反馈把节点缩成缩略卡） */',
	'[data-tier="thumb"] .wf-comfy-card > div > *:not([data-zone="thumb"]) { display: none !important; }',
	'[data-tier="thumb"] .wf-comfy-card > div > [data-zone="thumb"] { display: block !important; position: relative; inset: auto; width: 100%; aspect-ratio: 4 / 3; }',
	'[data-tier="thumb"] .wf-comfy-card > div > [data-zone="thumb"] .saros-zoom-thumb-img { width: 100%; height: 100%; object-fit: cover; }',
].join('\n');
