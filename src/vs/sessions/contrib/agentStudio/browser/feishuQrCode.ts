/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 极简 QR Code 生成器（字节模式 / EC Level L / Version 1–7）──
// 自包含、零依赖，仅用于把飞书 PersonalAgent 注册的
// `verification_uri_complete` 渲染成可被飞书 App 扫描的二维码。
// 容量上限（EC-L）：V1≈17B … V7≈154B。超出时调用方应回落到“复制链接”方案。

// ─── GF(256) ────────────────────────────────────────────────

const EXP = new Array<number>(512);
const LOG = new Array<number>(256);

(function initGf(): void {
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 0x100) {
			x ^= 0x11d;
		}
	}
	for (let i = 255; i < 512; i++) {
		EXP[i] = EXP[i - 255];
	}
})();

function gfMul(a: number, b: number): number {
	if (a === 0 || b === 0) {
		return 0;
	}
	return EXP[LOG[a] + LOG[b]];
}

function gfPolyMul(a: number[], b: number[]): number[] {
	const res = new Array<number>(a.length + b.length - 1).fill(0);
	for (let i = 0; i < a.length; i++) {
		for (let j = 0; j < b.length; j++) {
			res[i + j] ^= gfMul(a[i], b[j]);
		}
	}
	return res;
}

function rsGenPoly(degree: number): number[] {
	let g: number[] = [1];
	for (let i = 0; i < degree; i++) {
		g = gfPolyMul(g, [1, EXP[i]]);
	}
	return g;
}

function rsEncode(data: number[], ecLen: number): number[] {
	const gen = rsGenPoly(ecLen);
	const res = data.concat(new Array<number>(ecLen).fill(0));
	for (let i = 0; i < data.length; i++) {
		const coef = res[i];
		if (coef !== 0) {
			for (let j = 0; j < gen.length; j++) {
				res[i + j] ^= gfMul(gen[j], coef);
			}
		}
	}
	return res.slice(data.length);
}

// ─── 版本表（EC Level L, V1–7）─────────────────────────────

// 每版本总数据码字数
const DATA_CW = [19, 34, 55, 80, 108, 136, 156];
// 每块 EC 码字数
const EC_PER_BLOCK = [7, 10, 15, 20, 26, 18, 20];
// 块数
const NUM_BLOCKS = [1, 1, 1, 1, 1, 2, 2];
// 单块数据码字数（用于拆分）
const DATA_PER_BLOCK = [19, 34, 55, 80, 108, 68, 78];
// 可编码字节上限 ≈ DATA_CW - 2（头部 12bit + 终止符）
const MAX_BYTES = [17, 32, 53, 78, 106, 134, 154];
// 对齐图案中心坐标（不含三个定位角）
const ALIGN_POS: number[][] = [
	[],            // V1 无
	[6, 18],      // V2
	[6, 22],      // V3
	[6, 26],      // V4
	[6, 30],      // V5
	[6, 34],      // V6
	[6, 22, 38],  // V7
];

class BitBuffer {
	public readonly bits: number[] = [];
	public put(num: number, len: number): void {
		for (let i = len - 1; i >= 0; i--) {
			this.bits.push((num >> i) & 1);
		}
	}
}

function chooseVersion(len: number): number {
	for (let v = 0; v < MAX_BYTES.length; v++) {
		if (len <= MAX_BYTES[v]) {
			return v;
		}
	}
	throw new Error(`QR: 数据过长（${len} 字节），超出 V7 容量上限，请改用链接方式`);
}

// ─── BCH（格式 / 版本信息）─────────────────────────────────

const G15 = 0b10100110111;
const G15_MASK = 0b101010000010010;
const G18 = 0b1111100100101;

function bch15(data5: number): number {
	let rem = data5 << 10;
	for (let i = 14; i >= 10; i--) {
		if ((rem >> i) & 1) {
			rem ^= G15 << (i - 10);
		}
	}
	return rem & 0x3ff;
}

function bch18(version: number): number {
	let rem = version << 12;
	for (let i = 17; i >= 12; i--) {
		if ((rem >> i) & 1) {
			rem ^= G18 << (i - 12);
		}
	}
	return rem & 0xfff;
}

function formatBits(mask: number, eclOrdinal: number): number {
	const data = (eclOrdinal << 3) | mask; // 5 bits
	const bits = ((data << 10) | bch15(data)) ^ G15_MASK;
	return bits & 0x7fff;
}

// ─── 掩码条件 ─────────────────────────────────────────────

function maskFn(row: number, col: number, mask: number): boolean {
	switch (mask) {
		case 0: return (row + col) % 2 === 0;
		case 1: return row % 2 === 0;
		case 2: return col % 3 === 0;
		case 3: return (row + col) % 3 === 0;
		case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
		case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
		case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
		case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
		default: return false;
	}
}

// ─── 主入口：生成布尔矩阵 ────────────────────────────────

