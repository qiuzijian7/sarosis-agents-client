/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ABSTRACT_KINDS, ABSTRACT_LABEL, ANIMAL_COMBOS, ANIMAL_EYE_LABEL, BOT_COMBOS, BOT_EYE_LABEL, BOT_MOUTH_LABEL,
	CRITTER_DEFS, EAR_LABEL, FACE_LABEL, FURS, OBJECT_DEFS, PALETTES,
	abstractArt, animalArt, botArt,
	type AnimalEye, type EarKind, type IPalette,
} from './agentAvatarArt.js';

/**
 * Agent 头像预设库 —— 所有预设都产出 **SVG data URI**，可直接写入 `Agent.avatar`。
 *
 * 规模：**592 款**，分 5 组（图形由 `agentAvatarArt.ts` 参数化生成）。
 * 设计要点：
 *  1. **矢量优先**：SVG 在 24px 列表图标和 200px 大图下都清晰，单个只有 0.6~1.2KB，
 *     写入 `.agent.md` 不会撑大文件。
 *  2. **配套 emoji**：每个预设带一个 `icon`，用于纯文本/无 SVG 渲染能力的场景回退，
 *     写入时 `avatar` 与 `icon` 一起落盘，语义始终一致。
 *  3. **label 全局唯一**：由「图形维度 + 配色名」组合而成，便于 tooltip 区分。
 */

export interface IAgentAvatarPreset {
	/** 稳定 ID（仅用于 UI 选中态比对，不落盘） */
	readonly id: string;
	/** 展示名（tooltip） */
	readonly label: string;
	/** SVG data URI，可直接赋给 img.src / Agent.avatar */
	readonly dataUri: string;
	/** 配套 emoji：SVG 不可用时的回退展示，同时写入 Agent.icon */
	readonly icon: string;
}

export interface IAgentAvatarPresetGroup {
	readonly id: string;
	/** 短标签（浮层 tab 上显示） */
	readonly label: string;
	/** tooltip（含款数） */
	readonly title: string;
	readonly presets: readonly IAgentAvatarPreset[];
}

// ═══════════════════════════════════════════════════════════════════════════
//  data URI 编码
// ═══════════════════════════════════════════════════════════════════════════

/**
 * SVG 属性引号统一改用单引号 —— `'` 是 URL 合法字符，可免去百分号转义。
 * 只转义 data URI 中真正敏感的字符：
 *   `%`（转义符本身，必须最先处理）、`#`（会被当作 fragment 截断）、`<`/`>`。
 * 相比 `encodeURIComponent`（连 `=` `:` 空格都转义，体积膨胀约 1.6 倍），
 * 这样能把单个头像 data URI 压到 1KB 上下。
 */
