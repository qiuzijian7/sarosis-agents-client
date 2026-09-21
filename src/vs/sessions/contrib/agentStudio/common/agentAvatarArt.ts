/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 头像**图形层**：所有函数返回 64×64 画布内的 SVG 片段（不含渐变底），
 * 由 `agentAvatarPresets.ts` 统一套底、转 data URI。
 *
 * 为了把预设做到 500+ 又不让源码爆炸，这里尽量用**参数化组合**产出：
 *   - 机器人：眼型 × 嘴型 × 天线 × 配色
 *   - 动物  ：脸型 × 耳型 × 眼型 × 毛色
 *   - 抽象  ：图案 × 配色 × 变体
 *   - 物件  ：手写几何符号（无法参数化的语义图形）
 */

export interface IPalette {
	readonly name: string;
	readonly from: string;
	readonly to: string;
}

/** 12 套渐变配色，各组共用。 */
export const PALETTES: readonly IPalette[] = [
	{ name: '紫青', from: '#7C3AED', to: '#22D3EE' },
	{ name: '蓝靛', from: '#2563EB', to: '#6366F1' },
	{ name: '青绿', from: '#06B6D4', to: '#34D399' },
	{ name: '绿黄', from: '#10B981', to: '#FACC15' },
	{ name: '橙粉', from: '#F97316', to: '#EC4899' },
	{ name: '玫紫', from: '#F43F5E', to: '#A855F7' },
	{ name: '琥珀', from: '#F59E0B', to: '#EF4444' },
	{ name: '石蓝', from: '#475569', to: '#38BDF8' },
	{ name: '靛紫', from: '#4F46E5', to: '#C084FC' },
	{ name: '墨绿', from: '#0F766E', to: '#A3E635' },
	{ name: '赭石', from: '#78350F', to: '#F59E0B' },
	{ name: '夜幕', from: '#1E293B', to: '#7DD3FC' },
];

const INK = '#0F172A';
const PAPER = '#F8FAFC';

// ═══════════════════════════════════════════════════════════════════════════
//  机器人
// ═══════════════════════════════════════════════════════════════════════════

export type BotEye = 'dots' | 'visor' | 'single' | 'squares' | 'happy';
export type BotMouth = 'line' | 'smile' | 'grill' | 'none';

export const BOT_EYE_LABEL: Record<BotEye, string> = {
	dots: '圆眼', visor: '护目镜', single: '独眼', squares: '方眼', happy: '笑眼',
};
export const BOT_MOUTH_LABEL: Record<BotMouth, string> = {
	line: '直线嘴', smile: '微笑嘴', grill: '格栅嘴', none: '无嘴',
};

/** 5 眼 × 4 嘴 全排列 —— 保证每个配色内任取 15 款 label 都不重复。 */
export const BOT_COMBOS: ReadonlyArray<{ readonly eye: BotEye; readonly mouth: BotMouth }> = (() => {
	const eyes: BotEye[] = ['dots', 'visor', 'single', 'squares', 'happy'];
	const mouths: BotMouth[] = ['line', 'smile', 'grill', 'none'];
	const out: Array<{ eye: BotEye; mouth: BotMouth }> = [];
	for (const eye of eyes) { for (const mouth of mouths) { out.push({ eye, mouth }); } }
	return out;
})();

function botEyes(kind: BotEye): string {
	switch (kind) {
		case 'dots':
			return `<circle cx="24" cy="31" r="4.8" fill="${INK}"/><circle cx="40" cy="31" r="4.8" fill="${INK}"/>` +
				`<circle cx="25.6" cy="29.2" r="1.5" fill="${PAPER}"/><circle cx="41.6" cy="29.2" r="1.5" fill="${PAPER}"/>`;
		case 'visor':
			return `<rect x="16" y="25" width="32" height="12" rx="6" fill="${INK}"/>` +
				`<circle cx="25" cy="31" r="2.6" fill="#38BDF8"/><circle cx="39" cy="31" r="2.6" fill="#38BDF8"/>`;
		case 'single':
			return `<circle cx="32" cy="30" r="9" fill="${INK}"/><circle cx="32" cy="30" r="4" fill="#38BDF8"/>` +
				`<circle cx="34.4" cy="27.4" r="1.6" fill="${PAPER}"/>`;
		case 'squares':
			return `<rect x="18" y="26" width="10" height="10" rx="2.5" fill="${INK}"/>` +
				`<rect x="36" y="26" width="10" height="10" rx="2.5" fill="${INK}"/>` +
				`<rect x="20" y="28" width="3" height="3" rx="1" fill="${PAPER}"/>` +
				`<rect x="38" y="28" width="3" height="3" rx="1" fill="${PAPER}"/>`;
		case 'happy':
			return `<path d="M19 33c1.8-3.6 5.4-3.6 7.2 0" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/>` +
				`<path d="M37.8 33c1.8-3.6 5.4-3.6 7.2 0" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
	}
}

function botMouth(kind: BotMouth): string {
	switch (kind) {
		case 'line':
			return `<path d="M26 42h12" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`;
		case 'smile':
			return `<path d="M25 39c2.4 4.6 11.6 4.6 14 0" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
		case 'grill':
			return `<path d="M26 40v5M32 40v5M38 40v5" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>`;
		case 'none':
			return '';
	}
}

export function botArt(eye: BotEye, mouth: BotMouth, antenna: boolean): string {
	return (antenna
		? `<path d="M32 16V9" stroke="${PAPER}" stroke-width="3" stroke-linecap="round"/>` +
		`<circle cx="32" cy="6.4" r="3.4" fill="#FDE047"/>`
		: '') +
		// 两侧耳块
		`<rect x="6" y="27" width="5.5" height="13" rx="2.75" fill="${PAPER}"/>` +
		`<rect x="52.5" y="27" width="5.5" height="13" rx="2.75" fill="${PAPER}"/>` +
		// 头部
		`<rect x="10" y="14" width="44" height="38" rx="12" fill="${PAPER}"/>` +
		botEyes(eye) +
		botMouth(mouth);
}

// ═══════════════════════════════════════════════════════════════════════════
//  动物（脸型 × 耳型 × 眼型 × 毛色）
// ═══════════════════════════════════════════════════════════════════════════

export type FaceShape = 'round' | 'oval' | 'squarish';
export type EarKind = 'round' | 'pointed' | 'long' | 'small';
export type AnimalEye = 'dots' | 'big' | 'sleepy';

