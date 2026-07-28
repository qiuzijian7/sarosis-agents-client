/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Advanced Memory Tools — 接入 AgentMemory 引擎的编排/治理类高级能力。
 *
 * 背景：governance / teamMemory / meshCoord / sentinels / cascade / obsidianExport
 * 等模块已随引擎移植进 extensions/agentmemory-memory/src，并经 V2 provider
 * 方法暴露 + 网关动态路由 + renderer 代理 Proxy 兜底转发，链路完整，但客户端
 * 没有任何调用方（休眠）。本模块把这些能力注册为 LLM 可调用的内置工具：
 *
 *   memory_governance      — 记忆治理：按 ID 删除 / 条件批量删除(dryRun) / 审计查询
 *   memory_team            — 团队记忆池：共享条目 / 查询共享池（跨 agent）
 *   memory_mesh            — 网格对等节点：加入 / 列出 / 离开
 *   memory_sentinel        — 哨兵：创建条件监视器 / 列出
 *   memory_obsidian_export — 导出记忆为 Obsidian 兼容 Markdown
 *   memory_cascade         — 级联修复：把引用某被替代记忆的下游条目标记为 stale
 *
 * 所有调用经 IAgentOSService.getActiveMemoryProvider()（AgentMemoryProviderV2
 * 代理），未声明方法由代理的 Proxy 兜底转发到网关。
 */

import type { IAgentOSService } from '../../../common/agentOS.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';

export interface AdvancedMemoryToolContext {
	register(registration: IBuiltinToolRegistration): void;
	agentOS: IAgentOSService;
	logService: ILogService;
}

/** 取活跃 provider 并做 any 化（高级方法不在 IMemoryProvider 接口上声明，由代理转发） */
function memProvider(ctx: AdvancedMemoryToolContext): any | undefined {
	return ctx.agentOS.getActiveMemoryProvider() as any;
}

function noProvider(): [{ type: 'text'; text: string }] {
	return [{ type: 'text', text: 'error: no memory provider available (AgentMemory gateway not running?)' }];
}

