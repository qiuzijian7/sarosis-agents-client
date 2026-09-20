/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 会话事件影子日志（方案主线 B1，2026-09-20）。
 *
 * **做什么**：在现有 checkpointSink（快照模型）旁，以 **append-only JSONL** 影子记录
 * 每个 turn checkpoint 的**消息差量**——事件溯源（pi 的 session JSONL 树）的最小验证体：
 *   每行 = `{ seq, ts, sessionId, kind: 'turn-checkpoint', iteration, from, to, messages }`，
 *   `messages` 是自上一行以来新增的片段（快照的 state.messages 单调增长 ⇒ 差量即事件）。
 *   重建 transcript = 按序拼接所有行的 messages（B2 的对拍判据）。
 *
 * **纪律**：
 *   · **只写不读** —— 不参与任何恢复路径（B2 才做读侧对拍）；
 *   · **默认关** —— `globalThis.__SAROSIS_EVENT_SHADOW = true` 才写（dev 验证开关，
 *     与 `__SAROSIS_PI_KERNEL` 同款运行时门控约定）；关时零开销零文件；
 *   · **绝不抛错/阻断** —— 全部异常吞成 warn（影子设施不得影响主流程）；
 *   · 进程重启后 from/to 重新从 0 起 ⇒ 可能重复记录相同片段，由 iteration+from/to
 *     可辨识、对下游无害（影子期的可接受折衷）。
 *
 * @module agentStudio/browser/sessionEventShadowLog
 */

import type { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { AgentRunStateSnapshot } from '../common/agentRunState.js';

/** 一行影子事件（turn checkpoint 的消息差量）。 */
export interface IShadowTurnEvent {
	/** 写入时刻 epoch ms（兼任序号——同进程内单调）。 */
	readonly seq: number;
	readonly ts: string;
	readonly sessionId: string;
	readonly kind: 'turn-checkpoint' | 'turn-complete';
	/** checkpoint 的绝对迭代号（含 restored 偏移）。 */
	readonly iteration?: number;
	/** 本次新增消息在 transcript 中的区间 [from, to)。 */
	readonly from?: number;
	readonly to?: number;
	/** 新增消息片段（legacy 循环消息形状）。 */
	readonly messages?: readonly unknown[];
}

export interface IShadowLogDeps {
	readonly fileService: IFileService;
	/** 影子日志根目录（通常 `<dataRoot>/shadow`）。 */
	readonly shadowDirUri: URI;
	readonly log: (msg: string) => void;
	readonly logWarn: (msg: string) => void;
}

/**
 * 影子日志器。每个 session 一个 JSONL 文件（`<shadowDir>/turn-events.<sessionId>.jsonl`；
 * shadowDir 由接线方解析为 `<userRoamingDataHome>/agent-studio/shadow/` —— 即产品的
 * `~/.vssaros/agent-studio/shadow/`（dev 为 `~/.vssaros-dev/…`，与 chat-history 同根同约定）。
 * 实例生命周期 = 进程级（挂在 AgentDriverService 上）；`_lastWrittenCount` 是进程内
 * 差量游标（重启重归零 —— 见文件头的重复记录折衷说明）。
 */
export class SessionEventShadowLog {
	private readonly _lastWrittenCount = new Map<string, number>();
	/** 写盘串行化（同 session 的两次 checkpoint 可能近到交错 ⇒ 读改写必须串行）。 */
	private readonly _writeQueue = new Map<string, Promise<void>>();

	constructor(private readonly _deps: IShadowLogDeps) { }

	/** 是否启用（运行时门控，每次写入判一次 ⇒ devtools 翻转即时生效）。 */
	static isEnabled(): boolean {
		return (globalThis as { __SAROSIS_EVENT_SHADOW?: unknown }).__SAROSIS_EVENT_SHADOW === true;
	}

	/** turn checkpoint 落盘时的影子记录（fire-and-forget）。 */
	appendCheckpoint(sessionId: string, snapshot: AgentRunStateSnapshot): void {
		if (!SessionEventShadowLog.isEnabled()) { return; }
		try {
			const messages = (snapshot.state.messages ?? []) as readonly unknown[];
			const from = this._lastWrittenCount.get(sessionId) ?? 0;
			const to = messages.length;
			const appended = to > from ? messages.slice(from) : [];
			this._lastWrittenCount.set(sessionId, to);
			this._enqueue(sessionId, {
				seq: Date.now(), ts: new Date().toISOString(), sessionId,
				kind: 'turn-checkpoint',
				iteration: typeof snapshot.state.iteration === 'number' ? snapshot.state.iteration : undefined,
				from, to,
				messages: appended,
			});
		} catch (err) {
			this._deps.logWarn(`[ShadowLog] appendCheckpoint 失败（已忽略）: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** turn 成功完成（checkpoint 清除）时的终止标记。 */
	markTurnComplete(sessionId: string): void {
		if (!SessionEventShadowLog.isEnabled()) { return; }
		this._lastWrittenCount.delete(sessionId);
		this._enqueue(sessionId, {
			seq: Date.now(), ts: new Date().toISOString(), sessionId,
			kind: 'turn-complete',
		});
	}

	/** 仅供测试/诊断：读取某 session 的影子事件流。 */
	async readEvents(sessionId: string): Promise<IShadowTurnEvent[]> {
		try {
			const content = await this._deps.fileService.readFile(this._fileUri(sessionId));
			return content.value.toString().split('\n')
				.filter(line => line.trim().length > 0)
				.map(line => JSON.parse(line) as IShadowTurnEvent);
		} catch {
			return [];
		}
	}

	// ── 内部 ──────────────────────────────────────────────────────────────

	private _fileUri(sessionId: string): URI {
		const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
		return joinPath(this._deps.shadowDirUri, `turn-events.${safe}.jsonl`);
	}

	/** 同 session 串行读-改-写（读旧内容 + 追加一行 + 写回；无 append API 的最小实现）。 */
	private _enqueue(sessionId: string, event: IShadowTurnEvent): void {
		const prev = this._writeQueue.get(sessionId) ?? Promise.resolve();
		const next = prev.catch(() => { /* 前序失败不阻断后续 */ }).then(async () => {
			const uri = this._fileUri(sessionId);
			let existing = '';
			try { existing = (await this._deps.fileService.readFile(uri)).value.toString(); } catch { /* 不存在 */ }
			const line = JSON.stringify(event);
			const content = existing + (existing && !existing.endsWith('\n') ? '\n' : '') + line + '\n';
			await this._deps.fileService.writeFile(uri, VSBuffer.fromString(content));
			this._deps.log(`[ShadowLog] ${event.kind} @${sessionId} (to=${event.to ?? '-'})`);
		});
		this._writeQueue.set(sessionId, next);
		next.catch(() => { /* 吞：影子设施不抛错 */ }).finally(() => {
			if (this._writeQueue.get(sessionId) === next) { this._writeQueue.delete(sessionId); }
		});
	}
}
