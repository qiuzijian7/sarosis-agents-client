/*--------------------------------------------------------------------------
 * comfyTvTruth —— ComfyTV 节点卡样式「真源」（single source of truth）。
 *
 * 全部值从 ComfyTV 源码逐字提取（G:\CustomWorkspaces\AIProjects\ComfyTV），
 * 每项标注来源文件。本模块是 visual R15 契约断言与 comfyTvReference 参考
 * 卡的唯一依据 —— 改这里必须同步改 ComfyTV 源码出处，否则就是失真。
 *
 * 提取日期：2026-08-20
 *------------------------------------------------------------------------*/

/**
 * 颜色 token。
 * 来源：src/tailwind.css `@theme inline` 块（fallback 值即 ComfyUI 前端 1.45.x
 * 实际运行的默认主题值；运行时变量缺省时浏览器回落到这里的字面量）。
 */
export const CTV_COLORS = {
	/** 前景正文。--color-base-foreground */
	foreground: '#e0e0e0',
	/** 卡/面板背景。--color-base-background */
	background: '#1e1e1e',
	/** 次要文字。--color-muted-foreground */
	mutedForeground: '#888888',
	/** 输入框/次级控件底色。--color-muted-background */
	mutedBackground: '#2a2a2a',
	/** accent 蓝（选中/聚焦/连线高亮）。--color-accent-background */
	accent: '#4ea8ff',
	/** 主按钮底色（run）。--color-primary-background */
	primary: 'rgba(78,168,255,0.6)',
	/** 主按钮 hover。--color-primary-background-hover */
	primaryHover: 'rgba(78,168,255,0.75)',
	/** 次级按钮底色（action/preset）。--color-secondary-background */
	secondary: 'rgba(255,255,255,0.06)',
	/** 次级按钮 hover。--color-secondary-background-hover */
	secondaryHover: 'rgba(255,255,255,0.10)',
	/** 次级按钮选中。--color-secondary-background-selected */
	secondarySelected: 'rgba(78,168,255,0.20)',
	/** 错误红。--color-destructive-background */
	destructive: '#c0392b',
	/** 警告黄。--color-warning-background */
	warning: '#d39e00',
	/** 成功绿。--color-success-background */
	success: '#2e9e4f',
	/** 默认边框。--color-border-default */
	borderDefault: 'rgba(255,255,255,0.15)',
	/** 弱边框（小按钮/输入框描边）。--color-border-subtle */
	borderSubtle: 'rgba(255,255,255,0.08)',
	/** 节点组件边框。--color-node-component-border */
	nodeComponentBorder: 'rgba(255,255,255,0.20)',
} as const;

/**
 * 字号 token（px）。
 * 来源：src/tailwind.css `@theme`（--text-2xs/--text-3xs）+ Tailwind v4 默认刻度
 * （text-xs/text-sm）。全部 line-height 1（2xs/3xs 显式声明，xs/sm 为刻度默认）。
 */
export const CTV_FONT = {
	/** text-3xs —— 微标签（tile 底部标签、clear 按钮）。0.5625rem */
	'3xs': 9,
	/** text-2xs —— SectionLabel / 进度百分比。0.625rem */
	'2xs': 10,
	/** text-xs —— 卡根字号（正文/控件行）。 */
	xs: 12,
	/** text-sm —— run 按钮。 */
	sm: 14,
} as const;

/**
 * 布局 token。
 * 来源：src/components/stages/StageCard.vue `cardClass`：
 *   'ctv:flex ctv:flex-col ctv:gap-2 ctv:p-2 ctv:w-full ctv:h-full ctv:flex-1
 *    ctv:box-border ctv:text-xs ctv:text-base-foreground'
 * （正常态无背景/无边框/无圆角 —— 卡挂在 ComfyUI 前端 node 上，面板背景由
 * node 框提供；本项目 DOM 卡自带面板语义，背景对齐 CTV_COLORS.background）
 */
export const CTV_LAYOUT = {
	/** 卡内边距 p-2 */
	cardPadding: 8,
	/** 卡区块间距 gap-2 */
	cardGap: 8,
	/** run 按钮高 h-10 */
	runBtnHeight: 40,
	/** run 按钮圆角 rounded-lg */
	runBtnRadius: 8,
	/** run 按钮水平内边距 px-4 */
	runBtnPaddingX: 16,
	/** action/preset 按钮高 h-6 */
	smBtnHeight: 24,
	/** action/preset 按钮圆角 rounded-sm */
	smBtnRadius: 2,
	/** 进度条高 h-1.5 */
	progressHeight: 6,
	/** SectionLabel 下边距 mb-[3px] */
	sectionLabelMarginBottom: 3,
} as const;

/** rgba 字符串归一化为 [r,g,b,a]（比对容差用）。 */
export function parseRgba(s: string): [number, number, number, number] | null {
	const m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i);
	if (!m) { return null; }
	return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

/** 颜色比对：分量容差。 */
export function colorClose(a: string, b: string, tol = 6): boolean {
	const pa = parseRgba(a); const pb = parseRgba(b);
	if (!pa || !pb) { return a.replace(/\s/g, '') === b.replace(/\s/g, ''); }
	return pa.every((v, i) => Math.abs(v - (pb as [number, number, number, number])[i]) <= (i === 3 ? 0.06 : tol));
}
