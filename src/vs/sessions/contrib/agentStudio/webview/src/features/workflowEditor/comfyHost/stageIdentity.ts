/*---------------------------------------------------------------------------------------------
 *  stageIdentity — 节点的**持久身份**（stage uid）。
 *
 *  移植自 ComfyTV `src/composables/stages/stageIdentity.ts`。
 *
 *  ## 为什么必须有 uid（这是一个数据正确性问题，不是洁癖）
 *
 *  本项目的 `nodeId` 是**可复用的确定性字符串** —— `canvasOps.nextNodeId()` 生成
 *  `${base}-${max+1}`，而 `max` 只扫描**当前存在**的节点。于是：
 *
 *    1. 建 Rotate → id = `rotate-stage-1`，运行出图 → 快照写入 `rotate-stage-1:image:0`
 *    2. 删除该节点 → `store.removeNode()` 只删 nodes/edges，**快照残留**
 *    3. 再建一个 Rotate → 扫不到同类节点 → max=0 → **又叫 `rotate-stage-1`**
 *    4. 新节点 `ownSnapshots.length > 0` → OUTPUT 区**显示上一个节点的图**
 *
 *  快照是 IndexedDB 持久化且 `persistent:true` 时永不淘汰的（"persisted refs ARE
 *  the history"），所以这个错误会跨重启一直存在，且**静默发生** —— 用户不会收到
 *  任何提示，只会看到一张不属于该节点的图。
 *
 *  ## 解法
 *
 *  给节点一个随工作流序列化的 uid（`data.__sarosStageUid`），快照按 uid 归档。
 *  uid 由 `crypto.randomUUID()` 生成，永不复用，因此新节点绝不会撞上旧快照。
 *
 *  额外防护（同样来自 ComfyTV）：
 *   - `claimStageUid` 检测**复制粘贴撞车** —— 复制节点会连 properties 一起复制，
 *     两个节点拿到同一个 uid，此时为后来者重新生成。
 *   - `releaseStageUid` 在节点删除时释放占用，避免 live map 泄漏。
 *--------------------------------------------------------------------------------------------*/

/**
 * 节点 properties 上存放 uid 的键。
 * 用 `properties` 而非 `data` —— LiteGraph 的 `properties` 会随 `graph.serialize()`
 * 一起持久化，且本项目的 `__sarosId` 也存在这里，保持一致。
 */
export const STAGE_UID_KEY = '__sarosStageUid';

/** 最小节点形状（避免依赖 LiteGraph 具体类型，便于单测）。 */
export interface UidNodeLike {
	/** 画布身份（LiteGraph 数字 id 或本项目的 __sarosId 字符串）。 */
	id: string;
	properties?: Record<string, unknown>;
}

/** uid → 当前占用它的 nodeId。检测复制粘贴撞车。 */
const liveUids = new Map<string, string>();

function genUid(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) { return c.randomUUID(); }
	// 降级：时间戳 + 随机数（e2e / 老环境无 crypto.randomUUID）
	return `uid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 读取节点上已有的 uid（不生成）。纯函数。 */
export function readStageUid(node: UidNodeLike | undefined): string | undefined {
	const v = node?.properties?.[STAGE_UID_KEY];
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * 确保节点有 uid，返回它。会**就地写入** `node.properties[STAGE_UID_KEY]`。
 * 已有 uid 时原样返回（幂等）。
 */
export function ensureStageUid(node: UidNodeLike): string {
	let uid = readStageUid(node);
	if (!uid) {
		uid = genUid();
		if (!node.properties) { node.properties = {}; }
		node.properties[STAGE_UID_KEY] = uid;
	}
	return uid;
}

/**
 * 声明对 uid 的占用。若该 uid 已被**另一个** nodeId 占用（复制粘贴导致），
 * 为当前节点重新生成一个并写回。返回最终生效的 uid。
 */
export function claimStageUid(node: UidNodeLike): string {
	let uid = ensureStageUid(node);
	const owner = liveUids.get(uid);
	if (owner !== undefined && owner !== node.id) {
		// 复制粘贴：两个节点带同一个 uid，否则它们会共享快照历史。
		uid = genUid();
		if (!node.properties) { node.properties = {}; }
		node.properties[STAGE_UID_KEY] = uid;
	}
	liveUids.set(uid, node.id);
	return uid;
}

/** 释放节点对 uid 的占用（节点删除时调用）。 */
export function releaseStageUid(node: UidNodeLike): void {
	const uid = readStageUid(node);
	if (uid && liveUids.get(uid) === node.id) {
		liveUids.delete(uid);
	}
}

/**
 * 按 nodeId 释放占用。用于节点**已从 graph 移除**、拿不到 node 对象的场景
 * （画布 syncOverlay 只知道消失的 nodeId）。
 */
export function releaseStageUidByOwner(nodeId: string): void {
	for (const [uid, owner] of liveUids) {
		if (owner === nodeId) { liveUids.delete(uid); }
	}
}

/** 测试用：清空 live map。 */
export function resetStageUidRegistry(): void {
	liveUids.clear();
}

/**
 * 批量为一组节点补齐 uid 并 claim。用于工作流加载后（configure）——
 * 反序列化出来的节点需要重新登记占用，且老工作流可能完全没有 uid。
 *
 * 返回 `nodeId → uid` 映射，供快照迁移使用（等价 ComfyTV 的 adoptOutputs：
 * 把按旧 nodeId 归档的历史输出迁到 uid 名下，避免升级后历史图全部消失）。
 */
export function claimAllStageUids(nodes: readonly UidNodeLike[]): Map<string, string> {
	const out = new Map<string, string>();
	// 先登记已有 uid 的节点，避免无 uid 节点生成时与之冲突。
	for (const n of nodes) {
		if (readStageUid(n)) { out.set(n.id, claimStageUid(n)); }
	}
	for (const n of nodes) {
		if (!out.has(n.id)) { out.set(n.id, claimStageUid(n)); }
	}
	return out;
}

/** 该节点类型是否需要 uid（对齐 ComfyTV `usesStageUid`）。 */
export function usesStageUid(nodeType: string | undefined, variant: string | undefined): boolean {
	if (!nodeType) { return false; }
	// loader 的输出就是载入的素材本身，不产生需要归档的历史；
	// picker 从 pool 取图，也不按节点归档。
	if (variant === 'loader') { return false; }
	if (nodeType.endsWith('PickerStage')) { return false; }
	return true;
}
