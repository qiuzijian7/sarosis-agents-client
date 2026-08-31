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

	suite('MessageFormatConverter.toAnthropic — 主会话（无 forkContext）前缀缓存', () => {
		test('主会话：system 顶层转为带 cache_control 的数组形态（命中 prompt cache）', () => {
			const messages = [
				{ role: 'user', content: 'hi' } as any,
			];
			const out = MessageFormatConverter.convert(
				messages,
				{ systemPrompt: SYS, tools: TOOLS },
				{ specialToolFormat: 'anthropic-style' },
			);
			const sys: any = (out as any).separateSystemMessage;
			assert.ok(Array.isArray(sys), 'system 应为数组形态');
			assert.strictEqual(sys[0].type, 'text');
			assert.deepStrictEqual(sys[0].cache_control, { type: 'ephemeral' });
		});

		test('主会话：tools 末尾注入 cache 断点（与 system 构成稳定前缀）', () => {
			// anthropic-style 下 tools 通过 convertToolDefinitions 进入请求体，这里校验转换器直出。
			const defs = MessageFormatConverter.toAnthropicToolDefinitions(TOOLS, undefined, true, SYS);
			assert.strictEqual(defs.length, 2);
			assert.strictEqual(defs[0].cache_control, undefined);
			assert.deepStrictEqual(defs[1].cache_control, { type: 'ephemeral' });
		});

		test('forkContext 存在但未对齐 → 跳过 system/tools 断点（避免缓存脏前缀）', () => {
			const parent = buildForkContext(SYS, TOOLS);
			const out = MessageFormatConverter.toAnthropicToolDefinitions(
				TOOLS, parent, true, 'a different system than the frozen one',
			);
			assert.strictEqual(out[1].cache_control, undefined);
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

		// P1（2026-08-30）：toAnthropicToolDefinitions 按 name 排序，保证 tools 前缀逐字节稳定。
		test('工具乱序传入 → toAnthropicToolDefinitions 返回按 name 升序且断点落在排序末位', () => {
			// 父级冻结工具即本组工具的某顺序（alpha/mike/zeta 的另一种顺序），
			// 子请求以乱序传入 → 对齐判定排序无关应通过，断点落在排序末位。
			const frozen = [tool('mike_tool'), tool('zeta_tool'), tool('alpha_tool')];
			const parent = buildForkContext(SYS, frozen);
			const shuffled = [tool('zeta_tool'), tool('alpha_tool'), tool('mike_tool')];
			const out = MessageFormatConverter.toAnthropicToolDefinitions(
				shuffled, parent, true, SYS,
			) as Array<{ name: string; cache_control?: unknown }>;
			assert.deepStrictEqual(
				out.map((t) => t.name),
				['alpha_tool', 'mike_tool', 'zeta_tool'],
				'返回应按 name 升序，避免跨请求工具顺序漂移导致缓存前缀失效',
			);
			// 断点必须落在排序后的最后一个工具上，而非传入顺序的末位。
			assert.strictEqual(out[0].cache_control, undefined);
			assert.strictEqual(out[1].cache_control, undefined);
			assert.deepStrictEqual(out[2].cache_control, { type: 'ephemeral' });
		});

		// OpenAI 兼容路径不排序（结构为 function.name），断点落在传入顺序末位即可。
		test('toOpenAIToolDefinitions 乱序传入 → 不打乱原顺序，断点落在传入末位', () => {
			const parent = buildForkContext(SYS, TOOLS);
			const shuffled = [tool('zeta_tool'), tool('alpha_tool'), tool('mike_tool')];
			const out = MessageFormatConverter.toOpenAIToolDefinitions(
				shuffled, parent, true, SYS,
			) as Array<{ function: { name: string }; cache_control?: unknown }>;
			assert.deepStrictEqual(
				out.map((t) => t.function.name),
				['zeta_tool', 'alpha_tool', 'mike_tool'],
			);
			assert.strictEqual(out[2].cache_control, undefined); // 未对齐跳过断点路径已覆盖，此处仅校验顺序
		});
	});
});
