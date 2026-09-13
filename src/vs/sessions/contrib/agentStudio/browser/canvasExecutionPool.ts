/*---------------------------------------------------------------------------------------------
 * CanvasExecutionPool — headless 画布执行池（② 完整版，2026-09-09）。
 *
 * 聊天触发存储工作流 ComfyStage 节点而**没有任何画布打开**时（workflowSnapshotBridge
 * 同步 ack 判定 → directStageRunUnhandledEmitter），优先把请求交给本池的离屏
 * workflow-editor webview 执行——完全不打开 editor，用户无感。
 *
 * 关键事实（2026-09-09 调研，详见 memory 2026-09-09.md 批次 23/24）：
 * - chat 与 canvas 是**同一个 webview.js bundle**，panelType 区分面板；
 * - warm chat 实例是通用 webview：postMessage `pool.activate {panelType:'workflow-editor'}`
 *   即变身画布（webview 侧 index.tsx pool.activate 原生支持 + Zustand 状态清理）；
 * - WorkflowEditorPanel 挂载即 registerDirectStageRunner(workflowId??'default',
 *   runStageByClass)——runStageByClass 按 stageClass 查表执行，不依赖 workflow 文档内容；
 * - 回程 workflow.stageDirectRunResult/Progress 直接转发 bridge 全局
 *   resolveDirectStageRun / onStageRunProgress（无需完整 controller）。
 *
 * v1 策略：warm miss（acquire 返回 undefined）时返回失败 → 调用方回退
 * preserveFocus 打开画布路径（agentStudioWebviewController 现有 fallback）。
 * 单实例 + busy 队列：ComfyUI 采样可能持续数分钟，串行执行避免争抢。
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioWebviewPool, IPooledWebview } from './agentStudioWebviewPool.js';
import { resolveDirectStageRun, onDirectStageRunProgress, onDirectStageRunHeartbeat, onStageRunHeartbeat } from './workflow/workflowSnapshotBridge.js';
import type { DirectStageRunPayload } from './workflow/workflowSnapshotBridge.js';

interface IPoolInstance {
	webview: IPooledWebview['webview'];
	container: HTMLElement;
}

export class CanvasExecutionPool extends Disposable {
	private _instance: IPoolInstance | undefined;
	private _busy = false;
	private readonly _queue: DirectStageRunPayload[] = [];
	private readonly _onDidFail = this._register(new Emitter<{ payload: DirectStageRunPayload; reason: string }>());
	/** 池执行失败（无 warm / webview 通道异常）→ 调用方回退 preserveFocus 开画布。 */
	readonly onDidFail: Event<{ payload: DirectStageRunPayload; reason: string }> = this._onDidFail.event;

	constructor(
		private readonly webviewPool: IAgentStudioWebviewPool,
		private readonly logService: ILogService,
	) {
		super();
	}

	/** 尝试用池执行；成功入队返回 true，池不可用返回 false（调用方走 fallback）。 */
	tryExecute(payload: DirectStageRunPayload): boolean {
		if (this._busy) {
			this._queue.push(payload);
			return true;
		}
		if (!this._instance) {
			const warm = this.webviewPool.acquire();
			if (!warm) {
				this.logService.info('[CanvasExecPool] no warm instance → fallback to open-canvas path');
				return false;
			}
			if (!this._activate(warm)) { return false; }
			this._instance = { webview: warm.webview, container: warm.container };
		}
		this._busy = true;
		this._send(payload);
		return true;
	}

	private _activate(warm: IPooledWebview): boolean {
		try {
			const webview = warm.webview;
			// 回程转发：workflow.stageDirectRunResult/Progress → bridge 全局（无需 controller）。
			this._register(webview.onMessage((msg) => {
				// ★ webview 出站结构（messageClient.sendRequest）：{id, direction:'toHost', type, payload}
				//   —— payload 是顶层字段（runId 等在其内）；兼容 data 包装层。
				const m = msg.message as { type?: string; payload?: unknown; data?: unknown } | undefined;
				if (!m?.type) { return; }
				const p = (m.payload ?? m.data ?? m) as { runId?: string } & Record<string, unknown>;
				if (!p?.runId) { return; }
				if (m.type === 'workflow.stageDirectRunResult') {
					const ok = resolveDirectStageRun(p as unknown as Parameters<typeof resolveDirectStageRun>[0]);
					if (ok) { this._finishRun(); }
				} else if (m.type === 'workflow.stageDirectRunProgress') {
					onDirectStageRunProgress(p as unknown as Parameters<typeof onDirectStageRunProgress>[0]);
				} else if (m.type === 'workflow.stageDirectRunHeartbeat') {
					onDirectStageRunHeartbeat(p as unknown as { runId?: string });
				} else if (m.type === 'workflow.stageRunHeartbeat') {
					onStageRunHeartbeat(p as unknown as { runId?: string });
				}
			}));
			// 激活为 workflow-editor 面板（initialData=null → 空 workflow，runner 照常注册）。
			void webview.postMessage({
				direction: 'toWebview',
				type: 'pool.activate',
				data: { panelType: 'workflow-editor', initialTheme: '', cspNonce: undefined, initialData: null },
			});
			this.logService.info('[CanvasExecPool] pooled webview activated as workflow-editor');
			return true;
		} catch (err) {
			this.logService.warn('[CanvasExecPool] activate failed:', err);
			return false;
		}
	}

	private _send(payload: DirectStageRunPayload): void {
		this._instance!.webview.postMessage({
			direction: 'toWebview',
			type: 'workflow.stageDirectRun',
			data: payload,
		});
		this.logService.info(`[CanvasExecPool] sent runId=${payload.runId} stageClass=${payload.stageClass} (queue=${this._queue.length})`);
	}

	private _finishRun(): void {
		this._busy = false;
		const next = this._queue.shift();
		if (next && this._instance) {
			this._busy = true;
			this._send(next);
		}
	}

	override dispose(): void {
		if (this._instance) {
			try { this._instance.webview.dispose(); this._instance.container.remove(); } catch { /* ignore */ }
			this._instance = undefined;
		}
		super.dispose();
	}
}
