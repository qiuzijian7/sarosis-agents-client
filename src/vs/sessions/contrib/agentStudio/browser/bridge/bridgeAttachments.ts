/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 平台桥接层：入站附件落盘（对齐 cc-connect core/message.go SaveFilesToDisk / AppendFileRefs）──
// 入站文件写至 <workDir>/.saros/bridge/attachments/，文件名经 sanitize 防目录穿越；
// prompt 末尾追加本地路径引用，使 Agent 可用内置工具读取。

import { sanitizeAttachmentFileName } from "../../common/bridge/bridgeSecurity.js";
import { InboundAttachment } from "../../common/bridge/bridgeTypes.js";
import { nodeRequire } from "../rendererNodeRequire.js";
// ★ 2026-09-23：入站附件落盘改走**主进程**（渲染进程沙箱无 fs，旧路径在生产环境永远写不进去）
import { nativeIpcBridge } from "../../common/configHtmlConfig.js";
// ★ 2026-09-23：入站附件还要映射成「聊天面板/LLM 用的附件对象」（面板缩略图 / 文件 pill）
import type { IChatAttachmentSend } from "../../../../common/agentStudioService.js";

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
 * 字节 → base64（纯函数，可单测）。
 * **分块**处理：`String.fromCharCode(...bytes)` 一次展开大数组会爆栈（大文件必现）。
 */
export function bytesToBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let bin = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}

/**
 * 经**主进程**把附件写盘，返回绝对路径列表。
 *
 * 为什么必须这样：渲染进程是沙箱 Chromium，`nodeRequire('fs')` 恒为 undefined
 * （见 `rendererNodeRequire.ts`）⇒ 上面那个 `saveFilesToDisk` 在生产环境**永远返回空数组**，
 * 结果就是「附件收到了、prompt 里没有路径、Agent 拿不到」。
 * 主进程 handler：`vscode:bridgeSaveAttachment`（见 `electron-main/bridgeStoreChannel.ts`）。
 */
export async function saveFilesToDiskViaHost(files: InboundAttachment[]): Promise<string[]> {
	const ipc = nativeIpcBridge()?.ipcRenderer;
	if (!ipc?.invoke || !files || files.length === 0) {
		return [];
	}
	const paths: string[] = [];
	for (const f of files) {
		try {
			const r = await ipc.invoke('vscode:bridgeSaveAttachment', {
				name: f.fileName ?? 'attachment',
				base64: bytesToBase64(f.data),
			}) as { ok?: boolean; path?: string } | undefined;
			if (r?.ok && typeof r.path === 'string' && r.path) {
				paths.push(r.path);
			}
		} catch {
			// 单个附件失败不影响其余（与旧实现同语义）
		}
	}
	return paths;
}

/**
 * 入站附件落盘（2026-09-23 起）：**优先主进程**，退回旧 fs 实现（node 宿主/单测）。
 * 返回的绝对路径会被 `appendFileRefs` 追加进 prompt ⇒ Agent 才能读到图片/文件。
 */
export async function saveFilesToDiskAsync(workDir: string | undefined, files: InboundAttachment[]): Promise<string[]> {
	const viaHost = await saveFilesToDiskViaHost(files);
	if (viaHost.length > 0) {
		return viaHost;
	}
	return saveFilesToDisk(workDir, files);
}

/** mime → 扩展名（只为给没名字的附件起个像样的文件名）。 */
function extensionForMime(mimeType: string): string {
	const map: Record<string, string> = {
		'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
		'image/webp': '.webp', 'image/bmp': '.bmp',
	};
	return map[mimeType.toLowerCase()] ?? '';
}

/**
 * 把**入站附件**映射成聊天框 / LLM 用的附件对象（2026-09-23）。
 *
 * 为什么不只是「把路径拼进文本」—— 那样聊天框里只显示两行字（占位 + 本地路径），
 * 图片不是缩略图、文件不是可点开的 pill（用户问「能否正常显示」即此）。
 *
 * ★ 两条不同的取舍（由消费端契约决定，别改错）：
 *  - `type: 'image'` + `mimeType: image/*`：面板渲染缩略图（lightbox/hover 大图），
 *    `agentDriverService` 会把它作为**真正的 image content part** 交给模型 ⇒ 模型能看图。
 *    `data` 必须是 **base64**（去前缀）。图片**不会被持久化**（`agentChatService` 刻意排除
 *    image 附件以控制会话文件体积）⇒ 重启后不恢复，与「本地粘贴图片」既有行为一致。
 *  - `type: 'file'`：`agentDriverService` 会把 `data` **原文内联进 prompt**
 *    （`--- File: name ---\n<data>\n--- End of name ---`）⇒ 二进制文件**绝不能**把 base64
 *    塞进 `data`（会灌入巨量乱码 token 并烧钱）。故这里 `data: ''`，改由 prompt 里的
 *    **本地绝对路径**（`appendFileRefs`）让 Agent 用工具读取；`filePath` 让面板的 pill
 *    可点击在编辑器里打开。
 */
export function buildInboundChatAttachments(
	files: ReadonlyArray<InboundAttachment>,
	paths: ReadonlyArray<string> = [],
	idSeed: string = Date.now().toString(36),
): IChatAttachmentSend[] {
	return files.map((f, i) => {
		const isImage = /^image\//i.test(f.mimeType);
		const rawName = f.fileName?.trim();
		const name = rawName && rawName.length > 0
			? rawName
			: isImage ? `image-${i + 1}${extensionForMime(f.mimeType)}` : `attachment-${i + 1}`;
		const shared = {
			id: `bridge-${idSeed}-${i}`,
			name,
			mimeType: f.mimeType,
			size: f.data.byteLength,
			filePath: paths[i],
		};
		return isImage
			? { ...shared, type: 'image' as const, data: bytesToBase64(f.data) }
			: { ...shared, type: 'file' as const, data: '' };
	});
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
