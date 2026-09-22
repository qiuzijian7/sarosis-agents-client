/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { ChatMessage } from '../common/types.js';

/** 工具结果在下发给模型的 prompt 视图里的字符上限（单一真源，2026-09-22 L1 ✓）。 */
export const MAX_INLINE_TOOL_RESULT = 8 * 1024;
/** 外置标记（`\x1E` 前缀避免与正常内容冲突 ✓）。 */
const TOOL_REF_MARKER = '\x1EVSSAROS_TOOL_REF:';

/**
 * 工具结果 **sidecar 外置/取回** —— 从 `agentChatService.ts` 拆出的独立簇 ✓（2026-09-22）。
 *
 * 目录约定：`agents/{slug}/sessions/{sessionId}.sidecar/tool_{toolCallId}.json` ✓
 * （在**工作区之外** ⇒ 模型侧用 terminal/execute_code 读取 ✓）。
 *
 * 三条纪律 ✓：
 *  ① **失败不阻断**：落盘异常 ⇒ 返回空句柄（退化为纯截断）+ once-warn ✓；
 *  ② **幂等**：同一 `agentId::sessionId::toolCallId` 只写一次（内存句柄表 ✓）；
 *  ③ **确定性标记**：`TOOL_REF_MARKER` + 原字符数 ⇒ prompt 前缀缓存友好 ✓。
 */
