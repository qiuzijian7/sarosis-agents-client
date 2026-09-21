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
	/**
	 * **核心摘要**字符数（不含确定性追加的文件清单，2026-09-21）。
	 * 与边界 metadata 的 `summaryChars` 同源：摘要饥饿判据必须只度量"信息量"部分，
	 * 否则"星饿检索 + 大文件清单"会伪装成信息充足 ✗。
	 */
	readonly summaryChars?: number;
}

interface IWithCompactionMetadata {
	readonly role?: string;
	readonly content?: string;
	readonly metadata?: {
		readonly type?: string;
		readonly originalCount?: number;
		readonly compressedCount?: number;
		readonly tokensSaved?: number;
		readonly summaryChars?: number;
	} | undefined;
}

// ─── 边界有效性（2026-09-21，对齐 pi 的「摘要必须是有信息量的 LLM 产物」纪律）──────
//
// **事故（真机取证，日志 `vscode-app-1789994132110.log`）**：切到小窗口模型
// （`kimi-k3-ioa`）后 effectiveWindow 塌到 64k 下限，76k 的既有会话被判"120% 超压"
// ⇒ 强制压缩；而压缩走了 RETRIEVAL 模式，`source=recall tokens=129` —— **153 条消息
// 只换回 129 token**。边界照常写入（`saved=24836 > 0` ⇒ 伪装的"成功"），此后每轮
// `sliceAtCompactionBoundary` 都丢弃边界前的全部消息 ⇒ 模型永久失忆，转而去
// `session_search` 抓回**别的任务**的记忆（用户报「llm 好像都不知道」）。
//
// **要点**：`tokensSaved > 0` 是**错误的成功判据** —— 毁掉内容最容易省下 token。
// 正确的判据是**摘要的信息量**：被压缩掉 N 条消息，摘要至少要有与之相称的字符量。
// 判无效的代价只是"多回灌一段上下文"（安全）；判有效的代价是"永久丢历史"（不可逆）⇒
// 因此这里刻意**偏保守**（宁可误判无效）。

/** 摘要最小信息密度（字符 / 被压缩消息）。 */
export const MIN_COMPACTED_SUMMARY_CHARS_PER_MSG = 8;
/** 摘要字符绝对下限——低于此值无论被压缩消息数多小都判"饥饿"。 */
export const MIN_COMPACTED_SUMMARY_CHARS = 300;
/** 信息密度要求的上限（字符）——防止超长会话把门槛推到不合理高度。 */
export const MAX_COMPACTED_SUMMARY_CHARS_REQUIRED = 1200;

/**
 * 「摘要饥饿」门槛（**唯一真源**，两个消费方共用 ⇒ 不得各自复刻口径）：
 *  - 回放侧 `isValidCompactionBoundary`（判边界是否可信）；
 *  - 压缩侧 `ContextManager`（判本次压缩是否算"有效"，见 `_ineffectiveCompressionCount`）。
 * 两处问的是同一个问题："摘要有与被压缩内容相称的信息量吗？"
 */
export function requiredCompactionSummaryChars(compressedCount: number): number {
	const count = typeof compressedCount === 'number' && compressedCount > 0 ? compressedCount : 0;
	return Math.max(
		MIN_COMPACTED_SUMMARY_CHARS,
		Math.min(count * MIN_COMPACTED_SUMMARY_CHARS_PER_MSG, MAX_COMPACTED_SUMMARY_CHARS_REQUIRED),
	);
}

/**
 * 摘要是否**饥饿**（信息量与被压缩内容不相称）。
 * 真机事故：153 条消息 → 129 token（≈450 字符）⇒ 门槛 1200 ⇒ 饥饿 ✓。
 */
export function isCompactionSummaryStarved(summaryChars: number, compressedCount: number): boolean {
	if (!Number.isFinite(summaryChars) || summaryChars <= 0) { return true; }
	return summaryChars < requiredCompactionSummaryChars(compressedCount);
}

/** 插入侧摘要分隔标记（`_buildCompactionBoundaryMessage` 的固定措辞）。 */
const SUMMARY_SEP = '已压缩为以下摘要：';
/** 插入侧"用户最近的指令原文"尾部标记（fail-safe ① 追加，不计入摘要信息量）。 */
const TAIL_MARK = '**用户最近的指令';

/**
 * 从边界消息 content 中**剥离**固定前缀与"最近指令原文"尾部，取出纯摘要正文。
 * 兼容两类历史数据：插入侧完整格式、以及早期测试/旧版本的精简格式。
 */
export function extractCompactionSummary(content: string): string {
	let body = content ?? '';
	const sep = body.indexOf(SUMMARY_SEP);
	if (sep >= 0) {
		body = body.slice(sep + SUMMARY_SEP.length);
	} else if (body.startsWith('[上下文压缩]')) {
		const nl = body.indexOf('\n\n');
		if (nl >= 0) { body = body.slice(nl + 2); }
	}
	const tail = body.indexOf(TAIL_MARK);
	if (tail >= 0) { body = body.slice(0, tail); }
	body = body.replace(/\n*-{3,}\s*$/, '');
	return body.trim();
}

