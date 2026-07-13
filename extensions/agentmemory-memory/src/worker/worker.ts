/*---------------------------------------------------------------------------------------------
 *  III Engine Worker — 独立进程脚本，注册所有记忆函数到 iii-engine
 *
 *  运行方式: node --import tsx worker.ts
 *  或先编译: tsc && node out/worker/worker.js
 *
 *  使用 registerWorker(address, options) 连接 iii-engine 并获取 ISdk 实例，
 *  然后通过 sdk.registerFunction() 注册所有记忆函数。
 *
 *  存储：所有数据经 sdk.trigger('state::*') → iii-engine → SQLite。
 *
 *  对齐 agentmemory 的 worker 注册模式。
 *--------------------------------------------------------------------------------------------*/

import { registerWorker } from 'iii-sdk';

const III_URL = process.env['III_URL'] || 'ws://127.0.0.1:49134';

const sdk = registerWorker(III_URL, {});

console.log(`[AgentMemory Worker] Connecting to iii-engine at ${III_URL}`);

// ── 核心记忆操作 ──────────────────────────────────────────────

sdk.registerFunction('mem::write', async (data: { agentId: string; entry: Record<string, unknown> }) => {
	await sdk.trigger({
		function_id: 'state::set',
		payload: {
			scope: `mem:memories:${data.agentId}`,
			key: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			value: data.entry,
		},
	});
	return { success: true };
});

sdk.registerFunction('mem::search', async (data: { agentId: string; query: string; limit?: number }) => {
	const all = await sdk.trigger<{ scope: string }, Record<string, unknown>[]>({
		function_id: 'state::list',
		payload: { scope: `mem:memories:${data.agentId}` },
	});
	const q = data.query.toLowerCase();
	const scored = (all || [])
		.filter((m: any) => m.content && typeof m.content === 'string' && m.content.toLowerCase().includes(q))
		.slice(0, data.limit ?? 10);
	return { results: scored };
});

sdk.registerFunction('mem::remember', async (data: {
	agentId: string; content: string; type?: string; importance?: number;
	metadata?: Record<string, unknown>;
}) => {
	const entry = {
		id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
		content: data.content,
		type: data.type || 'working',
		importance: data.importance ?? 5,
		metadata: data.metadata ?? {},
		timestamp: Date.now(),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	await sdk.trigger({
		function_id: 'state::set',
		payload: { scope: `mem:memories:${data.agentId}`, key: entry.id, value: entry },
	});
	return { success: true, id: entry.id };
});

sdk.registerFunction('mem::forget', async (data: { agentId: string; memoryId: string }) => {
	await sdk.trigger({
		function_id: 'state::delete',
		payload: { scope: `mem:memories:${data.agentId}`, key: data.memoryId },
	});
	return { success: true };
});

sdk.registerFunction('mem::load-context', async (data: {
	agentId: string; sessionId: string; query?: string; budget?: number;
}) => {
	return {
		systemContext: '',
		userContext: '',
		agentId: data.agentId,
		sessionId: data.sessionId,
		timestamp: Date.now(),
	};
});

sdk.registerFunction('mem::stats', async () => {
	return { totalMemories: 0, semanticCount: 0, proceduralCount: 0, lessonCount: 0 };
});

console.log('[AgentMemory Worker] All functions registered');
