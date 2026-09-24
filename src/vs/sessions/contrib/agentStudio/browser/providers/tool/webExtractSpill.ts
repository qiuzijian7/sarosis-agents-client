/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `web_extract` 超限正文的落盘决策（纯逻辑，零 IO —— IO 留在调用侧，与 `execOutputSpill` 同一分工）。
 *
 * ## 动机（对比 Hermes-Agent 后补，2026-09-24）
 *
 * 此前 `web_extract` 对超限页面只有**硬截断**：`text.slice(0, LIMIT)` + 一条截断告警。
 * 中段与尾部**永久丢失** —— 而长文的关键结论常常在尾部（Hermes 因此选头 75% / 尾 25%）。
 * 模型唯一的补救是重抓一遍同一 URL，既慢又拿不到更多。
 *
 * 现在的处置与仓库里 `execute_code` / `terminal` 的落盘**同一套约定**：
 *   · 内联返回**头 + 省略标记 + 尾**（都切在行边界）；
 *   · 全量正文写入 `~/.vssaros/tmp/`（沙箱允许根之一 ⇒ 模型后续 `file_read` / `search_code`
 *     读它不会触发越界确认卡；写工作区则会污染用户仓库与 git status）；
 *   · 返回里告知路径 + **可直接执行**的检索方式，并明确劝阻重抓；
 *   · IO 失败（磁盘/权限）时调用方退化为纯截断 —— 落盘只是优化，不是依赖。
 *
 * ## 为什么阈值是「工具的输出预算」而不是 64KB
 *
 * `execOutputSpill` 的阈值是 64KB（命令输出本来就没有内联预算）；而 `web_extract` 有明确预算
 * （`WEB_EXTRACT_CHAR_LIMIT`）——**超出预算就是超限**，与绝对大小无关。所以这里按调用方给的
 * `charLimit` 判定，并复用同一套命名/回收策略常量（避免策略漂移）。
 */

import { SPILL_MAX_AGE_MS, SPILL_MAX_FILES } from './execOutputSpill.js';

/** 内联片段里头部占的比例（其余给尾部）—— 与 Hermes 的 head75/tail25 一致。 */
export const WEB_EXTRACT_SPILL_HEAD_RATIO = 0.75;

/** 落盘文件名前缀（回收时据此只删自己写的文件）。 */
const SPILL_NAME_PREFIX = 'web-extract-';

const SPILL_NAME_PATTERN = /^web-extract-\d{8}-\d{6}-\d{3}-\d{3}\.txt$/;

export interface IExtractExcerpt {
	/** 正文是否超出预算（超出才谈得上落盘）。 */
	readonly shouldSpill: boolean;
	/**
	 * 内联返回的片段：未超限时是**原文**；超限时是「头 + 省略标记 + 尾」。
	 * 长度**必定 ≤ charLimit**，所以可以直接交给格式化层而不触发它自己的截断告警。
	 */
	readonly inlineExcerpt: string;
	/** 正文总长度（字符），用于告知模型"丢了多少"。 */
	readonly totalChars: number;
}

/** 落盘成功时的省略标记 —— **必须自带路径**（见下方"为什么标记要带路径"）。 */
export function spillMarkerWithPath(filePath: string): string {
	return `\n\n... (middle omitted — the COMPLETE text is saved to: ${filePath}) ...\n\n`;
}

/** 落盘失败（IO 出错）时的省略标记：如实说"没能保存"，不假装有文件可读。 */
export function spillMarkerWithoutPath(reason: string): string {
	return `\n\n... (middle omitted — the full text could NOT be saved: ${reason}) ...\n\n`;
}

/**
 * 切出内联片段（头 + 调用方给的省略标记 + 尾）。
 *
 * ## 为什么省略标记由调用方传入、且**必须自带落盘路径**
 *
 * 因为**被缓存进 `webPageCache` 的正是这段内联片段**（`_cacheIfPossible` 存的就是它）。
 * 若标记只写"完整正文已存到文件、路径见下方"，那么 **24 小时内再次读同一 URL（缓存命中）时
 * 不会重发那条通知**，模型就会看到"说有文件、却找不到路径"—— 比不提示更糟。
 * 把路径写进标记本身，命中与首次抓取的输出就**完全一致**（这正是既有代码刻意追求的
 * "命中与刚抓取走同一条渲染路径"）。
 *
 * ## 切法
 *
 * 头尾都切在**行边界**（头取最后一个换行之前，尾从换行之后开始）—— 半行会误导模型把截断处
 * 当成内容。两个已知陷阱与 `execOutputSpill.decideOutputSpill` 相同，这里同样处理：
 *   ① 头部找不到换行（超长首行）⇒ 按字符切而不是放弃；
 *   ② 尾部找不到换行（超长末行）⇒ 回退到按字符切，**不能**退成空串（那等于又退回"只给头部"）。
 */