export function qrMatrix(text: string): boolean[][] {
	const encoder = new TextEncoder();
	const data = Array.from(encoder.encode(text));
	const vIdx = chooseVersion(data.length);
	const version = vIdx + 1;
	const size = 21 + 4 * vIdx;
	const totalDataCw = DATA_CW[vIdx];
	const ecLen = EC_PER_BLOCK[vIdx];
	const numBlocks = NUM_BLOCKS[vIdx];
	const dataPerBlock = DATA_PER_BLOCK[vIdx];

	// 1. 比特流
	const buf = new BitBuffer();
	buf.put(0b0100, 4);            // byte mode
	buf.put(data.length, 8);       // 字符计数（V1–9 为 8bit）
	for (const b of data) {
		buf.put(b, 8);
	}
	const capBits = totalDataCw * 8;
	const term = Math.min(4, capBits - buf.bits.length);
	buf.put(0, term);
	while (buf.bits.length % 8 !== 0) {
		buf.put(0, 1);
	}
	const pad = [0xec, 0x11];
	let pi = 0;
	while (buf.bits.length < capBits) {
		buf.put(pad[pi++ % 2], 8);
	}
	const dataCw: number[] = [];
	for (let i = 0; i < buf.bits.length; i += 8) {
		let val = 0;
		for (let j = 0; j < 8; j++) {
			val = (val << 1) | buf.bits[i + j];
		}
		dataCw.push(val);
	}

	// 2. 分块 + RS 纠错
	const blocks: number[][] = [];
	for (let b = 0; b < numBlocks; b++) {
		blocks.push(dataCw.slice(b * dataPerBlock, (b + 1) * dataPerBlock));
	}
	const ecBlocks = blocks.map((b) => rsEncode(b, ecLen));

	// 3. 交织
	const allCw: number[] = [];
	for (let i = 0; i < dataPerBlock; i++) {
		for (const blk of blocks) {
			if (i < blk.length) {
				allCw.push(blk[i]);
			}
		}
	}
	for (let i = 0; i < ecLen; i++) {
		for (const blk of ecBlocks) {
			allCw.push(blk[i]);
		}
	}
	const allBits: number[] = [];
	for (const cw of allCw) {
		for (let i = 7; i >= 0; i--) {
			allBits.push((cw >> i) & 1);
		}
	}

	// 4. 基础矩阵（定位/对齐/数据，未掩码）
	const mod: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
	const func: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

	const placeFinder = (r: number, c: number): void => {
		for (let dr = -1; dr <= 7; dr++) {
			for (let dc = -1; dc <= 7; dc++) {
				const rr = r + dr;
				const cc = c + dc;
				if (rr < 0 || rr >= size || cc < 0 || cc >= size) {
					continue;
				}
				const inFinder =
					(dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
					(dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
					(dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
				mod[rr][cc] = inFinder ? 1 : 0;
				func[rr][cc] = true;
			}
		}
	};
	placeFinder(0, 0);
	placeFinder(0, size - 7);
	placeFinder(size - 7, 0);

	// 分隔符（finder 与 timing 之间）
	for (let i = 0; i < size; i++) {
		if (!func[7][i]) { func[7][i] = true; mod[7][i] = 0; }
		if (!func[i][7]) { func[i][7] = true; mod[i][7] = 0; }
	}

	// 定时图案
	for (let i = 8; i < size - 8; i++) {
		const val = i % 2 === 0 ? 1 : 0;
		if (!func[i][6]) { mod[i][6] = val; func[i][6] = true; }
		if (!func[6][i]) { mod[6][i] = val; func[6][i] = true; }
	}

	// 对齐图案
	for (const ar of ALIGN_POS[vIdx] || []) {
		for (const ac of ALIGN_POS[vIdx] || []) {
			// 跳过与定位角重叠
			if ((ar <= 7 && ac <= 7) || (ar <= 7 && ac >= size - 8) || (ar >= size - 8 && ac <= 7)) {
				continue;
			}
			for (let dr = -2; dr <= 2; dr++) {
				for (let dc = -2; dc <= 2; dc++) {
					const rr = ar + dr;
					const cc = ac + dc;
					const isCenter = dr === 0 && dc === 0;
					const isRing = Math.abs(dr) === 2 || Math.abs(dc) === 2;
					mod[rr][cc] = (isCenter || isRing) ? 1 : 0;
					func[rr][cc] = true;
				}
			}
		}
	}

	// 预留格式/版本信息区
	const reserve = (r: number, c: number): void => { func[r][c] = true; };
	for (let i = 0; i <= 8; i++) { reserve(8, i); reserve(i, 8); }
	for (let i = size - 8; i < size; i++) { reserve(8, i); reserve(i, 8); }

	// 暗模块
	mod[size - 8][8] = 1;
	func[size - 8][8] = true;

	// 版本信息区（V7）
	if (version >= 7) {
		for (let i = 0; i < 6; i++) {
			for (let j = 0; j < 3; j++) {
				reserve(i, size - 11 + j);
				reserve(size - 11 + j, i);
			}
		}
	}

	// 数据放置（锯齿，未掩码）
	let bitIndex = 0;
	let dir = true;
	let col = size - 1;
	while (col > 0) {
		if (col === 6) {
			col--;
		}
		for (let i = 0; i < size; i++) {
			const row = dir ? size - 1 - i : i;
			for (let b = 0; b < 2; b++) {
				const c = col - b;
				if (c < 0 || func[row][c]) {
					continue;
				}
				const bit = bitIndex < allBits.length ? allBits[bitIndex++] : 0;
				mod[row][c] = bit;
			}
		}
		dir = !dir;
		col -= 2;
	}

	// 5. 选择最优掩码
	let best: number[][] | undefined;
	let bestScore = Number.MAX_SAFE_INTEGER;
	for (let mask = 0; mask < 8; mask++) {
		const m = mod.map((row) => row.slice());
		for (let r = 0; r < size; r++) {
			for (let c = 0; c < size; c++) {
				if (!func[r][c] && maskFn(r, c, mask)) {
					m[r][c] ^= 1;
				}
			}
		}
		// 格式信息
		const fmt = formatBits(mask, 1 /* EC-L */);
		for (let i = 0; i < 15; i++) {
			const bit = (fmt >> i) & 1;
			if (i <= 5) { m[8][i] = bit; }
			else if (i === 6) { m[8][7] = bit; }
			else if (i === 7) { m[8][8] = bit; }
			else { m[8][size - 15 + i] = bit; }
			if (i < 8) { m[size - 1 - i][8] = bit; }
			else { m[14 - i][8] = bit; }
		}
		m[8][size - 8] = 1;
		// 版本信息
		if (version >= 7) {
			const vb = bch18(version);
			for (let i = 0; i < 18; i++) {
				const bit = (vb >> i) & 1;
				const r = Math.floor(i / 3);
				const c = size - 11 + (i % 3);
				m[r][c] = bit;
				m[size - 11 + (i % 3)][r] = bit;
			}
		}
		const score = penalty(m, size);
		if (score < bestScore) {
			bestScore = score;
			best = m;
		}
	}

	const result: boolean[][] = (best ?? mod).map((row) => row.map((v) => v === 1));
	return result;
}

function penalty(m: number[][], size: number): number {
	let score = 0;
	// 规则1：连续同色行/列
	const run = (get: (i: number) => number): void => {
		let prev = -1;
		let count = 0;
		for (let i = 0; i < size; i++) {
			const v = get(i);
			if (v === prev) {
				count++;
			} else {
				if (count >= 5) { score += 3 + (count - 5); }
				count = 1;
				prev = v;
			}
		}
		if (count >= 5) { score += 3 + (count - 5); }
	};
	for (let r = 0; r < size; r++) {
		run((i) => m[r][i]);
	}
	for (let c = 0; c < size; c++) {
		run((i) => m[i][c]);
	}
	// 规则2：2x2 同色块
	for (let r = 0; r < size - 1; r++) {
		for (let c = 0; c < size - 1; c++) {
			const v = m[r][c];
			if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) {
				score += 3;
			}
		}
	}
	// 规则3：类似 1011101 的明暗明暗明图案
	const pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
	const check = (arr: number[]): void => {
		let match = 0;
		for (let i = 0; i + 10 < arr.length; i++) {
			let ok = true;
			for (let k = 0; k < 11; k++) {
				if (arr[i + k] !== pattern[k]) { ok = false; break; }
			}
			if (ok) { match++; }
		}
		score += match * 40;
	};
	for (let r = 0; r < size; r++) {
		const row: number[] = [];
		for (let c = 0; c < size; c++) { row.push(m[r][c]); }
		check(row);
	}
	for (let c = 0; c < size; c++) {
		const col: number[] = [];
		for (let r = 0; r < size; r++) { col.push(m[r][c]); }
		check(col);
	}
	// 规则4：黑模块比例
	let dark = 0;
	for (let r = 0; r < size; r++) {
		for (let c = 0; c < size; c++) {
			if (m[r][c] === 1) { dark++; }
		}
	}
	const percent = (dark * 100) / (size * size);
	const k = Math.floor(Math.abs(percent - 50) / 5);
	score += k * 10;
	return score;
}

// ─── 画到 canvas ──────────────────────────────────────────

export function drawQrToCanvas(canvas: HTMLCanvasElement, text: string, opts?: { scale?: number; margin?: number }): void {
	const scale = opts?.scale ?? 6;
	const margin = opts?.margin ?? 4;
	const matrix = qrMatrix(text);
	const n = matrix.length;
	canvas.width = (n + margin * 2) * scale;
	canvas.height = (n + margin * 2) * scale;
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return;
	}
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.fillStyle = '#000000';
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			if (matrix[r][c]) {
				ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
			}
		}
	}
}
