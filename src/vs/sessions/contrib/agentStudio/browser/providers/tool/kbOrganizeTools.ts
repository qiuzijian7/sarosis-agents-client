/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `kb_organize` —— 知识库「笔记区」的目录整理工具（★ 2026-09-23）。
 *
 * 背景（用户要求「LLM 也可以完善补充，甚至重构」）：知识库专家 agent 的工具集里**没有**
 * 移动/删除/重命名类工具 ⇒ 它**搬不动文件**；而 `terminal` 属 execute 档会逐次弹审批，
 * 不适合无人值守的批量构建。本工具就是「让 agent 真正自己动手重构」的落地：
 *
 *   · **域限定**：只允许在「笔记/」内操作（库/ 与 vault 其它内容不可达）；
 *   · **可回滚**：执行前为每个涉及的文件 `captureBeforeToolEdit` 写 checkpoint（聊天页签 `undoAll`），
 *     且每个文件都会被**备份到 vault 之外**（备份失败 ⇒ 跳过该项，宁可少搬也不让用户失去还原能力）；
 *   · **不覆盖**：`to` 已存在直接拒绝（跳过并报告）；
 *   · **delete ≠ 真删除**：是「移入备份目录」（回收站语义，对齐 Aider 的可恢复删除，但不需要 git）；
 *   · **免审批**：归 `filesystem` 写类（`securityLevel: Dangerous`），沙箱内写默认 `edit: auto`
 *     ⇒ 无人值守的批量构建不会被审批卡住；
 *   · **可观测**：结果里带一行 `KB_ORGANIZE_RESULT {json}` —— 宿主（kbImportController）据此修正构建缓存。
 *
 * 大批量重构（>10 项）仍走 `KB_REORG` 计划通道（宿主备份 + 用户确认后执行），见 kbImportController。
 */

import { URI } from '../../../../../../base/common/uri.js';
import { dirname } from '../../../../../../base/common/resources.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { INativeEnvironmentService } from '../../../../../../platform/environment/common/environment.js';
import { ICheckpointService } from '../../../common/checkpointService.js';
import { ToolSecurityLevel } from '../../../common/providers.js';
import type { IToolResultContent } from '../../../common/providers.js';
import type { IBuiltinToolRegistration } from './toolRegistry.js';
import { resolveKbRootUri } from '../../knowledge/kbVaultState.js';

/** 单次整理的操作上限（防模型失控输出上千条）。 */
const MAX_OPS = 50;

export interface KbOrganizeToolContext {
	register(registration: IBuiltinToolRegistration): void;
	fileService: IFileService;
	storageService: IStorageService;
	environmentService: INativeEnvironmentService;
	checkpointService: ICheckpointService;
	logService: ILogService;
}

