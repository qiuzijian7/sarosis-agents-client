/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';

/**
 * 终端工具运行期直播输出 —— 旁路通道。
 *
 * agentOS 工具执行为 async（阻塞到完成才 yield `tool_result` delta），无法在运行期把
 * 增量输出喂进 agent chat 卡片。这里用一个轻量 EventEmitter，让 `executeTerminalCommand`
 * 在 PTY `onData` 时直接把清洗后的增量 chunk 推送给 DOM 卡片，卡片按 `toolCallId` 订阅并
 * 就地追加，完全绕开生成器阻塞，实现「运行中实时可见」。
 *
 * 另维护一份按 toolCallId 的有限长缓存（上限 8000 字符），保证卡片因 `tool_args` 到达而
 * 重建时不会丢失已流式到的内容。
 */

export interface ITerminalLiveChunk {
	readonly toolCallId: string;
	readonly chunk: string;
}

const _onTerminalLiveOutput = new Emitter<ITerminalLiveChunk>();
export const onTerminalLiveOutput = _onTerminalLiveOutput.event;

const MAX_CACHE_LEN = 8000;
const _cache = new Map<string, string>();

export function appendTerminalLiveOutput(toolCallId: string | undefined, chunk: string): void {
	if (!toolCallId || !chunk) { return; }
	const prev = _cache.get(toolCallId) ?? '';
	let next = prev + chunk;
	if (next.length > MAX_CACHE_LEN) {
		// 保留末尾，丢弃头部，避免 DOM 膨胀（长命令如 npm install 会持续吐输出）
		next = next.slice(next.length - MAX_CACHE_LEN);
	}
	_cache.set(toolCallId, next);
	_onTerminalLiveOutput.fire({ toolCallId, chunk });
}

export function getTerminalLiveOutput(toolCallId: string | undefined): string {
	if (!toolCallId) { return ''; }
	return _cache.get(toolCallId) ?? '';
}

export function clearTerminalLiveOutput(toolCallId: string | undefined): void {
	if (!toolCallId) { return; }
	_cache.delete(toolCallId);
}
