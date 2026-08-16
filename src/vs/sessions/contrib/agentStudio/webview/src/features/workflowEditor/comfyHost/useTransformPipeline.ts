/*---------------------------------------------------------------------------------------------
 *  useTransformPipeline — transform variant 的「改参数即自动出图」管线。
 *
 *  移植自 ComfyTV `src/composables/widgets/useTransformPipeline.ts`（Vue composable
 *  → React hook）。ComfyTV 的 transform stage（Crop/Rotate/Mirror/ColorGrade/…）
 *  **没有运行按钮**：卡片里改一个滑块，200ms 防抖后自动重新计算并把结果写回
 *  stage output。本 hook 提供等价语义。
 *
 *  与 ComfyTV 的差异（有意）：
 *   - ComfyTV 注入 `compute(img) => canvas` 并自行 uploadBlob；本项目直接复用已有的
 *     `runInstantNode()`（它已封装「取上游图 → applyInstantDraw → toBlob →
 *     /upload/image → snapshotStore.put」整条链），因此自动重算与手动点运行走
 *     **完全相同**的代码路径，不会产生两套变换实现漂移。
 *   - runner 通过 runnerContext 单例解析（NodeCard 是 createNodeCard 挂载的，没有
 *     props 传 runner，见 runnerContext.ts 注释）。
 *
 *  保留 ComfyTV 的三个关键设计：
 *   1. debounce（默认 200ms）—— 拖滑块不会每帧发一次上传
 *   2. computeSeq 竞态防护 —— 过期结果直接丢弃，避免旧图覆盖新图
 *   3. 三态 UI 文案（idle/applying/applied）
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import { runInstantNode } from './instantExecutor.js';
import { getActiveRunnerRegistry, getActiveRunnerPreference } from './runnerContext.js';

/** 管线状态，驱动卡片上的三态提示文案。 */
export type TransformPhase = 'idle' | 'applying' | 'applied' | 'error';

export interface UseTransformPipelineOptions {
	/** 节点 id（快照按此 id 归档）。 */
	nodeId: string | undefined;
	/** 节点类型（ComfyTV.RotateStage 等），决定 applyInstantDraw 分支。 */
	nodeType: string | undefined;
	/** 当前控件值（angle / horizontal / x,y,width,height …）。 */
	values: Record<string, unknown>;
	/** 上游图像 ref —— 变化时也要重算（重新生成上游后下游应跟随刷新）。 */
	upstreamImageRef: string | undefined;
	/** 上游节点 id 列表（runInstantNode 用它找源图）。 */
	upstreamNodeIds: string[] | undefined;
	snapshotStore: MediaSnapshotStore | undefined;
	/** 仅 transform variant 启用；其它 variant 传 false 完全关闭。 */
	enabled: boolean;
	/**
	 * 注入的 fetch —— **必须传代理 fetch**（`createProxiedFetch()`）。
	 *
	 * 上游图是 ComfyUI 的 `view?filename=…` URL，webview 沙箱直接 `globalThis.fetch`
	 * 会被跨源拦掉，抛 `TypeError: Failed to fetch`（卡片上显示为红色文案）。
	 * 项目里其它取图路径（SnapshotPreview 等）一律走 createProxiedFetch，这里
	 * 漏传就会出现「参数一改就报 Failed to fetch、OUTPUT 永远空」。
	 */
	fetchImpl?: typeof fetch;
	debounceMs?: number;
}

export interface UseTransformPipelineResult {
	phase: TransformPhase;
	error: string | undefined;
	/** 手动触发（外部编辑器 commit 后可显式调用；参数变化已自动触发）。 */
	requestRecompute: () => void;
}

/** transform 参数的稳定签名 —— 避免 values 对象每次渲染新建导致的无限重算。 */
function valuesSignature(values: Record<string, unknown>): string {
	const keys = Object.keys(values).sort();
	let out = '';
	for (const k of keys) {
		const v = values[k];
		out += `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)};`;
	}
	return out;
}

export function useTransformPipeline(options: UseTransformPipelineOptions): UseTransformPipelineResult {
	const {
		nodeId, nodeType, values, upstreamImageRef, upstreamNodeIds,
		snapshotStore, enabled, fetchImpl, debounceMs = 200,
	} = options;

	const [phase, setPhase] = React.useState<TransformPhase>('idle');
	const [error, setError] = React.useState<string | undefined>(undefined);

	// 竞态防护：只有最后一次请求的结果被接受（对齐 ComfyTV computeSeq）。
	const seqRef = React.useRef(0);
	const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	// 已卸载后不要 setState（卡片随 syncOverlay 频繁挂/卸）。
	const aliveRef = React.useRef(true);
	React.useEffect(() => () => {
		aliveRef.current = false;
		if (timerRef.current) { clearTimeout(timerRef.current); }
	}, []);

	// 最新值放 ref：防抖回调里读 ref，避免把整个 values 塞进依赖数组。
	const latest = React.useRef({ nodeId, nodeType, values, upstreamNodeIds, snapshotStore, fetchImpl });
	latest.current = { nodeId, nodeType, values, upstreamNodeIds, snapshotStore, fetchImpl };

	const run = React.useCallback(async () => {
		const { nodeId: id, nodeType: type, values: vals, upstreamNodeIds: ups, snapshotStore: store, fetchImpl: fetcher } = latest.current;
		if (!id || !type || !store) { return; }
		const registry = getActiveRunnerRegistry();
		const runner = registry?.resolve(getActiveRunnerPreference());
		if (!runner) {
			// 未连接引擎：静默保持 idle（transform 无运行按钮，不该弹错误横幅刷屏）。
			return;
		}
		const mySeq = ++seqRef.current;
		if (aliveRef.current) { setPhase('applying'); setError(undefined); }
		try {
			const res = await runInstantNode({
				runner,
				nodeId: id,
				type,
				values: vals,
				upstreams: ups,
				store,
				// 缺这一行就是 `TypeError: Failed to fetch`（见 fetchImpl 注释）。
				fetchImpl: fetcher,
			});
			// 过期结果直接丢弃（ComfyTV: if (mySeq !== computeSeq) return）。
			if (mySeq !== seqRef.current || !aliveRef.current) { return; }
			if (res.status === 'success') {
				setPhase('applied');
			} else {
				setPhase('error');
				setError(res.error ?? '变换失败');
			}
		} catch (err) {
			if (mySeq !== seqRef.current || !aliveRef.current) { return; }
			setPhase('error');
			setError(String(err));
		}
	}, []);

	const requestRecompute = React.useCallback(() => {
		if (timerRef.current) { clearTimeout(timerRef.current); }
		timerRef.current = setTimeout(() => {
			timerRef.current = undefined;
			void run();
		}, debounceMs);
	}, [run, debounceMs]);

	// 参数或上游图变化 → 自动重算（ComfyTV: watch(angle, requestRecompute) +
	// watch(sourceImageUrl, …, { immediate: true })）。
	const sig = valuesSignature(values);
	React.useEffect(() => {
		if (!enabled || !upstreamImageRef) { return; }
		requestRecompute();
	}, [enabled, upstreamImageRef, sig, requestRecompute]);

	return { phase, error, requestRecompute };
}

/** 三态提示文案（对齐 ComfyTV 的 applying / applied / adjustToApply）。纯函数。 */
export function transformPhaseLabel(phase: TransformPhase, hasSource: boolean): string {
	if (!hasSource) { return '连接上游图像以开始'; }
	switch (phase) {
		case 'applying': return '应用中…';
		case 'applied': return '已应用';
		case 'error': return '变换失败';
		default: return '调整参数即自动应用';
	}
}