export function registerKbOrganizeTools(ctx: KbOrganizeToolContext): void {
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

	ctx.register({
		definition: {
			name: 'kb_organize',
			description: [
				'知识库「笔记区」的目录整理工具（**只能在笔记区内操作**）：',
				'- moves：移动/重命名笔记（自动建父目录；目标已存在 ⇒ 拒绝该项）',
				'- creates：新建目录',
				'- deletes：**不是真删除** —— 移入 vault 之外的备份目录（可恢复）',
				'执行前会为每个涉及的文件写 checkpoint（聊天页签可 undoAll 回滚），且每个文件都会被备份到 vault 外。',
				'路径给相对 vault 根的（形如 `笔记/…`）或绝对路径均可；结果里含一行 `KB_ORGANIZE_RESULT {json}`。',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					reason: { type: 'string', description: '本次整理的动机（写进日志与通知）' },
					moves: {
						type: 'array',
						description: '移动/重命名（改目录名 = 对目录下每个文件各写一条 move）',
						items: {
							type: 'object',
							properties: { from: { type: 'string' }, to: { type: 'string' } },
							required: ['from', 'to'],
						},
					},
					creates: { type: 'array', items: { type: 'string' }, description: '新建的目录（相对 vault 根，形如 `笔记/01_学习/UnrealEngine/09_UI与Slate`）' },
					deletes: { type: 'array', items: { type: 'string' }, description: '要「删除」的笔记（实际移入备份目录，不是真删）' },
				},
				required: [],
			},
			category: 'filesystem',
			source: 'builtin',
			securityLevel: ToolSecurityLevel.Dangerous,
		},
		handler: async (args, _signal, agentId) => {
			const log = ctx.logService;
			const vaultRoot = resolveKbRootUri(ctx.storageService, ctx.environmentService);
			const notesDir = URI.joinPath(vaultRoot, '笔记');
			const notesPrefix = notesDir.fsPath.replace(/\\/g, '/').toLowerCase() + '/';

			const rel = (u: URI) => u.path.replace(vaultRoot.path, '').replace(/^\//, '');
			const toUri = (p: unknown): URI | undefined => {
				if (typeof p !== 'string' || !p.trim()) { return undefined; }
				const s = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
				if (s.includes('..')) { return undefined; }   // 拒绝路径穿越
				return /^[a-zA-Z]:\//.test(s) || s.startsWith('/') ? URI.file(s) : URI.joinPath(vaultRoot, ...s.split('/'));
			};
			const inside = (u: URI) => u.fsPath.replace(/\\/g, '/').toLowerCase().startsWith(notesPrefix);
			const exists = async (u: URI): Promise<boolean> => { try { await ctx.fileService.resolve(u); return true; } catch { return false; } };

			const rawMoves = (Array.isArray(args['moves']) ? args['moves'] : []) as { from?: unknown; to?: unknown }[];
			const rawCreates = (Array.isArray(args['creates']) ? args['creates'] : []) as unknown[];
			const rawDeletes = (Array.isArray(args['deletes']) ? args['deletes'] : []) as unknown[];
			const reason = typeof args['reason'] === 'string' ? args['reason'] : '';

			// 备份目录：**vault 之外**（知识库文件树会把 vault 内的一切列出来，备份绝不能放进去）
			const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
			const vaultName = vaultRoot.path.split('/').pop() ?? 'vault';
			const backupDir = URI.joinPath(dirname(vaultRoot), `${vaultName}-backup-kborganize-${stamp}`);
			const backupOf = (u: URI) => URI.joinPath(backupDir, ...rel(u).split('/'));
			const backup = async (u: URI): Promise<boolean> => {
				try { await ctx.fileService.copy(u, backupOf(u), true); return true; }
				catch (e) { log.warn(`[kb_organize] 备份失败（跳过该项）: ${u.fsPath}: ${e}`); return false; }
			};

			const moved: { from: string; to: string }[] = [];
			const created: string[] = [];
			const deletedToBackup: string[] = [];
			const skipped: { item: string; why: string }[] = [];
			const total = rawMoves.length + rawCreates.length + rawDeletes.length;
			if (total === 0) {
				return text('kb_organize：没有任何操作项（moves/creates/deletes 全空）。');
			}
			if (total > MAX_OPS) {
				return text(`kb_organize：一次最多 ${MAX_OPS} 项操作（本次收到 ${total} 项）。请分批，或改用 KB_REORG 计划通道。`);
			}

			// ── 1. 新建目录 ─────────────────────────────────────────────────────────
			for (const c of rawCreates.slice(0, MAX_OPS)) {
				const d = toUri(c);
				if (!d) { skipped.push({ item: String(c), why: '路径无效' }); continue; }
				if (!inside(d)) { skipped.push({ item: d.fsPath, why: '越出笔记区' }); continue; }
				try { await ctx.fileService.createFolder(d); created.push(d.fsPath); }
				catch (e) { skipped.push({ item: d.fsPath, why: `createFolder 失败：${String(e)}` }); }
			}

			// ── 2. 移动 / 重命名 ────────────────────────────────────────────────────
			for (const m of rawMoves) {
				const from = toUri(m?.from); const to = toUri(m?.to);
				const label = `${String(m?.from ?? '?')} → ${String(m?.to ?? '?')}`;
				if (!from || !to) { skipped.push({ item: label, why: '路径无效' }); continue; }
				if (!inside(from) || !inside(to)) { skipped.push({ item: label, why: '越出笔记区' }); continue; }
				if (from.fsPath.toLowerCase() === to.fsPath.toLowerCase()) { skipped.push({ item: label, why: 'from === to' }); continue; }
				if (!(await exists(from))) { skipped.push({ item: label, why: 'from 不存在' }); continue; }
				if (await exists(to)) { skipped.push({ item: label, why: 'to 已存在（不覆盖）' }); continue; }
				// ① checkpoint（用户可在聊天页签 undoAll 回滚）——best-effort：没有活动会话时只 warn 不阻塞
				try { await ctx.checkpointService.captureBeforeToolEdit(agentId ?? '', from.toString()); }
				catch (e) { log.warn(`[kb_organize] checkpoint 失败（继续）: ${from.fsPath}: ${e}`); }
				// ② 备份（失败就不搬 —— 没有还原点就不动手）
				if (!(await backup(from))) { skipped.push({ item: label, why: '备份失败' }); continue; }
				// ③ 执行
				try {
					await ctx.fileService.createFolder(dirname(to));
					await ctx.fileService.move(from, to, false);
					moved.push({ from: from.fsPath, to: to.fsPath });
				} catch (e) { skipped.push({ item: label, why: String(e) }); }
			}

			// ── 3. 「删除」= 移入备份目录（回收站语义）──────────────────────────────
			for (const del of rawDeletes) {
				const u = toUri(del);
				if (!u) { skipped.push({ item: String(del), why: '路径无效' }); continue; }
				if (!inside(u)) { skipped.push({ item: u.fsPath, why: '越出笔记区' }); continue; }
				if (!(await exists(u))) { skipped.push({ item: u.fsPath, why: '不存在' }); continue; }
				try { await ctx.checkpointService.captureBeforeToolEdit(agentId ?? '', u.toString()); }
				catch (e) { log.warn(`[kb_organize] checkpoint 失败（继续）: ${u.fsPath}: ${e}`); }
				try {
					await ctx.fileService.createFolder(dirname(backupOf(u)));
					await ctx.fileService.move(u, backupOf(u), true);
					deletedToBackup.push(u.fsPath);
				} catch (e) { skipped.push({ item: u.fsPath, why: String(e) }); }
			}

			log.info(`[kb_organize] moved=${moved.length} created=${created.length} deleted=${deletedToBackup.length} skipped=${skipped.length} reason=${reason}`);
			const summary = { reason, moved, created, deletedToBackup, skipped, backupDir: backupDir.fsPath };
			return {
				content: text([
					`kb_organize 完成：移动 ${moved.length} 项 / 新建目录 ${created.length} 个 / 「删除」（移入备份）${deletedToBackup.length} 项 / 跳过 ${skipped.length} 项`,
					`备份目录：${backupDir.fsPath}`,
					...skipped.slice(0, 6).map(s => `跳过：${s.item}（${s.why}）`),
					`KB_ORGANIZE_RESULT ${JSON.stringify(summary)}`,
				].join('\n')),
				details: summary as unknown as Record<string, unknown>,
			};
		},
	});
}
