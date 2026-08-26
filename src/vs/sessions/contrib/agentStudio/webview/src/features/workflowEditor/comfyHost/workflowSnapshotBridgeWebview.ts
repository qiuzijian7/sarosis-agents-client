/*---------------------------------------------------------------------------------------------
 *  workflowSnapshotBridgeWebview — M2 动工作流桥的 webview 侧。
 *
 *  职责：
 *   - registerSnapshotSource(workflowId, store)：LiteGraphCanvas 创建 MediaSnapshotStore
 *     时注册到模块级 registry（后注册者=活跃画布；多画布按最后聚焦者应答）。
 *   - handleSnapshotQueryEvent：nodeOutput(stageUid,slot) 查询 → byNode（前缀合并天然
 *     处理 nodeId↔uid 别名）→ 物化 PortValue → sendRequest('workflow.snapshotResult')。
 *   - handleSnapshotArchiveEvent：run 结果 → store.put SAROS_JSON（kind:'text' +
 *     meta.sarosJson，键=锚点 stageUid —— 与 run 链路同一归档键体系）。
 *
 *  物化规则（与设计文档 §3.3.2 PortValue 一致）：
 *   meta.sarosJson → JSON.parse 原值（json）
 *   kind 'text'    → ref 字符串（text）
 *   image/video/audio → {kind:'media', url:ref, mime?}（media）
 *--------------------------------------------------------------------------------------------*/

import { sendRequest } from '../../../bridge/messageClient.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { MediaSnapshotEntry, MediaRef } from './mediaSnapshot.js';

/** host 下发的查询事件载荷（与 browser/workflow/workflowSnapshotBridge.ts 对齐）。 */
export interface ISnapshotQueryEvent {
	queryId: string;
	stageUid: string;
	slot?: number;
}

/** host 下发的归档事件载荷。 */
export interface ISnapshotArchiveEvent {
	anchorUid: string;
	value: unknown;
	meta: { name: string; runId: string };
}

/** host 下发的「执行画布节点」事件载荷（P0 stage() 写方向桥）。 */
export interface IStageRunEvent {
	runId: string;
	stageUid: string;
	overrides?: Record<string, unknown>;
}

/**
 * 画布节点执行器（由 WorkflowEditorPanel 注册）。
 * stage(uid) 经此真正跑 ComfyUI —— 返回执行后的物化输出（与 nodeOutput 同构）。
 * 抛错 = 执行失败（fail-loud 回程 host → worker fatal）。
 * `onProgress`：ComfyUI 生成进度（0-100），实时回推 host → 聊天工具卡。
 */
export type StageRunner = (
	stageUid: string,
	overrides?: Record<string, unknown>,
	onProgress?: (progress: number, message?: string) => void,
) => Promise<unknown>;

/** 活跃快照源注册表（key=workflowId；查询取最后注册者）。 */
const sources = new Map<string, MediaSnapshotStore>();
/** 活跃节点执行器注册表（key=workflowId；取最后注册者，与 sources 同策略）。 */
const runners = new Map<string, StageRunner>();

export function registerSnapshotSource(workflowId: string, store: MediaSnapshotStore): void {
	sources.set(workflowId || 'default', store);
}

export function unregisterSnapshotSource(workflowId: string): void {
	sources.delete(workflowId || 'default');
}

/** WorkflowEditorPanel 注册画布节点执行器（P0 stage() 用）。 */
export function registerStageRunner(workflowId: string, runner: StageRunner): void {
	runners.set(workflowId || 'default', runner);
}

export function unregisterStageRunner(workflowId: string): void {
	runners.delete(workflowId || 'default');
}

function activeRunner(): StageRunner | undefined {
	let last: StageRunner | undefined;
	for (const r of runners.values()) { last = r; }
	return last;
}

function activeStore(): MediaSnapshotStore | undefined {
	let last: MediaSnapshotStore | undefined;
	for (const s of sources.values()) { last = s; }
	return last;
}

/** MediaRef → PortValue（物化规则见文件头）。 */
export function materializeSnapshotEntry(media: MediaRef): unknown {
	if (media.meta?.['sarosJson'] === '1' || media.meta?.['sarosJson'] === 1) {
		try { return JSON.parse(media.ref); } catch { return media.ref; }
	}
	if (media.kind === 'text') { return media.ref; }
	return { kind: 'media', url: media.ref, ...(media.meta?.['mime'] !== undefined ? { mime: String(media.meta['mime']) } : {}) };
}

/** host → webview：workflow.snapshotQuery 事件处理（fail-loud 回程）。 */
export function handleSnapshotQueryEvent(data: unknown): void {
	const q = data as ISnapshotQueryEvent;
	if (!q || typeof q.queryId !== 'string' || typeof q.stageUid !== 'string') { return; }
	const store = activeStore();
	if (!store) {
		void sendRequest('workflow.snapshotResult', { queryId: q.queryId, ok: false, error: '画布未打开：无法解析 nodeOutput（请先打开工作流画布）' });
		return;
	}
	const entries: MediaSnapshotEntry[] = store.byNode(q.stageUid);
	if (entries.length === 0) {
		void sendRequest('workflow.snapshotResult', { queryId: q.queryId, ok: false, error: `画布节点无输出快照：stageUid "${q.stageUid}"（请先运行该节点）` });
		return;
	}
	const slot = q.slot ?? 0;
	if (slot >= entries.length) {
		void sendRequest('workflow.snapshotResult', { queryId: q.queryId, ok: false, error: `slot ${slot} 越界：节点 "${q.stageUid}" 共 ${entries.length} 个输出` });
		return;
	}
	const value = materializeSnapshotEntry(entries[slot].media);
	void sendRequest('workflow.snapshotResult', { queryId: q.queryId, ok: true, value });
}

