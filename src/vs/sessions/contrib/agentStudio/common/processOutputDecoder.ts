/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 子进程输出的字节流解码（纯逻辑，零 Node 依赖 —— 只用全局 `TextDecoder`/`Uint8Array`，
 * 故可同时被 electron-main 与 browser 层引用）。
 *
 * ## 事故（2026-08-22，日志 1787363991734）
 *
 * `execute_code` 里 PowerShell 的中文错误信息进入 LLM 上下文时是 mojibake：
 *
 *   实际输出（CP936 字节）: D5 D2 B2 BB B5 BD C2 B7 BE B6  = "找不到路径"
 *   模型收到:               "�Ҳ���·��"
 *
 * 实测复现（`new TextDecoder('utf-8').decode(那串字节)`）得到的正是日志里那串乱码 ——
 * 根因确认。**模型读到乱码错误信息，无法据此自纠**，只能瞎猜或重试。
 *
 * ## 两个独立缺陷
 *
 * 1. **编码假设错**：`data.toString()` 无参数即按 UTF-8 解码。Windows 控制台默认代码页
 *    是 CP936（简体中文），PowerShell/cmd **自身**的错误信息按该代码页输出。
 *    （注意 Python 脚本的输出没问题 —— 我们设了 `PYTHONIOENCODING=utf-8`；
 *     出问题的是 shell 自己的报错。）
 *
 * 2. **★ 逐 chunk 解码会切断多字节字符**：原实现 `stdout += data.toString()` 对**每个
 *    chunk** 单独解码。`'data'` 事件的分块边界由内核缓冲决定，一个 UTF-8 汉字（3 字节）
 *    或 GBK 汉字（2 字节）完全可能被切在两个 chunk 里 —— 此时**即使编码猜对了**，
 *    边界字符仍然是乱码。输出越大越容易踩到。
 *    修法：收集 chunk 到数组，进程结束后**一次性**解码完整字节流。
 *
 * ## 解码策略：先 UTF-8（fatal）后回退
 *
 * UTF-8 是**自校验**编码：任意 CP936/GBK 字节序列按 UTF-8 严格解码几乎必然失败
 * （`fatal: true` 会抛异常）。反之 UTF-8 字节按 GBK 解不会报错、但会得到乱码。
 * 因此顺序只能是「先严格试 UTF-8，失败才回退本地编码」，不可颠倒。
 *
 * 这也自动覆盖了「stdout 是 Python 的 UTF-8、stderr 是 shell 的 GBK」这种混合场景 ——
 * 两个流各自独立解码，天然分离。
 *
 * （参考 continue `core/util/processOutput.ts` 的同类启发式：先 UTF-8，检出替换字符
 *  则回退 GBK。这里改用 `fatal: true` 抛异常做判据，比检测 U+FFFD 更准 —— 原文本身
 *  就可能合法地含有 U+FFFD。）
 */

/** UTF-8 BOM。 */
const BOM_UTF8 = [0xef, 0xbb, 0xbf] as const;

/**
 * iconv-lite / chcp 风格的编码名 → WHATWG encoding label。
 *
 * 必要性：`resolveTerminalEncoding()`（`base/node/terminalEncoding.ts`）返回的是
 * iconv-lite 名（`cp936`/`cp1252`…），而 `TextDecoder` 只认 WHATWG label ——
 * 实测 `new TextDecoder('cp936')` 直接抛 "encoding is not supported"，
 * 而 `'gbk'` 正常工作。少了这层映射，回退路径会静默失效。
 */
const ICONV_TO_WHATWG: Readonly<Record<string, string>> = {
	cp936: 'gbk',
	cp950: 'big5',
	cp1252: 'windows-1252',
	cp866: 'ibm866',
	cp850: 'ibm850',
	cp852: 'ibm852',
	cp855: 'ibm855',
	cp857: 'ibm857',
	cp862: 'ibm862',
	// 注：cp437/860/861/863/865/869 无对应 WHATWG label，_safeDecoder 返回 undefined
	// 后由候选链继续尝试 gbk / windows-1252，最终有 lossy 兜底。
};

/** 把编码名归一为 `TextDecoder` 可接受的 label；不可用时返回 undefined。 */
function _toWhatwgLabel(encoding: string | undefined): string | undefined {
	if (!encoding) { return undefined; }
	const norm = encoding.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
	if (norm === 'utf8' || norm === 'utf-8') { return 'utf-8'; }
	return ICONV_TO_WHATWG[norm] ?? norm;
}

/** 构造 TextDecoder；label 不被支持时返回 undefined（而非抛错）。 */
function _safeDecoder(label: string, fatal: boolean): TextDecoder | undefined {
	try {
		return new TextDecoder(label, { fatal });
	} catch {
		return undefined;
	}
}

