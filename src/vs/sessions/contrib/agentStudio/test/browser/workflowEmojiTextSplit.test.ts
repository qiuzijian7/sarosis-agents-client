/*---------------------------------------------------------------------------------------------
 *  Unit tests for splitEmojiPrompts + parseEmojiCellArray —— EmojiStage 上游文本 → m×n 逐格。
 *
 *  严格性保证（用户诉求「严格按 JSON 数组划分」）：
 *   - JSON 数组是权威划分依据，命中后绝不 fallthrough 到逗号/换行启发式；
 *   - `[` 开头但非法 JSON → 作为单条保留（不被逗号误拆）；
 *   - 对象元素可携带 seed/text 完整字段（parseEmojiCellArray）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { splitEmojiPrompts, parseEmojiCellArray, extractJsonArray, stripMarkdownCodeFence } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';

suite('splitEmojiPrompts（启发式兜底路径）', () => {
	test('JSON 数组：字符串项逐个拆出', () => {
		assert.deepStrictEqual(splitEmojiPrompts(['["猫","狗","鸟","鱼"]']), ['猫', '狗', '鸟', '鱼']);
	});

	test('JSON 数组：支持 {prompt} 对象项', () => {
		assert.deepStrictEqual(
			splitEmojiPrompts(['["猫",{"prompt":"狗"},{"prompt":" 鸟 "},"鱼"]']),
			['猫', '狗', '鸟', '鱼'],
		);
	});

	test('★ 严格：JSON 数组元素内的逗号不误拆', () => {
		// `"猫, 狗"` 是一个 JSON 字符串元素（含逗号），必须整体保留，不被逗号拆成两条。
		assert.deepStrictEqual(splitEmojiPrompts(['["猫, 狗","鸟"]']), ['猫, 狗', '鸟']);
	});

	test('多行文本：每行一个表情描述', () => {
		assert.deepStrictEqual(splitEmojiPrompts(['猫\n狗\n鸟']), ['猫', '狗', '鸟']);
	});

	test('多行文本：CRLF 与空行被忽略', () => {
		assert.deepStrictEqual(splitEmojiPrompts(['猫\r\n\r\n狗\r\n鸟']), ['猫', '狗', '鸟']);
	});

	test('分隔符：逗号/顿号/分号/竖线混用', () => {
		assert.deepStrictEqual(splitEmojiPrompts(['猫,狗、鸟;鱼|虾']), ['猫', '狗', '鸟', '鱼', '虾']);
	});

	test('单条文本：原样作为唯一 prompt', () => {
		assert.deepStrictEqual(splitEmojiPrompts(['一只可爱的橘猫']), ['一只可爱的橘猫']);
	});

	test('空数组：返回空', () => {
		assert.deepStrictEqual(splitEmojiPrompts([]), []);
	});

	test('空字符串 / 纯空白：被过滤', () => {
		assert.deepStrictEqual(splitEmojiPrompts(['', '   ', '\n']), []);
	});

	test('★ 严格：非合法 JSON 的方括号开头 → 单条保留（不误拆）', () => {
		// `[猫,狗` JSON 解析失败 → 严格模式作为单条保留，而非逗号拆成 `['[猫','狗']`。
		assert.deepStrictEqual(splitEmojiPrompts(['[猫,狗']), ['[猫,狗']);
	});

	test('混合多文本条目：按顺序累积', () => {
		assert.deepStrictEqual(
			splitEmojiPrompts(['["猫","狗"]', '鸟\n鱼']),
			['猫', '狗', '鸟', '鱼'],
		);
	});

	test('含对象但 prompt 非字符串的项：跳过该项', () => {
		assert.deepStrictEqual(
			splitEmojiPrompts(['["猫",{"prompt":123},{"prompt":"狗"}]']),
			['猫', '狗'],
		);
	});

	test('分隔符拆分也 trim 首尾空白', () => {
		assert.deepStrictEqual(splitEmojiPrompts([' 猫 , 狗 , 鸟 ']), ['猫', '狗', '鸟']);
	});
});

suite('parseEmojiCellArray（严格 JSON cell 数组，含 seed/text）', () => {
	test('字符串元素数组 → 完整 cell（seed=0 text=""）', () => {
		assert.deepStrictEqual(
			parseEmojiCellArray(['["猫","狗"]']),
			[
				{ prompt: '猫', seed: 0, text: '' },
				{ prompt: '狗', seed: 0, text: '' },
			],
		);
	});

	test('对象元素数组 → 完整三字段（prompt/seed/text）', () => {
		assert.deepStrictEqual(
			parseEmojiCellArray(['[{"prompt":"猫","seed":123,"text":"喵"}]']),
			[{ prompt: '猫', seed: 123, text: '喵' }],
		);
	});

	test('对象元素字段可选：缺省 seed/text 补零', () => {
		assert.deepStrictEqual(
			parseEmojiCellArray(['[{"prompt":"猫"}]']),
			[{ prompt: '猫', seed: 0, text: '' }],
		);
	});

	test('★ 严格：元素内 prompt 含逗号不误拆', () => {
		assert.deepStrictEqual(
			parseEmojiCellArray(['["猫, 狗"]']),
			[{ prompt: '猫, 狗', seed: 0, text: '' }],
		);
	});

	test('非 JSON 数组（普通文本）→ null', () => {
		assert.strictEqual(parseEmojiCellArray(['猫,狗']), null);
		assert.strictEqual(parseEmojiCellArray(['猫\n狗']), null);
	});

	test('★ 严格：`[` 开头但非法 JSON → null（不产出半截）', () => {
		assert.strictEqual(parseEmojiCellArray(['[猫,狗']), null);
	});

	test('非数组 JSON（对象）→ null', () => {
		assert.strictEqual(parseEmojiCellArray(['{"prompt":"猫"}']), null);
	});

	test('空输入 → null', () => {
		assert.strictEqual(parseEmojiCellArray([]), null);
		assert.strictEqual(parseEmojiCellArray(['']), null);
	});

	test('数组元素全非法 → null（不返回空数组）', () => {
		assert.strictEqual(parseEmojiCellArray(['[123, true]']), null);
	});

	test('多条目：取第一条合法 JSON 数组', () => {
		assert.deepStrictEqual(
			parseEmojiCellArray(['猫,狗', '["猫","狗"]']),
			[
				{ prompt: '猫', seed: 0, text: '' },
				{ prompt: '狗', seed: 0, text: '' },
			],
		);
	});

	test('混合元素：字符串与对象并存', () => {
		assert.deepStrictEqual(
			parseEmojiCellArray(['["猫",{"prompt":"狗","seed":7,"text":"汪"}]']),
			[
				{ prompt: '猫', seed: 0, text: '' },
				{ prompt: '狗', seed: 7, text: '汪' },
			],
		);
	});

	test('★ markdown 代码块包裹 → 正常解析', () => {
		assert.deepStrictEqual(
			parseEmojiCellArray(['```json\n["猫","狗"]\n```']),
			[
				{ prompt: '猫', seed: 0, text: '' },
				{ prompt: '狗', seed: 0, text: '' },
			],
		);
	});

	test('★ 前后缀说明文本 → 提取内嵌数组', () => {
		assert.deepStrictEqual(
			parseEmojiCellArray(['好的，以下是表情列表：["猫","狗"]，共 2 个']),
			[
				{ prompt: '猫', seed: 0, text: '' },
				{ prompt: '狗', seed: 0, text: '' },
			],
		);
	});

	test('★ markdown + 前后缀同时存在 → 提取', () => {
		assert.deepStrictEqual(
			parseEmojiCellArray(['```json\n这是结果：["猫","狗"]\n```']),
			[
				{ prompt: '猫', seed: 0, text: '' },
				{ prompt: '狗', seed: 0, text: '' },
			],
		);
	});
});

suite('extractJsonArray / stripMarkdownCodeFence（LLM 输出容错提取）', () => {
	test('stripMarkdownCodeFence：剥 ```json 包裹', () => {
		assert.strictEqual(stripMarkdownCodeFence('```json\n["猫"]\n```'), '["猫"]');
	});

	test('stripMarkdownCodeFence：剥裸 ``` 包裹', () => {
		assert.strictEqual(stripMarkdownCodeFence('```\n["猫"]\n```'), '["猫"]');
	});

	test('stripMarkdownCodeFence：无代码块原样返回', () => {
		assert.strictEqual(stripMarkdownCodeFence('["猫"]'), '["猫"]');
	});

	test('extractJsonArray：干净数组', () => {
		assert.deepStrictEqual(extractJsonArray('["猫","狗"]'), ['猫', '狗']);
	});

	test('extractJsonArray：前后缀文本中提取', () => {
		assert.deepStrictEqual(extractJsonArray('前缀 ["猫"] 后缀'), ['猫']);
	});

	test('extractJsonArray：跳过字符串内的括号', () => {
		assert.deepStrictEqual(extractJsonArray('["猫[图]狗","鸟"]'), ['猫[图]狗', '鸟']);
	});

	test('extractJsonArray：跳过转义引号', () => {
		assert.deepStrictEqual(extractJsonArray('["猫\\"狗","鸟"]'), ['猫"狗', '鸟']);
	});

	test('extractJsonArray：多候选取第一个合法数组', () => {
		assert.deepStrictEqual(extractJsonArray('[猫,狗] 然后 ["真","数组"]'), ['真', '数组']);
	});

	test('extractJsonArray：非数组 JSON → null', () => {
		assert.strictEqual(extractJsonArray('{"a":1}'), null);
	});

	test('extractJsonArray：无数组 → null', () => {
		assert.strictEqual(extractJsonArray('纯文本无括号'), null);
	});

	test('extractJsonArray：空输入 → null', () => {
		assert.strictEqual(extractJsonArray(''), null);
	});
});
