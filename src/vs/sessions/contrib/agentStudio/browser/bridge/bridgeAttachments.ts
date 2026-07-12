/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 平台桥接层：入站附件落盘（对齐 cc-connect core/message.go SaveFilesToDisk / AppendFileRefs）──
// 入站文件写至 <workDir>/.saros/bridge/attachments/，文件名经 sanitize 防目录穿越；
// prompt 末尾追加本地路径引用，使 Agent 可用内置工具读取。

import { sanitizeAttachmentFileName } from "../../common/bridge/bridgeSecurity.js";
import { InboundAttachment } from "../../common/bridge/bridgeTypes.js";

// ─── nodeRequire：Electron renderer 中安全访问 Node 内置模块 ───────────────

function nodeRequire(moduleName: string): any {
	if (typeof globalThis !== "undefined" && typeof (globalThis as any).require === "function") {
		try {
			return (globalThis as any).require(moduleName);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

let _fs: any | undefined;
let _path: any | undefined;
function getFs(): any {
	if (_fs === undefined) {
		_fs = nodeRequire("fs") ?? null;
	}
	return _fs;
}
function getPath(): any {
	if (_path === undefined) {
		_path = nodeRequire("path") ?? null;
	}
	return _path;
}

/** 附件落盘根目录（相对 workDir）。 */
export const BRIDGE_ATTACH_DIR = ".saros/bridge/attachments";

/**
 * 将入站附件写入磁盘，返回绝对路径列表（对齐 cc-connect SaveFilesToDisk）。
 * - workDir 绝对化，确保 Agent 能打开；空 workDir 回退到进程 cwd。
 * - 文件名经 sanitizeAttachmentFileName 处理，防目录穿越（../../escape.txt）。
 * - fs 不可用时返回空数组（调用方忽略附件引用）。
 */
export function saveFilesToDisk(workDir: string | undefined, files: InboundAttachment[]): string[] {
	if (!files || files.length === 0) {
		return [];
	}
	const fs = getFs();
	const pathMod = getPath();
	if (!fs || !pathMod) {
		return [];
	}

	let absWorkDir: string;
	try {
		absWorkDir = pathMod.resolve(workDir ?? ".");
	} catch {
		absWorkDir = workDir ?? ".";
	}

	const attachDir = pathMod.join(absWorkDir, BRIDGE_ATTACH_DIR);
	try {
		fs.mkdirSync(attachDir, { recursive: true });
	} catch {
		// 忽略目录创建失败，后续写文件会各自失败并被跳过
	}

	const paths: string[] = [];
	files.forEach((f, i) => {
		if (!f.data || f.data.length === 0) {
			return;
		}
		let fname = sanitizeAttachmentFileName(f.fileName);
		if (fname === "") {
			fname = `file_${Date.now()}_${i}`;
		}
		const fpath = pathMod.join(attachDir, fname);
		try {
			// fs.writeFileSync 接受 Uint8Array（ArrayBufferView），避免依赖渲染进程缺失的全局 Buffer。
			fs.writeFileSync(fpath, f.data);
			paths.push(fpath);
		} catch {
			// 单文件失败不影响其余附件
		}
	});
	return paths;
}

/**
 * 在 prompt 末尾追加本地文件路径引用（对齐 cc-connect AppendFileRefs）。
 * 路径经绝对化，确保 Agent 拿到的始终是真实磁盘位置。
 */
export function appendFileRefs(prompt: string, filePaths: string[]): string {
	if (!filePaths || filePaths.length === 0) {
		return prompt;
	}
	const pathMod = getPath();
	let abs: string[];
	if (pathMod) {
		abs = filePaths.map(p => {
			try {
				return pathMod.isAbsolute(p) ? p : pathMod.resolve(p);
			} catch {
				return p;
			}
		});
	} else {
		abs = filePaths;
	}
	const base = prompt && prompt.trim().length > 0 ? prompt : "请分析下面附带的本地文件。";
	return `${base}\n\n(以下文件已保存到本地，请直接读取：\n${abs.join("\n")})`;
}
