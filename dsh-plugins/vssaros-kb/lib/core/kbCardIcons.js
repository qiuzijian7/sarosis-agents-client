/*
 * 知识库总览卡片图标（2026-11-11 落地 doc/kb-card-icon-e-mixed.html 定型稿）
 *
 * 方案 = E 的状态化卡片 + B 的语义 SVG 图标：
 *   · 图标照 Outline IconPicker / BookStack 的语义图标库，全部内联 SVG、stroke=currentColor；
 *   · 颜色按库的**语义分类**上色，不再按库名 hash 出随机色；
 *   · 缺省走「按库名关键词自动推断」（用户拍板的默认口径），不引入库级元数据文件。
 *
 * 纯函数：不 import fs / 宿主服务，便于守卫直测。
 * ⚠ 这些是强调色（明暗两态都成立），不是表面色 ⇒ 不写进主题的 --dsw-alias-* 变量。
 */

/** 与 doc/kb-card-icon-e-mixed.html 的 ICONS 逐字一致（含 link 状态角标）。 */
export const ICONS = {
	coins: '<circle cx="8" cy="8" r="4.2"/><path d="M15.6 5.4a4.2 4.2 0 1 1 0 7.2M12 16v3M8 20h8"/>',
	code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5l-3 14"/>',
	game: '<path d="M7.5 8h9a4 4 0 0 1 3.8 3l.9 5a2.4 2.4 0 0 1-4.2 2l-1.6-2h-6.8L7 18a2.4 2.4 0 0 1-4.2-2l.9-5A4 4 0 0 1 7.5 8Z"/><path d="M7 12h4M9 10v4M16.5 11.5h.01M18.5 14h.01"/>',
	palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.9 1.8-1.8 0-1.2-1-1.6-1-2.7 0-.9.7-1.5 1.7-1.5H16a5 5 0 0 0 5-5c0-3.9-4-7-9-7Z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="15" cy="7.5" r="1"/>',
	cube: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
	book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5A2.5 2.5 0 0 1 4 20.5Z"/>',
	link: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/>',
};

/**
 * 关键词 → 语义分类。⚠ 顺序敏感，且刻意不放「技术 / 设计」这类泛词，
 * 否则 `ComfyUI技术` 会被误判成技术、`游戏设计` 会被误判成创作。
 */
const RULES = [
	{ re: /财经|金融|投资|股票|会计|财务|数据|统计|报表|coins|finance/i, icon: 'coins', cat: '数据', color: '#e0a33e' },
	{ re: /游戏|玩法|关卡|策划|game|gamedev/i, icon: 'game', cat: '设计', color: '#b57bea' },
	{ re: /unreal|ue4|ue5|引擎|渲染|3d|图形|shader/i, icon: 'cube', cat: '技术', color: '#3fb9b0' },
	{ re: /comfy|绘|画|图|设计|ui|素材|创作|摄影|视频|palette/i, icon: 'palette', cat: '创作', color: '#e4758a' },
	{ re: /\bai\b|agent|llm|模型|算法|代码|开发|编程|前端|后端|架构/i, icon: 'code', cat: '技术', color: '#5b8cff' },
];

const DEFAULT_ICON = { icon: 'book', cat: '知识库', color: '#8b8f99' };

/** 按库名推断图标（大小写不敏感；空名 / 非字符串 ⇒ 默认书本）。 */
export function iconForKb(name) {
	const s = String(name ?? '').trim();
	if (!s) { return { ...DEFAULT_ICON }; }
	for (const rule of RULES) {
		if (rule.re.test(s)) { return { icon: rule.icon, cat: rule.cat, color: rule.color }; }
	}
	return { ...DEFAULT_ICON };
}

/** 包一层 `<svg>`；路径来自内置常量，不含用户输入。 */
export function svgIcon(key) {
	const body = ICONS[key] || ICONS[DEFAULT_ICON.icon];
	return `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}
