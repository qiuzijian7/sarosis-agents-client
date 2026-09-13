/**
 * 多 agent 协同内核（纯逻辑，无 DOM / 无 LiteGraph 依赖，可直接单测）。
 *
 * 设计来源（详见 `docs/multi-agent-collaboration-design.md`）：
 *  - `semaphore`       ← open-multi-agent `utils/semaphore.ts`（并发闸门）
 *  - `collaborationQueue` ← open-multi-agent `task/queue.ts`（就绪集 + 级联终态）
 *  - `contextAssembly` ← open-multi-agent `orchestrator/task-execution.ts:buildTaskPrompt`（拒绝式注入）
 *  - `blackboard`      ← open-multi-agent `memory/shared.ts` + Swarm blackboard（共享记忆）
 *  - `deliveryQueue`   ← openclaw `agent-steering-queue.ts`（租约式结果回灌）
 *  - `loopGuard`       ← open-multi-agent `agent/loop-detector.ts`（循环/重复检测）
 */
export { createSemaphore, runPooled, type Semaphore } from './semaphore';
export {
	createCollaborationQueue, validateDependencies,
	type CollaborationQueue, type CollabTask, type CollabTaskStatus, type CollabQueueEvent,
} from './collaborationQueue';
export {
	assembleNodeContext, stableStringify, DependencyPayloadError, DEFAULT_MAX_PAYLOAD_BYTES,
	type DependencyResult, type ContextAssemblyOptions, type ContextAssemblyResult,
	type DependencyPayloadMode, type MemoryScope,
} from './contextAssembly';
export {
	createBlackboard,
	type Blackboard, type BlackboardEntry, type BlackboardWriteOptions, type BlackboardSummaryFilter,
} from './blackboard';
export {
	createDeliveryQueue, DEFAULT_LEASE_TTL_MS, DEFAULT_MAX_CONTENT_CHARS,
	type DeliveryQueue, type DeliveryItem, type DeliveryStatus, type DeliveryQueueOptions,
} from './deliveryQueue';
export {
	createLoopDetector, createIterationGuard, computeToolSignature,
	type LoopDetector, type LoopDetectionInfo, type IterationGuard, type LoopDetectorOptions,
} from './loopGuard';