export const FACE_LABEL: Record<FaceShape, string> = { round: '圆脸', oval: '鹅蛋脸', squarish: '方脸' };
export const EAR_LABEL: Record<EarKind, string> = { round: '圆耳', pointed: '尖耳', long: '长耳', small: '小耳' };
export const ANIMAL_EYE_LABEL: Record<AnimalEye, string> = { dots: '', big: '大眼', sleepy: '眯眼' };

export interface IFur {
	readonly name: string;
	/** 毛发主色 */
	readonly fur: string;
	/** 耳内/腹部浅色 */
	readonly inner: string;
}

export const FURS: readonly IFur[] = [
	{ name: '奶白', fur: '#F1F5F9', inner: '#F472B6' },
	{ name: '蜜棕', fur: '#D97706', inner: '#FCD34D' },
	{ name: '炭灰', fur: '#64748B', inner: '#CBD5E1' },
	{ name: '墨黑', fur: '#334155', inner: '#94A3B8' },
	{ name: '奶黄', fur: '#FDE047', inner: '#F59E0B' },
	{ name: '珊瑚', fur: '#FB7185', inner: '#FECACA' },
	{ name: '湖蓝', fur: '#38BDF8', inner: '#BAE6FD' },
	{ name: '薄荷', fur: '#6EE7B7', inner: '#A7F3D0' },
	{ name: '丁香', fur: '#C084FC', inner: '#E9D5FF' },
	{ name: '砖红', fur: '#F87171', inner: '#FECACA' },
];

/** 12 种脸型 × 耳型组合（眼型由调用方按索引派生，不参与 label 唯一性）。 */
export const ANIMAL_COMBOS: ReadonlyArray<{ readonly face: FaceShape; readonly ear: EarKind }> = (() => {
	const faces: FaceShape[] = ['round', 'oval', 'squarish'];
	const ears: EarKind[] = ['round', 'pointed', 'long', 'small'];
	const out: Array<{ face: FaceShape; ear: EarKind }> = [];
	for (const face of faces) { for (const ear of ears) { out.push({ face, ear }); } }
	return out;
})();

function animalEars(ear: EarKind, fur: IFur): string {
	switch (ear) {
		case 'round':
			return `<circle cx="17" cy="22" r="9" fill="${fur.fur}"/><circle cx="47" cy="22" r="9" fill="${fur.fur}"/>` +
				`<circle cx="17" cy="22" r="4.6" fill="${fur.inner}"/><circle cx="47" cy="22" r="4.6" fill="${fur.inner}"/>`;
		case 'pointed':
			return `<path d="M17 25L12 11l15 5z" fill="${fur.fur}"/><path d="M47 25l5-14-15 5z" fill="${fur.fur}"/>` +
				`<path d="M18 23l-3.6-8.4 8 3z" fill="${fur.inner}"/><path d="M46 23l3.6-8.4-8 3z" fill="${fur.inner}"/>`;
		case 'long':
			return `<ellipse cx="23" cy="18" rx="5" ry="12" fill="${fur.fur}"/><ellipse cx="41" cy="18" rx="5" ry="12" fill="${fur.fur}"/>` +
				`<ellipse cx="23" cy="18" rx="2.4" ry="8" fill="${fur.inner}"/><ellipse cx="41" cy="18" rx="2.4" ry="8" fill="${fur.inner}"/>`;
		case 'small':
			return `<circle cx="19" cy="21" r="6" fill="${fur.fur}"/><circle cx="45" cy="21" r="6" fill="${fur.fur}"/>` +
				`<circle cx="19" cy="21" r="2.8" fill="${fur.inner}"/><circle cx="45" cy="21" r="2.8" fill="${fur.inner}"/>`;
	}
}

function animalFace(shape: FaceShape, fur: IFur): string {
	switch (shape) {
		case 'round':
			return `<circle cx="32" cy="37" r="19" fill="${fur.fur}"/>`;
		case 'oval':
			return `<ellipse cx="32" cy="38" rx="18" ry="20" fill="${fur.fur}"/>`;
		case 'squarish':
			return `<rect x="12" y="19" width="40" height="37" rx="13" fill="${fur.fur}"/>`;
	}
}

