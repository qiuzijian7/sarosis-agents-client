/*---------------------------------------------------------------------------------------------
 *  Fork 前缀缓存 — 请求构造端接 ForkContext 单元测试
 *
 *  覆盖：
 *   - evaluateForkPrefixCache 对齐判定（含工具乱序无关性）
 *   - MessageFormatConverter.toOpenAI：Anthropic 兼容 + 前缀对齐时在冻结 system 边界
 *     注入 cache_control；OpenAI 原生 + 对齐时不注入（不识别该字段）
 *   - toOpenAIToolDefinitions：Anthropic + forkContext 时在最后一个工具打 cache 断点
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { MessageFormatConverter } from '../../common/adapters/messageFormatConverter.js';
import { buildForkContext, evaluateForkPrefixCache, type IForkContext } from '../../common/forkContext.js';
import type { IToolDefinition } from '../../common/providers.js';

function tool(name: string): IToolDefinition {
	return {
		name,
		description: `desc of ${name}`,
		inputSchema: { type: 'object', properties: {} },
	};
}

const SYS = 'You are a frozen system prompt for the prefix-cache test.';
const TOOLS = [tool('read_file'), tool('write_file')];

suite('Fork 前缀缓存 — 请求构造端', () => {

	suite('evaluateForkPrefixCache', () => {
		test('child 前缀 == 父级冻结前缀 → aligned=true（工具乱序无关）', () => {
			const parent: IForkContext = buildForkContext(SYS, TOOLS);
			// 子请求工具顺序与父级不同，但 fingerprint 排序无关 → 仍对齐。
			const decision = evaluateForkPrefixCache(parent, SYS, [TOOLS[1], TOOLS[0]]);
			assert.strictEqual(decision.aligned, true);
			assert.strictEqual(decision.childFork.toolsFingerprint, parent.toolsFingerprint);
			assert.strictEqual(decision.parentFingerprint, parent.toolsFingerprint);
		});

		test('child system 不同 → aligned=false', () => {
			const parent = buildForkContext(SYS, TOOLS);
			const decision = evaluateForkPrefixCache(parent, 'a totally different system', TOOLS);
			assert.strictEqual(decision.aligned, false);
		});

		test('无父级上下文 → aligned=false', () => {
			const decision = evaluateForkPrefixCache(undefined, SYS, TOOLS);
			assert.strictEqual(decision.aligned, false);
			assert.strictEqual(decision.parentFingerprint, undefined);
		});
	});

	suite('MessageFormatConverter.toOpenAI', () => {
		test('isAnthropic + 前缀对齐 → 冻结 system 消息注入 cache_control', () => {
			const parent = buildForkContext(SYS, TOOLS);
			const messages = [
				{ role: 'system', content: SYS } as any,
				{ role: 'user', content: 'hi' } as any,
			];
			const out = MessageFormatConverter.toOpenAI(messages, {
				isAnthropic: true,
				tools: TOOLS,
				systemPrompt: SYS,
				forkContext: parent,
			});
			const sysMsg: any = out.find((m: any) => m.role === 'system');
			assert.ok(sysMsg, 'system message exists');
			assert.deepStrictEqual(sysMsg.cache_control, { type: 'ephemeral' });
		});

		test('isAnthropic + 无 forkContext → 仍在最后 system 消息注入 cache_control（旧行为兜底）', () => {
			const messages = [
				{ role: 'system', content: 'S1' } as any,
				{ role: 'user', content: 'x' } as any,
			];
			const out = MessageFormatConverter.toOpenAI(messages, { isAnthropic: true });
			const sysMsg: any = out.find((m: any) => m.role === 'system');
			assert.deepStrictEqual(sysMsg.cache_control, { type: 'ephemeral' });
		});

		test('isAnthropic=false + 前缀对齐 → 不注入 cache_control（OpenAI 原生不识别该字段）', () => {
			const parent = buildForkContext(SYS, TOOLS);
			const messages = [
				{ role: 'system', content: SYS } as any,
				{ role: 'user', content: 'hi' } as any,
			];
			const out = MessageFormatConverter.toOpenAI(messages, {
				isAnthropic: false,
				tools: TOOLS,
				systemPrompt: SYS,
				forkContext: parent,
			});
			const sysMsg: any = out.find((m: any) => m.role === 'system');
			assert.strictEqual(sysMsg.cache_control, undefined);
		});

		test('多 system 消息时 cache_control 落在与 options.systemPrompt 匹配的冻结 system 上', () => {
			const parent = buildForkContext(SYS, TOOLS);
			const messages = [
				{ role: 'system', content: SYS } as any,
				{ role: 'system', content: 'dynamic memory context (not frozen)' } as any,
				{ role: 'user', content: 'hi' } as any,
			];
			const out = MessageFormatConverter.toOpenAI(messages, {
				isAnthropic: true,
				tools: TOOLS,
				systemPrompt: SYS,
				forkContext: parent,
			});
			const sysMsgs: any[] = out.filter((m: any) => m.role === 'system');
			// 冻结 system（第一个）有 cache_control，动态 memory system（最后一个）不应有。
			assert.deepStrictEqual(sysMsgs[0].cache_control, { type: 'ephemeral' });
			assert.strictEqual(sysMsgs[1].cache_control, undefined);
		});
	});

	suite('MessageFormatConverter.toOpenAIToolDefinitions', () => {
		test('isAnthropic + forkContext → 最后一个工具打 cache 断点', () => {
			const parent = buildForkContext(SYS, TOOLS);
			const out = MessageFormatConverter.toOpenAIToolDefinitions(TOOLS, parent, true, SYS);
			assert.strictEqual(out.length, 2);
			assert.strictEqual(out[0].cache_control, undefined);
			assert.deepStrictEqual(out[1].cache_control, { type: 'ephemeral' });
		});

		test('isAnthropic=false → 即便有 forkContext 也不打 cache 断点', () => {
			const parent = buildForkContext(SYS, TOOLS);
			const out = MessageFormatConverter.toOpenAIToolDefinitions(TOOLS, parent, false, SYS);
			assert.strictEqual(out[1].cache_control, undefined);
		});

		test('无 forkContext → 不打 cache 断点', () => {
			const out = MessageFormatConverter.toOpenAIToolDefinitions(TOOLS, undefined, true, SYS);
			assert.strictEqual(out[1].cache_control, undefined);
		});
	});
});