/** 剥掉 UTF-8 BOM（PowerShell 的 Out-File 默认带 BOM）。 */
function _stripUtf8Bom(bytes: Uint8Array): Uint8Array {
	if (bytes.length >= 3 && bytes[0] === BOM_UTF8[0] && bytes[1] === BOM_UTF8[1] && bytes[2] === BOM_UTF8[2]) {
		return bytes.subarray(3);
	}
	return bytes;
}

/** 是否带 UTF-16 BOM（PowerShell 5.1 某些重定向输出是 UTF-16LE）。 */
function _utf16Label(bytes: Uint8Array): string | undefined {
	if (bytes.length >= 2) {
		if (bytes[0] === 0xff && bytes[1] === 0xfe) { return 'utf-16le'; }
		if (bytes[0] === 0xfe && bytes[1] === 0xff) { return 'utf-16be'; }
	}
	return undefined;
}

/** 解码结果（`encoding` 便于日志复盘实际走了哪条路）。 */
export interface IDecodedProcessOutput {
	readonly text: string;
	/** 实际生效的编码 label。 */
	readonly encoding: string;
	/** 是否回退到了本地编码（true 说明该流不是 UTF-8）。 */
	readonly usedFallback: boolean;
}

/**
 * 解码子进程输出字节流。
 *
 * @param bytes 完整字节流 —— **必须是拼接后的完整流**，不可逐 chunk 调用
 *              （见模块头注释缺陷 2）。
 * @param localEncoding 本地控制台编码（Windows 下由 `resolveTerminalEncoding()` 探测，
 *                      如 `cp936`）。缺省时回退用 `gbk`（简中 Windows 最常见），
 *                      非 Windows 平台传 `'utf8'` 即可让本函数永不回退。
 */
export function decodeProcessOutput(
	bytes: Uint8Array,
	localEncoding?: string,
): IDecodedProcessOutput {
	if (bytes.length === 0) { return { text: '', encoding: 'utf-8', usedFallback: false }; }

	// ① UTF-16 BOM 是无歧义的，优先处理
	const u16 = _utf16Label(bytes);
	if (u16) {
		const dec = _safeDecoder(u16, false);
		if (dec) {
			return { text: dec.decode(bytes.subarray(2)), encoding: u16, usedFallback: true };
		}
	}

	const body = _stripUtf8Bom(bytes);

	// ② 严格试 UTF-8。成功即采用 —— UTF-8 自校验，通过说明极可能确实是 UTF-8。
	const strict = _safeDecoder('utf-8', true);
	if (strict) {
		try {
			return { text: strict.decode(body), encoding: 'utf-8', usedFallback: false };
		} catch {
			// 含非法 UTF-8 序列 → 落到本地编码
		}
	}

	// ③ 回退本地编码。localEncoding 未探测到时用 gbk（简中 Windows 最常见）。
	const label = _toWhatwgLabel(localEncoding);
	const candidates = [label, 'gbk', 'windows-1252'].filter((l): l is string => !!l && l !== 'utf-8');
	for (const c of candidates) {
		const dec = _safeDecoder(c, false);
		if (dec) {
			return { text: dec.decode(body), encoding: c, usedFallback: true };
		}
	}

	// ④ 兜底：非 fatal 的 UTF-8（用 U+FFFD 替换非法字节，至少不丢长度）
	const lossy = _safeDecoder('utf-8', false);
	return {
		text: lossy ? lossy.decode(body) : '',
		encoding: 'utf-8(lossy)',
		usedFallback: true,
	};
}

/**
 * 收集子进程某个流的字节块，并在结束时一次性解码。
 *
 * 之所以提供这个小工具而不是让调用方自己 `Buffer.concat` —— 调用点有三处
 * （主进程 handler / renderer fallback 的 stdout / stderr），复制粘贴容易漏掉
 * 「必须整体解码」这一约束，退回逐 chunk 解码的老 bug。
 */
export class ProcessOutputCollector {
	private readonly _chunks: Uint8Array[] = [];
	private _totalLength = 0;

	/** 累积一个 chunk。接受 Buffer（Buffer 是 Uint8Array 的子类）。 */
	push(chunk: Uint8Array): void {
		this._chunks.push(chunk);
		this._totalLength += chunk.length;
	}

	/** 当前累积字节数（用于超限保护）。 */
	get byteLength(): number { return this._totalLength; }

	/** 拼接并解码。可多次调用（超时路径会先读一次，随后 close 再读）。 */
	decode(localEncoding?: string): string {
		if (this._chunks.length === 0) { return ''; }
		const merged = new Uint8Array(this._totalLength);
		let offset = 0;
		for (const c of this._chunks) {
			merged.set(c, offset);
			offset += c.length;
		}
		return decodeProcessOutput(merged, localEncoding).text;
	}
}
