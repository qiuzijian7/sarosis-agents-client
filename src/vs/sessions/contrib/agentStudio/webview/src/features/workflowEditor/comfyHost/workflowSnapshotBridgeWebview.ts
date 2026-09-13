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
	/**
	 * 中止信号（2026-09-11）：host 放弃该 `stage()`（空闲超时 / 取消）时触发，
	 * runner 须透传进 `runNodeOrStage({ signal })`（执行层早已支持）。
	 */
	signal?: AbortSignal,
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

/** 当前生效的快照库（`applyCanvasOpsToStore` 解析 picker 池时也要用 → 导出）。 */
export function activeStore(): MediaSnapshotStore | undefined {
	let last: MediaSnapshotStore | undefined;
	for (const s of sources.values()) { last = s; }
	return last;
}

/** 已回流的「最新一格」签名（key=nodeId）——保证**只推增量**。 */
const lastForwardedMedia = new Map<string, string>();

/**
 * 取该节点**最新归档**的媒体条目，用于随进度回流到 host（2026-09-11 用户需求
 * 「动态表情包节点，输出一个就显示一个」）。
 *
 * 由来：执行器**逐格归档**（`replaceByKey` 原地替换，见 animatedEmojiExecutor），
 * 但 host 此前**只在节点结束时**才拿到 `snapshot`（`subagent_end`）→ 聊天卡要等
 * 9 格全跑完才出图 ✗（画布侧因为直接读本 store，早已逐格显示 ✓）。
 *
 * 增量语义：同一格已推过 → 返回 undefined（**绝不重复推整份 data URL 快照** ✗ ——
 * 一格 ref 常是数百 KB，逐帧推送会刷爆消息通道）。
 */
