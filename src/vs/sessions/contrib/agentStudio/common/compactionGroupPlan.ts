/*---------------------------------------------------------------------------------------------
 *  压缩分组计划（方案 C「收纳手风琴」的**纯函数核心**，零 DOM 零副件）。
 *
 *  背景（2026-09-22 用户选定方案 C）：
 *  手动 `/compact` 与自动压缩都会在会话历史里插入一条 `metadata.type = 'compaction'`
 *  的边界消息（见 historyCompaction.ts 顶部说明）。此前 UI 侧的处理是**整条丢弃** ✗
 *  （`adaptPersistedChatMessage` 里 `return null`）⇒ 用户看到的历史**毫无变化**：
 *  他无法知道"模型从哪一条起就看不见了"、省了多少、能不能撤销 ✗✓。
 *
 *  方案 C 的表现（用户拍板 ✓）：
 *    · 被压缩区间**整体收纳**为一个可分组的块（组头 / 组体 / 组脚 ✓）；
 *    · 组体**默认不渲染**（懒渲染 ✓ 26 条消息不建 DOM ⇒ 与 lineFoldPlan 同一条纪律 ✓）；
 *    · 组脚承载摘要一行 + 展开摘要 + **撤销压缩**（复用 `/compact-reset` ✓）。
 *
 *  ⚠ 两条安全纪律（本模块的核心价值，必须由单测钉死）：
 *   ① **不可信边界绝不收纳** ✗✓ —— 边界有效性判据**唯一真源**是 historyCompaction 的
 *      `isValidCompactionBoundary`（摘要饥饿 / tokensSaved<=0 / 空摘要 ⇒ 判无效 ✓）。
 *      无效边界本就不进模型视野（`sliceAtCompactionBoundary` 会把它过滤掉 ✓），
 *      模型此刻**仍看得见全部历史** ⇒ 若 UI 却把历史收纳折叠起来，就是在**撒谎** ✗✓
 *      （用户会误以为省了 token 且历史已被摘要承载 ✓）。真机事故背景见 historyCompaction.ts
 *      的「153 条消息 → 129 token」段 ✓。
 *   ② **多次压缩只认最后一条可信边界** ✓，更早的边界**只做计数**，绝不重复渲染成多个组 ✗
 *     （嵌套/重复分组会让"到底哪段在视野外"再次不可知 ✗✓）。
 *--------------------------------------------------------------------------------------------*/

import {
	COMPACTION_METADATA_TYPE,
	extractCompactionSummary,
	findLastCompactionBoundaryIndex,
	findLastValidCompactionBoundaryIndex,
	isValidCompactionBoundary,
} from './historyCompaction.js';

/**
 * ⚠ **唯一的类型桥接点**：落盘的 `metadata` 是 `Record<string, unknown>`（可能是脏数据 ✓），
 * 而 historyCompaction 的判据要求 `{ type?: string; tokensSaved?: number; … }` 结构。
 * 这里从**判据函数自身**推导参数类型（`Parameters<…>[0]` ✓）⇒ 不会与真源漂移 ✓，
 * 且判据规则 100% 留在 historyCompaction（**绝不在此复刻饥饿/省 token 规则** ✗✓）。
 */
type BoundaryLike = Parameters<typeof isValidCompactionBoundary>[0];
function asBoundaryArray(list: ReadonlyArray<ICompactionPlanMessage>): ReadonlyArray<BoundaryLike> {
	return list as unknown as ReadonlyArray<BoundaryLike>;
}

/** 判单条消息的压缩边界是否可信（视图层提示行用 ✓ —— 判据同上，唯一真源 ✓）。 */
export function isValidBoundaryMessage(m: ICompactionPlanMessage | undefined | null): boolean {
	return !!m && isValidCompactionBoundary(m as unknown as BoundaryLike);
}

/**
 * 计划函数所需的最小消息面（结构化 ✓ 便于纯测 ✓）。
 * ⚠ 刻意**不**依赖 `IAgentChatMessage` / `ChatMessage` 任一具体类型：
 *   本模块同时被"持久化历史"与"已适配的面板消息"两条链复用 ⇒ 只约束用到的字段 ✓。
 */
export interface ICompactionPlanMessage {
	readonly id?: string;
	readonly content?: string;
	readonly timestamp?: number;
	readonly metadata?: Record<string, unknown> | undefined;
}

