/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';

/**
 * 原子写（temp + rename）的**唯一入口**。
 *
 * ── 为什么需要（与「单实例 / 多实例」无关）────────────────────────────────────
 * 本项目的高频持久化几乎都是**整文件覆盖写 JSON**：会话历史本体、会话索引、检查点索引与快照、
 * `workspaces.json` / agents 绑定等。普通 `writeFile` 是「截断 + 写」两步 —— 进程在两步之间
 * 被 kill / 断电 / OOM，磁盘上就留下**截断的 JSON** ✗。而这些文件**都是启动即读**的关键数据，
 * 损坏后的用户可见表现是「对话历史突然没了 / 工作区列表空了 / 检查点无法回退」，且无法自行恢复。
 * temp + rename 让替换成为**原子**操作：磁盘上要么是旧内容、要么是新内容，绝不会是半截 ✓。
 *
 * ⚠ 必须先探能力：`fileService.writeFile(..., { atomic })` 在 provider 不具备
 * `FileAtomicWrite` 能力时会**直接 throw**（`platform/files/common/fileService.ts` 的
 * `writeFailedAtomicUnsupported` 分支），而本项目的会话/检查点可能落在 remote 或虚拟 FS 上
 * ⇒ 探不到能力就退回普通写：**少一层崩溃保护，但绝不让写入失败** ✓。
 *
 * ⚠ 两个已知取舍：
 *   · temp 文件（`<file>.vsctmp`）存在期间**会被文件监听看到**，但它在 rename 前只存活极短时间，
 *     且落地后即不存在；已知的 watcher（图谱只认源码扩展名、检查点/会话按目录监听）不受影响。
 *   · rename 会**替换 inode** ⇒ 若目标文件是符号链接/硬链接，链接关系会被打断（Windows 上极少见）。
 *
 * 先例：`AgentChatService._writeSessionIndex()` 自 2026-09 起就是这么写的，但**只有那一处**
 * —— 会话本体、检查点、workspaces 都漏了。本文件把它抽出来，避免"每个写入点各自记得"。
 */
export const ATOMIC_WRITE_POSTFIX = '.vsctmp';

/**
 * 原子写（能力允许时）；否则退回普通写。
 *
 * 语义与直接 `fileService.writeFile` 完全一致，只多一层「崩溃安全」；调用方不需要 try/catch。
 */
export async function writeFileAtomicSafe(fileService: IFileService, resource: URI, content: VSBuffer): Promise<void> {
	if (fileService.hasCapability(resource, FileSystemProviderCapabilities.FileAtomicWrite)) {
		await fileService.writeFile(resource, content, { atomic: { postfix: ATOMIC_WRITE_POSTFIX } });
		return;
	}
	await fileService.writeFile(resource, content);
}

/**
 * 追加写（**只追加，不重写** ✓）—— 2026-09-21（P0-1 会话追加日志）。
 *
 * 与 `writeFileAtomicSafe` 同款「先探能力、探不到就降级」策略 ✓：
 * `diskFileSystemProvider` / `indexedDBFileSystemProvider` 都声明了 `FileAppend` ✓，
 * 但会话数据可能落在 remote / 虚拟 FS 上 ⇒ 缺能力时 `fileService.writeFile(..., { append: true })`
 * 会**直接 throw**（`platform/files/common/fileService.ts` 的 `writeFailedFileAppendUnsupported` 分支 ✗）。
 * ⇒ 降级为「读-拼接-原子写」：语义相同（末尾追加），代价是该次写入退化成整文件重写
 * （少一层增量收益，但**绝不失败、也绝不半写** ✓）。
 *
 * ⚠ 调用方须知：`append` 不保证「多字节写入的原子性」—— 进程若在写入中途被 kill，
 * 文件末尾可能留下**半行 JSON** ✓。消费侧必须容忍（见 `sessionHistoryLog.replaySessionLog`
 * 的「只丢那一行」策略 ✓），不要在此处加校验后抛错 ✗。
 */
export async function appendFileSafe(fileService: IFileService, resource: URI, content: VSBuffer): Promise<void> {
	if (fileService.hasCapability(resource, FileSystemProviderCapabilities.FileAppend)) {
		// ⚠ 不需要（也不能）显式传 `create: true` —— `IFileWriteOptions.append` 的语义已隐含
		// 「文件不存在则创建」（见 `platform/files/common/files.ts` 的注释 ✓）。
		await fileService.writeFile(resource, content, { append: true });
		return;
	}
	let existing: VSBuffer | undefined;
	try {
		if (await fileService.exists(resource)) {
			existing = (await fileService.readFile(resource)).value;
		}
	} catch {
		existing = undefined; // 读不到就当作空文件（宁可丢旧尾巴，也不要写入失败 ✗）
	}
	await writeFileAtomicSafe(fileService, resource, existing ? VSBuffer.concat([existing, content]) : content);
}
