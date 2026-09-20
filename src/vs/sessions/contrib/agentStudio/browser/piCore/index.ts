/*---------------------------------------------------------------------------------------------
 * piCore —— pi 作为 agentloop 核心的适配层（doc/agentloop-pi-core-redesign.md）。
 *
 * 打包纪律：**类型** type-only 从 npm 引（运行时擦除）；**运行时**只从 `./vendor/*`（相对路径）。
 *--------------------------------------------------------------------------------------------*/

export * from './piCoreTypes.js';

export { createPiStreamFn } from './streamFnAdapter.js';
export type { SarosModelStreamSource, PiStreamFnAdapterOptions } from './streamFnAdapter.js';

export { agentEventToChatDeltas } from './eventAdapter.js';

export { toPiAgentTool } from './toolAdapter.js';
export type { ISarosToolSpec, SarosToolExecute } from './toolAdapter.js';

export { convertToLlm } from './contextAdapter.js';

export { createNoopPiStateBridge } from './stateAdapter.js';
export type { IPiStateBridge } from './stateAdapter.js';

export { composeBeforeToolCall } from './guardrailBridge.js';
export type { SarosToolGuard, PiBeforeToolCallResult } from './guardrailBridge.js';

export { runPiCraftTurn } from './piTurnDriver.js';
export type { PiCraftTurnParams } from './piTurnDriver.js';

// 宿主桥（P1 接线件）：LMBridge 流源 / 历史转换 / 只读工具集 / 对拍全局入口
export {
	createLmBridgeStreamSource,
	chatMessagesToPiMessages,
	piMessagesToChatMessages,
	createReadOnlyPiTools,
	installPiDualRunGlobal,
} from './piHostBridge.js';
export type { ILmChatFn, PiDualRunSummary } from './piHostBridge.js';