/**
 * 判一条压缩边界消息是否**可信**（不可信 ⇒ 不切片，等价于"该压缩没发生过"）。
 *
 * 三条否定判据：
 *  ① `tokensSaved <= 0`：压缩没省 token 却销毁上下文（真机取证 `sess_ms5kriv8_0j6atj`
 *     的 `tokensSaved = -73`）；
 *  ② 摘要饥饿：纯摘要字符数 < `max(300, min(originalCount×8, 1200))`（本次事故 129 token
 *     ≈ 450 字符 vs 153 条消息 ⇒ 门槛 1200 ⇒ 判无效 ✓）；
 *  ③ 摘要正文为空（含只有前缀/tail 的"空壳边界"）。
 * 元数据缺失（旧数据）时退化为"只按摘要字符量判"，仍然能拦住本次这类饥饿摘要。
 */
export function isValidCompactionBoundary(message: IWithCompactionMetadata): boolean {
	if (message?.metadata?.type !== COMPACTION_METADATA_TYPE) { return false; }
	const md = message.metadata;
	if (typeof md.tokensSaved === 'number' && md.tokensSaved <= 0) { return false; }

	// 摘要字符数：优先用插入侧记录的精确值，否则从 content 现场剥离
	const summaryChars = typeof md.summaryChars === 'number' && md.summaryChars >= 0
		? md.summaryChars
		: extractCompactionSummary(message.content ?? '').length;

	const originalCount = typeof md.originalCount === 'number' && md.originalCount > 0
		? md.originalCount
		: 0;
	// ②/③ 饥饿判定共用唯一真源（`isCompactionSummaryStarved`：summaryChars<=0 也判饥饿 ✓）
	return !isCompactionSummaryStarved(summaryChars, originalCount);
}

/**
 * 找**最后一条可信的**压缩边界索引（无 ⇒ -1）。
 *
 * 注意这里刻意从尾部向前扫描"跳过不可信边界"：历史的尾部边界若已失效（如本次事故
 * 那种饥饿摘要），更早的**可信**边界仍应继续生效 —— 这样既恢复上下文，又不会把已被
 * 正确摘要覆盖的更早历史重新灌进来。
 */
export function findLastValidCompactionBoundaryIndex(
	messages: ReadonlyArray<IWithCompactionMetadata>,
): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isValidCompactionBoundary(messages[i])) {
			return i;
		}
	}
	return -1;
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
 * 压缩边界回放：有**可信**边界时丢弃边界**之前**的全部消息，边界消息本身保留为
 * 历史首条（其 content 即摘要，作为 assistant 历史消息参与后续回灌）。
 * 无边界时原样返回（向后兼容：旧会话无标记，行为不变）。
 *
 * ⚠ 2026-09-21：判据从"最后一条边界"改为"最后一条**可信**边界"
 * （`findLastValidCompactionBoundaryIndex`）。原因见本文件顶部的边界有效性说明：
 * 一条摘要饥饿的边界会让模型永久失忆，而"不切片"只是多回灌一段上下文 ——
 * 两者代价不对称，故必须按可信度过滤。旧的 `findLastCompactionBoundaryIndex`
 * 保留给需要"纯最后一条"语义的调用方（不影响它们的行为）。
 */
export function sliceAtCompactionBoundary<T extends IWithCompactionMetadata>(messages: readonly T[]): readonly T[] {
	const idx = findLastValidCompactionBoundaryIndex(messages);
	const sliced = idx > 0 ? messages.slice(idx) : messages;
	// ② 不可信边界**不进模型视野**：它的 content 形如
	//    `[上下文压缩] 此前的对话历史（153 条消息）已压缩为以下摘要：无` —— 若照常下发，
	//    模型会以为"历史已被压缩掉了"（明明我们并没有切片）⇒ 主动放弃已有上下文 ✗。
	//    可信边界（承载真摘要）必须保留 ✓。
	return sliced.filter(m =>
		m?.metadata?.type !== COMPACTION_METADATA_TYPE || isValidCompactionBoundary(m)
	);
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

// ─── 文件操作累计（2026-09-21，对齐 pi `formatFileOperations`）───────────────────────
//
// 编码任务里"读过/改过哪些文件"是压缩后**最贵的一类信息**，而摘要 LLM 可能漏掉、
// 检索式重构更是常常只回 129 token（真机事故 `vscode-app-1789994132110.log`）。
// 这里从本轮消息的工具调用**确定性**提取，追加到摘要尾部 —— 不依赖摘要质量，永远在场。

/** 读类工具（产物=读取的文件路径）。 */
const FILE_READ_TOOLS: ReadonlySet<string> = new Set([
	'file_read', 'read_file', 'grep', 'search_code', 'search_file', 'list_dir', 'find_file', 'codebase_grep',
]);
/** 写类工具（产物=修改的文件路径）。 */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
	'file_write', 'write', 'edit', 'file_edit', 'edit_file', 'create_file', 'patch', 'str_replace_editor', 'multi_edit', 'notebook_edit',
]);
/** 参数里可能承载文件路径的字段名（按优先级取第一个非空字符串）。 */
const FILE_ARG_KEYS: readonly string[] = ['filePath', 'path', 'file', 'fileName', 'targetFile', 'target_file', 'notebook_path'];

