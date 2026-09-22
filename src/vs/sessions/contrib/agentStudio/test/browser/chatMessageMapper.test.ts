/*---------------------------------------------------------------------------------------------
 *  host ChatMessage[] → driver IChatMessage[] 的**唯一漏斗**行为测试（2026-09-22 阶段④-b1 ✓）。
 *
 *  为什么值得单测 ✓：这三段是**纯逻辑**（无 DOM / 无文件 IO ✓ —— 落盘经回调注入 ✓），
 *  却同时承载四条"只能有一个真相源"的强约定 ✗✓：压缩边界回放 / 相邻重复 user 去重 /
 *  污染过滤（含 tool_call ↔ tool 配对完整 ✓）/ 冻结截断 + 取回句柄 ✓。
 *  任何一条退化都会**静默**污染模型上下文（用户看到的是"模型失忆/重复回答"✗）⇒ 必须钉住 ✓。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/chatMessageMapper.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import type { ChatMessage } from '../../common/types.js';
import type { IChatMessage } from '../../common/providers.js';
import { COMPACTION_METADATA_TYPE } from '../../common/historyCompaction.js';
import {
	buildCompactionBoundaryMessage,
	isContaminated,
	toDriverMessages,
	type IChatMessageMapperDeps,
} from '../../browser/chatMessageMapper.js';

interface ILog { warns: string[]; infos: string[]; errors: string[]; }

function makeDeps(opts?: { cached?: ChatMessage[]; handle?: string | undefined }): { deps: IChatMessageMapperDeps; log: ILog; sidecarCalls: string[] } {
	const log: ILog = { warns: [], infos: [], errors: [] };
	const sidecarCalls: string[] = [];
	const deps: IChatMessageMapperDeps = {
		logService: {
			info: (m: string) => log.infos.push(m),
			warn: (m: string) => log.warns.push(m),
			error: (m: string) => log.errors.push(m),
			trace: () => { },
			debug: () => { },
		} as any,
		getCachedMessages: () => opts?.cached ?? [],
		ensureSidecarFullText: async (_a, _s, toolCallId) => { sidecarCalls.push(toolCallId); return opts?.handle; },
	};
	return { deps, log, sidecarCalls };
}

const user = (id: string, content: string): ChatMessage => ({ id, role: 'user', content, timestamp: '' } as ChatMessage);
const assistant = (id: string, content: string, toolCalls?: any[]): ChatMessage =>
	({ id, role: 'assistant', content, toolCalls, timestamp: '' } as ChatMessage);

suite('chatMessageMapper — isContaminated（污染语料 ✗）', () => {
	test('未遂道歉 / 假装完成 语料命中；正常内容不误伤 ✓', () => {
		assert.strictEqual(isContaminated(''), false, '空串不命中 ✓');
		assert.strictEqual(isContaminated('您完全正确，我这就重新执行'), true);
		assert.strictEqual(isContaminated('我犯了严重错误'), true);
		assert.strictEqual(isContaminated('让我重新开始'), true);
		assert.strictEqual(isContaminated('抱歉，我重新来'), true);
		assert.strictEqual(isContaminated('检测到模型未真正调用工具'), true, '自家 nudge 也不得回灌 ✓');
		// 只看**开头 80 字符**（尾部偶然出现的"重新"不该误杀长回答 ✓）
		assert.strictEqual(isContaminated('这是一段正常的回答。'.repeat(10) + '让我重新开始'), false,
			'只判定开头 ⇒ 长回答尾部出现该措辞不误杀 ✓');
		assert.strictEqual(isContaminated('我来解释一下压缩边界的实现'), false);
	});
});

suite('chatMessageMapper — toDriverMessages（唯一漏斗 ✓）', () => {
	test('★ 相邻重复 user 必须折叠（持久化双写 race 的脏数据 ✗✓）', async () => {
		const { deps, log } = makeDeps();
		const out = await toDriverMessages(
			[user('u1', 'hello'), user('u2', 'hello'), user('u3', 'hello'), user('u4', 'world'), user('u5', 'world')],
			'a', 's', deps,
		);
		assert.deepStrictEqual(out.map(m => m.content), ['hello', 'world'],
			'相邻且内容全等 ⇒ 只留第一条 ✓');
		assert.ok(log.warns.some(w => w.includes('collapsed')), '折叠必须留下可查 warning ✓');
		// ⚠ 只折叠**相邻**：正常的"连续两条不同消息"不受影响 ✓
		const out2 = await toDriverMessages([user('a', 'x'), user('b', 'y'), user('c', 'x')], 'a', 's', deps);
		assert.deepStrictEqual(out2.map(m => m.content), ['x', 'y', 'x'], '非相邻重复不得折叠 ✓');
	});

	test('★ 污染的 assistant：无工具调用 ⇒ 整条丢弃；有工具调用 ⇒ 保留但 content 清空（配对完整 ✗✓）', async () => {
		const { deps } = makeDeps();
		const out = await toDriverMessages([
			user('u1', 'do it'),
			assistant('a1', '您完全正确，我这就重新执行'),                       // 无工具 ⇒ 丢弃
			assistant('a2', '抱歉，我重新来', [
				{ id: 't1', name: 'file_read', arguments: '{}', result: 'ok' },   // 有工具 ⇒ 保留
			]),
		], 'a', 's', deps);
		const roles = out.map(m => m.role);
		assert.deepStrictEqual(roles, ['user', 'assistant', 'tool'], '无工具的污染 assistant 必须整条丢弃 ✓');
		assert.strictEqual(out[1].content, '', '有工具调用时 content 清空 ⇒ 模型只看到工具历史 ✓');
		assert.strictEqual((out[1] as any).toolCalls?.length, 1, '工具调用必须保留（否则配对断裂 ✗）');
		assert.strictEqual(out[2].role, 'tool', '每个已完成工具调用都要补一条配对 tool 消息 ✓');
		assert.strictEqual((out[2] as any).toolCallId, 't1', 'toolCallId 必须与 toolCall.id 一致 ✓');
	});

	test('★ 只有**已完成**（有 result）的工具调用进入 driver 消息', async () => {
		const { deps } = makeDeps();
		const out = await toDriverMessages([
			assistant('a1', 'working', [
				{ id: 't1', name: 'x', arguments: '{}', result: 'done' },
				{ id: 't2', name: 'y', arguments: '{}' },                        // 无 result ⇒ 未完成
			]),
		], 'a', 's', deps);
		const toolMsgs = out.filter(m => m.role === 'tool');
		assert.strictEqual(toolMsgs.length, 1, '未完成的工具调用不得下发（否则配对不符 ✗）');
		assert.strictEqual((toolMsgs[0] as any).toolCallId, 't1');
	});

	test('★ 超长工具结果：确定性截断 + 全文落盘取回句柄（信息永不真正丢失 ✓）', async () => {
		const big = 'L'.repeat(40_000);
		const { deps, sidecarCalls } = makeDeps({ handle: 'h-1' });
		const out = await toDriverMessages([
			assistant('a1', 'ok', [{ id: 't1', name: 'file_read', arguments: '{}', result: big }]),
		], 'a', 's', deps);
		const tool = out.find(m => m.role === 'tool') as IChatMessage;
		assert.ok(tool.content.length < big.length, '超长结果必须被截断 ✓');
		assert.ok(tool.content.includes('h-1'), '截断文本里必须带取回句柄 ⇒ 全文可回读 ✓');
		assert.deepStrictEqual(sidecarCalls, ['t1'], '必须以**原始全文**落盘（而非截断后文本 ✓）');
		// 确定性：同一输入两次结果逐字节相同 ⇒ 跨 turn 前缀缓存不漂移 ✓
		const again = await toDriverMessages([
			assistant('a1', 'ok', [{ id: 't1', name: 'file_read', arguments: '{}', result: big }]),
		], 'a', 's', makeDeps({ handle: 'h-1' }).deps);
		assert.strictEqual((again.find(m => m.role === 'tool') as IChatMessage).content, tool.content,
			'冻结截断 ⇒ 同一内容永远同一字节串 ✓');
	});

	test('system / tool 角色原样映射（防御性分支 ✓）', async () => {
		const { deps } = makeDeps();
		const out = await toDriverMessages([
			{ id: 's1', role: 'system', content: 'sys', timestamp: '' } as ChatMessage,
			{ id: 't1', role: 'tool', content: 'raw', timestamp: '' } as ChatMessage,
		], 'a', 's', deps);
		assert.strictEqual(out[0].role, 'system');
		assert.strictEqual(out[1].role, 'tool');
	});
});

suite('chatMessageMapper — buildCompactionBoundaryMessage（摘要失真的 fail-safe ✓）', () => {
	test('★ 必须原文保留「用户最近指令」并排除"当前这条"（避免与 driver 追加重复 ✗）', () => {
		const { deps } = makeDeps({
			cached: [
				user('u1', '请把 test-qiuzijian 这个 agent 的存储路径找出来'),
				user('u2', '执行'),
			],
		});
		const boundary = buildCompactionBoundaryMessage(
			deps, 'agent-1', 'sess-1',
			{ originalCount: 11, compressedCount: 10, tokensSaved: 50, summary: '## Active Task\n无' },
			'执行',
		);
		assert.ok(boundary.content.includes('请把 test-qiuzijian 这个 agent 的存储路径找出来'),
			'摘要写"无"时必须靠原文兜底（否则用户说"执行"模型答"没有待执行任务"✗✓）');
		assert.ok(!boundary.content.includes('\n1. 执行'), '不得把当前这条也塞进去 ✓');
		assert.strictEqual((boundary.metadata as any).type, COMPACTION_METADATA_TYPE, '边界标记必须保留 ✓');
		assert.strictEqual((boundary.metadata as any).summaryChars, '## Active Task\n无'.trim().length,
			'摘要指纹未透传时按核心摘要长度记（供边界可信度判定 ✓）');
	});

	test('取不到桶时**降级不抛**（无原文尾部，仅摘要 ✓）', () => {
		const deps = { ...makeDeps().deps, getCachedMessages: () => { throw new Error('boom'); } };
		const boundary = buildCompactionBoundaryMessage(
			deps, 'agent-1', 'sess-1',
			{ originalCount: 11, compressedCount: 10, tokensSaved: 50, summary: 'S' },
			undefined,
		);
		assert.ok(boundary.content.includes('S'), '取原文失败也必须产出边界（不阻塞压缩路径 ✓）');
		assert.ok(!boundary.content.includes('用户最近的指令'), '无原文时不得输出空尾部 ✓');
	});
});
