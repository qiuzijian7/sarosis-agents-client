/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * checkpointSnapshotPolicy — 快照内容的**省略策略**（纯函数，无 IO）。
 *
 * 背景（2026-09-12，P2-3）：快照存的是文件**完整明文内容**（`IFileSnapshot.content`）。
 * 若 agent 通过 `file_write` 写了一个大文件（打包产物、日志、数据文件）或二进制文件
 * （图片 / 视频 / 压缩包），会：
 *   ① 立刻产生一份等大的快照（配额淘汰也救不了「单条就超大」）；
 *   ② 二进制被 `VSBuffer.toString()` 解成乱码字符串，回退时写回的是**损坏文件**
 *      （比不回退更糟 —— 用户以为还原了）。
 *
 * 策略：内容超过阈值**或**探测到二进制特征（NUL 字节）时，**只记录元数据、不存内容**
 * （`contentOmitted: true`），回退时**跳过该文件并明确告知用户**（对齐 Claude Code
 * 的「Restored the code, but skipped N files」显式提示，而非静默留下损坏文件）。
 *
 * 注意：`existedBefore === false`（新建文件）的快照即使省略内容也无损 ——
 * 回退语义是「删除该文件」，不依赖内容。
 */

/**
 * 单份快照允许保存的最大内容长度（字符数）。
 *
 * 用**字符数**而非字节数近似：UTF-8 下中文 1 字符 ≈ 3 字节，故实际阈值偏保守
 * （更早触发省略），方向安全。
 */
export const MAX_SNAPSHOT_CONTENT_CHARS = 1_000_000; // ≈ 1 MB（ASCII 场景）

/** 二进制探测的采样窗口（只看开头，避免为检测遍历整个大文件）。 */
const BINARY_PROBE_CHARS = 8192;

/**
 * 判断某份快照的内容是否应被省略。
 *
 * 触发条件（任一）：
 *   · 长度超过 `maxChars`；
 *   · 开头采样窗口内出现 NUL（`\u0000`）—— 文本文件不会包含它，二进制几乎必然包含。
 */
export function shouldOmitSnapshotContent(
	content: string,
	maxChars: number = MAX_SNAPSHOT_CONTENT_CHARS,
): boolean {
	if (!content) { return false; }
	if (content.length > maxChars) { return true; }
	const probe = content.length > BINARY_PROBE_CHARS ? content.slice(0, BINARY_PROBE_CHARS) : content;
	return probe.includes('\u0000');
}

/**
 * 生成「部分文件未回退」的用户可见提示。
 *
 * @param skippedFiles 被跳过文件的 URI / 路径列表。
 * @returns 提示文案；列表为空时返回 `undefined`（调用方不提示）。
 */
export function describeSkippedSnapshots(skippedFiles: readonly string[]): string | undefined {
	if (skippedFiles.length === 0) { return undefined; }
	const names = skippedFiles
		.map(f => f.split(/[/\\]/).filter(Boolean).pop() ?? f)
		.slice(0, 5)
		.join('、');
	const more = skippedFiles.length > 5 ? ` 等 ${skippedFiles.length} 个文件` : '';
	return `有 ${skippedFiles.length} 个文件因体积过大或为二进制未纳入检查点，回退时已跳过：${names}${more}。` +
		`这些文件保持当前内容，请手动确认。`;
}
