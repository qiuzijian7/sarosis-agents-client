/*---------------------------------------------------------------------------------------------
 *  跨窗口产物广播（P4，2026-09-13）。
 *
 *  场景：同一工作流可同时开在多个 webview —— 画布 tab（`WorkflowEditorPane`）+
 *  节点编辑器 tab / 独立窗口（`WorkflowNodeEditorPane`，P2/P3）。在其中一个窗口点
 *  「运行」产出的图/视频，另一个窗口的卡片预览看不到（各 webview 持有**独立**的
 *  `MediaSnapshotStore`，backend 是各自 origin 下的 IndexedDB → 互不可见）。
 *
 *  ★ 为什么成本可控：`MediaRef.ref` 是**自包含的 URL 字符串**（http / COS 签名 URL /
 *    data URL —— 见 `providerImagesToMedia` / `emojiRemoveBg` / `nodeCard.onRenderUploaded`），
 *    payload **无需传输**，只广播这条轻量 ref 即可；接收端 `putRemote` 后可直接加载 ✓。
 *
 *  与 `nodeControlWrite.ts` 同构（同样的「节流 → 动态 import bridge」做法）：
 *   - 不引入顶层 bridge 依赖（本模块被画布核心链路引用）；
 *   - 300ms 窗口内合并批量发送（一次运行可能连产多张图）。
 *--------------------------------------------------------------------------------------------*/
import type { MediaSnapshotEntry } from './mediaSnapshot.js';

/**
 * 单条 ref 的长度上限（超过则跳过广播）。
 *
 * 产物多为 http/COS URL（几十~几百字节），但 **data URL** 形态（本地渲染、抠图重切、
 * provider 返回 b64）可达数 MB —— postMessage 传大字符串会明显卡顿。
 * 超限产物**不广播**（另一窗口重载后仍可见，因为已落各自 IndexedDB + host 媒体库），
 * 并打一行日志说明原因（不静默）。
 */
const MAX_REF_LENGTH = 2_000_000; // 2MB

/** 待广播的产物（按 nodeId:port:ref 合并 —— 同 ref 去重，不同 ref 都保留）。 */
const pending = new Map<string, MediaSnapshotEntry>();
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;

/** 批量发送（300ms 窗口）。 */
function flushBroadcast(): void {
	broadcastTimer = undefined;
	const batch = Array.from(pending.values());
	pending.clear();
	if (batch.length === 0) { return; }
	void import('../../../bridge/messageClient.js').then(m => {
		for (const entry of batch) {
			void m.sendRequest('workflow.snapshotPut', {
				nodeId: entry.nodeId,
				port: entry.port,
				media: entry.media,
			}).catch(() => { /* 通道不可用则忽略（不阻塞画布） */ });
		}
	}).catch(() => { /* 忽略 */ });
}

/**
 * 广播一条**本窗口产生**的产物给其它窗口（`MediaSnapshotStore` 的 `onProduced` 回调）。
 *
 * 调用方：`LiteGraphCanvas` 构造 snapshot store 时传入（见该处 `onProduced`）。
 */
export function scheduleBroadcastSnapshot(entry: MediaSnapshotEntry): void {
	// 只同步 image/video（与 onAsset 的收录口径一致）。text 类快照是内部编排数据
	// （Prompt/Start 文本、SAROS_JSON 归档），跨窗口重放没有意义且可能污染。
	if (entry.media.kind !== 'image' && entry.media.kind !== 'video') { return; }
	const ref = entry.media.ref;
	if (typeof ref !== 'string' || !ref) { return; }
	if (ref.length > MAX_REF_LENGTH) {
		// eslint-disable-next-line no-console
		console.warn(`[snapshotBroadcast] ${entry.nodeId}:${entry.port} 产物过大（${Math.round(ref.length / 1024)}KB > ${MAX_REF_LENGTH / 1024}KB），未跨窗口同步（另一窗口重载后可见）`);
		return;
	}
	// 合并键用 ref 的「长度 + 前缀」而非完整 ref：同一次运行的多张图 ref 不同 →
	// 都会保留；重复广播同一 ref → 合并成一条 ✓。
	pending.set(`${entry.nodeId}:${entry.port}:${ref.length}:${ref.slice(0, 64)}`, entry);
	if (broadcastTimer !== undefined) { return; }
	broadcastTimer = setTimeout(flushBroadcast, 300);
}
