/*---------------------------------------------------------------------------------------------
 *  历史压缩边界（compaction boundary）— 压缩状态跨 turn 持久化的纯函数核心。
 *
 *  背景（2026-07-23 实施，对齐 opencode / MiMo-Code / openclaw）：
 *  此前 compressContext 只替换 loop 内存数组，落盘的仍是完整因果链 —— 下一个
 *  turn 回灌全量历史、重新膨胀、重新触发压缩。本模块提供：
 *
 *  1. 压缩边界标记：压缩发生后，chatService 在历史中插入一条
 *     metadata.type = 'compaction' 的边界消息（content 承载摘要）。
 *  2. 边界回放（sliceAtCompactionBoundary）：回灌时只重放最后一条边界
 *     及其之后的消息 —— 边界前的历史由摘要语义承载，长会话不再每 turn 膨胀。
 *     与 opencode 的 compaction 行 / MiMo 的 compaction 边界标记同构。
 *  3. 冻结截断文本（truncateToolResultContent）：同一工具结果内容在各 turn
 *     永远得到逐字节相同的截断结果（openclaw frozen projection 思路），
 *     消除"消息从 tail 保护区移入 middle 截断区"造成的缓存前缀漂移。
 *--------------------------------------------------------------------------------------------*/

/** 压缩边界消息的 metadata.type 标记。 */
export const COMPACTION_METADATA_TYPE = 'compaction';

/** 截断后缀标记（与原 IPC 截断格式保持一致，避免旧数据格式漂移）。 */
export const TRUNCATED_FOR_IPC_SUFFIX = '\n...[truncated for IPC]';

/** 压缩边界信息（由 context_compacted 流事件捕获）。 */
export interface ICompactionBoundaryInfo {
	/** 压缩摘要文本（作为边界消息的 content 主体）。 */
	readonly summary: string;
	/** 压缩发生时已累积的 assistant_turn 数（决定边界在历史中的插入位置）。 */
	readonly turnCount: number;
	/** 压缩前消息数。 */
	readonly originalCount: number;
	/** 压缩后消息数。 */
	readonly compressedCount: number;
	/** 节省的估算 tokens。 */
	readonly tokensSaved: number;
}

interface IWithCompactionMetadata {
	readonly metadata?: { readonly type?: string } | undefined;
}

/**
 * 找历史中**最后一条**压缩边界消息的索引（无边界返回 -1）。
 * 多次压缩时只有最后一条边界有效（更早的边界覆盖的历史已被最新摘要承载）。
 */
export function findLastCompactionBoundaryIndex(messages: ReadonlyArray<IWithCompactionMetadata>): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.metadata?.type === COMPACTION_METADATA_TYPE) {
			return i;
		}
	}
	return -1;
}

/**
 * 压缩边界回放：有边界时丢弃边界**之前**的全部消息，边界消息本身保留为
 * 历史首条（其 content 即摘要，作为 assistant 历史消息参与后续回灌）。
 * 无边界时原样返回（向后兼容：旧会话无标记，行为不变）。
 */
export function sliceAtCompactionBoundary<T extends IWithCompactionMetadata>(messages: readonly T[]): readonly T[] {
	const idx = findLastCompactionBoundaryIndex(messages);
	return idx > 0 ? messages.slice(idx) : messages;
}

/**
 * 确定性工具结果截断（冻结截断文本）。
 * 同一 content 永远返回逐字节相同的结果 —— 与位置（head/middle/tail 区）和
 * 调用轮次无关，因此跨 turn 回灌时历史字节稳定，不破坏 provider 前缀缓存。
 */
export function truncateToolResultContent(content: string, limit: number): string {
	if (content.length <= limit) {
		return content;
	}
	return content.slice(0, limit) + TRUNCATED_FOR_IPC_SUFFIX;
}
