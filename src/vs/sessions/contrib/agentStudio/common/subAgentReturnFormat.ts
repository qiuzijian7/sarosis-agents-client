/*---------------------------------------------------------------------------------------------
 *  SubAgent 结构化返回契约（MiMo-Code RETURN_FORMAT_INSTRUCTION 对齐）
 *
 *  背景（2026-07-23）：completionGate.gateResult 的 `parseStructuredResultMarker`
 *  支持 XML 标记 `<result status="..."/>`，但子代理提示词从未要求输出任何状态
 *  标记 —— selfReported 几乎总为 undefined，完成门退化为纯推断。MiMo-Code 的
 *  做法是在任务 briefing 中注入强制返回格式（spawn.ts:48 RETURN_FORMAT_INSTRUCTION），
 *  再用正则解析（return-header.ts），使完成门拿到**模型自报的结构化状态**。
 *
 *  本模块：
 *  1. `RETURN_FORMAT_INSTRUCTION` — 注入子代理任务消息的格式契约（Markdown 头，
 *     比 XML 标记更贴合模型的自然输出习惯，状态词表与完成门完全一致）。
 *  2. `parseReturnHeader` — 从子代理最终文本解析 Status/Summary 头（容错：
 *     接受 `**Status**:` / `Status:`、大小写不敏感、取最后一次出现）。
 *
 *  纯函数 + 零依赖 → 完全可单测。
 *--------------------------------------------------------------------------------------------*/

import type { SubAgentGateStatus } from './completionGate.js';

/**
 * 注入子代理任务 briefing 的返回格式契约。
 * 与 MiMo-Code RETURN_FORMAT_INSTRUCTION 同构，状态词表与 SubAgentGateStatus 对齐
 * （success | partial | failed | blocked）。
 */
export const RETURN_FORMAT_INSTRUCTION = `

---

## Return format (REQUIRED)

Your FINAL message — what the parent agent receives — MUST begin with this header block:

  **Status**: success | partial | failed | blocked
  **Summary**: <one sentence: what was accomplished>

Then include the deliverable the task asked for (findings, analysis, code changes).
When relevant, append:

  **Files touched**: <comma-separated paths, or "(none)">

Rules:
- **Status** meanings — success: task fully done; partial: done with gaps (say what is missing); failed: could not complete (say why); blocked: stuck on an external obstacle you cannot resolve.
- Do NOT write anything before the **Status** line.
- Be honest: the parent agent verifies your claim against ground truth (files actually modified, unfinished tasks, truncation). A false "success" is worse than an honest "partial".`;

/** 解析结果：Status 头提取出的自报状态与一句话摘要。 */
export interface IReturnHeader {
	readonly status: SubAgentGateStatus;
	readonly summary?: string;
}

const STATUS_HEADER_RE = /\*\*Status\*\*\s*[:：]\s*(success|partial|failed|blocked)\b/i;
const STATUS_PLAIN_RE = /^\s*Status\s*[:：]\s*(success|partial|failed|blocked)\b/im;
const SUMMARY_HEADER_RE = /\*\*Summary\*\*\s*[:：]\s*([^\r\n]+)/i;

/**
 * 从子代理最终文本解析 Status/Summary 头。
 * 优先 `**Status**: X` 格式；兼容无加粗的 `Status: X`（行首）。
 * 多次出现时取**最后一次**（正文可能引用格式说明，最终以末尾自报为准）。
 * 无法解析返回 undefined（调用方回退推断式完成门）。
 */
export function parseReturnHeader(text: string): IReturnHeader | undefined {
	if (!text) { return undefined; }
	let status: SubAgentGateStatus | undefined;
	for (const m of text.matchAll(new RegExp(STATUS_HEADER_RE.source, 'gi'))) {
		status = m[1].toLowerCase() as SubAgentGateStatus;
	}
	if (!status) {
		const plain = STATUS_PLAIN_RE.exec(text);
		if (plain) {
			status = plain[1].toLowerCase() as SubAgentGateStatus;
		}
	}
	if (!status) { return undefined; }

	// Summary 取 Status 之后的第一个 **Summary**: 行（若有）
	let summary: string | undefined;
	const afterStatusIdx = text.toLowerCase().lastIndexOf('**status**');
	const searchArea = afterStatusIdx >= 0 ? text.slice(afterStatusIdx) : text;
	const summaryMatch = SUMMARY_HEADER_RE.exec(searchArea);
	if (summaryMatch && summaryMatch[1].trim().length > 0) {
		summary = summaryMatch[1].trim();
	}
	return { status, summary };
}

/**
 * 把返回格式契约注入任务 briefing（追加到任务文本末尾）。
 * 保持系统提示词不变（冻结前缀缓存），契约随任务消息下发 —— 与 MiMo 把
 * RETURN_FORMAT_INSTRUCTION 拼进 task prompt 的做法一致。
 */
export function injectReturnFormatIntoTask(task: string): string {
	return task + RETURN_FORMAT_INSTRUCTION;
}