export interface IFileOperations {
	/** 读过的文件（去重，按**最近使用**序，封顶 FILE_MANIFEST_CAP 个）。 */
	readonly read: string[];
	/** 改过的文件（去重，按**最近使用**序，封顶 FILE_MANIFEST_CAP 个）。 */
	readonly modified: string[];
	/** 因封顶被省略的条数（M2，对齐 MiMo `FILE_MANIFEST_LIMIT` 思路——清单必须有界）。 */
	readonly truncatedRead?: number;
	readonly truncatedModified?: number;
}

/**
 * 文件清单封顶（M2，对齐 MiMo `FILE_MANIFEST_LIMIT` 思路）：长会话的工具调用上千次，
 * 清单必须有界——按"最近使用"序截尾，丢的是最早的那批。
 */
export const FILE_MANIFEST_CAP = 20;

/**
 * 从消息的工具调用中提取文件操作（确定性、与摘要质量无关）。
 * 遍历 `assistant.toolCalls[*]`（`arguments` 是 JSON 字符串或对象），取第一个命中的
 * 路径字段；坏 JSON / 非字符串路径跳过（宁可漏一条，也不让坏数据阻断压缩）。
 * 排序按**最近使用**（复用会移到末尾）⇒ 封顶时优先保留最近碰过的文件。
 */
export function extractFileOperations(messages: ReadonlyArray<unknown>): IFileOperations {
	const read: string[] = [];
	const modified: string[] = [];
	const seenRead = new Set<string>();
	const seenModified = new Set<string>();
	const push = (list: string[], seen: Set<string>, p: unknown): void => {
		const v = typeof p === 'string' ? p.trim() : '';
		if (!v) { return; }
		if (seen.has(v)) {
			// 复用 = 最近又碰过 ⇒ 挪到末尾 ⇒ 封顶时优先留下
			seen.delete(v); seen.add(v);
			const i = list.indexOf(v);
			if (i >= 0) { list.splice(i, 1); list.push(v); }
			return;
		}
		seen.add(v); list.push(v);
	};
	for (const m of messages) {
		const toolCalls = (m as { toolCalls?: ReadonlyArray<{ name?: string; arguments?: unknown }> }).toolCalls;
		if (!Array.isArray(toolCalls)) { continue; }
		for (const tc of toolCalls) {
			const name = typeof tc?.name === 'string' ? tc.name : '';
			const isWrite = FILE_WRITE_TOOLS.has(name);
			const isRead = !isWrite && FILE_READ_TOOLS.has(name);
			if (!isWrite && !isRead) { continue; }
			let args: Record<string, unknown> | undefined;
			try {
				args = typeof tc.arguments === 'string' && tc.arguments.trim()
					? JSON.parse(tc.arguments) as Record<string, unknown>
					: (typeof tc.arguments === 'object' && tc.arguments !== null
						? tc.arguments as Record<string, unknown>
						: undefined);
			} catch { continue; }
			const p = FILE_ARG_KEYS.map(k => args?.[k]).find(v => typeof v === 'string' && v.trim().length > 0);
			if (isWrite) { push(modified, seenModified, p); } else { push(read, seenRead, p); }
		}
	}
	// 封顶截尾（丢最早的）：清单必须对长会话有界。
	const truncatedRead = Math.max(0, read.length - FILE_MANIFEST_CAP);
	const truncatedModified = Math.max(0, modified.length - FILE_MANIFEST_CAP);
	if (truncatedRead > 0) { read.splice(0, truncatedRead); }
	if (truncatedModified > 0) { modified.splice(0, truncatedModified); }
	return {
		read, modified,
		...(truncatedRead > 0 ? { truncatedRead } : {}),
		...(truncatedModified > 0 ? { truncatedModified } : {}),
	};
}

/** 把文件操作清单格式化成摘要段落（空 ⇒ 返回空串，由调用方决定是否追加）。 */
export function formatFileOperationSummary(ops: IFileOperations): string {
	const parts: string[] = [];
	if (ops.modified.length > 0) {
		const more = ops.truncatedModified ? `，另有 ${ops.truncatedModified} 个更早的从略` : '';
		parts.push(`修改（${ops.modified.length} 个${more}）：${ops.modified.join('、')}`);
	}
	if (ops.read.length > 0) {
		const more = ops.truncatedRead ? `，另有 ${ops.truncatedRead} 个更早的从略` : '';
		parts.push(`读取（${ops.read.length} 个${more}）：${ops.read.join('、')}`);
	}
	return parts.length > 0
		? `## 文件操作（确定性提取，与摘要质量无关）\n- ${parts.join('\n- ')}`
		: '';
}
