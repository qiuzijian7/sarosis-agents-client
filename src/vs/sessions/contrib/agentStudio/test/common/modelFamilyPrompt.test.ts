/*---------------------------------------------------------------------------------------------
 *  按模型族分发提示词片段（modelFamilyPrompt）单元测试
 *
 *  覆盖：
 *   - detectModelFamily：各族识别、大小写、空值、匹配顺序敏感项
 *   - 与被替代的 TOOL_USE_ENFORCEMENT_MODELS 的**行为等价性**（含一处有意差异）
 *   - buildToolCallFormatDirective / buildOutputFormatRule：原生族去掉有害退路，
 *     generic 族保留改前原文（向后兼容基线）
 *   - 确定性：同族同输入 → 同字节（前缀缓存前提）
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	detectModelFamily,
	getFamilyPromptProfile,
	needsToolUseEnforcement,
	buildToolCallFormatDirective,
	buildOutputFormatRule,
	type ModelFamily,
} from '../../common/modelFamilyPrompt.js';

/** 被本模块替代的旧判据（原样复制，用于等价性对照）。 */
const LEGACY_ENFORCEMENT_MODELS = ['deepseek', 'gpt-', 'gemini', 'gemma', 'grok', 'glm', 'qwen'];
const legacyNeedsEnforcement = (modelId: string) =>
	LEGACY_ENFORCEMENT_MODELS.some((m) => modelId.toLowerCase().includes(m));