export function buildExtractExcerpt(text: string, charLimit: number, marker: string): IExtractExcerpt {
	const totalChars = text.length;
	if (totalChars <= charLimit || charLimit <= 0) {
		return { shouldSpill: false, inlineExcerpt: text, totalChars };
	}

	// 省略标记本身要占额度，先留出它的空间（否则内联片段会略微超出预算）。
	const budget = Math.max(0, charLimit - marker.length);
	const headBudget = Math.floor(budget * WEB_EXTRACT_SPILL_HEAD_RATIO);

	let headCut = text.lastIndexOf('\n', headBudget);
	if (headCut < headBudget / 2) { headCut = headBudget; }	// 陷阱 ①

	const tailFrom = Math.max(headCut, text.length - (budget - headBudget));
	const nlAfter = text.indexOf('\n', tailFrom);
	const tailCut = nlAfter === -1 ? tailFrom : nlAfter + 1;	// 陷阱 ②

	return {
		shouldSpill: true,
		inlineExcerpt: text.slice(0, headCut) + marker + text.slice(tailCut),
		totalChars,
	};
}

/** 生成落盘文件名（可排序 + 唯一，形态对齐 `execOutputSpill.spillFileName`）。 */
export function webExtractSpillFileName(now: Date, seq: number): string {
	const pad = (n: number, w = 2) => String(n).padStart(w, '0');
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
		+ `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
		+ `-${pad(now.getMilliseconds(), 3)}`;
	return `${SPILL_NAME_PREFIX}${stamp}-${pad(seq % 1000, 3)}.txt`;
}

/**
 * 落盘后追加给模型的说明。
 *
 * 必须做到：① 明确「正文没有丢」② 给出**可直接执行**的检索方式 ③ 劝阻重抓（重抓还要再等一次
 * 网络往返，而且拿到的仍是同一份被截断的输出）。
 */
export function webExtractSpillNotice(filePath: string, totalChars: number, url: string): string {
	return (
		`\n\n[PAGE TRUNCATED IN CONTEXT — FULL TEXT SAVED]\n`
		+ `The page has ${totalChars} characters; only the HEAD and TAIL are shown above. Nothing was lost — `
		+ `the COMPLETE extracted text was written to:\n  ${filePath}\n`
		+ `To read the omitted middle, use the file tools on that path:\n`
		+ `  - file_read with offset/limit — to page through it\n`
		+ `  - search_code with path set to that file — to jump straight to a keyword\n`
		+ `Do NOT call web_extract again for the same URL just to see more: it will return the same truncated excerpt `
		+ `(pass refresh=true only when the page itself may have changed).`
	);
}

/** 是否为本工具写下的落盘文件（回收时据此判断，绝不误删别人的文件）。 */
export function isWebExtractSpillFile(fileName: string): boolean {
	return SPILL_NAME_PATTERN.test(fileName);
}

/** 从目录列表里挑出应删除的本工具落盘文件（超龄 + 超量），策略常量与 exec 落盘共用。 */
export function selectWebExtractSpillFilesToDelete(
	files: readonly { readonly name: string; readonly mtimeMs: number }[],
	now: number,
): string[] {
	const owned = files.filter(f => isWebExtractSpillFile(f.name));
	const stale = owned.filter(f => now - f.mtimeMs > SPILL_MAX_AGE_MS).map(f => f.name);
	const staleSet = new Set(stale);
	const fresh = owned.filter(f => !staleSet.has(f.name)).sort((a, b) => b.mtimeMs - a.mtimeMs);
	const overflow = fresh.slice(SPILL_MAX_FILES).map(f => f.name);
	return [...stale, ...overflow];
}