/** 组的元信息（**视图层唯一数据源** ✓ —— 组头/组脚/组体全部由它渲染 ✓）。 */
export interface ICompactionGroupMeta<TArchive extends ICompactionPlanMessage = ICompactionPlanMessage> {
	/** 合成消息 id（稳定 ⇒ 折叠状态可跨 rebuild 保留 ✓；见视图层状态 Map ✓）。 */
	readonly id: string;
	/** UI 上的「已压缩 N 条」= 被收纳的区间长度 **减去**其中边界消息数 ✓（边界由组自身代表 ✓）。 */
	readonly count: number;
	/** 摘要正文（已剥离固定前缀与「用户最近的指令」尾部 ✓ —— 与有效性判据同源 ✓）。 */
	readonly summary: string;
	/** 边界记载的省 token 数（缺失/非法 ⇒ 0 ✓ 仅用于展示 ✓）。 */
	readonly tokensSaved: number;
	/** 核心摘要字符数（缺失 ⇒ 现场剥离计算 ✓ —— 与 `isValidCompactionBoundary` 同源 ✓）。 */
	readonly summaryChars: number;
	/** 组内更早的边界数（多次压缩 ⇒ 只做计数提示 ✓ 不重复渲染 ✓）。 */
	readonly staleBoundaryCount: number;
	/** 被收纳消息的时间范围（缺失 ⇒ undefined ⇒ 组头不显示时间 ✓）。 */
	readonly fromTime?: number;
	readonly toTime?: number;
	/**
	 * 被收纳的原始消息（**仅保留模式**下非空 ✓；其中的边界已**降级**为普通消息 ⇒ 绝不嵌套 ✓）。
	 * 移除模式（默认 ✓）下恒为**空数组** ⇒ 这 100+ 条消息对象、其 `parts` 派生结果与 markdown
	 * 资源全部立即可回收 ✓✓。
	 */
	readonly archived: readonly TArchive[];
	/**
	 * ★ 2026-09-22（用户要求「压缩后从聊天框移除被压缩内容」✓）：是否**保留了原文**。
	 * `false`（默认）⇒ 移除模式：视图**不再提供展开**，只给一行摘要 + 「恢复完整历史」入口 ✓
	 * （原文不会丢：磁盘一条没删 ✓ `/compact-reset` 可一键取回 ✓✓）。
	 */
	readonly archivedKept: boolean;
	/** 从聊天框**移除**的条数（= 归档区间总长，含其中已失效的历史边界 ✓ 用于提示文案 ✓）。 */
	readonly removedCount: number;
}

/** 收纳计划（`hasGroup=false` ⇒ 视图必须**原样**渲染，不做任何折叠 ✗）。 */
export interface ICompactionGroupPlan<TArchive extends ICompactionPlanMessage = ICompactionPlanMessage> {
	/** 是否有可收纳区间 ✓。 */
	readonly hasGroup: boolean;
	/** 最后一条（不论可信与否的）边界下标（-1 = 无边界 ✓）。 */
	readonly boundaryIndex: number;
	/** 最后一条**可信**边界下标（-1 = 无可信边界 ✓）。 */
	readonly validBoundaryIndex: number;
	/** 收纳区间 = `[0, archiveEnd)`，**含边界消息自身** ✓（其摘要由组脚承载 ✓）。 */
	readonly archiveEnd: number;
	/**
	 * 存在边界但**不可信** ⇒ 不收纳 ✓ 且 UI 必须显式说明"模型其实仍看得见全部" ✗✓。
	 * 注意：它可能是"历史里有无效边界，但更早还有一条可信边界"的混合态 —— 此时
	 * `hasGroup=true` 且 `invalidBoundary=true` 同时成立 ✓（有效边界照常收纳 ✓，
	 * 无效那条落在尾部、单独渲染为提示行 ✓）。
	 */
	readonly invalidBoundary: boolean;
	readonly group?: ICompactionGroupMeta<TArchive>;
}

/** 判一条消息是不是压缩边界（唯一真源 = historyCompaction 的标记常量 ✓）。 */
export function isCompactionBoundaryMessage(m: ICompactionPlanMessage | undefined | null): boolean {
	return m?.metadata?.type === COMPACTION_METADATA_TYPE;
}