suite('modelFamilyPrompt', () => {

	suite('detectModelFamily', () => {
		test('识别主流族', () => {
			assert.strictEqual(detectModelFamily('claude-sonnet-4-5'), 'anthropic');
			assert.strictEqual(detectModelFamily('gpt-4o'), 'openai');
			assert.strictEqual(detectModelFamily('gemini-2.5-pro'), 'gemini');
			assert.strictEqual(detectModelFamily('deepseek-v3'), 'deepseek');
			assert.strictEqual(detectModelFamily('qwen3-max'), 'qwen');
			assert.strictEqual(detectModelFamily('kimi-k2'), 'kimi');
			assert.strictEqual(detectModelFamily('glm-4.6'), 'glm');
			assert.strictEqual(detectModelFamily('grok-4'), 'grok');
		});

		test('本项目默认模型 hy3-ioa → hunyuan', () => {
			assert.strictEqual(detectModelFamily('hy3-ioa'), 'hunyuan');
		});

		test('同族别名归一', () => {
			assert.strictEqual(detectModelFamily('gemma-3-27b'), 'gemini');
			assert.strictEqual(detectModelFamily('moonshot-v1-128k'), 'kimi');
			assert.strictEqual(detectModelFamily('codex-mini'), 'openai');
			assert.strictEqual(detectModelFamily('o3-mini'), 'openai');
		});

		test('大小写不敏感', () => {
			assert.strictEqual(detectModelFamily('Claude-Opus'), 'anthropic');
			assert.strictEqual(detectModelFamily('GPT-4'), 'openai');
		});

		test('空 / undefined / 未知 → generic', () => {
			assert.strictEqual(detectModelFamily(''), 'generic');
			assert.strictEqual(detectModelFamily(undefined), 'generic');
			assert.strictEqual(detectModelFamily(null), 'generic');
			assert.strictEqual(detectModelFamily('some-unknown-model-v9'), 'generic');
		});

		test('匹配顺序：更具体的族先于 openai（gpt 是易被包含的子串）', () => {
			// 聚合网关常见拼法：厂商前缀 + gpt-oss。更具体的族应先胜出。
			assert.strictEqual(detectModelFamily('deepseek-gpt-oss'), 'deepseek');
			assert.strictEqual(detectModelFamily('qwen-gpt-bridge'), 'qwen');
			// 纯 gpt 仍归 openai（控制组：顺序调整不得让 openai 失效）
			assert.strictEqual(detectModelFamily('gpt-5'), 'openai');
		});
	});

	suite('与旧判据 TOOL_USE_ENFORCEMENT_MODELS 的等价性', () => {
		test('旧列表中每个族仍然触发强制指令', () => {
			for (const id of ['deepseek-v3', 'gpt-4o', 'gemini-2.5-pro', 'gemma-3', 'grok-4', 'glm-4.6', 'qwen3-max']) {
				assert.strictEqual(needsToolUseEnforcement(id), true, `${id} 应触发`);
				assert.strictEqual(legacyNeedsEnforcement(id), true, `${id} 旧判据也应触发（对照）`);
			}
		});

		test('旧列表外的模型仍然不触发（默认模型基线不得改变）', () => {
			for (const id of ['claude-sonnet-4-5', 'hy3-ioa', 'kimi-k2', 'some-unknown-model']) {
				assert.strictEqual(needsToolUseEnforcement(id), false, `${id} 不应触发`);
				assert.strictEqual(legacyNeedsEnforcement(id), false, `${id} 旧判据也不触发（对照）`);
			}
		});

		test('★ 一处有意差异：gpt4o（无连字符）旧判据漏判，新实现覆盖', () => {
			assert.strictEqual(legacyNeedsEnforcement('gpt4o'), false, '旧判据用 gpt- 故漏判');
			assert.strictEqual(needsToolUseEnforcement('gpt4o'), true, '新实现按族识别，已覆盖');
		});

		test('空值不崩且不触发', () => {
			assert.strictEqual(needsToolUseEnforcement(undefined), false);
			assert.strictEqual(needsToolUseEnforcement(''), false);
		});
	});

	suite('getFamilyPromptProfile', () => {
		test('除 generic 外均视原生 FC 可靠', () => {
			const families: ModelFamily[] = ['anthropic', 'openai', 'gemini', 'deepseek', 'qwen', 'kimi', 'glm', 'grok', 'hunyuan'];
			for (const f of families) {
				assert.strictEqual(getFamilyPromptProfile(f).nativeToolCalling, true, `${f} 应为原生 FC`);
			}
			assert.strictEqual(getFamilyPromptProfile('generic').nativeToolCalling, false);
		});

		test('未知族入参 → 回退 generic profile（不抛错）', () => {
			const p = getFamilyPromptProfile('not-a-family' as ModelFamily);
			assert.strictEqual(p.nativeToolCalling, false);
			assert.strictEqual(p.needsToolUseEnforcement, false);
		});
	});

	suite('buildToolCallFormatDirective', () => {
		test('原生族：不给「打印 JSON」退路（本次修复的核心）', () => {
			const s = buildToolCallFormatDirective('anthropic');
			assert.ok(s.includes('NATIVE function call'), s);
			assert.ok(!s.includes('output a JSON object in this exact format'), '原生族不得保留 JSON 退路');
			assert.ok(!s.includes('if NOT'), '原生族不得出现「如果不支持」分支');
			// 仍必须明确禁止 XML / 代码块 / 散文形式
			assert.ok(s.includes('<tool_call>') && s.includes('code block'), s);
		});

		test('generic 族：保留改前原文（向后兼容基线）', () => {
			const s = buildToolCallFormatDirective('generic');
			assert.ok(s.includes('If your model supports function calling'), s);
			assert.ok(s.includes('{"name": "<tool_name>", "arguments": {<args>}}'), s);
		});

		test('确定性：同族多次调用字节一致（前缀缓存前提）', () => {
			assert.strictEqual(buildToolCallFormatDirective('openai'), buildToolCallFormatDirective('openai'));
			assert.strictEqual(buildToolCallFormatDirective('generic'), buildToolCallFormatDirective('generic'));
		});

		test('原生族与 generic 族输出必须不同（否则分发无意义）', () => {
			assert.notStrictEqual(buildToolCallFormatDirective('anthropic'), buildToolCallFormatDirective('generic'));
		});

		test('原生族措辞比 generic 短（省 token 是副产品）', () => {
			assert.ok(buildToolCallFormatDirective('anthropic').length < buildToolCallFormatDirective('generic').length);
		});
	});

	suite('buildOutputFormatRule', () => {
		test('编号由调用方给定，保持规则表连续', () => {
			assert.ok(buildOutputFormatRule('anthropic', 4).startsWith('4. '));
			assert.ok(buildOutputFormatRule('generic', 7).startsWith('7. '));
		});

		test('原生族：不再把 fenced code block 说成 fallback（与反幻觉第 1 条自相矛盾）', () => {
			const s = buildOutputFormatRule('openai', 4);
			assert.ok(!s.includes('fenced code block'), s);
			assert.ok(s.includes('NOT a tool call'), s);
		});

		test('generic 族：保留改前原文', () => {
			const s = buildOutputFormatRule('generic', 4);
			assert.ok(s.includes('FALLBACK'), s);
			assert.ok(s.includes('fenced code block'), s);
		});
	});
});
