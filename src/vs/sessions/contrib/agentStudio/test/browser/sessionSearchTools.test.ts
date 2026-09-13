/*---------------------------------------------------------------------------------------------
 *  会话历史搜索工具（session_search）单元测试
 *
 *  背景（2026-09-11）：`session_search` 此前是「基础设施齐全、唯独缺 handler」的半成品
 *  （配置项 / 设置 UI / 工具名映射 / CORE_TOOLS 与 core exactNames 登记俱全，但
 *  `name: 'session_search'` 只出现在 bundled 定义里 → 注册成 stub → listTools 跳过
 *  → 模型看不到）。本文件锁定补全后的行为。
 *
 *  覆盖：
 *   - 工具注册（名称 / inputSchema / 必需的 query 参数）
 *   - handler 边界（空 query / 无 agentId / 单会话读取失败不影响整体）
 *   - 搜索语义（命中会话名与消息、大小写不敏感、limit、按命中数排序）
 *   - ★ 性能上限（会话扫描数、每会话消息数）—— 防止历史累积后拖垮调用
 *   - 纯函数（extractSearchableText / buildSnippet）
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/sessionSearchTools.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import {
	registerSessionSearchTools, SESSION_SEARCH_TOOL_NAME,
	extractSearchableText, buildSnippet, searchSessions,
} from '../../browser/providers/tool/sessionSearchTools.js';

import type { IToolResultContent } from '../../common/providers.js';

interface IMeta { id: string; name: string; createdAt: string; updatedAt: string; messageCount: number }

function meta(id: string, name: string, updatedAt = '2026-09-10T00:00:00.000Z'): IMeta {
	return { id, name, createdAt: '2026-09-01T00:00:00.000Z', updatedAt, messageCount: 1 };
}

/** 注册工具后取回 `definition` 与可直接调用的 `invoke`。 */

