/*---------------------------------------------------------------------------------------------
 *  codebaseGraphMemoryWatchdog.ts — 解析期内存看门狗的**纯决策**（2026-09-21，UE 95k 文件 OOM 实证）
 *
 *  实证（日志 vscode-app-1789978945531）：watcher 触发 deficient 强全量 ⇒ 95,532 个 UE 源文件的
 *  tree-sitter 解析结果全部堆在渲染进程内存里（store nodes/edges + 虚拟边缓冲；SQLite 同步在
 *  解析**之后**才发生）⇒ heap 348→2230MB（每 30s +~950MB）⇒ 越过 V8 ~4GB 上限 ⇒ renderer OOM。
 *  而阶段边界的 `_reportGraphMemory` 只在 `_seg` 触发——解析是单一最长阶段 ⇒ 崩溃前永不响 ✗。
 *
 *  本模块只做判定（纯函数，可直接单测）；副作用（WARN/进度提示/cts.cancel）在
 *  `CodebaseGraphService._parseMemoryWatchdog`。
 *--------------------------------------------------------------------------------------------*/

/** 解析循环内的堆检查结论。 */
export type ParseHeapAction = 'ok' | 'soft' | 'abort';

/**
 * 判定当前是否该告警/中止：
 *   · `usedBytes` 越过**硬上限**（绝对堆，默认 3072MB，可配 `saros.codebaseGraph.hardHeapLimitMb`）
 *     ⇒ `abort`（中止本轮解析；已解析部分照常收尾落盘，剩余文件哈希未记 ⇒ 下次增量自动补齐 ⇒
 *     渐进收敛，不再有「崩溃 → 残缺制品 → 下次又全量」的自激振荡 ✓）；
 *   · 本轮增量（`usedBytes - baselineBytes`，基线=本轮起始堆）超过预算 ×1.5 ⇒ `soft`（WARN 一次）；
 *   · 其余 ⇒ `ok`。
 *
 * ⚠ 硬上限用**绝对堆**、软告警报**相对增量** —— 前者是「离崩溃多远」的生存问题，后者是
 * 「这轮索引吃掉多少」的归因问题，口径不同是刻意的（别合并 ✗）。
 */
export function resolveParseHeapAction(input: {
	readonly usedBytes: number;
	readonly baselineBytes: number;
	readonly budgetBytes: number;
	readonly hardLimitBytes: number;
}): ParseHeapAction {
	if (input.hardLimitBytes > 0 && input.usedBytes > input.hardLimitBytes) { return 'abort'; }
	if (input.baselineBytes > 0 && input.budgetBytes > 0
		&& input.usedBytes - input.baselineBytes > input.budgetBytes * 1.5) { return 'soft'; }
	return 'ok';
}
