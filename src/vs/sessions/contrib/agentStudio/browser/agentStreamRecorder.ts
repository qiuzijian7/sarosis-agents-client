/*---------------------------------------------------------------------------------------------
 *  agentStreamRecorder.ts
 *
 *  LLM 流式输出本地记录器。
 *
 *  把 nativeChatEditorPane 收到的原始 delta 流（text/thinking/tool 系/subagent_trace/
 *  done/error 等）按 JSONL 格式写入 `<userData>/stream-records/` 目录：
 *    - 第 1 行：{ kind: 'meta', ... } 会话元信息
 *    - 中间行：{ kind: 'delta', t, type, delta } — t 为相对流开始的 ms 偏移
 *    - 末行：  { kind: 'end', reason, durationMs, deltaCount }
 *
 *  用途：
 *    1. 排障——事后逐条回放 UI 实际收到的流式数据（而非只看日志摘要）；
 *    2. 测试——记录文件可直接作为 streamReplayUi.test.ts 的 fixture，
 *       驱动 StreamReplayModel 验证聊天框消息模型的渲染正确性。
 *
 *  开关（默认关闭，避免无谓 IO）：
 *    localStorage['saros.streamRecord'] = '1'  —— F12 控制台设置后新流式会话生效。
 *
 *  设计约束：
 *    - 模块不依赖 DOM / window（localStorage 访问有 typeof 守卫），Node 单测可直接
 *      import 纯函数部分（sanitize / format / parse）。
 *    - 写文件整体覆盖（行集保存在内存，flush 时全量重写），避免追加竞态；
 *      流式内容量级（百 KB ~ 几 MB）内存可承受。
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { ILogService } from '../../../../platform/log/common/log.js';
import type { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';

// ─── 记录文件格式（纯函数，可单测）────────────────────────────────────────

export interface IStreamRecordMeta {
	readonly agentId: string;
	readonly sessionId?: string;
	readonly chatId?: string;
	readonly startedAt: number;
	readonly note?: string;
}

export interface IStreamRecordEnd {
	readonly reason: string;
	readonly durationMs: number;
	readonly deltaCount: number;
}

/** 单条记录行（kind='delta'）。 */
export interface IStreamRecordLine {
	readonly t: number;
	readonly type: string;
	readonly delta: unknown;
}

/** 超过此长度的字符串字段在记录时截断（防单个巨大 tool_result 撑爆文件）。 */
export const STREAM_RECORD_MAX_FIELD_LEN = 8000;

/**
 * 截断 delta 中的超长字符串字段（浅层 + 一层嵌套），返回可安全 JSON 化的副本。
 * text delta 的 content 通常很小（增量片段），不会被截断；
 * 主要作用于 tool_result.content / subagent_trace.subagentData 等大载荷。
 */
export function sanitizeDeltaForRecord(delta: unknown, maxLen: number = STREAM_RECORD_MAX_FIELD_LEN): unknown {
	if (delta === null || delta === undefined) { return delta; }
	if (typeof delta === 'string') {
		return delta.length > maxLen ? delta.slice(0, maxLen) + `…[truncated ${delta.length - maxLen}ch]` : delta;
	}
	if (Array.isArray(delta)) {
		return delta.map(item => sanitizeDeltaForRecord(item, maxLen));
	}
	if (typeof delta === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(delta as Record<string, unknown>)) {
			out[k] = sanitizeDeltaForRecord(v, maxLen);
		}
		return out;
	}
	return delta;
}

/** 格式化一条 delta 记录行（不含换行符）。 */
export function formatRecordLine(t: number, delta: unknown): string {
	const type = (delta as { type?: string })?.type ?? 'unknown';
	return JSON.stringify({ kind: 'delta', t, type, delta: sanitizeDeltaForRecord(delta) });
}

/** 格式化 meta 头行。 */
export function formatMetaLine(meta: IStreamRecordMeta): string {
	return JSON.stringify({ kind: 'meta', ...meta });
}

/** 格式化 end 尾行。 */
export function formatEndLine(end: IStreamRecordEnd): string {
	return JSON.stringify({ kind: 'end', ...end });
}

export interface IParsedStreamRecord {
	readonly meta: IStreamRecordMeta | undefined;
	readonly records: IStreamRecordLine[];
	readonly end: IStreamRecordEnd | undefined;
}

/**
 * 解析 JSONL 记录文件。容忍空行与坏行（跳过），
 * 使手写/裁剪过的 fixture 也能被测试加载。
 */
