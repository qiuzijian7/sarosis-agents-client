/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  tokenEmbedder.ts — token 级切块 + 均值池化（mean pooling）。
 *
 *  对标 Hyper-Extract 的 `CompatibleEmbeddings._split_texts` + running-mean 聚合：
 *   - 每段输入文本若超过 embedding API 的 token 上限（OpenAI 系为 8191），
 *     按 token 上限滑窗切成多段子文本，分别向量化，最后对同一原文的多段子向量
 *     做「均值池化」聚合回 1 个向量，保证「一段长文 = 1 个语义向量」。
 *   - 空白文本回填零向量（维度取首个非空向量），保持输出与输入 texts 同长度、同顺序。
 *   - 分批调用（maxBatchSize）以兼容对 batch size 有限制的 provider。
 *
 *  Tokenizer 选型：渲染进程 sandbox 禁止引入原生 / 大体积 WASM 依赖（如 tiktoken），
 *  这里采用零依赖的字符级近似（约 4 字符 ≈ 1 token，对 CJK 更保守地按 ~1.5 字符/token
 *  折算），足以驱动「超长块安全切分」这一核心诉求。若后续放开依赖，可替换 estimateTokens /
 *  splitByTokens 为精确 tiktoken 实现，其余聚合逻辑无需改动。
 *--------------------------------------------------------------------------------------------*/

/** embedFn：批量向量化函数（由 KbVectorIndex 注入，内部走 IEmbeddingService.embed）。 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface ITokenEmbedderOptions {
	/** 单段最大 token（默认 8191，OpenAI embedding 上限）。 */
	readonly maxTokens?: number;
	/** 每批子文本数量（默认 64；对 batch 上限低的 provider 可调小，如 10）。 */
	readonly maxBatchSize?: number;
	/** 相邻子块的 token 重叠（默认 0，纯切分）。 */
	readonly overlapTokens?: number;
}

const DEFAULT_MAX_TOKENS = 8191;
const DEFAULT_MAX_BATCH = 64;

/**
 * 估算文本 token 数（字符级近似）。
 * 对 ASCII 约 4 字符/token；对含大量 CJK 的文本按更保守的 ~1.6 字符/token 折算，
 * 取两者较大值，避免低估导致超限。
 */
export function estimateTokens(text: string): number {
	if (!text) { return 0; }
	const len = text.length;
	let cjk = 0;
	for (let i = 0; i < len; i++) {
		const code = text.charCodeAt(i);
		// 常见 CJK / 全角区间粗略判定
		if (code >= 0x2e80 && code <= 0x9fff || code >= 0xac00 && code <= 0xd7ff || code >= 0xf900 && code <= 0xfaff) {
			cjk++;
		}
	}
	const asciiEstimate = Math.ceil(len / 4);
	const cjkEstimate = Math.ceil(cjk / 1.6) + Math.ceil((len - cjk) / 4);
	return Math.max(asciiEstimate, cjkEstimate);
}

/**
 * 按 token 上限把单段文本切成多段子文本。
 * 使用字符级近似换算：maxChars ≈ maxTokens * 4；优先在最近的空白/换行边界断开，
 * 避免把一个词/句硬切两半。文本本身不超限时原样返回 [text]。
 */
export function splitByTokens(text: string, maxTokens = DEFAULT_MAX_TOKENS, overlapTokens = 0): string[] {
	if (!text) { return []; }
	if (estimateTokens(text) <= maxTokens) {
		return [text];
	}
	// 近似字符窗口。用较保守的 3.5 字符/token 以留安全边界。
	const maxChars = Math.max(1, Math.floor(maxTokens * 3.5));
	const overlapChars = Math.max(0, Math.floor(overlapTokens * 3.5));
	const parts: string[] = [];
	let pos = 0;
	const n = text.length;
	while (pos < n) {
		let end = Math.min(n, pos + maxChars);
		if (end < n) {
			// 在窗口尾部回退到最近的空白/换行，尽量对齐语义边界。
			const windowStart = Math.max(pos + Math.floor(maxChars * 0.6), pos + 1);
			let cut = -1;
			for (let i = end; i > windowStart; i--) {
				const ch = text.charCodeAt(i - 1);
				if (ch === 0x0a /* \n */ || ch === 0x20 /* space */ || ch === 0x09 /* tab */) {
					cut = i;
					break;
				}
			}
			if (cut > 0) { end = cut; }
		}
		const part = text.slice(pos, end);
		if (part.trim().length > 0) { parts.push(part); }
		if (end >= n) { break; }
		pos = overlapChars > 0 ? Math.max(end - overlapChars, pos + 1) : end;
	}
	return parts.length > 0 ? parts : [text];
}

/**
 * token 级切块 + 均值池化的批量向量化。
 *
 * @param embedFn   实际向量化函数（分批调用）。
 * @param texts     输入文本数组。
 * @param opts      切块 / 批处理参数。
 * @returns         与 texts 一一对应的向量数组（长度、顺序一致；空白文本为零向量）。
 */
export async function embedWithPooling(
	embedFn: EmbedFn,
	texts: string[],
	opts?: ITokenEmbedderOptions,
): Promise<number[][]> {
	const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
	const maxBatch = Math.max(1, opts?.maxBatchSize ?? DEFAULT_MAX_BATCH);
	const overlap = opts?.overlapTokens ?? 0;

	// 1. 切分：记录每个子文本归属的原始 index。
	const subTexts: string[] = [];
	const originIndex: number[] = [];
	for (let i = 0; i < texts.length; i++) {
		const t = texts[i];
		if (!t || t.trim().length === 0) { continue; } // 空白 → 后续回填零向量
		for (const part of splitByTokens(t, maxTokens, overlap)) {
			subTexts.push(part);
			originIndex.push(i);
		}
	}

	// 2. 分批向量化子文本。
	const subVectors: number[][] = [];
	for (let i = 0; i < subTexts.length; i += maxBatch) {
		const batch = subTexts.slice(i, i + maxBatch);
		const vecs = await embedFn(batch);
		for (const v of vecs) { subVectors.push(v); }
	}

	// 3. 探测维度（首个非空向量）。
	let dim = 0;
	for (const v of subVectors) {
		if (v && v.length > 0) { dim = v.length; break; }
	}

	// 4. running-mean 聚合到原文粒度。
	const sums: (Float64Array | null)[] = new Array(texts.length).fill(null);
	const counts: number[] = new Array(texts.length).fill(0);
	for (let k = 0; k < subVectors.length; k++) {
		const v = subVectors[k];
		if (!v || v.length === 0) { continue; }
		const oi = originIndex[k];
		let acc = sums[oi];
		if (!acc) { acc = new Float64Array(v.length); sums[oi] = acc; }
		const m = Math.min(acc.length, v.length);
		for (let d = 0; d < m; d++) { acc[d] += v[d]; }
		counts[oi]++;
	}

	// 5. 生成与 texts 对齐的输出（空白 / 失败 → 零向量）。
	const out: number[][] = new Array(texts.length);
	for (let i = 0; i < texts.length; i++) {
		const acc = sums[i];
		const c = counts[i];
		if (acc && c > 0) {
			const arr = new Array<number>(acc.length);
			for (let d = 0; d < acc.length; d++) { arr[d] = acc[d] / c; }
			out[i] = arr;
		} else {
			out[i] = dim > 0 ? new Array<number>(dim).fill(0) : [];
		}
	}
	return out;
}
