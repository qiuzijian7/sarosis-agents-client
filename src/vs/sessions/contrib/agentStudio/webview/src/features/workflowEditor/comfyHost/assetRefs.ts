/*---------------------------------------------------------------------------------------------
 *  assetRefs — Stage 卡片的「资产引用」（Asset References）数据层。
 *
 *  对齐 ComfyTV 源码：
 *    - `src/composables/stages/imageRefs.ts`   → 存储格式 + 读写 + 订阅
 *    - `src/composables/stages/assetSlots.ts`  → slot 分配 / 校验 / 注入
 *    - `src/composables/stages/imageSlotMentions.ts` → slotColor
 *
 *  ## 语义
 *  Stage 节点除了「连线」拿上游图，还可以**钉住**（pin）任意资产作为参考图：
 *  每条引用占一个 **slot**（`images.image{N}` / `videos.video{N}` / `audio.audio{N}`），
 *  执行时由 `injectAssetRefs` 写进 workflow inputs，**覆盖**同 slot 的连线输入。
 *
 *  ## 与 ComfyTV 的差异（本项目无 assetStore/后端资产库）
 *  ComfyTV 用 `asset_id`（后端资产表主键）+ `batch_id/batch_index`（pinned batch）。
 *  本项目的资产来源是 `MediaSnapshotStore`（IndexedDB 快照），天然以 **media ref
 *  字符串**（http URL / data: URL）为身份，因此这里存 `ref` + 可选 `label`，
 *  不再存 asset_id。存储属性名沿用 ComfyTV 的 `comfytv_image_refs`，便于将来
 *  与 ComfyTV 工作流互操作。
 *--------------------------------------------------------------------------------------------*/

/** node.properties 上的存储键（与 ComfyTV 一致）。 */
export const ASSET_REFS_PROP = 'comfytv_image_refs';

export type AssetRefType = 'image' | 'video' | 'audio';

export interface AssetRef {
	/** 媒体引用（http(s) URL / data: URL / 快照 key）。 */
	ref: string;
	/** 目标 slot 序号（0 基）。 */
	slot: number;
	/** 媒体类型；缺省视为 image（对齐 ComfyTV refType）。 */
	type?: AssetRefType;
	/** 展示用标签（可选，缺省用 `#slot`）。 */
	label?: string;
}

/** 归一化类型（对齐 ComfyTV `refType`）。 */
export function refType(r: AssetRef): AssetRefType {
	return r.type === 'video' || r.type === 'audio' ? r.type : 'image';
}

/** 去重键（同一 ref 只允许钉一次）。 */
export function refKey(r: AssetRef): string {
	return `${refType(r)}:${r.ref}`;
}

/** slot 配色（对齐 ComfyTV SLOT_COLORS，用于 tile 描边 + 角标）。 */
export const SLOT_COLORS = ['#60A5FA', '#FB923C', '#4ADE80', '#F472B6', '#A78BFA', '#22D3EE'];

export function slotColor(slot: number): string {
	const n = SLOT_COLORS.length;
	return SLOT_COLORS[((slot % n) + n) % n];
}

/** slot 角标文案（对齐 ComfyTV：图 `#N`、视频 `VN`、音频 `A`）。 */
export function slotBadge(r: AssetRef): string {
	const t = refType(r);
	return t === 'video' ? `V${r.slot}` : t === 'audio' ? 'A' : `#${r.slot}`;
}

/* ------------------------------------------------------------------ *
 * 读写 + 订阅（对齐 ComfyTV imageRefs.ts）
 * ------------------------------------------------------------------ */

interface NodeLike { properties?: Record<string, unknown> }

/** 从 node.properties 读回引用列表（脏数据静默丢弃）。 */
export function readAssetRefs(node: unknown): AssetRef[] {
	const raw = (node as NodeLike | null)?.properties?.[ASSET_REFS_PROP];
	if (!Array.isArray(raw)) { return []; }
	const out: AssetRef[] = [];
	for (const item of raw) {
		const rec = item as Partial<AssetRef> | null;
		const ref = typeof rec?.ref === 'string' ? rec.ref : '';
		if (!ref) { continue; }
		const slot = typeof rec?.slot === 'number' && Number.isInteger(rec.slot) ? rec.slot : NaN;
		if (!Number.isInteger(slot) || slot < 0) { continue; }
		const type = rec?.type === 'video' || rec?.type === 'audio' ? rec.type : undefined;
		const label = typeof rec?.label === 'string' && rec.label ? rec.label : undefined;
		out.push({ ref, slot, ...(type ? { type } : {}), ...(label ? { label } : {}) });
	}
	return out;
}

const refListeners = new WeakMap<object, Set<() => void>>();

/** 订阅某节点引用列表的变化（返回退订函数）。 */
export function subscribeAssetRefs(node: unknown, listener: () => void): () => void {
	if (!node || typeof node !== 'object') { return () => { /* no-op */ }; }
	let set = refListeners.get(node);
	if (!set) { set = new Set(); refListeners.set(node, set); }
	set.add(listener);
	return () => { set?.delete(listener); };
}

/** 写回 node.properties 并通知订阅者。 */
export function writeAssetRefs(node: unknown, refs: AssetRef[]): void {
	const n = node as NodeLike | null;
	if (!n) { return; }
	if (!n.properties) { n.properties = {}; }
	n.properties[ASSET_REFS_PROP] = refs.map(r => ({
		ref: r.ref,
		slot: r.slot,
		...(r.type ? { type: r.type } : {}),
		...(r.label ? { label: r.label } : {}),
	}));
	refListeners.get(n as object)?.forEach(fn => fn());
}