/** 从 metadata 安全取数（脏数据 ⇒ undefined ✓ 不抛错 ✓）。 */
function num(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * 计算收纳计划。
 *
 * 判据全部委托 historyCompaction（**不得在此复刻** ✗✓）：
 *   · `findLastValidCompactionBoundaryIndex`（可信边界 ✓）
 *   · `findLastCompactionBoundaryIndex`（任意边界 ⇒ 用于区分"没有边界"与"边界不可信" ✓）
 */
/** 收纳计划的选项（默认值刻意选**性能优先** ✓）。 */
export interface ICompactionGroupOptions {
	/**
	 * 是否把被压缩的原文**留在内存**里（默认 **false** ⇒ 直接舍弃 ✓）。
	 *
	 * 为什么默认舍弃：保留 `archived` 会让这 100+ 条消息对象、其派生 `parts` 与 markdown
	 * 渲染资源继续被引用 ✗ ⇒ 与"压缩后从聊天框移除、间接提升 UI 性能"的目标相反 ✓。
	 * 舍弃是**安全**的：磁盘历史一条没删 ✓，`/compact-reset` 可恢复完整历史 ✓。
	 * 仅供"调试/对照"场景传 true ✓（视图会自动切回收纳手风琴 ✓）。
	 */
	readonly keepArchived?: boolean;
}

export function planCompactionGroup<TArchive extends ICompactionPlanMessage>(
	messages: ReadonlyArray<TArchive> | undefined | null,
	opts?: ICompactionGroupOptions,
): ICompactionGroupPlan<TArchive> {
	const list: ReadonlyArray<TArchive> = messages ?? [];
	// ★ 移除模式（默认 ✓）：量完条数就**不持有**原文 ✓
	const keepArchived = opts?.keepArchived === true;
	// ⚠ 判据**只此一处**复用真源（类型桥接见文件顶部 asBoundaryArray ✓ 不复刻规则 ✗✓）
	const validIdx = findLastValidCompactionBoundaryIndex(asBoundaryArray(list));
	const anyIdx = findLastCompactionBoundaryIndex(asBoundaryArray(list));
	// ⚠「存在不可信边界」= **最后一条**边界不可信 ✓（而不是"连一条可信的都没有" ✗）：
	//   它可能落在尾部（模型视野里被 `sliceAtCompactionBoundary` 过滤掉 ✓）⇒ 视图必须**单独**
	//   渲染一条警告行 ✓；而更早的**可信**边界照常收纳 ✓（两者不互斥 ✓ 混合态已由单测钉住 ✓）。
	const invalidBoundary = anyIdx >= 0 && !isValidBoundaryMessage(list[anyIdx]);

	// ⚠ 判据 ①：无可信边界 ⇒ 绝不收纳 ✓（含"完全没有边界"与"只有饥饿边界"两种情形 ✓）
	//   区间必须**有内容**：边界位于 0 号位时前面没有可收纳的消息 ⇒ 无意义 ⇒ 不建组 ✓
	if (validIdx <= 0) {
		return { hasGroup: false, boundaryIndex: anyIdx, validBoundaryIndex: validIdx, archiveEnd: 0, invalidBoundary };
	}

	const boundary = list[validIdx];
	const archiveEnd = validIdx + 1;   // 尾部起点（**含**支配边界自身 ✓）
	// ⚠ 归档区间 = `[0, validIdx)` ⇒ **不含支配边界自身** ✗✓ —— 边界由组自身代表（组头计数 +
	//   组脚摘要 ✓）。若把它也收进组体，就会：① 「已压缩 N 条」虚高 1 ✗；② 组头时间范围被
	//   "压缩发生的那一刻"污染（变成"最后一条消息发生在压缩时" ✗✓）；③ 组体里多出一条赘余消息 ✓。
	//   （此三点正是本文件首次跑单测时被抓出的真 bug ✓ —— 单测的价值 ✓。）
	const archivedRaw = list.slice(0, validIdx);

	let staleBoundaryCount = 0;
	const archived: TArchive[] = [];
	let fromTime: number | undefined;
	let toTime: number | undefined;
	let count = 0;
	for (const m of archivedRaw) {
		const t = num(m?.timestamp);
		if (t !== undefined) {
			if (fromTime === undefined || t < fromTime) { fromTime = t; }
			if (toTime === undefined || t > toTime) { toTime = t; }
		}
		if (isCompactionBoundaryMessage(m)) {
			// 更早的边界：只计数 ✓；保留模式下还要**降级**为普通系统消息 ✓（否则展开后会嵌套分组 ✗✓）
			staleBoundaryCount++;
			if (keepArchived) { archived.push(downgradeBoundaryForArchive(m)); }
			continue;
		}
		count++;
		// ⚠ 门控点（唯一 ✓）：移除模式下**不持有**原文 ⇒ 这些对象出栈即可被 GC ✓✓
		if (keepArchived) { archived.push(m); }
	}

	const md = (boundary?.metadata ?? {}) as Record<string, unknown>;
	const summary = extractCompactionSummary(boundary?.content ?? '');
	const summaryChars = num(md.summaryChars) ?? summary.length;
	const boundaryId = typeof boundary?.id === 'string' && boundary.id.length > 0
		? boundary.id
		: `compaction-boundary@${validIdx}`;

	const group: ICompactionGroupMeta<TArchive> = {
		id: `compaction-group:${boundaryId}`,
		count,
		archivedKept: keepArchived,
		// ⚠ +1：**支配边界自身**也被这个分组取代 ⇒ 它同样"从聊天框消失了" ✓（提示文案要数全 ✓）
		removedCount: archivedRaw.length + 1,
		summary,
		tokensSaved: num(md.tokensSaved) ?? 0,
		summaryChars,
		staleBoundaryCount,
		fromTime,
		toTime,
		archived,
	};
	return { hasGroup: true, boundaryIndex: anyIdx, validBoundaryIndex: validIdx, archiveEnd, invalidBoundary, group };
}

/**
 * 把一条边界消息**降级**为普通系统消息（剥掉边界标记 ⇒ 视图层不会再当分组/提示渲染 ✓）。
 * 用于组体内部：更早的边界只应作为"历史痕迹"被看到，不应嵌套出第二个分组 ✗✓。
 */
export function downgradeBoundaryForArchive<T extends ICompactionPlanMessage>(m: T): T {
	const { metadata, ...rest } = m as T & { metadata?: Record<string, unknown> };
	const kept = metadata ? { ...metadata } : undefined;
	if (kept) { delete (kept as Record<string, unknown>).type; }
	return { ...(rest as T), metadata: kept } as T;
}
