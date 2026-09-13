/**
 * fxAndLoadImageNodes — fx 链与原生 LoadImage 的声明式收编（2026-09-09 批次 10）。
 *
 * - fx（builder ×N + chain 终端）：run 内合并上游 values（fx 线程语义）→
 *   runSingleNode；builder 走 comfyOutputsToFxSnapshots 提取，chain 终端直接产真实视频快照。
 * - 原生 LoadImage：provider 快照（http/data URL）→ 先上传 ComfyUI（bridging）再执行；
 *   无桥接变化 → 直接 runSingleNode（LoadImage 不会有 plugin hook，可安全内联链尾）。
 *
 * 执行器/工具依赖全部来自可独立 import 的模块（workflowRunShared/nodeExecutor/fxChain），
 * 不回指 workflowRun.ts——分发链剩余段收敛为：providerPicker → LLMImage → schema → plugin。
 */
import { defineNodeRuntime } from '../nodeDefinition.js';
import type { NodeExecutionInput } from '../workflowRunShared.js';
import type { SingleNodeRunResult } from '../nodeExecutor.js';
import { collectUpstreamValues, resolveLoadImageInputForNode } from '../workflowRunShared.js';
import { runSingleNode, comfyOutputsToFxSnapshots } from '../nodeExecutor.js';
import { FX_BUILD_NODE_IDS, isFxChainNode } from '../fxChain.js';

const runFx = (input: NodeExecutionInput): Promise<SingleNodeRunResult> => {
	const fxValues = { ...collectUpstreamValues(input.store, input.upstreams), ...input.values };
	return runSingleNode({
		runner: input.runner,
		nodeId: input.nodeId,
		snapshotKey: input.snapshotKey,
		type: input.type,
		values: fxValues,
		store: input.store,
		// chain 终端产真实视频快照（标准提取）；中间 builder 产出线程化 fx 值。
		extractOutputs: isFxChainNode(input.type) ? undefined : comfyOutputsToFxSnapshots,
		onProgress: p => input.onProgress?.({ value: p.value }),
		signal: input.signal,
	});
};
for (const id of FX_BUILD_NODE_IDS) {
	defineNodeRuntime({ type: `ComfyTV.${id}`, run: runFx });
}
defineNodeRuntime({ type: 'ComfyTV.FXChainStage', run: runFx });

const runLoadImage = async (input: NodeExecutionInput): Promise<SingleNodeRunResult> => {
	const bridged = await resolveLoadImageInputForNode(input);
	if (bridged.status === 'error') { return bridged.result; }
	if (bridged.values !== input.values) {
		return runSingleNode({
			runner: input.runner,
			nodeId: input.nodeId,
			snapshotKey: input.snapshotKey,
			type: input.type,
			values: bridged.values,
			store: input.store,
			onProgress: p => input.onProgress?.({ value: p.value }),
			signal: input.signal,
		});
	}
	// 无桥接变化 → 原值执行（LoadImage 不参与 plugin hook，可安全内联链尾语义）。
	return runSingleNode({
		runner: input.runner,
		nodeId: input.nodeId,
		snapshotKey: input.snapshotKey,
		type: input.type,
		values: input.values,
		store: input.store,
		onProgress: p => input.onProgress?.({ value: p.value }),
		signal: input.signal,
	});
};
defineNodeRuntime({ type: 'LoadImage', run: runLoadImage });
