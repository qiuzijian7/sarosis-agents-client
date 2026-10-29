/**
 * 取「当前作用域**可见**的工具名」——**只要名字**，不要 schema。
 *
 * ★ 2026-10-29（首启慢的真正大头）：`dsh-tools` 的 `schemas(scope)` 会对**每个**可见工具做一次
 * `parameters` 的 JSON 深拷贝（`snapshotJsonValue`）：
 *   `schemas: [...this.view(scope).visible.values()].map(d => this.schemaOf(d, true))`
 * 本机一次 197 个工具 ⇒ 30 个 preset × 每次 `tools/change` 重算 ⇒ 光深拷贝就吃掉 **十几秒**
 * （实测：Host 冷启动 24.3s 里有 ~18s 卡在插件 apply）。
 *
 * 而 `denyTools` 收敛**只要工具名**（`expandDenyPatterns(patterns, names)`）⇒ 没必要付这个代价。
 *
 * 快路径：内部 API `tools.view()` 直接给出「可见工具名 → 定义」的 Map ⇒ **零深拷贝**。
 * 内部 API 不是承诺（未来可能改名）⇒ 取不到就退回公开 API `schemas()`（行为不变，只是慢）。
 */

/**
 * 当前作用域可见的工具名。
 *
 * @param {any} tools dsh 的 tools 服务实例（preset 作用域里 inject 到的那个）。
 * @returns {string[] | null} 可见工具名；`null` = 注册表还没就绪（调用方应等下一次 `tools/change`）。
 */
export function visibleToolNames(tools) {
	if (!tools) { return null; }
	// 快路径：内部 API —— 只要 Map 的 key（= 工具名），不做任何深拷贝。
	try {
		const visible = tools.view?.()?.visible;
		if (visible && typeof visible.keys === 'function') {
			return [...visible.keys()];
		}
	} catch {
		// 内部 API 变了（改名/改签名）⇒ 落到公开 API。
	}
	// 公开 API：语义完全一致，但每个工具要深拷贝一次 parameters（慢）。
	try {
		return (tools.schemas?.() ?? []).map(schema => schema?.name).filter(Boolean);
	} catch {
		return null;   // 注册表还没就绪 ⇒ 等下一次 `tools/change`
	}
}

/**
 * 「按实例隔离 + 按版本失效」的工具名快照器。
 *
 * 为什么这么设计（三条都是踩过的坑）：
 *   · **按实例隔离**：`tools` 服务在 preset 作用域里是**每个 preset 一个实例**
 *     （`tools.restrict()` 注释明说"作用域不对会抛"）⇒ 不同 preset 的可见集不同
 *     ⇒ 快照**不能跨 preset 共享**（否则会拿 A 的可见集去裁 B 的工具面 ✗✗）。
 *   · **按版本失效**：工具注册/撤销会发 `tools/change` ⇒ 收到就必须失效，
 *     **不能**用"时间 TTL"糊弄（TTL 窗口内新注册的工具会**漏藏**，而且没有下一次事件来补 ⇒ 永久漏藏 ✗）。
 *   · **同一批内复用**：`tools/change` 会成簇到达（去抖后仍有多轮）⇒ 版本没变时复用上一次结果，
 *     把"每 preset 每轮一次全量"压成"每 preset 一次全量"。
 */
export function createToolNameSnapshot() {
	let version = 0;
	/** tools 实例 → { version, names }（WeakMap：实例被回收即随之消失，不会泄漏）。 */
	const entries = new WeakMap();
	return {
		/** 收到 `tools/change` 时调用 ⇒ 下一轮必定重新取名（不漏藏）。 */
		invalidate() {
			version += 1;
		},
		/** 当前版本号（诊断用）。 */
		get version() {
			return version;
		},
		/**
		 * 取当前可见工具名（带缓存）。
		 * @returns {string[] | null} null = 注册表还没就绪。
		 */
		namesOf(tools) {
			const hit = entries.get(tools);
			if (hit && hit.version === version) {
				return hit.names;
			}
			const names = visibleToolNames(tools);
			if (names === null) { return null; }
			entries.set(tools, { version, names });
			return names;
		},
	};
}
