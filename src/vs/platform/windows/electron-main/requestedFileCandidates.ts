/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hasWorkspaceFileExtension } from '../../workspace/common/workspace.js';

/**
 * ★ 2026-10-31（用户要求「用外部工具打开时，选 VsSaros = 当前这个 IDE 窗口」）。
 *
 * 把「一次 open 请求里哪些原始串**可能是文件**」这段判断抽成**纯函数**：
 *   · 不解析 URI、不 `stat`、不依赖任何服务 ⇒ 可以被守卫脚本直接 import 后跑断言 ✓
 *     （`WindowsMainService` 本身依赖二十多个服务 + `electron.app`，无法在单测里实例化 ✗）
 *   · 真实性的判断（路径存不存在、是不是文件）留给调用方用 `fileService.stat()` 完成 ⇒
 *     这条守卫只负责"筛选规则"，不负责 IO ✓
 *
 * 为什么需要这段逻辑（真机事故链，见 `windowsMainService.ensureAgentsWindow` 的 case ②b）：
 *   第二个实例转发过来的目标常常是**单个文件**，而它此前无处可落（`urisToOpen` 为空、
 *   文件夹分支不认领）⇒ 掉进"复用记住的工作区"分支 ⇒ 文件被丢弃 ✗。
 */

/** 一次 open 请求里"可能是文件"的**原始串**来源。 */
export interface IRequestedFileInput {
	/** `--file-uri` 传进来的原始串（可能还没解析成 URI）。 */
	readonly fileUriFlags?: readonly string[];
	/**
	 * 位置参数（`cli._`）。
	 * ⚠ dev 链的第一个位置参数是 Electron 的 app 路径（**文件夹**）⇒ 它在这里**不会被排除**，
	 *   靠调用方 `stat().isFile` 过滤（放到纯函数里就变成 IO 了 ✗）。
	 */
	readonly positional?: readonly string[];
}

/**
 * 挑出候选文件的原始串（**纯逻辑**）。
 *
 * 规则（顺序即优先级）：
 *   ① 空串 / 只有空白 ⇒ 丢；
 *   ② 以 `-` 开头 ⇒ 那是开关（`-n` / `--goto` …）不是路径，丢；
 *   ③ `.code-workspace` ⇒ 工作区文件由 `ensureAgentsWindow` 的 case ① 处理，这里不认领；
 *   ④ 去重（按**原始串**）：同一路径可能同时出现在 `--file-uri` 与位置参数里。
 *
 * @returns 候选文件的原始串（**未经 stat 验证**）。
 */
export function collectRequestedFileCandidates(input: IRequestedFileInput): string[] {
	const out: string[] = [];
	const seen = new Set<string>();

	const consider = (raw: string): void => {
		if (typeof raw !== 'string') {
			return;
		}
		const value = raw.trim();
		if (!value || value.startsWith('-')) {
			return; // ① ②
		}
		if (hasWorkspaceFileExtension(value)) {
			return; // ③
		}
		if (seen.has(value)) {
			return; // ④
		}
		seen.add(value);
		out.push(value);
	};

	for (const raw of input.fileUriFlags ?? []) {
		consider(raw);
	}
	for (const raw of input.positional ?? []) {
		consider(raw);
	}

	return out;
}
