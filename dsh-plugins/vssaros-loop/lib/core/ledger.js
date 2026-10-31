// 委托层 —— 真源在 `@vssaros/dsh-workitem/lib/core/ledger.js`（cordis 服务 `vssarosWorkItems`）。
//
// 为什么要这一层薄壳而不是删掉本文件：
//   调用方（runner / index / store）的 import 与调用签名**完全不变**，真源却只有一份 ⇒
//   loop 与群聊共用同一套去重/退避/恢复语义，不可能分叉。
//
// 为什么不能直接 import 内核的文件：插件是独立安装的包，profile 里没有跨包解析路径，
// 运行期实现必须经 cordis 服务拿（`lib/workItemRef.js` 的 bindWorkItems）。
// 服务没绑上 ⇒ 调用时抛带指引的错（fail-fast，不静默回退 —— 静默回退会复活"两份实现"）。

import { workItems } from '../workItemRef.js';

export const LEDGER_VERSION = 1;

export const createLedger = () => workItems().createLedger();
export const normalizeLedger = raw => workItems().normalizeLedger(raw);
export const entryOf = (ledger, key) => workItems().entryOf(ledger, key);

/**
 * 这个 key 本轮该不该跳过。`spec` 只需带 `maxAttempts` / `retryBackoffS`
 * （loop 传整个 spec 也行，多余的字段内核不看）。
 */
export const skipReasonOf = (entry, spec, nowMs) => workItems().skipReasonOf(entry, spec, nowMs);

export const markRunning = (ledger, key, options, nowMs) => workItems().markRunning(ledger, key, options, nowMs);
export const markDone = (ledger, key, options, nowMs) => workItems().markDone(ledger, key, options, nowMs);
export const markFailed = (ledger, key, options, nowMs) => workItems().markFailed(ledger, key, options, nowMs);
export const markBlocked = (ledger, key, options, nowMs) => workItems().markBlocked(ledger, key, options, nowMs);

export const recoverOnStart = (ledger, nowMs) => workItems().recoverOnStart(ledger, nowMs);
export const summarizeLedger = ledger => workItems().summarizeLedger(ledger);