function makeRunner(opts: {
	sessions?: IMeta[];
	messages?: Record<string, unknown[]>;
	onLoad?: (sessionId: string) => void;
	loadError?: string;
}) {
	const registered: { definition: any; handler: (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<IToolResultContent[]> }[] = [];
	const ctx: any = {
		register: (d: any) => registered.push(d),
		logService: { info() { }, warn() { }, error() { } },
		listSessions: async () => opts.sessions ?? [],
		loadMessages: async (_agentId: string, sessionId: string) => {
			opts.onLoad?.(sessionId);
			if (opts.loadError && sessionId === opts.loadError) { throw new Error('boom'); }
			return opts.messages?.[sessionId] ?? [];
		},
	};
	registerSessionSearchTools(ctx);
	const handler = registered[0].handler;
	return {
		definition: registered[0].definition,
		invoke: async (args: Record<string, unknown>, agentId?: string): Promise<string> => {
			const res = await handler(args, undefined, agentId);
			assert.ok(Array.isArray(res) && res.length === 1, 'handler should return exactly one block');
			return (res[0] as { text: string }).text;
		},
	};
}

suite('Session Search Tool (session_search)', () => {

	test('SESSION_SEARCH_TOOL_NAME 与 bundled/白名单登记名一致', () => {
		// bundled 定义、CORE_TOOLS、core 的 exactNames 都用这个名字；
		// 不一致会导致 hasTool 不命中 → 真实工具被 stub 抢先注册。
		assert.strictEqual(SESSION_SEARCH_TOOL_NAME, 'session_search');
	});

	test('注册的 definition 结构正确（query 必填、limit 可选）', () => {
		const r = makeRunner({});
		assert.strictEqual(r.definition.name, 'session_search');
		assert.ok(r.definition.description.length > 0, 'description 必填');
		assert.strictEqual(r.definition.inputSchema.type, 'object');
		assert.deepStrictEqual(r.definition.inputSchema.required, ['query']);
		assert.ok(r.definition.inputSchema.properties.query, '应有 query');
		assert.ok(r.definition.inputSchema.properties.limit, '应有可选 limit');
	});

	test('空 query → 明确报错', async () => {
		const r = makeRunner({});
		const text = await r.invoke({ query: '   ' }, 'agent-1');
		assert.ok(text.includes('"query" is required'), '空 query 应报错');
	});

	test('无 agentId → 明确报错（无法定位历史）', async () => {
		const r = makeRunner({});
		const text = await r.invoke({ query: 'drawio' }, undefined);
		assert.ok(text.includes('no agent context'), '缺 agentId 应报错');
	});

	test('命中会话名 → 返回该会话并标注「会话名」', async () => {
		const r = makeRunner({
			sessions: [meta('s1', 'drawio 工具补全')],
			messages: { s1: [{ role: 'user', content: '无关内容' }] },
		});
		const text = await r.invoke({ query: 'drawio' }, 'agent-1');
		assert.ok(text.includes('drawio 工具补全'), '应返回命中的会话');
		assert.ok(text.includes('(会话名)'), '应标注命中来源为会话名');
	});

	test('命中消息内容 → 返回片段', async () => {
		const r = makeRunner({
			sessions: [meta('s1', '某会话')],
			messages: { s1: [{ role: 'user', content: '我们之前讨论过 mermaid 的渲染流程' }] },
		});
		const text = await r.invoke({ query: 'mermaid' }, 'agent-1');
		assert.ok(text.includes('mermaid'), '应回显命中片段');
		assert.ok(text.includes('user:'), '片段应带角色前缀');
	});

	test('大小写不敏感', async () => {
		const r = makeRunner({
			sessions: [meta('s1', 'DrawIO')],
			messages: {},
		});
		const text = await r.invoke({ query: 'drawio' }, 'agent-1');
		assert.ok(text.includes('DrawIO'), '大小写不同也应命中');
	});

	test('无匹配 → 明确说明「已扫描 N 个会话」（不谎称不存在）', async () => {
		const r = makeRunner({
			sessions: [meta('s1', 'A'), meta('s2', 'B')],
			messages: { s1: [], s2: [] },
		});
		const text = await r.invoke({ query: 'zzz-not-found' }, 'agent-1');
		assert.ok(text.includes('No matches'), '应报告无匹配');
		assert.ok(text.includes('2 most recent session'), '应说明扫描范围，避免被理解为「从未讨论过」');
	});

	test('limit 生效', async () => {
		const sessions = [meta('s1', 'hit one'), meta('s2', 'hit two'), meta('s3', 'hit three')];
		const r = makeRunner({ sessions, messages: {} });
		const text = await r.invoke({ query: 'hit', limit: 2 }, 'agent-1');
		const numbered = text.split('\n').filter(l => /^\d+\. /.test(l));
		assert.strictEqual(numbered.length, 2, 'limit=2 应只返回 2 个会话');
	});

	test('★ 按命中次数排序（命中多的在前）', async () => {
		const r = makeRunner({
			sessions: [meta('s1', '少'), meta('s2', '多')],
			messages: {
				s1: [{ content: 'alpha' }],
				s2: [{ content: 'alpha alpha alpha' }, { content: 'alpha' }],
			},
		});
		const text = await r.invoke({ query: 'alpha' }, 'agent-1');
		const firstLine = text.split('\n').find(l => /^\d+\. /.test(l)) ?? '';
		assert.ok(firstLine.includes('多'), `命中次数多的会话应排前，实际首行: ${firstLine}`);
	});

	test('★ 单会话读取失败 → 跳过该会话，其余仍返回', async () => {
		const r = makeRunner({
			sessions: [meta('s1', '好的'), meta('s2', '坏的')],
			messages: { s1: [{ content: 'needle' }] },
			loadError: 's2',
		});
		const text = await r.invoke({ query: 'needle' }, 'agent-1');
		assert.ok(text.includes('好的'), '读取失败不应让整次搜索失败');
	});

	test('★ 性能上限：最多扫描 30 个会话', async () => {
		const sessions = Array.from({ length: 40 }, (_, i) => meta(`s${i}`, `session ${i}`));
		const loaded: string[] = [];
		const r = makeRunner({ sessions, messages: {}, onLoad: id => loaded.push(id) });
		await r.invoke({ query: 'nothing' }, 'agent-1');
		assert.strictEqual(loaded.length, 30, `最多扫描 30 个会话，实际 ${loaded.length}`);
	});

	// ─── 纯函数 ────────────────────────────────────────────────────────────

	test('extractSearchableText：字符串 / 数组 / {text} 可提取，其余返回空', () => {
		assert.strictEqual(extractSearchableText('hello'), 'hello');
		assert.strictEqual(extractSearchableText([{ text: 'a' }, 'b']), 'a b');
		assert.strictEqual(extractSearchableText({ text: 'x' }), 'x');
		// 刻意不 stringify 任意对象 —— 否则工具调用 JSON 会淹没搜索信噪比
		assert.strictEqual(extractSearchableText({ foo: 'bar' }), '');
		assert.strictEqual(extractSearchableText(undefined), '');
	});

	test('buildSnippet：以匹配点为中心截取（不丢长消息中部的命中）', () => {
		const long = 'A'.repeat(500) + 'NEEDLE' + 'B'.repeat(500);
		const snip = buildSnippet(long, 'needle');
		assert.ok(snip.includes('NEEDLE'), '片段必须包含命中点');
		assert.ok(snip.startsWith('…'), '前置内容被截断应有省略号');
		assert.ok(snip.length <= 160, `片段应受长度上限约束，实际 ${snip.length}`);
	});

	test('searchSessions：命中数为 0 的会话不进入结果', () => {
		const hits = searchSessions('zzz', [meta('s1', 'A')], new Map(), 5);
		assert.strictEqual(hits.length, 0);
	});
});