export class SessionSidecarStore {
	/** 已外置的句柄缓存（key = agentId::sessionId::toolCallId ✓）—— 避免重复落盘 ✓。 */
	private readonly _files = new Map<string, URI>();
	/** 落盘失败只提示一次（避免每轮刷屏 ✓）。 */
	private _warnedFail = false;

	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
		/** 解析该 agent 的 sessions 目录（由宿主注入 ⇒ 本模块不含路径学 ✓）。 */
		private readonly resolveSessionsDir: (agentId: string) => Promise<URI>,
	) { }

	/** 会话 sidecar 目录：`<sessionsDir>/<sessionId>.sidecar/` ✓。 */
	async dirUri(agentId: string, sessionId: string): Promise<URI> {
		const sessionsDirUri = await this.resolveSessionsDir(agentId);
		return URI.joinPath(sessionsDirUri, `${sessionId}.sidecar`);
	}

	/**
	 * 把超长工具结果的**全文**确保落盘到会话 sidecar，返回**取回句柄**
	 * （追加到截断文本尾部，供模型按需取回 ✓）。
	 *
	 * 背景（事故：`[P5-frozen] Truncated 22 tool result(s) (-217.3KB, cap=2048)`）：
	 * 此前模型只看到 2048 字符的头切片，**原文虽在 sidecar 却没有任何取回通道**
	 * （标记里只有 id/长度/预览，无路径）⇒ "模型好像忘了某次工具输出"。
	 */
	async ensure(agentId: string | undefined, sessionId: string | undefined, toolCallId: string, content: string): Promise<string> {
		if (!agentId || !sessionId || !toolCallId) { return ''; }
		const key = `${agentId}::${sessionId}::${toolCallId}`;
		try {
			let file = this._files.get(key);
			if (!file) {
				const dir = await this.dirUri(agentId, sessionId);
				if (!(await this.fileService.exists(dir))) {
					await this.fileService.createFolder(dir);
				}
				file = URI.joinPath(dir, `tool_${toolCallId}.json`);
				if (!(await this.fileService.exists(file))) {
					await this.fileService.writeFile(file, VSBuffer.fromString(content));
				}
				this._files.set(key, file);
			}
			return `\n[全文 ${content.length} 字符已落盘：${file.fsPath}（需要原文可用 terminal 读取，如 cat/sed -n；或重新执行该工具）]`;
		} catch (e) {
			if (!this._warnedFail) {
				this._warnedFail = true;
				this.logService.warn(
					`[SessionSidecarStore][P5-sidecar] 工具结果落盘失败（本次会话仅提示一次，退化为纯截断）：`
					+ `${e instanceof Error ? e.message : String(e)}`,
				);
			}
			return '';
		}
	}

	/**
	 * 把消息数组里**超长**的工具结果外置到 sidecar，并把内联内容替换成标记。
	 * 调用于 LRU 淘汰时（让磁盘上的会话文件保持紧凑、后续懒加载更快 ✓）。
	 *
	 * @returns 外置的条数 ✓
	 */
	async externalize(agentId: string, sessionId: string, messages: ChatMessage[]): Promise<number> {
		let count = 0;
		const sidecarDir = await this.dirUri(agentId, sessionId);
		if (!(await this.fileService.exists(sidecarDir))) {
			await this.fileService.createFolder(sidecarDir);
		}
		for (const msg of messages) {
			if (!msg.toolCalls) { continue; }
			for (const tc of msg.toolCalls) {
				const result = tc.result;
				if (!result || result.length <= MAX_INLINE_TOOL_RESULT) { continue; }
				// Write full result to sidecar
				const sidecarFile = URI.joinPath(sidecarDir, `tool_${tc.id}.json`);
				const preview = result.slice(0, 400);
				const marker = `${TOOL_REF_MARKER}${tc.id}:${result.length}\x1E${preview}`;
				await this.fileService.writeFile(sidecarFile, VSBuffer.fromString(result));
				// Replace inline result with marker
				(tc as any).result = marker;
				count++;
			}
		}
		if (count > 0) {
			this.logService.info(
				`[SessionSidecarStore][P1] Externalised ${count} tool result(s) for ${sessionId} (cap=${MAX_INLINE_TOOL_RESULT})`,
			);
		}
		return count;
	}

	/**
	 * 把外置标记还原成全文（懒加载时调用 ⇒ 内存桶里始终是完整数据 ✓）。
	 *
	 * @returns 还原的条数 ✓
	 */
	async resolveRefs(agentId: string, sessionId: string, messages: ChatMessage[]): Promise<number> {
		let count = 0;
		const sidecarDir = await this.dirUri(agentId, sessionId);
		const sidecarExists = await this.fileService.exists(sidecarDir);
		for (const msg of messages) {
			if (!msg.toolCalls) { continue; }
			for (const tc of msg.toolCalls) {
				const result = tc.result;
				if (!result || !result.startsWith(TOOL_REF_MARKER)) { continue; }
				if (!sidecarExists) { continue; }
				// Parse: \x1EVSSAROS_TOOL_REF:toolCallId:len\x1Epreview
				const payload = result.slice(TOOL_REF_MARKER.length);
				const endIdx = payload.indexOf('\x1E');
				if (endIdx < 0) { continue; }
				const header = payload.slice(0, endIdx);
				const colonIdx = header.lastIndexOf(':');
				if (colonIdx < 0) { continue; }
				const toolCallId = header.slice(0, colonIdx);
				const sidecarFile = URI.joinPath(sidecarDir, `tool_${toolCallId}.json`);
				try {
					if (!(await this.fileService.exists(sidecarFile))) { continue; }
					const content = await this.fileService.readFile(sidecarFile);
					(tc as any).result = content.value.toString();
					count++;
				} catch {
					// Sidecar read failed — leave marker as-is (UI will show preview)
				}
			}
		}
		if (count > 0) {
			this.logService.info(
				`[SessionSidecarStore][P1] Resolved ${count} tool result ref(s) for ${sessionId}`,
			);
		}
		return count;
	}

	/** 删除会话的 sidecar 目录（删除会话时调用 ✓）。 */
	async deleteDir(agentId: string, sessionId: string): Promise<void> {
		try {
			const sidecarDir = await this.dirUri(agentId, sessionId);
			if (await this.fileService.exists(sidecarDir)) {
				await this.fileService.del(sidecarDir, { recursive: true });
			}
		} catch {
			/* ignore */
		}
	}
}