/* ------------------------------------------------------------------ *
 * slot 分配 / 已连线探测（对齐 ComfyTV assetSlots.ts）
 * ------------------------------------------------------------------ */

export const AUTOGROW_IMAGE_KEY_RE = /^images\.image(\d+)$/;
export const AUTOGROW_VIDEO_KEY_RE = /^videos\.video(\d+)$/;
export const AUTOGROW_AUDIO_KEY_RE = /^audio\.audio(\d+)$/;

function slotRe(type: AssetRefType): RegExp {
	return type === 'video' ? AUTOGROW_VIDEO_KEY_RE
		: type === 'audio' ? AUTOGROW_AUDIO_KEY_RE
			: AUTOGROW_IMAGE_KEY_RE;
}

/** 节点上「已连线」的 slot 序号（该 slot 由上游提供，pin 会覆盖它）。 */
export function wiredSlots(node: unknown, type: AssetRefType = 'image'): number[] {
	const inputs = (node as { inputs?: Array<{ name?: unknown; link?: unknown }> } | null)?.inputs;
	if (!Array.isArray(inputs)) { return []; }
	const re = slotRe(type);
	const out: number[] = [];
	for (const i of inputs) {
		if (typeof i?.name !== 'string' || i.link == null) { continue; }
		if (type === 'audio' && i.name === 'audio') { out.push(0); continue; }
		const m = re.exec(i.name);
		if (m) { out.push(Number(m[1])); }
	}
	return [...new Set(out)].sort((a, b) => a - b);
}

/** 下一个空闲 slot（跳过已连线与已占用，对齐 ComfyTV nextFreeSlot）。 */
export function nextFreeSlot(node: unknown, refs: AssetRef[], type: AssetRefType = 'image'): number {
	const taken = new Set<number>([
		...wiredSlots(node, type),
		...refs.filter(r => refType(r) === type).map(r => r.slot),
	]);
	let i = 0;
	while (taken.has(i)) { i++; }
	return i;
}

/* ------------------------------------------------------------------ *
 * 校验（对齐 ComfyTV refSlotWarnings）
 * ------------------------------------------------------------------ */

export type RefSlotWarning =
	| { kind: 'duplicate'; slot: number }
	| { kind: 'override'; slot: number };

/** slot 冲突检查：同 slot 钉两次 / 覆盖了上游连线。 */
export function refSlotWarnings(refs: AssetRef[], wired: number[]): RefSlotWarning[] {
	if (refs.length === 0) { return []; }
	const out: RefSlotWarning[] = [];
	const counts = new Map<number, number>();
	for (const r of refs) { counts.set(r.slot, (counts.get(r.slot) ?? 0) + 1); }
	const wiredSet = new Set(wired);
	for (const [slot, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
		if (count > 1) { out.push({ kind: 'duplicate', slot }); }
		if (wiredSet.has(slot)) { out.push({ kind: 'override', slot }); }
	}
	return out;
}

/** 警告文案（中文，对齐 ComfyTV locales imageRefs.warn*）。 */
export function warningText(w: RefSlotWarning): string {
	switch (w.kind) {
		case 'duplicate': return `slot #${w.slot} 被钉了两次 —— 后一个生效`;
		case 'override': return `slot #${w.slot} 已有上游连线 —— 钉住的资产会覆盖它`;
	}
}

/* ------------------------------------------------------------------ *
 * 注入执行入参（对齐 ComfyTV injectAssetRefs）
 * ------------------------------------------------------------------ */

/**
 * 把引用写进 workflow 执行入参（`images.image{N}` 等），返回警告文案。
 * 同 slot 后者覆盖前者；已有连线的 slot 被 pin 覆盖（与 ComfyTV 一致）。
 */
export function injectAssetRefs(inputs: Record<string, unknown>, refs: AssetRef[]): string[] {
	if (refs.length === 0) { return []; }

	const wiredOf = (re: RegExp): Set<number> => {
		const out = new Set<number>();
		for (const key of Object.keys(inputs)) {
			const m = re.exec(key);
			if (m) { out.add(Number(m[1])); }
		}
		return out;
	};
	const wired: Record<AssetRefType, Set<number>> = {
		image: wiredOf(AUTOGROW_IMAGE_KEY_RE),
		video: wiredOf(AUTOGROW_VIDEO_KEY_RE),
		audio: new Set<number>([...wiredOf(AUTOGROW_AUDIO_KEY_RE), ...('audio' in inputs ? [0] : [])]),
	};

	const warnings: string[] = [];
	const seen: Record<AssetRefType, Set<number>> = { image: new Set(), video: new Set(), audio: new Set() };
	for (const r of refs) {
		const t = refType(r);
		if (seen[t].has(r.slot)) {
			warnings.push(warningText({ kind: 'duplicate', slot: r.slot }));
		} else if (wired[t].has(r.slot)) {
			warnings.push(warningText({ kind: 'override', slot: r.slot }));
		}
		seen[t].add(r.slot);
	}

	for (const r of refs) {
		const t = refType(r);
		if (t === 'video') {
			inputs[`videos.video${r.slot}`] = r.ref;
		} else if (t === 'audio') {
			if ('audio' in inputs) { inputs['audio'] = r.ref; }
			else { inputs[`audio.audio${r.slot}`] = r.ref; }
		} else {
			inputs[`images.image${r.slot}`] = r.ref;
		}
	}
	return warnings;
}
