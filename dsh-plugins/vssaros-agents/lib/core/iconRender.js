// @vssaros/dsh-agents — 图标值解析 + 内联 SVG 渲染（2026-10-19）。
//
// 两种取值并存：
//   · `lucide:<name>` —— 新的 SVG 图标（表见 `core/icons.js`，来源 Lucide/ISC）；
//   · 单个 emoji / 字 —— 老数据（`icon: 🧪`）继续按文本渲染，**不改用户的旧文件**。
//
// 渲染纪律：只从 `ICON_PATHS` 里取**已知名字**的片段拼进 `<svg>`，用户输入永远不直接进 HTML
// （否则 `icon: <img onerror=...>` 就是 XSS 入口）。未知名字走回退，不报错。
import { ICON_NAMES, ICON_PATHS, ICON_SET } from './icons.js';

const NAMED = `lucide:`;

/** `icon` 字段 → `{ kind: 'svg'|'text'|'none', name?, text? }`。 */
export function parseIconValue(value) {
	const raw = String(value ?? '').trim();
	if (!raw) {
		return { kind: 'none' };
	}
	if (raw.toLowerCase().startsWith(NAMED)) {
		const name = raw.slice(NAMED.length).trim().toLowerCase();
		if (ICON_PATHS[name]) {
			return { kind: 'svg', name };
		}
		return { kind: 'none' };   // 未知图标名：当作没设置（页面会用名字首字兜底）
	}
	// 老数据：emoji / 1~2 个字符
	return { kind: 'text', text: raw };
}

/** 该值是否是一个"已知的 SVG 图标"。 */
export function isIconName(value) {
	return parseIconValue(value).kind === 'svg';
}

/** 渲染内联 SVG（`name` 必须是表里的名字；否则返回空串）。 */
export function renderIconHtml(value, options = {}) {
	const parsed = parseIconValue(value);
	if (parsed.kind === 'none') {
		return '';
	}
	if (parsed.kind === 'text') {
		const size = Number(options.size) || 18;
		return `<span class="${options.cls ?? 'ico-emoji'}" style="font-size:${size}px;line-height:1">${escapeHtml(parsed.text)}</span>`;
	}
	const size = Number(options.size) || 18;
	const cls = options.cls ? ` ${options.cls}` : '';
	const stroke = Number(options.stroke) || 2;
	return `<svg class="ico-svg${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-icon="${parsed.name}">${ICON_PATHS[parsed.name]}</svg>`;
}

/** 名册/卡片上的头像内容：有图标用图标，没有就用名字首字。 */
export function renderAvatarContent(value, fallbackText, options = {}) {
	const html = renderIconHtml(value, options);
	if (html) {
		return html;
	}
	const size = Number(options.size) || 18;
	return `<span class="ico-emoji" style="font-size:${size}px;line-height:1">${escapeHtml(fallbackText ?? '?')}</span>`;
}

/** 转义（与页面其它地方同口径；这里自带一份，避免循环依赖）。 */
function escapeHtml(text) {
	return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** 图标选择器要渲染的数据（页面脚本拿到 JSON 后自己画网格）。 */
export function iconPickerData() {
	return {
		set: ICON_SET,
		icons: ICON_NAMES.map((name) => ({ name, value: `${NAMED}${name}`, svg: ICON_PATHS[name] })),
	};
}