function takeNewestMediaForHost(nodeId: string | undefined): { ref: string; kind: string; port: string; index: number } | undefined {
	if (!nodeId) { return undefined; }
	const entries = activeStore()?.byNode(nodeId);
	// ★★ 只回流**最终产物**（2026-09-11 实测 bug）：执行器每格归档**两条** ——
	//   `port:'video'`（绿幕中间视频，非最终产物 ✗）与 `port:'output'`（最终 GIF ✓）。
	//   不区分就会把中间视频也推进聊天卡 → 卡片「已完成 42 个输出」+ 一堆黑屏 `<video>`
	//   （用户实测：视频不能播放、表情缺了，本该只有 9 个）✗。
	//   优先取最新 `output` 条目；没有（其它执行器）才回退最新条目。
	const outEntries = entries ? entries.filter(e => String(e?.port) === 'output') : [];
	// ★ 两阶段（2026-09-11）：阶段①「视频抠像」**不产出 output** —— 此时优先回退到
	//   `port:'matte'`（抠像结果 PNG，小、可显示），**绝不回退到 `port:'video'`**
	//   （绿幕 mp4 的 data URL 常达数 MB，推进聊天卡既卡顿又只能黑屏）✗。
	const matteEntries = entries ? entries.filter(e => String(e?.port) === 'matte') : [];
	const last = outEntries.length > 0
		? outEntries[outEntries.length - 1]
		: matteEntries.length > 0
			? matteEntries[matteEntries.length - 1]
			: (entries ?? []).filter(e => String(e?.port) !== 'video').slice(-1)[0];
	const media = last?.media;
	if (!last || !media || typeof media.ref !== 'string' || !media.ref) { return undefined; }
	const sig = typeof last.key === 'string' ? last.key : `${last.nodeId}:${last.port}:${last.index}`;
	if (lastForwardedMedia.get(nodeId) === sig) { return undefined; }
	lastForwardedMedia.set(nodeId, sig);
	return { ref: media.ref, kind: String(media.kind ?? 'image'), port: String(last.port ?? 'output'), index: Number(last.index ?? 0) };
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

/** 正在执行的 `stage()`：runId → AbortController（2026-09-11，与直跑同构）。 */
const activeStageRuns = new Map<string, AbortController>();

/**
 * host → webview：`workflow.stageRunCancel` —— host 已放弃该 `stage()`（空闲超时 / 取消），
 * 通知画布**停止执行**（与直跑同构）。
 */
export function handleStageRunCancel(data: unknown): void {
	const d = data as { runId?: unknown };
	if (!d || typeof d.runId !== 'string') { return; }
	const controller = activeStageRuns.get(d.runId);
	if (!controller) { return; }
	console.log(`[StageRun] host 请求取消：runId=${d.runId}`);
	controller.abort();
}

/** host → webview：workflow.stageRun 事件处理（P0：真正执行画布媒体节点）。 */
export async function handleStageRunEvent(data: unknown): Promise<void> {
	const s = data as IStageRunEvent;
	if (!s || typeof s.runId !== 'string' || typeof s.stageUid !== 'string') { return; }
	const runner = activeRunner();
	if (!runner) {
		void sendRequest('workflow.stageRunResult', { runId: s.runId, ok: false, error: '画布未打开：无法执行 stage()（请先打开工作流画布）' });
		return;
	}
	// 执行可能耗时数分钟（ComfyUI 采样）；host 侧 requestStageRun 是**空闲超时**（90s 无任何
	// 消息才判死）+ 心跳续期，故下方心跳与进度都必须真的发出去（长任务不被误杀的依据）。
	const controller = new AbortController();
	activeStageRuns.set(s.runId, controller);
	const heartbeatTimer = setInterval(() => {
		void sendRequest('workflow.stageRunHeartbeat', { runId: s.runId });
	}, STAGE_RUN_HEARTBEAT_MS);
	// 进度回推：ComfyUI 生成进度 → host（fire-and-forget；host 端未认领时静默丢弃）。
	const onProgress = (progress: number, message?: string): void => {
		void sendRequest('workflow.stageRunProgress', { runId: s.runId, progress, ...(message !== undefined ? { message } : {}) });
	};
	try {
		const value = await runner(s.stageUid, s.overrides, onProgress, controller.signal);
		void sendRequest('workflow.stageRunResult', { runId: s.runId, ok: true, value });
	} catch (err: unknown) {
		void sendRequest('workflow.stageRunResult', {
			runId: s.runId,
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		clearInterval(heartbeatTimer);
		activeStageRuns.delete(s.runId);
	}
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

/** host → webview：workflow.snapshotMediaPut 载荷（媒体引用落库）。 */
export interface ISnapshotMediaPutEvent {
	/** 落库锚点（发起节点 id）—— 下游按 `store.byNode(该 id)` 取用。 */
	anchorUid: string;
	/** 端口名（用发起节点自身的输出口名）。 */
	port: string;
	/** ★ `'text'`（2026-09-13 P1-2）：Agent / Task 的文本输出也走本通道落库。 */
	kind: 'image' | 'video' | 'audio' | 'text';
	ref: string;
	meta?: Record<string, unknown>;
}

/**
 * host → webview：`workflow.snapshotMediaPut` 事件处理（**媒体**引用落库）。
 *
 * 2026-09-11：选择型节点（`apply:'snapshot'`，如 ImagePicker）不执行节点，其选中结果
 * 原先只存在 host 侧 executionState → 下游按 `store.byNode(上游 id)` 取参考图的执行器
 * （Saros.AnimatedEmoji）取不到 → 报「动态表情包制作需要上游参考图输入」。此处把选中
 * 媒体落进快照库，使选择型节点的输出对下游**与普通节点同构**。
 *
 * `skipImport=true`：透传的是上游已入库资产，避免重复导入媒体库（与 picker/loader
 * 路由语义一致，见 MediaSnapshotStore.put 注释）。
 */
export function handleSnapshotMediaPutEvent(data: unknown): void {
	const a = data as ISnapshotMediaPutEvent;
	if (!a || typeof a.anchorUid !== 'string' || !a.anchorUid) { return; }
	if (typeof a.ref !== 'string' || !a.ref) { return; }
	const store = activeStore();
	if (!store) { return; } // 落库是增益不是前置：画布不在则静默跳过
	store.put({
		nodeId: a.anchorUid,
		port: typeof a.port === 'string' && a.port ? a.port : 'image',
		key: '',
		index: 0,
		media: {
			kind: a.kind,
			ref: a.ref,
			...(a.meta ? { meta: a.meta } : {}),
		},
	}, true /* skipImport：透传上游已入库资产 */);
}

// ─── Direct stage run 桥（存储工作流 ComfyStage → 画布，按 stageClass + values 直跑）───

/** host 下发的「直接执行 stage」事件载荷（与 browser 侧 directStageRunEmitter 对齐）。 */
export interface IDirectStageRunEvent {
	runId: string;
	stageClass: string;
	values: Record<string, unknown>;
	images?: string[];
	/** 原工作流节点 id（snapKey：查快照库命中节点上配置的默认素材）。 */
	nodeId?: string;
	/**
	 * 上游节点 id 列表（2026-09-11）：透传给 runner 从快照库取上游快照 ——
	 * 逐格图生视频类 stage（Saros.AnimatedEmoji）的参考图来源。
	 *
	 * 注：与 `DirectStageRunner` 的同名参数**必须同步**（本接口是 host 下发侧、
	 * 那里是执行侧）——曾出现执行侧已加、本接口漏加的类型漂移（webview
	 * typecheck 新增 2 条错误）。
	 */
	upstreams?: string[];
	/** 工作流 session（2026-09-11）：runner 据此隔离快照库（不同会话内容互不可见）。 */
	workflowSessionId?: string;
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
 * stageClass（如 `ComfyTV.StatEmojiStage` / `ComfyTV.DynEmojiStage`）+ 已解析 values + 参考图 → 跑对应 stage，
 * 返回结构化结果（outputs + snapshot 媒体引用）。抛错 = 执行失败（fail-loud 回程）。
 */
export type DirectStageRunner = (
	stageClass: string,
	values: Record<string, unknown>,
	images: string[] | undefined,
	onProgress: (progress: number, message?: string) => void,
	/** 原节点 id（snapKey：命中节点上配置的默认素材；缺省回退 direct-* 临时 id）。 */
	nodeId?: string,
	/**
	 * 上游节点 id 列表（2026-09-11）：runner 据此从快照库取上游快照 ——
	 * 逐格图生视频类 stage（Saros.AnimatedEmoji）的参考图来源。
	 */
	upstreams?: string[],
	/** 工作流 session（2026-09-11）：runner 据此隔离快照库（不同会话内容互不可见）。 */
	workflowSessionId?: string,
	/**
	 * 中止信号（2026-09-11）：host 放弃该直跑（空闲超时 / 取消）时触发，runner 须透传进
	 * `runNodeOrStage({ signal })` —— 执行层早已支持（animatedEmojiExecutor 逐格检查、
	 * comfyRunner 轮询检查、emojiExecutor throwIfAborted），此前直跑路径未接 →
	 * 「聊天报失败、画布仍在跑并在稍后出图」的僵尸 ✗。
	 */
	signal?: AbortSignal,
) => Promise<DirectStageRunResult>;

const directRunners = new Map<string, DirectStageRunner>();

/**
 * 等待 runner（=画布 panel mount）注册的最长时间：10 分钟。
 * 用户需求（2026-09-10）：画布未打开时应**等待用户打开画布**再继续，而非立即失败。
 * 与 host 侧 requestDirectStageRun 的兜底超时（12min，见 comfyStageBridge）配对，
 * webview 先到点则报明确错误，host 侧留 2min 余量避免竞态。
 */
const DIRECT_STAGE_RUNNER_WAIT_MS = 600_000;

/**
 * 直跑心跳间隔（2026-09-11）：30s（host 空闲窗口 720s，12× 余量）。
 * 心跳把「活性」与「进度」解耦 —— stage 合法地长时间不上报进度时不会被误杀 ✓。
 */
export const DIRECT_STAGE_HEARTBEAT_MS = 30_000;

/**
 * `stage()` 心跳间隔（2026-09-11）：**8s**。
 * 该路径 host 侧空闲窗口只有 90s（`DEFAULT_STAGE_TIMEOUT_MS`），故心跳必须更密
 * —— 30s 那种间隔在这里余量不足（仅 3×）✗。8s → 11× 余量 ✓。
 */
export const STAGE_RUN_HEARTBEAT_MS = 8_000;

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

/** 正在执行的直跑：runId → AbortController（2026-09-11：host 放弃时可通知画布停止）。 */
const activeDirectRuns = new Map<string, AbortController>();

/**
 * host → webview：`workflow.stageDirectRunCancel` —— host 已放弃该直跑（空闲超时等），
 * 通知画布**停止生成**，消除「聊天报失败、画布仍在跑、稍后还可能出图」的僵尸 ✗。
 *
 * 中止能力无需新造：执行层早有 `NodeExecutionInput.signal`（animatedEmojiExecutor 逐格
 * 检查 `input.signal?.aborted`、comfyRunner 轮询检查、emojiExecutor `throwIfAborted`），
 * 此前只是**直跑路径没把 signal 接进去**。
 */
export function handleDirectStageRunCancel(data: unknown): void {
	const d = data as { runId?: unknown };
	if (!d || typeof d.runId !== 'string') { return; }
	const controller = activeDirectRuns.get(d.runId);
	if (!controller) { return; }   // 已结束 / 未知 runId → 无事可做
	console.log(`[DirectStageRun] host 请求取消：runId=${d.runId}`);
	controller.abort();
}

/** host → webview：workflow.stageDirectRun 事件处理（存储工作流 ComfyStage 真正执行）。 */
export async function handleDirectStageRunEvent(data: unknown): Promise<void> {
	const d = data as IDirectStageRunEvent;
	if (!d || typeof d.runId !== 'string' || typeof d.stageClass !== 'string') { return; }

	// ★ controller 在**等待画布之前**就建立（2026-09-11）：host 可能在「等用户打开画布」
	//   期间就放弃，此时应立刻停止等待，而不是继续空转满 10 分钟。
	const controller = new AbortController();
	activeDirectRuns.set(d.runId, controller);
	const onProgress = (progress: number, message?: string): void => {
		// ★ 逐格媒体回流（2026-09-11 用户需求「输出一个就显示一个」）：见
		//   `takeNewestMediaForHost` 头注释（增量、只推新格）。
		const media = takeNewestMediaForHost(d.nodeId);
		void sendRequest('workflow.stageDirectRunProgress', { runId: d.runId, progress, ...(message !== undefined ? { message } : {}), ...(media ? { media } : {}) });
	};
	// ★ 心跳（2026-09-11）：从**接受请求起**就发（含「等用户打开画布」阶段），
	//   使 host 的空闲超时只反映「真的没有消息」——stage 合法长时间无进度不会误杀 ✓。
	//   画布消失则由 host 侧空闲超时 + 面板 dispose 的 abandon 兜底。
	const heartbeatTimer = setInterval(() => {
		void sendRequest('workflow.stageDirectRunHeartbeat', { runId: d.runId });
	}, DIRECT_STAGE_HEARTBEAT_MS);
	try {
		// ★ 等 runner 注册（2026-09-10 用户需求：画布未打开时**等待**而非失败）：
		//   重放时机是「webview 首条 toHost 消息」（bundle 启动最早时刻），而
		//   registerDirectStageRunner 在 WorkflowEditorPanel 的 useEffect（React mount 后）
		//   —— 事件早于注册。此外用户可能尚未打开画布（panel 未 mount），此时应持续等待
		//   用户打开画布，而不是立即失败。轮询至 host 侧兜底超时为止，
		//   每 5s 打一条等待日志（便于用户知道"在等你打开画布"）。
		let runner = activeDirectRunner();
		const runnerWaitDeadline = Date.now() + DIRECT_STAGE_RUNNER_WAIT_MS;
		let waitedLogged = 0;
		while (!runner && !controller.signal.aborted && Date.now() < runnerWaitDeadline) {
			await new Promise<void>(r => setTimeout(r, 200));
			runner = activeDirectRunner();
			const waited = Date.now() - (runnerWaitDeadline - DIRECT_STAGE_RUNNER_WAIT_MS);
			if (!runner && waited - waitedLogged >= 5_000) {
				waitedLogged = waited;
				console.log(`[DirectStageRun] waiting for canvas/runner… ${Math.round(waited / 1000)}s（请打开工作流画布以继续执行）`);
			}
		}
		if (controller.signal.aborted) { return; }   // host 已放弃 → 不再回程（host 侧条目已清）
		if (!runner) {
			void sendRequest('workflow.stageDirectRunResult', { runId: d.runId, ok: false, error: `画布未打开：等待 ${Math.round(DIRECT_STAGE_RUNNER_WAIT_MS / 60000)} 分钟仍无画布，无法执行 ComfyStage` });
			return;
		}
		// 执行可能耗时**数十分钟**（AnimatedEmoji 逐格图生视频 + 抠像 + 拼 GIF）。
		// host 侧 requestDirectStageRun 是**空闲超时**（12 分钟无任何进度才判死）+ 绝对上限兜底，
		// 故下方每条进度都必须真的发出去 —— 这是长任务不被误杀的唯一依据（2026-09-11）。
		const value = await runner(d.stageClass, d.values ?? {}, d.images, onProgress, d.nodeId, d.upstreams, d.workflowSessionId, controller.signal);
		void sendRequest('workflow.stageDirectRunResult', { runId: d.runId, ok: true, value });
	} catch (err: unknown) {
		// 取消导致的失败也如实回程：host 侧若仍在等待（取消早于超时）可立即收尾，
		// 不必再等到空闲超时；host 侧条目已清时回程被静默忽略（resolve 返回 false）。
		void sendRequest('workflow.stageDirectRunResult', {
			runId: d.runId,
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		clearInterval(heartbeatTimer);
		activeDirectRuns.delete(d.runId);
	}
}
