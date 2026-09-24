/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 渠道绑定状态（chat_id ↔ Agent / 专属会话）的**主进程**文件存储。
 *
 * ## ★★ 为什么必须放主进程（2026-09-23 修「重启后 chat_id 绑定信息丢失」）
 *
 * 渲染进程是沙箱 Chromium，`nodeRequire('fs')` **必然返回 undefined**
 * （证据与说明见 `browser/rendererNodeRequire.ts` 头注释：`globalThis.require` 被 AMD shim
 *  替换、preload 的 require 也只有 `electron/events/timers/url`）。
 * 因此 `createFileBindingStore()` 在桌面端**永远**返回 undefined，`BridgeEngine` 只好
 * 退化成 `createMemoryBindingStore()` ⇒ 绑定只活在内存里，**每次重启全丢**。
 * 本仓既定修法就是这句话：「需要真正的 node 能力时，把实现放到主进程并经 IPC channel
 * 暴露给渲染进程」（先例：`gitVersionCore ↔ node/gitVersionEngine ↔ electron-main/gitVersionChannel`，
 * 以及同目录的 `comfyLaunchChannel` / `larkCliChannel`）。
 *
 * ## ★ 存储位置：`<userData>/bridge/<file>`，**不再用 `process.cwd()`**
 *
 * 原先 `bridgeService._resolveBridgeWorkDir()` 优先取 `process.cwd()`。cwd 随启动方式变化
 * （IDE 启动 / 命令行 / 安装版 / 不同工作区）⇒ 同一份数据在两次启动里落到不同路径，
 * 即使能写盘也会表现为「绑定凭空消失」。这里固定用 Electron 的 userData 目录，
 * 与启动方式、工作区都无关。
 *
 * ## 安全
 *
 * 文件名走**白名单**（只允许 bridge 目录下的三个已知 JSON），不接受任意路径，
 * 避免渲染进程把它当成任意文件读写通道。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { validatedIpcMain } from '../../../../base/parts/ipc/electron-main/ipcMain.js';
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
// 纯逻辑（白名单 / 目录 / 路径拼接）放 common，便于单测且与渲染层共用同一份定义
import {
	MAX_BRIDGE_STORE_WRITE_BYTES,
	bridgeStoreFilePath,
	isAllowedBridgeStoreFile,
	joinBridgePath,
	resolveBridgeStoreDir,
} from '../common/bridgeStore.js';
import { sanitizeAttachmentFileName } from '../common/bridge/bridgeSecurity.js';

/** 附件 base64 上限（≈48MB 文件；防御性上限，避免 IPC 传巨量文本）。 */
const MAX_ATTACHMENT_BASE64_CHARS = 64 * 1024 * 1024;

export interface IBridgeStoreReadResult {
	readonly ok: boolean;
	/** 文件内容；文件尚不存在时为 undefined（**不是错误**，首次运行即此情形）。 */
	readonly json?: string;
	readonly error?: string;
}

export interface IBridgeStoreWriteResult {
	readonly ok: boolean;
	readonly error?: string;
}

export class BridgeStoreChannel extends Disposable {

	constructor(
		private readonly logService: ILogService,
	) {
		super();
		this.registerChannels();
	}

	override dispose(): void {
		validatedIpcMain.removeHandler('vscode:bridgeStoreRead');
		validatedIpcMain.removeHandler('vscode:bridgeStoreWrite');
		validatedIpcMain.removeHandler('vscode:bridgeSaveAttachment');
		super.dispose();
	}

	/** 入站附件目录：`<userData>/bridge/attachments`。 */
	private attachmentsDir(): string {
		return joinBridgePath(this.dir(), 'attachments');
	}

	private dir(): string {
		return resolveBridgeStoreDir(app.getPath('userData'));
	}

	private filePathOf(file: unknown): string | undefined {
		return isAllowedBridgeStoreFile(file) ? bridgeStoreFilePath(this.dir(), file) : undefined;
	}

	private registerChannels(): void {
		// 注意：validatedIpcMain 要求 channel 名以 `vscode:` 开头。
		validatedIpcMain.handle('vscode:bridgeStoreRead', async (_event, payload: { file?: string } | undefined): Promise<IBridgeStoreReadResult> => {
			const path = this.filePathOf(payload?.file);
			if (!path) {
				return { ok: false, error: `不允许的存储文件：${String(payload?.file)}` };
			}
			try {
				if (!existsSync(path)) {
					// 首次运行：文件不存在是正常状态，返回 ok 且不带内容
					return { ok: true };
				}
				return { ok: true, json: readFileSync(path, 'utf8') };
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				this.logService.info(`[AgentStudio] bridgeStore:read '${path}' 失败：${error}`);
				return { ok: false, error };
			}
		});

		validatedIpcMain.handle('vscode:bridgeStoreWrite', async (_event, payload: { file?: string; json?: string } | undefined): Promise<IBridgeStoreWriteResult> => {
			const path = this.filePathOf(payload?.file);
			if (!path) {
				return { ok: false, error: `不允许的存储文件：${String(payload?.file)}` };
			}
			const json = payload?.json;
			if (typeof json !== 'string') {
				return { ok: false, error: 'json 必须是字符串' };
			}
			if (json.length > MAX_BRIDGE_STORE_WRITE_BYTES) {
				return { ok: false, error: `内容过大（${json.length} bytes）` };
			}
			// ★ 写前校验可解析：宁可不写，也不要把损坏的 JSON 覆盖上去（下次启动会读不回来）
			try {
				JSON.parse(json);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				this.logService.info(`[AgentStudio] bridgeStore:write 拒绝写入非法 JSON（${path}）：${error}`);
				return { ok: false, error: `非法 JSON：${error}` };
			}
			try {
				mkdirSync(this.dir(), { recursive: true });
				writeFileSync(path, json, 'utf8');
				return { ok: true };
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				this.logService.info(`[AgentStudio] bridgeStore:write '${path}' 失败：${error}`);
				return { ok: false, error };
			}
		});

		// 入站附件落盘（飞书图片/文件，2026-09-23）：渲染进程沙箱里 `nodeRequire('fs')` 必然
		// 返回 undefined ⇒ 原先的 `saveFilesToDisk` 永远写不进去（prompt 里没有路径，Agent 读不到图）。
		// 这里搬到主进程：写 `<userData>/bridge/attachments/`，文件名经 sanitize 防目录穿越，
		// 并加时间戳前缀避免同名覆盖；返回**绝对路径**供 prompt 引用。
		validatedIpcMain.handle('vscode:bridgeSaveAttachment', async (_event, payload: { name?: string; base64?: string } | undefined) => {
			const base64 = payload?.base64;
			if (typeof base64 !== 'string' || base64.length === 0) {
				return { ok: false, error: 'base64 必填' };
			}
			if (base64.length > MAX_ATTACHMENT_BASE64_CHARS) {
				return { ok: false, error: `附件过大（base64 ${base64.length} 字符）` };
			}
			try {
				const dir = this.attachmentsDir();
				mkdirSync(dir, { recursive: true });
				const safe = sanitizeAttachmentFileName(payload?.name ?? 'attachment');
				const path = joinBridgePath(dir, `${Date.now().toString(36)}-${safe}`);
				writeFileSync(path, Buffer.from(base64, 'base64'));
				this.logService.info(`[AgentStudio] bridgeSaveAttachment 已写入 ${path}`);
				return { ok: true, path };
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				this.logService.info(`[AgentStudio] bridgeSaveAttachment 失败：${error}`);
				return { ok: false, error };
			}
		});
	}
}