export function registerAdvancedMemoryTools(ctx: AdvancedMemoryToolContext): void {
	const source = 'saros.builtin-tools';

	// ── memory_governance ─────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_governance',
			description: 'Memory governance: delete memories by exact IDs, bulk-delete by filters (supports dry-run preview), or query the governance audit log. Use for cleaning up outdated/wrong memories in bulk.',
			inputSchema: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['delete', 'bulk_delete', 'audit'], description: 'Governance action' },
					ids: { type: 'array', items: { type: 'string' }, description: 'Exact memory IDs to delete (action=delete)' },
					filters: {
						type: 'object',
						description: 'Bulk filters (action=bulk_delete); empty object matches ALL active memories — use with dry_run first',
						properties: {
							type: { type: 'string', description: 'Only memories of this type (working/pattern/fact/preference/architecture/bug/workflow/semantic/procedural/episodic)' },
							maxStrength: { type: 'number', description: 'Only memories with strength <= this value' },
							minAgeDays: { type: 'number', description: 'Only memories older than this many days' },
							pattern: { type: 'string', description: 'Only memories whose content contains this substring (case-insensitive)' },
						},
					},
					dry_run: { type: 'boolean', description: 'Preview only, do not delete (action=bulk_delete, default true)' },
					limit: { type: 'number', description: 'Max audit entries (action=audit, default 20)' },
				},
				required: ['action'],
			},
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_governance error: agentId is required' }]; }
			const mp = memProvider(ctx);
			if (!mp) { return noProvider(); }
			const action = args['action'] as string;
			try {
				switch (action) {
					case 'delete': {
						const ids = args['ids'] as string[] | undefined;
						if (!ids?.length) { return [{ type: 'text', text: 'memory_governance delete: ids[] required' }]; }
						const r = await mp.governanceDelete(agentId, ids);
						return [{ type: 'text', text: `Deleted ${r?.deleted ?? 0} memories (requested ${ids.length}).` }];
					}
					case 'bulk_delete': {
						const filters = (args['filters'] as object) ?? {};
						const dryRun = args['dry_run'] !== false; // 默认 dry-run，安全优先
						const r = await mp.governanceBulkDelete(agentId, { ...filters, dryRun });
						if (dryRun) {
							return [{ type: 'text', text: `Dry-run: ${r?.matched ?? 0} of ${r?.scanned ?? 0} active memories would be deleted. Re-run with dry_run=false to apply.` }];
						}
						return [{ type: 'text', text: `Bulk-deleted ${r?.deleted ?? 0} of ${r?.scanned ?? 0} active memories.` }];
					}
					case 'audit': {
						const limit = typeof args['limit'] === 'number' ? args['limit'] : 20;
						const entries = (await mp.governanceAuditQuery(agentId, { limit })) ?? [];
						if (!entries.length) { return [{ type: 'text', text: 'No governance audit entries.' }]; }
						const lines = entries.slice(0, limit).map((e: any) => `- ${e.timestamp ?? e.createdAt ?? ''} ${e.operation ?? e.action ?? ''} ${JSON.stringify(e.details ?? e).slice(0, 160)}`);
						return [{ type: 'text', text: `Governance audit (${entries.length} entries):\n${lines.join('\n')}` }];
					}
					default:
						return [{ type: 'text', text: `memory_governance error: unknown action "${action}"` }];
				}
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] memory_governance failed:', err);
				return [{ type: 'text', text: `memory_governance failed: ${err instanceof Error ? err.message : String(err)}` }];
			}
		},
	});

	// ── memory_team ───────────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_team',
			description: 'Team memory pool: share one of your memories to the team pool so other agents can discover it, or query what others have shared. Use for cross-agent knowledge sharing (e.g. a learned project convention).',
			inputSchema: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['share', 'query'], description: 'Team action' },
					memory_id: { type: 'string', description: 'ID of your memory to share (action=share)' },
					item_type: { type: 'string', description: 'Type label of the shared item (action=share, default "memory")' },
					project: { type: 'string', description: 'Project scope tag (optional)' },
					query: { type: 'string', description: 'Keyword filter (action=query; empty = all shared items)' },
				},
				required: ['action'],
			},
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_team error: agentId is required' }]; }
			const mp = memProvider(ctx);
			if (!mp) { return noProvider(); }
			const action = args['action'] as string;
			try {
				if (action === 'share') {
					const memId = args['memory_id'] as string | undefined;
					if (!memId) { return [{ type: 'text', text: 'memory_team share: memory_id required (use memory_search to find it)' }]; }
					const r = await mp.teamShare(agentId, memId, (args['item_type'] as string) ?? 'memory', args['project'] as string | undefined);
					return r?.success
						? [{ type: 'text', text: `Shared memory ${memId} to team pool (share id: ${r.item?.id ?? '?'}).` }]
						: [{ type: 'text', text: `Share failed: ${r?.error ?? 'unknown error'}` }];
				}
				if (action === 'query') {
					const items = (await mp.teamQuery(agentId, (args['query'] as string) || undefined)) ?? [];
					if (!items.length) { return [{ type: 'text', text: 'Team pool is empty.' }]; }
					const lines = items.slice(0, 20).map((i: any) => {
						const content = typeof i.content === 'string' ? i.content : (i.content?.content ?? JSON.stringify(i.content));
						return `- [${i.type ?? 'item'}] by ${i.sharedBy ?? '?'} @ ${i.sharedAt ?? ''}: ${String(content).slice(0, 160)}`;
					});
					return [{ type: 'text', text: `Team pool (${items.length} items):\n${lines.join('\n')}` }];
				}
				return [{ type: 'text', text: `memory_team error: unknown action "${action}"` }];
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] memory_team failed:', err);
				return [{ type: 'text', text: `memory_team failed: ${err instanceof Error ? err.message : String(err)}` }];
			}
		},
	});

	// ── memory_mesh ───────────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_mesh',
			description: 'Mesh peer federation for distributed agent coordination: join a peer, list peers, leave, or sync (push/pull memory deltas with last-write-wins merge). Sync requires both gateways to share AGENTMEMORY_SECRET and peer gateways to allow their address (AGENTMEMORY_MESH_ALLOW_LOCAL=true for localhost/LAN peers).',
			inputSchema: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['join', 'list', 'leave', 'sync'], description: 'Mesh action' },
					name: { type: 'string', description: 'Peer display name (action=join)' },
					url: { type: 'string', description: 'Peer gateway base URL, e.g. http://192.168.1.10:3111 (action=join)' },
					scopes: { type: 'array', items: { type: 'string' }, description: 'Shared scopes (action=join/sync, default ["memories","actions"])' },
					peer_id: { type: 'string', description: 'Peer ID (action=leave/sync; sync all online peers when omitted)' },
					direction: { type: 'string', enum: ['push', 'pull', 'both'], description: 'Sync direction (action=sync, default both)' },
				},
				required: ['action'],
			},
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_mesh error: agentId is required' }]; }
			const mp = memProvider(ctx);
			if (!mp) { return noProvider(); }
			const action = args['action'] as string;
			try {
				if (action === 'join') {
					const name = args['name'] as string | undefined;
					const url = args['url'] as string | undefined;
					if (!name || !url) { return [{ type: 'text', text: 'memory_mesh join: name and url required' }]; }
					const peer = await mp.meshJoin(agentId, name, url, args['scopes'] as string[] | undefined);
					return [{ type: 'text', text: `Joined mesh peer "${name}" (${url}) → peer id ${peer?.id ?? '?'}.` }];
				}
				if (action === 'list') {
					const peers = (await mp.meshList(agentId)) ?? [];
					if (!peers.length) { return [{ type: 'text', text: 'No mesh peers registered.' }]; }
					const lines = peers.map((p: any) => `- [${p.id}] ${p.name ?? ''} ${p.url ?? ''} status=${p.status ?? '?'} scopes=${(p.sharedScopes ?? []).join(',')}${p.lastSyncAt ? ` lastSync=${p.lastSyncAt}` : ''}`);
					return [{ type: 'text', text: `Mesh peers (${peers.length}):\n${lines.join('\n')}` }];
				}
				if (action === 'leave') {
					const peerId = args['peer_id'] as string | undefined;
					if (!peerId) { return [{ type: 'text', text: 'memory_mesh leave: peer_id required' }]; }
					const ok = await mp.meshLeave(agentId, peerId);
					return [{ type: 'text', text: ok ? `Peer ${peerId} marked offline.` : `Peer ${peerId} not found.` }];
				}
				if (action === 'sync') {
					const r = await mp.meshSync(agentId, {
						peerId: args['peer_id'] as string | undefined,
						scopes: args['scopes'] as string[] | undefined,
						direction: args['direction'] as 'push' | 'pull' | 'both' | undefined,
					});
					if (!r?.success) { return [{ type: 'text', text: `memory_mesh sync failed: ${r?.error ?? 'unknown error'}` }]; }
					const lines = (r.results ?? []).map((x: any) =>
						`- ${x.peerName}: pushed=${x.pushed} pulled=${x.pulled}${x.errors?.length ? ` errors=[${x.errors.join('; ')}]` : ''}`);
					return [{ type: 'text', text: `Mesh sync complete:\n${lines.join('\n') || '(no online peers)'}` }];
				}
				return [{ type: 'text', text: `memory_mesh error: unknown action "${action}"` }];
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] memory_mesh failed:', err);
				return [{ type: 'text', text: `memory_mesh failed: ${err instanceof Error ? err.message : String(err)}` }];
			}
		},
	});

	// ── memory_sentinel ───────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_sentinel',
			description: 'Sentinels (condition watchers): create a named watcher with a condition expression, list watchers, manually evaluate them now (check), or cancel one. Sentinels are also evaluated automatically during memory maintenance sweeps. Condition formats — threshold: "memory_count > 1000" (metrics: memory_count/total_memories/lesson_count/skill_count/session_count/action_count/signal_count/checkpoint_count; ops: > < >= <= == != or gt/lt/gte/lte/eq/neq); pattern: regex or substring matched against new memories; schedule: "24h"/"7d" or ISO date.',
			inputSchema: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['create', 'list', 'check', 'cancel'], description: 'Sentinel action' },
					name: { type: 'string', description: 'Watcher name (action=create)' },
					condition: { type: 'string', description: 'Condition expression to watch, e.g. "memory_count > 1000" (action=create)' },
					type: { type: 'string', enum: ['threshold', 'pattern', 'schedule'], description: 'Watcher type (action=create, default threshold)' },
					sentinel_id: { type: 'string', description: 'Sentinel ID (action=cancel)' },
				},
				required: ['action'],
			},
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_sentinel error: agentId is required' }]; }
			const mp = memProvider(ctx);
			if (!mp) { return noProvider(); }
			const action = args['action'] as string;
			try {
				if (action === 'create') {
					const name = args['name'] as string | undefined;
					const condition = args['condition'] as string | undefined;
					if (!name || !condition) { return [{ type: 'text', text: 'memory_sentinel create: name and condition required' }]; }
					const s = await mp.sentinelCreate(agentId, name, condition, (args['type'] as string) ?? 'threshold');
					return [{ type: 'text', text: `Sentinel "${name}" created (id: ${s?.id ?? '?'}), condition: ${condition}. It will be evaluated on the next maintenance sweep (or call action=check).` }];
				}
				if (action === 'list') {
					const list = (await mp.sentinelList(agentId)) ?? [];
					if (!list.length) { return [{ type: 'text', text: 'No sentinels registered.' }]; }
					const lines = list.map((s: any) => `- [${s.id}] ${s.name} (${s.type ?? 'threshold'}): ${s.condition ?? ''} status=${s.status ?? 'watching'}${s.triggeredAt ? ` triggered=${s.triggeredAt}` : ''} created=${s.createdAt ?? ''}`);
					return [{ type: 'text', text: `Sentinels (${list.length}):\n${lines.join('\n')}` }];
				}
				if (action === 'check') {
					const r = await mp.sentinelCheck(agentId);
					const parts = [`Checked ${r?.checked ?? 0} watching sentinels`];
					if (r?.expired) { parts.push(`${r.expired} expired`); }
					if (r?.triggered?.length) {
						parts.push(`TRIGGERED ${r.triggered.length}:`);
						for (const t of r.triggered) {
							parts.push(`  - "${t.name}" (${t.type}): ${JSON.stringify(t.result).slice(0, 200)}`);
						}
					} else {
						parts.push('none triggered');
					}
					if (r?.errors?.length) {
						parts.push(`errors: ${r.errors.map((e: any) => `${e.id}: ${e.error}`).join('; ')}`);
					}
					return [{ type: 'text', text: parts.join('\n') }];
				}
				if (action === 'cancel') {
					const sid = args['sentinel_id'] as string | undefined;
					if (!sid) { return [{ type: 'text', text: 'memory_sentinel cancel: sentinel_id required' }]; }
					const r = await mp.sentinelCancel(agentId, sid);
					return r?.success
						? [{ type: 'text', text: `Sentinel ${sid} cancelled.` }]
						: [{ type: 'text', text: `Cancel failed: ${r?.error ?? 'unknown error'}` }];
				}
				return [{ type: 'text', text: `memory_sentinel error: unknown action "${action}"` }];
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] memory_sentinel failed:', err);
				return [{ type: 'text', text: `memory_sentinel failed: ${err instanceof Error ? err.message : String(err)}` }];
			}
		},
	});

	// ── memory_obsidian_export ────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_obsidian_export',
			description: 'Export all active memories as an Obsidian-compatible Markdown document (grouped by memory type with wikilinks). Returns the markdown content — write it to a .md file if the user wants a vault note.',
			inputSchema: { type: 'object', properties: { _no_params: { type: 'boolean', description: 'No parameters needed' } } },
			category: 'memory',
			source,
		},
		handler: async (_args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_obsidian_export error: agentId is required' }]; }
			const mp = memProvider(ctx);
			if (!mp) { return noProvider(); }
			try {
				const md = await mp.obsidianExport(agentId);
				const text = typeof md === 'string' ? md : JSON.stringify(md);
				if (!text) { return [{ type: 'text', text: 'Nothing to export (no active memories).' }]; }
				// 预览 + 全文（截断保护：超过 8K 只给预览并提示写入文件）
				if (text.length > 8000) {
					return [{ type: 'text', text: `Exported ${text.length} chars of Obsidian markdown (preview first 4000):\n\n${text.slice(0, 4000)}\n\n…(truncated — full export is ${text.length} chars; ask to write it to a file if needed)` }];
				}
				return [{ type: 'text', text: `Exported Obsidian markdown (${text.length} chars):\n\n${text}` }];
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] memory_obsidian_export failed:', err);
				return [{ type: 'text', text: `memory_obsidian_export failed: ${err instanceof Error ? err.message : String(err)}` }];
			}
		},
	});

	// ── memory_cascade ────────────────────────────────────
	ctx.register({
		definition: {
			name: 'memory_cascade',
			description: 'Cascade repair: given a superseded memory ID, mark all downstream entries that reference it (actions/sketches/snapshots) as stale. Normally runs automatically on supersede; use manually to repair historical supersessions.',
			inputSchema: {
				type: 'object',
				properties: {
					memory_id: { type: 'string', description: 'The superseded memory ID to cascade from' },
				},
				required: ['memory_id'],
			},
			category: 'memory',
			source,
		},
		handler: async (args, _signal, agentId) => {
			if (!agentId) { return [{ type: 'text', text: 'memory_cascade error: agentId is required' }]; }
			const mp = memProvider(ctx);
			if (!mp) { return noProvider(); }
			const memId = args['memory_id'] as string | undefined;
			if (!memId) { return [{ type: 'text', text: 'memory_cascade error: memory_id required' }]; }
			try {
				const r = await mp.cascadeUpdate(agentId, memId);
				return r?.success
					? [{ type: 'text', text: `Cascade complete: flagged ${r.flagged ?? 0} downstream entries as stale (from memory ${memId}).` }]
					: [{ type: 'text', text: `Cascade: memory ${memId} not found (nothing flagged).` }];
			} catch (err) {
				ctx.logService.warn('[BuiltinTools] memory_cascade failed:', err);
				return [{ type: 'text', text: `memory_cascade failed: ${err instanceof Error ? err.message : String(err)}` }];
			}
		},
	});

	ctx.logService.info('[BuiltinTools] registerAdvancedMemoryTools: 6 advanced memory tools registered (governance/team/mesh/sentinel/obsidian/cascade)');
}