export function parseRecordFile(text: string): IParsedStreamRecord {
	let meta: IStreamRecordMeta | undefined;
	let end: IStreamRecordEnd | undefined;
	const records: IStreamRecordLine[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) { continue; }
		let obj: any;
		try {
			obj = JSON.parse(line);
		} catch {
			continue; // 坏行跳过
		}
		if (obj?.kind === 'meta') {
			const { kind: _k, ...rest } = obj;
			meta = rest as IStreamRecordMeta;
		} else if (obj?.kind === 'end') {
			const { kind: _k, ...rest } = obj;
			end = rest as IStreamRecordEnd;
		} else if (obj?.kind === 'delta') {
			records.push({ t: obj.t ?? 0, type: obj.type ?? obj.delta?.type ?? 'unknown', delta: obj.delta });
		}
	}
	return { meta, records, end };
}

/** 开关判定（browser 环境读 localStorage；Node 测试环境恒 false）。 */
export function isStreamRecordEnabled(): boolean {
	try {
		if (typeof localStorage !== 'undefined') {
			const v = localStorage.getItem('saros.streamRecord');
			return v === '1' || v === 'true';
		}
	} catch { /* ignore */ }
	return false;
}

// ─── 记录器（browser 层使用）─────────────────────────────────────────────

export class AgentStreamRecorder extends Disposable {
	private _active = false;
	private _lines: string[] = [];
	private _startedAt = 0;
	private _deltaCount = 0;
	private _fileUri: URI | undefined;
	private _flushTimer: ReturnType<typeof setTimeout> | undefined;
	private _flushing = false;
	private _dirty = false;

	constructor(
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService,
		private readonly _envService: INativeEnvironmentService,
	) {
		super();
	}

	/** 流式会话开始（_initStreamingMessage 时调用）。未启用时整个会话零开销。 */
	begin(meta: IStreamRecordMeta, paneTag?: string): void {
		this._active = isStreamRecordEnabled();
		if (!this._active) { return; }
		this._lines = [formatMetaLine(meta)];
		this._startedAt = meta.startedAt;
		this._deltaCount = 0;
		this._dirty = true;
		const ts = new Date(meta.startedAt);
		const pad = (n: number) => String(n).padStart(2, '0');
		const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
		const safeAgent = (meta.agentId || 'agent').replace(/[\\/:*?"<>|]/g, '_');
		const fname = `stream-${stamp}-${safeAgent}${paneTag ? `-${paneTag}` : ''}.jsonl`;
		this._fileUri = URI.joinPath(URI.file(this._envService.userDataPath), 'stream-records', fname);
		this._logService.info(`[StreamRecorder] begin → ${this._fileUri.fsPath}`);
	}

	/** 记录一条 delta（_handleStreamDelta 入口 / subagent trace 总线处调用）。 */
	record(delta: unknown): void {
		if (!this._active) { return; }
		this._deltaCount++;
		this._lines.push(formatRecordLine(Date.now() - this._startedAt, delta));
		this._dirty = true;
		// 2s 节流 flush，防长流式会话崩溃丢全部记录
		if (this._flushTimer === undefined) {
			this._flushTimer = setTimeout(() => {
				this._flushTimer = undefined;
				void this._flush();
			}, 2000);
		}
	}

	/** 流式会话结束（done/error 时调用）。写出最终文件并重置状态。 */
	async end(reason: string): Promise<void> {
		if (!this._active) { return; }
		if (this._flushTimer !== undefined) {
			clearTimeout(this._flushTimer);
			this._flushTimer = undefined;
		}
		this._lines.push(formatEndLine({
			reason,
			durationMs: Date.now() - this._startedAt,
			deltaCount: this._deltaCount,
		}));
		this._dirty = true;
		await this._flush();
		this._logService.info(`[StreamRecorder] end (${reason}) deltas=${this._deltaCount}`);
		this._active = false;
		this._lines = [];
		this._fileUri = undefined;
	}

	private async _flush(): Promise<void> {
		if (!this._dirty || !this._fileUri || this._flushing) { return; }
		this._flushing = true;
		this._dirty = false;
		try {
			const content = this._lines.join('\n') + '\n';
			await this._fileService.writeFile(this._fileUri, VSBuffer.fromString(content));
		} catch (err) {
			this._logService.warn(`[StreamRecorder] flush failed: ${err}`);
		} finally {
			this._flushing = false;
			// flush 期间又有新行 → 补一次
			if (this._dirty) {
				void this._flush();
			}
		}
	}

	override dispose(): void {
		if (this._flushTimer !== undefined) {
			clearTimeout(this._flushTimer);
			this._flushTimer = undefined;
		}
		if (this._active) {
			void this.end('dispose');
		}
		super.dispose();
	}
}