/** host → webview：workflow.stageRun 事件处理（P0：真正执行画布媒体节点）。 */
export function handleStageRunEvent(data: unknown): void {
	const s = data as IStageRunEvent;
	if (!s || typeof s.runId !== 'string' || typeof s.stageUid !== 'string') { return; }
	const runner = activeRunner();
	if (!runner) {
		void sendRequest('workflow.stageRunResult', { runId: s.runId, ok: false, error: '画布未打开：无法执行 stage()（请先打开工作流画布）' });
		return;
	}
	// 执行可能耗时数分钟（ComfyUI 采样），不设本地超时——host 侧 requestStageRun 已有 10min 兜底。
	// 进度回推：ComfyUI 生成进度 → host（fire-and-forget；host 端未认领时静默丢弃）。
	const onProgress = (progress: number, message?: string): void => {
		void sendRequest('workflow.stageRunProgress', { runId: s.runId, progress, ...(message !== undefined ? { message } : {}) });
	};
	runner(s.stageUid, s.overrides, onProgress)
		.then(value => {
			void sendRequest('workflow.stageRunResult', { runId: s.runId, ok: true, value });
		})
		.catch((err: unknown) => {
			void sendRequest('workflow.stageRunResult', {
				runId: s.runId,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		});
}

/** host → webview：workflow.snapshotArchive 事件处理（SAROS_JSON 落库）。 */
export function handleSnapshotArchiveEvent(data: unknown): void {
	const a = data as ISnapshotArchiveEvent;
	if (!a || typeof a.anchorUid !== 'string' || !a.anchorUid) { return; }
	const store = activeStore();
	if (!store) { return; } // 归档是增益不是前置：画布不在则静默跳过
	const ref = JSON.stringify(a.value ?? null);
	store.put({
		nodeId: a.anchorUid,
		port: 'output',
		key: `${a.anchorUid}:output:0`,
		index: 0,
		media: {
			kind: 'text',
			ref,
			meta: { sarosJson: '1', workflowRun: a.meta?.name, runId: a.meta?.runId, mime: 'application/json' },
		},
	}, true);
}

// ─── Direct stage run 桥（存储工作流 ComfyStage → 画布，按 stageClass + values 直跑）───

/** host 下发的「直接执行 stage」事件载荷（与 browser 侧 directStageRunEmitter 对齐）。 */
export interface IDirectStageRunEvent {
	runId: string;
	stageClass: string;
	values: Record<string, unknown>;
	images?: string[];
}

/** 直接 stage 执行结果（与 browser/comfyStageBridge.ts::DirectStageRunResult 同构）。 */
export interface DirectStageRunResult {
	status: 'success' | 'error';
	error?: string;
	outputs: Record<string, unknown>;
	snapshot?: Array<{
		port: string;
		kind: 'image' | 'video' | 'audio' | 'text' | 'unknown';
		ref: string;
		meta?: Record<string, unknown>;
	}>;
	summary?: string;
}

/**
 * 直接 stage 执行器（由 WorkflowEditorPanel 注册）。
 * stageClass（如 `ComfyTV.EmojiStage`）+ 已解析 values + 参考图 → 跑对应 stage，
 * 返回结构化结果（outputs + snapshot 媒体引用）。抛错 = 执行失败（fail-loud 回程）。
 */
export type DirectStageRunner = (
	stageClass: string,
	values: Record<string, unknown>,
	images: string[] | undefined,
	onProgress: (progress: number, message?: string) => void,
) => Promise<DirectStageRunResult>;

const directRunners = new Map<string, DirectStageRunner>();

export function registerDirectStageRunner(workflowId: string, runner: DirectStageRunner): void {
	directRunners.set(workflowId || 'default', runner);
}

export function unregisterDirectStageRunner(workflowId: string): void {
	directRunners.delete(workflowId || 'default');
}

function activeDirectRunner(): DirectStageRunner | undefined {
	let last: DirectStageRunner | undefined;
	for (const r of directRunners.values()) { last = r; }
	return last;
}

/** host → webview：workflow.stageDirectRun 事件处理（存储工作流 ComfyStage 真正执行）。 */
export function handleDirectStageRunEvent(data: unknown): void {
	const d = data as IDirectStageRunEvent;
	if (!d || typeof d.runId !== 'string' || typeof d.stageClass !== 'string') { return; }
	const runner = activeDirectRunner();
	if (!runner) {
		void sendRequest('workflow.stageDirectRunResult', { runId: d.runId, ok: false, error: '画布未打开：无法执行 ComfyStage（请先打开工作流画布）' });
		return;
	}
	// 执行可能耗时数分钟（ComfyUI 采样）；host 侧 requestDirectStageRun 有 10min 兜底。
	const onProgress = (progress: number, message?: string): void => {
		void sendRequest('workflow.stageDirectRunProgress', { runId: d.runId, progress, ...(message !== undefined ? { message } : {}) });
	};
	runner(d.stageClass, d.values ?? {}, d.images, onProgress)
		.then(value => {
			void sendRequest('workflow.stageDirectRunResult', { runId: d.runId, ok: true, value });
		})
		.catch((err: unknown) => {
			void sendRequest('workflow.stageDirectRunResult', {
				runId: d.runId,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		});
}