function animalEyes(kind: AnimalEye): string {
	switch (kind) {
		case 'dots':
			return `<circle cx="25" cy="35" r="3.1" fill="${INK}"/><circle cx="39" cy="35" r="3.1" fill="${INK}"/>` +
				`<circle cx="26.2" cy="33.8" r="1.1" fill="${PAPER}"/><circle cx="40.2" cy="33.8" r="1.1" fill="${PAPER}"/>`;
		case 'big':
			return `<circle cx="25" cy="35" r="5.4" fill="${PAPER}"/><circle cx="39" cy="35" r="5.4" fill="${PAPER}"/>` +
				`<circle cx="25.8" cy="35.6" r="3" fill="${INK}"/><circle cx="39.8" cy="35.6" r="3" fill="${INK}"/>`;
		case 'sleepy':
			return `<path d="M21 35c1.6-3 5-3 6.6 0" stroke="${INK}" stroke-width="2.6" fill="none" stroke-linecap="round"/>` +
				`<path d="M36.4 35c1.6-3 5-3 6.6 0" stroke="${INK}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
	}
}

/** 口鼻：吻部椭圆 + 鼻头 + 嘴线。 */
function animalMuzzle(): string {
	return `<ellipse cx="32" cy="43" rx="8" ry="6" fill="${PAPER}" opacity="0.92"/>` +
		`<ellipse cx="32" cy="41" rx="2.6" ry="2" fill="${INK}"/>` +
		`<path d="M32 43v2.4M32 45.4l-3 2M32 45.4l3 2" stroke="${INK}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`;
}

export function animalArt(face: FaceShape, ear: EarKind, eye: AnimalEye, fur: IFur): string {
	return animalEars(ear, fur) +
		animalFace(face, fur) +
		animalEyes(eye) +
		animalMuzzle();
}

// ═══════════════════════════════════════════════════════════════════════════
//  抽象几何（图案 × 变体）
// ═══════════════════════════════════════════════════════════════════════════

export type AbstractKind =
	| 'rings' | 'waves' | 'burst' | 'stripes' | 'dots' | 'grid'
	| 'peaks' | 'orbit' | 'checker' | 'rays' | 'bubbles' | 'hex';

export const ABSTRACT_LABEL: Record<AbstractKind, string> = {
	rings: '同心圆', waves: '波纹', burst: '星芒', stripes: '斜纹', dots: '点阵', grid: '窗格',
	peaks: '山峦', orbit: '轨道', checker: '棋盘', rays: '曙光', bubbles: '气泡', hex: '蜂巢',
};

export const ABSTRACT_KINDS: readonly AbstractKind[] = [
	'rings', 'waves', 'burst', 'stripes', 'dots', 'grid', 'peaks', 'orbit', 'checker', 'rays', 'bubbles', 'hex',
];

export function abstractArt(kind: AbstractKind, variant: number): string {
	const v = variant % 2;
	switch (kind) {
		case 'rings':
			return v === 0
				? `<circle cx="32" cy="32" r="23" fill="none" stroke="${PAPER}" stroke-width="3.4" opacity="0.85"/>` +
				`<circle cx="32" cy="32" r="14" fill="none" stroke="${PAPER}" stroke-width="3" opacity="0.95"/>` +
				`<circle cx="32" cy="32" r="6" fill="${PAPER}"/>`
				: `<circle cx="24" cy="28" r="20" fill="none" stroke="${PAPER}" stroke-width="3" opacity="0.7"/>` +
				`<circle cx="40" cy="36" r="14" fill="none" stroke="${PAPER}" stroke-width="3" opacity="0.9"/>` +
				`<circle cx="40" cy="36" r="5" fill="${PAPER}"/>`;
		case 'waves':
			return `<path d="M6 24c7-7 13 7 20 0s13-7 20 0 12 7 18 0" stroke="${PAPER}" stroke-width="3.4" fill="none" stroke-linecap="round" opacity="0.9"/>` +
				`<path d="M6 36c7-7 13 7 20 0s13-7 20 0 12 7 18 0" stroke="${PAPER}" stroke-width="3.4" fill="none" stroke-linecap="round" opacity="0.7"/>` +
				(v === 0
					? `<path d="M6 48c7-7 13 7 20 0s13-7 20 0 12 7 18 0" stroke="${PAPER}" stroke-width="3.4" fill="none" stroke-linecap="round" opacity="0.5"/>`
					: `<circle cx="32" cy="12" r="5" fill="${PAPER}" opacity="0.9"/>`);
		case 'burst':
			return (v === 0
				? `<g stroke="${PAPER}" stroke-width="3.2" stroke-linecap="round" opacity="0.92">` +
				`<path d="M32 6v14M32 44v14M6 32h14M44 32h14M13.6 13.6l9.9 9.9M40.5 40.5l9.9 9.9M50.4 13.6l-9.9 9.9M23.5 40.5l-9.9 9.9"/>` +
				`</g><circle cx="32" cy="32" r="7" fill="${PAPER}"/>`
				: `<g stroke="${PAPER}" stroke-width="2.6" stroke-linecap="round" opacity="0.8">` +
				`<path d="M32 10v10M32 44v10M11 32h10M43 32h10M17.2 17.2l7 7M39.8 39.8l7 7M46.8 17.2l-7 7M24.2 39.8l-7 7"/>` +
				`</g><circle cx="32" cy="32" r="13" fill="none" stroke="${PAPER}" stroke-width="3" opacity="0.9"/>` +
				`<circle cx="32" cy="32" r="4.5" fill="${PAPER}"/>`);
		case 'stripes':
			return v === 0
				? `<g stroke="${PAPER}" stroke-width="5" stroke-linecap="round" opacity="0.88">` +
				`<path d="M2 50L50 2M12 60L60 12M2 34L34 2M30 60L60 30"/></g>`
				: `<g stroke="${PAPER}" stroke-width="4" stroke-linecap="round" opacity="0.88">` +
				`<path d="M62 50L14 2M52 60L4 12M62 34L30 2M34 60L2 30"/></g>`;
		case 'dots': {
			const out: string[] = [];
			for (let r = 0; r < 5; r++) {
				for (let c = 0; c < 5; c++) {
					const big = (r + c + v) % 3 === 0;
					out.push(`<circle cx="${10 + c * 11}" cy="${10 + r * 11}" r="${big ? 4.2 : 2.4}" fill="${PAPER}" opacity="${big ? 0.95 : 0.6}"/>`);
				}
			}
			return out.join('');
		}
		case 'grid': {
			const out: string[] = [];
			for (let r = 0; r < 4; r++) {
				for (let c = 0; c < 4; c++) {
					if ((r + c + v) % 3 === 0) { continue; }
					out.push(`<rect x="${8 + c * 13}" y="${8 + r * 13}" width="10" height="10" rx="2.5" fill="${PAPER}" opacity="0.85"/>`);
				}
			}
			return out.join('');
		}
		case 'peaks':
			return `<circle cx="${v === 0 ? 46 : 18}" cy="18" r="7" fill="${PAPER}" opacity="0.95"/>` +
				`<path d="M4 52l18-24 14 18z" fill="${PAPER}" opacity="0.95"/>` +
				`<path d="M24 52l16-20 20 20z" fill="${PAPER}" opacity="0.75"/>` +
				`<path d="M4 52h56" stroke="${PAPER}" stroke-width="3" stroke-linecap="round" opacity="0.6"/>`;
		case 'orbit':
			return `<circle cx="32" cy="32" r="9" fill="${PAPER}"/>` +
				`<ellipse cx="32" cy="32" rx="26" ry="11" fill="none" stroke="${PAPER}" stroke-width="2.6" opacity="0.85"/>` +
				`<ellipse cx="32" cy="32" rx="11" ry="26" fill="none" stroke="${PAPER}" stroke-width="2.6" opacity="0.55"/>` +
				(v === 0
					? `<circle cx="58" cy="32" r="4" fill="${PAPER}" opacity="0.95"/><circle cx="32" cy="6" r="3" fill="${PAPER}" opacity="0.8"/>`
					: `<circle cx="6" cy="32" r="4" fill="${PAPER}" opacity="0.95"/><circle cx="32" cy="58" r="3" fill="${PAPER}" opacity="0.8"/>`);
		case 'checker': {
			const out: string[] = [];
			for (let r = 0; r < 4; r++) {
				for (let c = 0; c < 4; c++) {
					if ((r + c + v) % 2 !== 0) { continue; }
					out.push(`<rect x="${6 + c * 13}" y="${6 + r * 13}" width="13" height="13" fill="${PAPER}" opacity="0.9"/>`);
				}
			}
			return out.join('');
		}
		case 'rays':
			return `<path d="M32 32L32 4A28 28 0 0 1 51.8 12.2z" fill="${PAPER}" opacity="0.9"/>` +
				`<path d="M32 32L51.8 51.8A28 28 0 0 1 12.2 51.8z" fill="${PAPER}" opacity="0.6"/>` +
				(v === 0
					? `<circle cx="32" cy="32" r="9" fill="${PAPER}"/>`
					: `<circle cx="32" cy="32" r="9" fill="none" stroke="${PAPER}" stroke-width="3"/>`);
		case 'bubbles':
			return v === 0
				? `<circle cx="20" cy="22" r="9" fill="${PAPER}" opacity="0.9"/><circle cx="43" cy="18" r="6" fill="${PAPER}" opacity="0.75"/>` +
				`<circle cx="48" cy="40" r="11" fill="${PAPER}" opacity="0.85"/><circle cx="24" cy="45" r="7" fill="${PAPER}" opacity="0.7"/>` +
				`<circle cx="34" cy="32" r="4" fill="${PAPER}" opacity="0.95"/><circle cx="12" cy="36" r="3.4" fill="${PAPER}" opacity="0.6"/>`
				: `<circle cx="32" cy="32" r="14" fill="${PAPER}" opacity="0.9"/><circle cx="32" cy="32" r="22" fill="none" stroke="${PAPER}" stroke-width="3" opacity="0.6"/>` +
				`<circle cx="52" cy="14" r="4" fill="${PAPER}" opacity="0.8"/><circle cx="12" cy="52" r="5" fill="${PAPER}" opacity="0.7"/>`;
		case 'hex':
			return `<defs><polygon id="hx" points="0,-9 7.8,-4.5 7.8,4.5 0,9 -7.8,4.5 -7.8,-4.5"/></defs>` +
				(v === 0
					? `<g fill="${PAPER}" opacity="0.9">` +
					`<use href="#hx" transform="translate(32,32)"/>` +
					`<use href="#hx" transform="translate(32,14) scale(0.62)"/>` +
					`<use href="#hx" transform="translate(48.5,23) scale(0.62)"/>` +
					`<use href="#hx" transform="translate(48.5,41) scale(0.62)"/>` +
					`<use href="#hx" transform="translate(32,50) scale(0.62)"/>` +
					`<use href="#hx" transform="translate(15.5,41) scale(0.62)"/>` +
					`<use href="#hx" transform="translate(15.5,23) scale(0.62)"/></g>`
					: `<g fill="none" stroke="${PAPER}" stroke-width="2.6" opacity="0.9">` +
					`<use href="#hx" transform="translate(32,32)"/>` +
					`<use href="#hx" transform="translate(32,14) scale(0.62)"/>` +
					`<use href="#hx" transform="translate(48.5,23) scale(0.62)"/>` +
					`<use href="#hx" transform="translate(48.5,41) scale(0.62)"/>` +
					`<use href="#hx" transform="translate(32,50) scale(0.62)"/>` +
					`<use href="#hx" transform="translate(15.5,41) scale(0.62)"/>` +
					`<use href="#hx" transform="translate(15.5,23) scale(0.62)"/></g>` +
					`<circle cx="32" cy="32" r="3.4" fill="${PAPER}"/>`);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
//  物件符号（手写几何，无法参数化的语义图形）
// ═══════════════════════════════════════════════════════════════════════════

export interface IObjectDef {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	readonly body: string;
}

export const OBJECT_DEFS: readonly IObjectDef[] = [
	{ id: 'book', label: '书本', icon: '📚', body: `<path d="M10 14h20c3 0 5 2 5 5v30c0-3-2-5-5-5H10z" fill="${PAPER}" opacity="0.95"/><path d="M54 14H34c-3 0-5 2-5 5v30c0-3 2-5 5-5h20z" fill="${PAPER}" opacity="0.75"/><path d="M32 19v30" stroke="${INK}" stroke-width="2" opacity="0.35"/>` },
	{ id: 'bulb', label: '灯泡', icon: '💡', body: `<circle cx="32" cy="26" r="15" fill="${PAPER}"/><rect x="25" y="41" width="14" height="7" rx="2" fill="${PAPER}" opacity="0.6"/><rect x="27" y="48" width="10" height="6" rx="2" fill="${PAPER}" opacity="0.4"/><path d="M26 26a6 6 0 0 1 12 0" stroke="${INK}" stroke-width="2" fill="none" opacity="0.35"/>` },
	{ id: 'gear', label: '齿轮', icon: '⚙️', body: `<circle cx="32" cy="32" r="18" fill="${PAPER}"/><circle cx="32" cy="32" r="7" fill="${INK}" opacity="0.35"/><g stroke="${PAPER}" stroke-width="6" stroke-linecap="round"><path d="M32 6v8M32 50v8M6 32h8M50 32h8M13.6 13.6l5.7 5.7M44.7 44.7l5.7 5.7M50.4 13.6l-5.7 5.7M19.3 44.7l-5.7 5.7"/></g>` },
	{ id: 'hammer', label: '锤子', icon: '🔨', body: `<rect x="10" y="12" width="30" height="14" rx="3" fill="${PAPER}" transform="rotate(-20 25 19)"/><rect x="30" y="28" width="8" height="30" rx="3" fill="${PAPER}" opacity="0.7" transform="rotate(-20 34 43)"/>` },
	{ id: 'shield', label: '盾牌', icon: '🛡️', body: `<path d="M32 8l20 7v18c0 13-9 21-20 24-11-3-20-11-20-24V15z" fill="${PAPER}"/><path d="M32 20v20" stroke="${INK}" stroke-width="3" stroke-linecap="round" opacity="0.3"/>` },
	{ id: 'key', label: '钥匙', icon: '🔑', body: `<circle cx="20" cy="22" r="10" fill="none" stroke="${PAPER}" stroke-width="5"/><path d="M27 29l24 24" stroke="${PAPER}" stroke-width="5" stroke-linecap="round"/><path d="M44 47l6 6M50 41l6 6" stroke="${PAPER}" stroke-width="4.4" stroke-linecap="round"/>` },
	{ id: 'pin', label: '图钉', icon: '📍', body: `<path d="M32 8c10 0 18 8 18 18 0 13-18 28-18 28S14 39 14 26c0-10 8-18 18-18z" fill="${PAPER}"/><circle cx="32" cy="26" r="7" fill="${INK}" opacity="0.35"/>` },
	{ id: 'bell', label: '铃铛', icon: '🔔', body: `<path d="M32 10c11 0 19 9 19 21v9H13v-9c0-12 8-21 19-21z" fill="${PAPER}"/><rect x="11" y="41" width="42" height="6" rx="3" fill="${PAPER}" opacity="0.75"/><circle cx="32" cy="52" r="5" fill="${PAPER}" opacity="0.6"/><path d="M32 6v4" stroke="${PAPER}" stroke-width="3.4" stroke-linecap="round"/>` },
	{ id: 'magnet', label: '磁铁', icon: '🧲', body: `<path d="M14 46V28a18 18 0 0 1 36 0v18" fill="none" stroke="${PAPER}" stroke-width="8" stroke-linecap="round"/><rect x="10" y="44" width="14" height="12" rx="3" fill="#F87171"/><rect x="40" y="44" width="14" height="12" rx="3" fill="#38BDF8"/>` },
	{ id: 'telescope', label: '望远镜', icon: '🔭', body: `<path d="M8 40l34-14 6 12-34 14z" fill="${PAPER}"/><path d="M44 30l12-5 3 7-12 5z" fill="${PAPER}" opacity="0.7"/><path d="M26 50l-6 10M34 46l4 12" stroke="${PAPER}" stroke-width="4" stroke-linecap="round"/>` },
	{ id: 'flask', label: '烧瓶', icon: '🧪', body: `<path d="M26 10h12v14l14 26a4 4 0 0 1-3.5 6H15.5a4 4 0 0 1-3.5-6l14-26z" fill="${PAPER}" opacity="0.9"/><path d="M17 42h30l6 8a4 4 0 0 1-3.5 6H15.5a4 4 0 0 1-3.5-6z" fill="#38BDF8" opacity="0.85"/><rect x="24" y="6" width="16" height="6" rx="2" fill="${PAPER}"/>` },
	{ id: 'chip', label: '芯片', icon: '💻', body: `<rect x="16" y="16" width="32" height="32" rx="5" fill="${PAPER}"/><rect x="24" y="24" width="16" height="16" rx="3" fill="${INK}" opacity="0.35"/><g stroke="${PAPER}" stroke-width="3.4" stroke-linecap="round"><path d="M24 16V8M40 16V8M24 48v8M40 48v8M16 24H8M16 40H8M48 24h8M48 40h8"/></g>` },
	{ id: 'cloud', label: '云', icon: '☁️', body: `<path d="M18 44a10 10 0 0 1 1-20 14 14 0 0 1 26 4 9 9 0 0 1 1 16z" fill="${PAPER}"/><path d="M20 50h26" stroke="${PAPER}" stroke-width="3" stroke-linecap="round" opacity="0.55"/>` },
	{ id: 'sun', label: '太阳', icon: '☀️', body: `<circle cx="32" cy="32" r="14" fill="${PAPER}"/><g stroke="${PAPER}" stroke-width="3.4" stroke-linecap="round" opacity="0.85"><path d="M32 6v8M32 50v8M6 32h8M50 32h8M13.6 13.6l5.7 5.7M44.7 44.7l5.7 5.7M50.4 13.6l-5.7 5.7M19.3 44.7l-5.7 5.7"/></g>` },
	{ id: 'rainbow', label: '彩虹', icon: '🌈', body: `<g fill="none" stroke-width="5" stroke-linecap="round"><path d="M8 50a24 24 0 0 1 48 0" stroke="#F87171"/><path d="M15 50a17 17 0 0 1 34 0" stroke="#FBBF24"/><path d="M22 50a10 10 0 0 1 20 0" stroke="#34D399"/><path d="M29 50a3 3 0 0 1 6 0" stroke="#60A5FA"/></g>` },
	{ id: 'music', label: '音符', icon: '🎵', body: `<path d="M26 44V16l22-6v28" stroke="${PAPER}" stroke-width="3.6" fill="none" stroke-linecap="round"/><ellipse cx="20" cy="46" rx="7" ry="6" fill="${PAPER}"/><ellipse cx="42" cy="40" rx="7" ry="6" fill="${PAPER}"/>` },
	{ id: 'palette', label: '调色板', icon: '🎨', body: `<path d="M32 8c15 0 26 10 26 22 0 8-6 12-12 12h-6c-5 0-8 3-8 7 0 4-3 7-7 7C15 56 6 45 6 32 6 18 18 8 32 8z" fill="${PAPER}"/><circle cx="20" cy="24" r="4" fill="#F87171"/><circle cx="32" cy="19" r="4" fill="#FBBF24"/><circle cx="44" cy="25" r="4" fill="#34D399"/><circle cx="44" cy="38" r="4" fill="#60A5FA"/>` },
	{ id: 'scissors', label: '剪刀', icon: '✂️', body: `<g stroke="${PAPER}" stroke-width="4" fill="none" stroke-linecap="round"><path d="M16 10l24 30M48 10L24 40"/><circle cx="16" cy="48" r="7"/><circle cx="48" cy="48" r="7"/></g>` },
	{ id: 'battery', label: '电池', icon: '🔋', body: `<rect x="8" y="20" width="44" height="24" rx="4" fill="none" stroke="${PAPER}" stroke-width="4"/><rect x="52" y="28" width="6" height="8" rx="2" fill="${PAPER}"/><rect x="14" y="26" width="12" height="12" rx="2" fill="#34D399"/><rect x="30" y="26" width="12" height="12" rx="2" fill="#34D399" opacity="0.6"/>` },
	{ id: 'wifi', label: '信号', icon: '📶', body: `<g fill="none" stroke="${PAPER}" stroke-width="4.4" stroke-linecap="round"><path d="M12 26a28 28 0 0 1 40 0"/><path d="M20 36a18 18 0 0 1 24 0"/><path d="M27 45a9 9 0 0 1 10 0"/></g><circle cx="32" cy="53" r="3.6" fill="${PAPER}"/>` },
	{ id: 'target', label: '靶心', icon: '🎯', body: `<circle cx="32" cy="32" r="24" fill="none" stroke="${PAPER}" stroke-width="4" opacity="0.9"/><circle cx="32" cy="32" r="15" fill="none" stroke="${PAPER}" stroke-width="4" opacity="0.7"/><circle cx="32" cy="32" r="6" fill="#F87171"/>` },
	{ id: 'hourglass', label: '沙漏', icon: '⏳', body: `<path d="M18 8h28M18 56h28" stroke="${PAPER}" stroke-width="4" stroke-linecap="round"/><path d="M20 8l12 16v16l-12 16M44 8L32 24v16l12 16" fill="none" stroke="${PAPER}" stroke-width="3.4" stroke-linejoin="round"/><path d="M22 46h20l-10-10z" fill="#FBBF24"/>` },
	{ id: 'crown', label: '皇冠', icon: '👑', body: `<path d="M10 46l4-28 10 12 8-18 8 18 10-12 4 28z" fill="${PAPER}"/><rect x="10" y="46" width="44" height="8" rx="3" fill="${PAPER}" opacity="0.75"/><circle cx="32" cy="22" r="3" fill="#F87171"/><circle cx="14" cy="26" r="2.6" fill="#60A5FA"/><circle cx="50" cy="26" r="2.6" fill="#34D399"/>` },
	{ id: 'wand', label: '魔法棒', icon: '🪄', body: `<path d="M14 52l22-22" stroke="${PAPER}" stroke-width="6" stroke-linecap="round"/><path d="M40 8l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="#FBBF24"/><circle cx="46" cy="26" r="2.6" fill="#FBBF24" opacity="0.8"/><circle cx="30" cy="14" r="2" fill="#FBBF24" opacity="0.7"/>` },
	{ id: 'clock', label: '时钟', icon: '🕐', body: `<circle cx="32" cy="32" r="24" fill="none" stroke="${PAPER}" stroke-width="4"/><path d="M32 18v15l10 6" stroke="${PAPER}" stroke-width="3.6" fill="none" stroke-linecap="round"/><circle cx="32" cy="32" r="2.6" fill="${PAPER}"/>` },
	{ id: 'compass', label: '指南针', icon: '🧭', body: `<circle cx="32" cy="32" r="24" fill="none" stroke="${PAPER}" stroke-width="4"/><path d="M42 22L26 30l-8 16 16-8z" fill="#F87171"/><circle cx="32" cy="32" r="2.6" fill="${PAPER}"/>` },
	{ id: 'mail', label: '信封', icon: '✉️', body: `<rect x="8" y="16" width="48" height="32" rx="4" fill="${PAPER}"/><path d="M8 20l24 16 24-16" fill="none" stroke="${INK}" stroke-width="3.4" opacity="0.35" stroke-linejoin="round"/>` },
	{ id: 'camera', label: '相机', icon: '📷', body: `<rect x="8" y="18" width="48" height="30" rx="5" fill="${PAPER}"/><circle cx="32" cy="33" r="10" fill="${INK}" opacity="0.4"/><circle cx="32" cy="33" r="4.6" fill="${PAPER}" opacity="0.9"/><rect x="38" y="12" width="12" height="7" rx="2" fill="${PAPER}" opacity="0.75"/>` },
	{ id: 'headphone', label: '耳机', icon: '🎧', body: `<path d="M12 36v-4a20 20 0 0 1 40 0v4" fill="none" stroke="${PAPER}" stroke-width="5" stroke-linecap="round"/><rect x="6" y="34" width="12" height="16" rx="5" fill="${PAPER}"/><rect x="46" y="34" width="12" height="16" rx="5" fill="${PAPER}"/>` },
	{ id: 'mic', label: '麦克风', icon: '🎤', body: `<rect x="24" y="8" width="16" height="28" rx="8" fill="${PAPER}"/><path d="M16 30a16 16 0 0 0 32 0" fill="none" stroke="${PAPER}" stroke-width="3.6" stroke-linecap="round"/><path d="M32 46v8M24 54h16" stroke="${PAPER}" stroke-width="3.6" stroke-linecap="round"/>` },
	{ id: 'brush', label: '画笔', icon: '🖌️', body: `<path d="M44 8l12 12-22 22-12-12z" fill="#FBBF24"/><path d="M22 42l-8 8 6 2-2 6 8-8z" fill="${PAPER}"/>` },
	{ id: 'ruler', label: '尺子', icon: '📏', body: `<rect x="6" y="22" width="52" height="20" rx="3" fill="${PAPER}" transform="rotate(-12 32 32)"/><g stroke="${INK}" stroke-width="2" opacity="0.35"><path d="M16 24v6M26 22v8M36 20v8M46 18v8" transform="rotate(-12 32 32)"/></g>` },
	{ id: 'lens', label: '放大镜', icon: '🔍', body: `<circle cx="27" cy="27" r="16" fill="none" stroke="${PAPER}" stroke-width="5"/><path d="M39 39l16 16" stroke="${PAPER}" stroke-width="6" stroke-linecap="round"/><path d="M20 20a10 10 0 0 1 8-4" stroke="${PAPER}" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.6"/>` },
	{ id: 'lock', label: '锁', icon: '🔒', body: `<rect x="14" y="28" width="36" height="26" rx="5" fill="${PAPER}"/><path d="M22 28v-8a10 10 0 0 1 20 0v8" fill="none" stroke="${PAPER}" stroke-width="5"/><circle cx="32" cy="40" r="4" fill="${INK}" opacity="0.4"/>` },
	{ id: 'umbrella', label: '雨伞', icon: '☂️', body: `<path d="M6 32a26 26 0 0 1 52 0z" fill="${PAPER}"/><path d="M32 32v20a8 8 0 0 0 16 0" fill="none" stroke="${PAPER}" stroke-width="4" stroke-linecap="round"/><path d="M6 32h52" stroke="${INK}" stroke-width="2" opacity="0.2"/>` },
	{ id: 'gift', label: '礼物', icon: '🎁', body: `<rect x="10" y="24" width="44" height="30" rx="3" fill="${PAPER}"/><rect x="8" y="16" width="48" height="10" rx="3" fill="${PAPER}" opacity="0.8"/><path d="M32 16v38" stroke="#F87171" stroke-width="5"/><path d="M32 16c-8-8-16-2-8 4M32 16c8-8 16-2 8 4" fill="none" stroke="#F87171" stroke-width="3.4" stroke-linecap="round"/>` },
	{ id: 'flag', label: '旗帜', icon: '🚩', body: `<path d="M18 8v48" stroke="${PAPER}" stroke-width="4.4" stroke-linecap="round"/><path d="M20 12h30l-7 10 7 10H20z" fill="#F87171"/>` },
	{ id: 'map', label: '地图', icon: '🗺️', body: `<path d="M8 16l18-6 14 6 16-6v38l-16 6-14-6-18 6z" fill="${PAPER}" opacity="0.92"/><path d="M26 10v40M40 16v38" stroke="${INK}" stroke-width="2.6" opacity="0.3"/>` },
	{ id: 'calc', label: '计算器', icon: '🧮', body: `<rect x="12" y="8" width="40" height="48" rx="5" fill="${PAPER}"/><rect x="18" y="14" width="28" height="12" rx="2" fill="${INK}" opacity="0.35"/><g fill="${INK}" opacity="0.45"><circle cx="22" cy="34" r="3"/><circle cx="32" cy="34" r="3"/><circle cx="42" cy="34" r="3"/><circle cx="22" cy="44" r="3"/><circle cx="32" cy="44" r="3"/><circle cx="42" cy="44" r="3"/></g>` },
	{ id: 'anchor', label: '锚', icon: '⚓', body: `<circle cx="32" cy="14" r="6" fill="none" stroke="${PAPER}" stroke-width="4"/><path d="M32 20v36" stroke="${PAPER}" stroke-width="4.4" stroke-linecap="round"/><path d="M16 32h32" stroke="${PAPER}" stroke-width="4.4" stroke-linecap="round"/><path d="M12 40a20 20 0 0 0 40 0" fill="none" stroke="${PAPER}" stroke-width="4.4" stroke-linecap="round"/>` },
	{ id: 'rocket2', label: '飞船', icon: '🛸', body: `<ellipse cx="32" cy="34" rx="26" ry="10" fill="${PAPER}"/><path d="M32 34c-8-4-8-14 0-20 8 6 8 16 0 20z" fill="${PAPER}" opacity="0.75"/><g fill="#38BDF8"><circle cx="20" cy="38" r="3"/><circle cx="32" cy="41" r="3"/><circle cx="44" cy="38" r="3"/></g>` },
];

// ═══════════════════════════════════════════════════════════════════════════
//  动物精品（手写，形态辨识度优先）
// ═══════════════════════════════════════════════════════════════════════════

export interface ICritterDef {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	readonly from: string;
	readonly to: string;
	readonly body: string;
}

export const CRITTER_DEFS: readonly ICritterDef[] = [
	{
		id: 'cat', label: '猫', icon: '🐱', from: '#FB7185', to: '#FDBA74',
		body: `<path d="M18 24L13 12l15 5z" fill="${PAPER}"/><path d="M46 24l5-12-15 5z" fill="${PAPER}"/>` +
			`<path d="M19 22l-4-8 8 3z" fill="#F472B6" opacity="0.55"/><path d="M45 22l4-8-8 3z" fill="#F472B6" opacity="0.55"/>` +
			`<ellipse cx="32" cy="38" rx="19" ry="16" fill="${PAPER}"/>` +
			`<circle cx="26" cy="35" r="3.1" fill="${INK}"/><circle cx="38" cy="35" r="3.1" fill="${INK}"/>` +
			`<path d="M32 40v2M32 42l-3 2M32 42l3 2" stroke="${INK}" stroke-width="1.8" fill="none" stroke-linecap="round"/>` +
			`<path d="M16 38h8M15 42h8M40 38h8M41 42h8" stroke="#CBD5E1" stroke-width="1.6" stroke-linecap="round"/>`,
	},
	{
		id: 'fox', label: '狐狸', icon: '🦊', from: '#0EA5E9', to: '#A78BFA',
		body: `<path d="M16 26L11 10l14 8z" fill="#FB923C"/><path d="M48 26l5-16-14 8z" fill="#FB923C"/>` +
			`<ellipse cx="32" cy="38" rx="19" ry="16" fill="#FB923C"/>` +
			`<ellipse cx="32" cy="43" rx="11" ry="8" fill="#FFF7ED"/>` +
			`<circle cx="25" cy="33" r="2.9" fill="${INK}"/><circle cx="39" cy="33" r="2.9" fill="${INK}"/>` +
			`<ellipse cx="32" cy="41" rx="2.6" ry="2" fill="${INK}"/>`,
	},
	{
		id: 'panda', label: '熊猫', icon: '🐼', from: '#34D399', to: '#22D3EE',
		body: `<circle cx="20" cy="20" r="7.5" fill="${INK}"/><circle cx="44" cy="20" r="7.5" fill="${INK}"/>` +
			`<ellipse cx="32" cy="39" rx="19" ry="16" fill="${PAPER}"/>` +
			`<ellipse cx="25" cy="35" rx="6" ry="7" fill="${INK}"/><ellipse cx="39" cy="35" rx="6" ry="7" fill="${INK}"/>` +
			`<circle cx="25" cy="35" r="2.6" fill="${PAPER}"/><circle cx="39" cy="35" r="2.6" fill="${PAPER}"/>` +
			`<ellipse cx="32" cy="44" rx="2.6" ry="2" fill="${INK}"/>`,
	},
	{
		id: 'rabbit', label: '兔子', icon: '🐰', from: '#F472B6', to: '#C084FC',
		body: `<ellipse cx="24" cy="19" rx="5" ry="12" fill="${PAPER}"/><ellipse cx="40" cy="19" rx="5" ry="12" fill="${PAPER}"/>` +
			`<ellipse cx="24" cy="19" rx="2.4" ry="8" fill="#F9A8D4"/><ellipse cx="40" cy="19" rx="2.4" ry="8" fill="#F9A8D4"/>` +
			`<ellipse cx="32" cy="41" rx="17" ry="14" fill="${PAPER}"/>` +
			`<circle cx="26" cy="39" r="3" fill="${INK}"/><circle cx="38" cy="39" r="3" fill="${INK}"/>` +
			`<ellipse cx="32" cy="45" rx="2.4" ry="1.8" fill="#F472B6"/>` +
			`<path d="M32 47v2M32 49l-3 2M32 49l3 2" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
	},
	{
		id: 'frog', label: '青蛙', icon: '🐸', from: '#0EA5E9', to: '#34D399',
		body: `<ellipse cx="32" cy="41" rx="20" ry="15" fill="#4ADE80"/>` +
			`<circle cx="22" cy="27" r="7" fill="#4ADE80"/><circle cx="42" cy="27" r="7" fill="#4ADE80"/>` +
			`<circle cx="22" cy="27" r="4.4" fill="${PAPER}"/><circle cx="42" cy="27" r="4.4" fill="${PAPER}"/>` +
			`<circle cx="22" cy="28" r="2.4" fill="${INK}"/><circle cx="42" cy="28" r="2.4" fill="${INK}"/>` +
			`<path d="M18 41c4 7 24 7 28 0" stroke="#166534" stroke-width="2.6" fill="none" stroke-linecap="round"/>`,
	},
	{
		id: 'penguin', label: '企鹅', icon: '🐧', from: '#38BDF8', to: '#818CF8',
		body: `<ellipse cx="32" cy="37" rx="18" ry="20" fill="${INK}"/>` +
			`<ellipse cx="32" cy="44" rx="12" ry="13" fill="${PAPER}"/>` +
			`<circle cx="26" cy="32" r="3" fill="${PAPER}"/><circle cx="38" cy="32" r="3" fill="${PAPER}"/>` +
			`<circle cx="26" cy="32" r="1.6" fill="${INK}"/><circle cx="38" cy="32" r="1.6" fill="${INK}"/>` +
			`<path d="M28 39l4 3 4-3z" fill="#F59E0B"/>` +
			`<path d="M22 56l-4 6M42 56l4 6" stroke="#F59E0B" stroke-width="3" stroke-linecap="round"/>`,
	},
	{
		id: 'owl', label: '猫头鹰', icon: '🦉', from: '#F59E0B', to: '#B45309',
		body: `<path d="M16 24l-3-10 13 5z" fill="#B45309"/><path d="M48 24l3-10-13 5z" fill="#B45309"/>` +
			`<ellipse cx="32" cy="39" rx="18" ry="18" fill="#B45309"/>` +
			`<circle cx="24" cy="35" r="8" fill="${PAPER}"/><circle cx="40" cy="35" r="8" fill="${PAPER}"/>` +
			`<circle cx="24" cy="35" r="3.6" fill="${INK}"/><circle cx="40" cy="35" r="3.6" fill="${INK}"/>` +
			`<path d="M32 40l-3 6h6z" fill="#F59E0B"/>` +
			`<path d="M22 50h20" stroke="#78350F" stroke-width="2" stroke-linecap="round"/>`,
	},
	{
		id: 'bee', label: '蜜蜂', icon: '🐝', from: '#FBBF24', to: '#F97316',
		body: `<path d="M28 16c-1-4 1-6 3-6M36 16c1-4-1-6-3-6" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"/>` +
			`<ellipse cx="32" cy="38" rx="16" ry="15" fill="#FACC15"/>` +
			`<path d="M22 27h20M20 47h24" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>` +
			`<ellipse cx="15" cy="31" rx="9" ry="5" fill="${PAPER}" opacity="0.8" transform="rotate(-25 15 31)"/>` +
			`<ellipse cx="49" cy="31" rx="9" ry="5" fill="${PAPER}" opacity="0.8" transform="rotate(25 49 31)"/>` +
			`<circle cx="26" cy="37" r="2.7" fill="${INK}"/><circle cx="38" cy="37" r="2.7" fill="${INK}"/>` +
			`<path d="M28 43c1.6 2 6.4 2 8 0" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
	},
	{
		id: 'whale', label: '鲸鱼', icon: '🐳', from: '#0EA5E9', to: '#1E3A8A',
		body: `<path d="M26 26c1-7 3-11 6-12" stroke="${PAPER}" stroke-width="3.4" fill="none" stroke-linecap="round"/>` +
			`<ellipse cx="29" cy="41" rx="22" ry="14" fill="#38BDF8"/>` +
			`<path d="M49 33l11-8v24l-11-8z" fill="#38BDF8"/>` +
			`<path d="M14 49c4 7 22 7 28 0z" fill="${PAPER}" opacity="0.85"/>` +
			`<circle cx="19" cy="37" r="3" fill="${INK}"/>`,
	},
	{
		id: 'chick', label: '小鸡', icon: '🐤', from: '#FCD34D', to: '#FB923C',
		body: `<path d="M32 21c-2-6 0-9 2-9s4 3 3 6" fill="#F97316"/>` +
			`<ellipse cx="32" cy="39" rx="17" ry="16" fill="#FDE047"/>` +
			`<circle cx="26" cy="35" r="2.8" fill="${INK}"/><circle cx="38" cy="35" r="2.8" fill="${INK}"/>` +
			`<path d="M28 43l4 3 4-3z" fill="#F97316"/>` +
			`<path d="M22 50l-5 5M42 50l5 5" stroke="#F97316" stroke-width="2.6" stroke-linecap="round"/>`,
	},
	{
		id: 'tiger', label: '老虎', icon: '🐯', from: '#F59E0B', to: '#DC2626',
		body: `<path d="M14 23l-2-9 11 5z" fill="#FB923C"/><path d="M50 23l2-9-11 5z" fill="#FB923C"/>` +
			`<ellipse cx="32" cy="39" rx="19" ry="16" fill="#FB923C"/>` +
			`<path d="M20 28h4M20 33h5M44 28h-4M44 33h-5" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>` +
			`<circle cx="26" cy="36" r="3" fill="${INK}"/><circle cx="38" cy="36" r="3" fill="${INK}"/>` +
			`<ellipse cx="32" cy="44" rx="6" ry="4.6" fill="${PAPER}"/>` +
			`<ellipse cx="32" cy="43" rx="2.4" ry="1.8" fill="${INK}"/>`,
	},
	{
		id: 'dog', label: '狗', icon: '🐶', from: '#D97706', to: '#78350F',
		body: `<ellipse cx="14" cy="35" rx="6" ry="11" fill="#92400E"/><ellipse cx="50" cy="35" rx="6" ry="11" fill="#92400E"/>` +
			`<ellipse cx="32" cy="39" rx="18" ry="16" fill="#D97706"/>` +
			`<circle cx="26" cy="35" r="3" fill="${INK}"/><circle cx="38" cy="35" r="3" fill="${INK}"/>` +
			`<ellipse cx="32" cy="45" rx="7" ry="5" fill="#FFF7ED"/>` +
			`<ellipse cx="32" cy="43" rx="2.8" ry="2.2" fill="${INK}"/>` +
			`<path d="M32 47v3M32 50l-3 2M32 50l3 2" stroke="${INK}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
	},
];