function escapeSvgUri(svg: string): string {
	return svg
		.replace(/%/g, '%25')
		.replace(/#/g, '%23')
		.replace(/</g, '%3C')
		.replace(/>/g, '%3E')
		.replace(/"/g, "'")
		.replace(/\s+/g, ' ');
}

/** 统一的渐变底（含两处柔光装饰圆，避免大面积纯色显得单调）。 */
function backdrop(palette: IPalette): string {
	return (
		`<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
		`<stop offset="0" stop-color="${palette.from}"/><stop offset="1" stop-color="${palette.to}"/>` +
		`</linearGradient></defs>` +
		`<rect width="64" height="64" fill="url(#bg)"/>` +
		`<circle cx="54" cy="58" r="15" fill="#FFFFFF" opacity="0.14"/>` +
		`<circle cx="9" cy="9" r="11" fill="#FFFFFF" opacity="0.10"/>`
	);
}

function svgDataUri(palette: IPalette, body: string): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${backdrop(palette)}${body}</svg>`;
	return `data:image/svg+xml,${escapeSvgUri(svg)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  组 1：机器人 —— 12 配色 × 15 组合（眼 × 嘴）= 180
// ═══════════════════════════════════════════════════════════════════════════

const BOT_PER_PALETTE = 15;

function buildBotPresets(): IAgentAvatarPreset[] {
	const out: IAgentAvatarPreset[] = [];
	PALETTES.forEach((palette, pi) => {
		for (let j = 0; j < BOT_PER_PALETTE; j++) {
			// 步长 7 与 20 互质：同一配色的 15 款互不重复，跨配色又能覆盖全部 20 种组合
			const combo = BOT_COMBOS[(pi * 7 + j) % BOT_COMBOS.length];
			const antenna = (pi + j) % 2 === 0;
			out.push({
				id: `bot-${pi}-${j}`,
				label: `${BOT_EYE_LABEL[combo.eye]}${BOT_MOUTH_LABEL[combo.mouth]}机器人 · ${palette.name}`,
				dataUri: svgDataUri(palette, botArt(combo.eye, combo.mouth, antenna)),
				icon: '🤖',
			});
		}
	});
	return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  组 2：动物 —— 12 款手写精品 + 10 毛色 × 12 脸型耳型 = 132
// ═══════════════════════════════════════════════════════════════════════════

const EAR_ICON: Record<EarKind, string> = { round: '🐻', pointed: '🦊', long: '🐰', small: '🐼' };
const ANIMAL_EYES: AnimalEye[] = ['dots', 'big', 'sleepy'];

function buildAnimalPresets(): IAgentAvatarPreset[] {
	const out: IAgentAvatarPreset[] = [];

	// 2a. 手写精品（形态辨识度优先）
	CRITTER_DEFS.forEach(def => {
		out.push({
			id: `critter-${def.id}`,
			label: `造型 · ${def.label}`,
			dataUri: svgDataUri({ name: def.label, from: def.from, to: def.to }, def.body),
			icon: def.icon,
		});
	});

	// 2b. 参数化动物脸
	FURS.forEach((fur, fi) => {
		ANIMAL_COMBOS.forEach((combo, ci) => {
			const eye = ANIMAL_EYES[(fi + ci) % ANIMAL_EYES.length];
			const eyeSuffix = ANIMAL_EYE_LABEL[eye];
			out.push({
				id: `animal-${fi}-${ci}`,
				label: `${fur.name}·${FACE_LABEL[combo.face]}${EAR_LABEL[combo.ear]}${eyeSuffix}`,
				dataUri: svgDataUri(PALETTES[(fi + ci) % PALETTES.length], animalArt(combo.face, combo.ear, eye, fur)),
				icon: EAR_ICON[combo.ear],
			});
		});
	});

	return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  组 3：抽象几何 —— 12 图案 × 10 配色 = 120
// ═══════════════════════════════════════════════════════════════════════════

const ABSTRACT_ICON: Record<string, string> = {
	rings: '⭕', waves: '🌊', burst: '✨', stripes: '🎼', dots: '🔘', grid: '🔳',
	peaks: '⛰️', orbit: '🪐', checker: '🏁', rays: '🌅', bubbles: '🫧', hex: '🍯',
};

function buildAbstractPresets(): IAgentAvatarPreset[] {
	const out: IAgentAvatarPreset[] = [];
	ABSTRACT_KINDS.forEach((kind, ki) => {
		PALETTES.slice(0, 10).forEach((palette, pi) => {
			out.push({
				id: `abstract-${ki}-${pi}`,
				label: `${ABSTRACT_LABEL[kind]} · ${palette.name}`,
				dataUri: svgDataUri(palette, abstractArt(kind, pi)),
				icon: ABSTRACT_ICON[kind],
			});
		});
	});
	return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  组 4：物件符号 —— 40 款手写几何
// ═══════════════════════════════════════════════════════════════════════════

function buildObjectPresets(): IAgentAvatarPreset[] {
	return OBJECT_DEFS.map((def, i) => ({
		id: `object-${def.id}`,
		label: `物件 · ${def.label}`,
		dataUri: svgDataUri(PALETTES[i % PALETTES.length], def.body),
		icon: def.icon,
	}));
}

// ═══════════════════════════════════════════════════════════════════════════
//  组 5：Emoji 徽章 —— 120 款（渐变底 + emoji 字形，仍是 SVG）
// ═══════════════════════════════════════════════════════════════════════════

const EMOJI_CHOICES: readonly string[] = [
	'🤖', '🦞', '🐱', '🐶', '🦊', '🐼', '🐨', '🐯',
	'🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🦄', '🐴',
	'🐝', '🐙', '🐟', '🦈', '🐬', '🐢', '🦀', '🐳',
	'🦋', '🐌', '🐿️', '🦔', '🦉', '🦅', '🦆', '🦢',
	'🦩', '🦜', '🐦', '🦃', '🐧', '🐺', '🐗', '🦓',
	'🦍', '🐫', '🦒', '🐘', '🦏', '🐑', '🐐', '🦌',
	'🐇', '🐁', '🐀', '🦛', '🐋', '🐊', '🦎', '🐉',
	'🦖', '🦕', '🌟', '⚡', '🔥', '🎯', '🎨', '📚',
	'🔬', '🧠', '💡', '🛠', '🚀', '🧑‍💻', '👩‍💻', '🧙',
	'🕵️', '🎮', '📊', '🗂️', '🔒', '💬', '🧩', '🧭',
	'🎧', '📷', '🎤', '🎬', '🎹', '🎸', '🥁', '🎺',
	'☕', '🍵', '🍺', '🍷', '🍎', '🍊', '🍋', '🍉',
	'🍇', '🍓', '🥑', '🌽', '🍞', '🧁', '🍰', '🍩',
	'🍔', '🍟', '🍕', '🌮', '🍜', '🍣', '🍱', '🥗',
	'⛰️', '🌊', '🌋', '🏝️', '🌌', '🚁', '🚂', '🚗',
];

function buildEmojiPresets(): IAgentAvatarPreset[] {
	return EMOJI_CHOICES.map((emoji, i) => {
		// 字体名不能加引号 —— escapeSvgUri 会把 " 统一换成 '，
		// 嵌套引号会让属性值提前截断（CSS 本身允许带空格的无引号字体名）。
		const body = `<text x="32" y="45" text-anchor="middle" font-size="34" ` +
			`font-family="system-ui, Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif">${emoji}</text>`;
		return {
			id: `emoji-${i}`,
			label: `Emoji · ${emoji}`,
			dataUri: svgDataUri(PALETTES[i % PALETTES.length], body),
			icon: emoji,
		};
	});
}

// ═══════════════════════════════════════════════════════════════════════════
//  对外导出
// ═══════════════════════════════════════════════════════════════════════════

function group(id: string, label: string, name: string, presets: IAgentAvatarPreset[]): IAgentAvatarPresetGroup {
	return { id, label, title: `${name} · ${presets.length} 款`, presets };
}

export const AVATAR_PRESET_GROUPS: readonly IAgentAvatarPresetGroup[] = [
	group('bot', '🤖', '机器人', buildBotPresets()),
	group('animal', '🐱', '动物造型', buildAnimalPresets()),
	group('abstract', '◈', '抽象几何', buildAbstractPresets()),
	group('object', '🔮', '物件符号', buildObjectPresets()),
	group('emoji', '😀', 'Emoji', buildEmojiPresets()),
];

/** 总预设数（用于 UI 提示）。 */
export const AVATAR_PRESET_TOTAL = AVATAR_PRESET_GROUPS.reduce((n, g) => n + g.presets.length, 0);

/** 按 dataUri 反查预设（用于回显当前选中的是哪一款）。 */
export function findAvatarPreset(dataUri: string | undefined): IAgentAvatarPreset | undefined {
	if (!dataUri) { return undefined; }
	for (const g of AVATAR_PRESET_GROUPS) {
		const hit = g.presets.find(p => p.dataUri === dataUri);
		if (hit) { return hit; }
	}
	return undefined;
}
