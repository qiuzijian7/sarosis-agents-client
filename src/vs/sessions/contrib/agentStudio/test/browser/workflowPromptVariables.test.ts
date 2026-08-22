/*---------------------------------------------------------------------------------------------
 *  Unit tests for resolvePromptVariables / makeNamedWithVariables ——
 *  Saros.Prompt 节点 variables 字段接线（P0）。
 *
 *  覆盖：JSON 解析、非字符串值 stringify、值内 {{input}}/{{args.x}} 引用、
 *  变量间引用、循环引用保护、非法 JSON 降级、命名空间优先级。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	resolvePromptVariables,
	makeNamedWithVariables,
	resolveTemplateVars,
	stringifyResolvedValue,
	findUnresolvedPlaceholders,
} from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';

suite('resolvePromptVariables', () => {
	test('JSON 字符串 → 具名变量映射', () => {
		const v = resolvePromptVariables('{"角色":"翻译助手","目标语言":"中文"}', {});
		assert.deepStrictEqual(v, { 角色: '翻译助手', 目标语言: '中文' });
	});

	test('对象直接传入（非字符串）', () => {
		const v = resolvePromptVariables({ a: '1', b: '2' }, {});
		assert.deepStrictEqual(v, { a: '1', b: '2' });
	});

	test('非字符串值 JSON.stringify', () => {
		const v = resolvePromptVariables({ n: 42, arr: [1, 2, 3], o: { x: 1 } }, {});
		assert.strictEqual(v.n, '42');
		assert.strictEqual(v.arr, '[1,2,3]');
		assert.strictEqual(v.o, '{"x":1}');
	});

	test('null / undefined 值 → 空字符串', () => {
		const v = resolvePromptVariables({ a: null, b: undefined }, {});
		assert.strictEqual(v.a, '');
		assert.strictEqual(v.b, '');
	});

	test('变量值内可引用 {{input}}', () => {
		const v = resolvePromptVariables('{"主题":"{{input}}"}', { input: 'cyberpunk' });
		assert.strictEqual(v.主题, 'cyberpunk');
	});

	test('变量值内可引用 {{args.x}}', () => {
		const v = resolvePromptVariables('{"数量":"{{args.count}}"}', { args: { count: 4 } });
		assert.strictEqual(v.数量, '4');
	});

	test('变量间引用（B 引用 A）', () => {
		const v = resolvePromptVariables('{"A":"cyberpunk","B":"风格是 {{A}}"}', {});
		assert.strictEqual(v.A, 'cyberpunk');
		assert.strictEqual(v.B, '风格是 cyberpunk');
	});

	test('循环引用保护（A↔B 不无限递归）', () => {
		const v = resolvePromptVariables('{"A":"{{B}}","B":"{{A}}"}', {});
		// 循环引用降级为原文（占位符原样保留），不抛异常、不空替换
		assert.ok(typeof v.A === 'string' && typeof v.B === 'string');
		assert.ok(v.A.includes('{{B}}') || v.B.includes('{{A}}'), '循环引用应保留原文占位符');
	});

	test('非法 JSON 字符串 → 空映射', () => {
		assert.deepStrictEqual(resolvePromptVariables('not-json', {}), {});
		assert.deepStrictEqual(resolvePromptVariables('[1,2]', {}), {}); // 数组不是对象
	});

	test('空值 → 空映射', () => {
		assert.deepStrictEqual(resolvePromptVariables(undefined, {}), {});
		assert.deepStrictEqual(resolvePromptVariables('', {}), {});
		assert.deepStrictEqual(resolvePromptVariables(null, {}), {});
	});
});

suite('makeNamedWithVariables', () => {
	test('局部变量优先于 fallback', () => {
		const named = makeNamedWithVariables({ 角色: '局部值' }, () => '外部值');
		assert.strictEqual(named('角色'), '局部值');
	});

	test('未命中局部变量 → 回退 fallback', () => {
		const named = makeNamedWithVariables({}, (l) => l === 'x' ? 'X' : undefined);
		assert.strictEqual(named('x'), 'X');
		assert.strictEqual(named('y'), undefined);
	});

	test('fallback 缺失 → undefined', () => {
		const named = makeNamedWithVariables({});
		assert.strictEqual(named('任意'), undefined);
	});
});

suite('端到端：变量注入 prompt 模板', () => {
	test('{{变量名}} 在 prompt 中解析', () => {
		const variables = resolvePromptVariables('{"角色":"翻译助手","目标语言":"中文"}', {});
		const named = makeNamedWithVariables(variables);
		const text = resolveTemplateVars('你是{{角色}}，翻译成{{目标语言}}', { named });
		assert.strictEqual(text, '你是翻译助手，翻译成中文');
	});

	test('变量 + input + args 混合解析', () => {
		const variables = resolvePromptVariables('{"风格":"{{input}} 风格"}', { input: 'cyberpunk', args: { n: 4 } });
		const named = makeNamedWithVariables(variables);
		const text = resolveTemplateVars('{{风格}}，生成 {{args.n}} 张', { input: 'cyberpunk', args: { n: 4 }, named });
		assert.strictEqual(text, 'cyberpunk 风格，生成 4 张');
	});

	test('变量值引用上游 label（经 fallback named）', () => {
		const fallback = (l: string) => l === '分析' ? '{"tags":["neon"]}' : undefined;
		const variables = resolvePromptVariables('{"标签":"{{分析.tags}}"}', { named: fallback });
		const named = makeNamedWithVariables(variables, fallback);
		const text = resolveTemplateVars('标签是 {{标签}}', { named });
		// P2 类型安全：tags 是数组 → JSON.stringify → ["neon"]（旧版 String(["neon"]) 巧合得 "neon"）
		assert.strictEqual(text, '标签是 ["neon"]');
	});
});

suite('P2a: stringifyResolvedValue（类型安全）', () => {
	test('对象 → JSON.stringify（不再 [object Object]）', () => {
		assert.strictEqual(stringifyResolvedValue({ a: 1, b: 'x' }), '{"a":1,"b":"x"}');
	});

	test('数组 → JSON.stringify', () => {
		assert.strictEqual(stringifyResolvedValue([1, 2, 3]), '[1,2,3]');
	});

	test('嵌套对象 → JSON.stringify', () => {
		assert.strictEqual(stringifyResolvedValue({ list: [1, { x: true }] }), '{"list":[1,{"x":true}]}');
	});

	test('标量 → String', () => {
		assert.strictEqual(stringifyResolvedValue('hello'), 'hello');
		assert.strictEqual(stringifyResolvedValue(42), '42');
		assert.strictEqual(stringifyResolvedValue(true), 'true');
	});

	test('undefined/null → 空串', () => {
		assert.strictEqual(stringifyResolvedValue(undefined), '');
		assert.strictEqual(stringifyResolvedValue(null), '');
	});
});

suite('P2a: resolveTemplateVars 点路径对象取值', () => {
	test('{{input.path}} 对象值 → JSON.stringify（不 [object Object]）', () => {
		const input = JSON.stringify({ meta: { tags: ['a', 'b'] } });
		const out = resolveTemplateVars('标签 {{input.meta.tags}}', { input });
		assert.strictEqual(out, '标签 ["a","b"]');
	});

	test('{{args.x}} 对象值 → JSON.stringify', () => {
		const out = resolveTemplateVars('配置 {{args.config}}', { args: { config: { width: 1024, height: 512 } } });
		assert.strictEqual(out, '配置 {"width":1024,"height":512}');
	});

	test('{{label.field}} 对象值 → JSON.stringify', () => {
		const named = (l: string) => l === '分析' ? '{"tags":["neon","cyber"]}' : undefined;
		const out = resolveTemplateVars('结果 {{分析.tags}}', { named });
		assert.strictEqual(out, '结果 ["neon","cyber"]');
	});

	test('标量路径值仍正常（不回归）', () => {
		const out = resolveTemplateVars('{{args.count}} 个', { args: { count: 4 } });
		assert.strictEqual(out, '4 个');
	});
});

suite('P2b: findUnresolvedPlaceholders', () => {
	test('无占位符 → 空数组', () => {
		assert.deepStrictEqual(findUnresolvedPlaceholders('纯文本'), []);
	});

	test('全部解析成功 → 空数组', () => {
		assert.deepStrictEqual(findUnresolvedPlaceholders('cyberpunk 风格，生成 4 张'), []);
	});

	test('残留占位符 → 提取并去重', () => {
		assert.deepStrictEqual(
			findUnresolvedPlaceholders('你是{{角色}}，翻译成{{角色}}，以及{{缺失}}'),
			['角色', '缺失'],
		);
	});

	test('只提取内容（不含花括号）', () => {
		assert.deepStrictEqual(findUnresolvedPlaceholders('{{input}} {{args.x}}'), ['input', 'args.x']);
	});

	test('空占位符 {{}} → 忽略', () => {
		assert.deepStrictEqual(findUnresolvedPlaceholders('{{}}'), []);
	});

	test('空字符串 / 无 {{ → 空数组', () => {
		assert.deepStrictEqual(findUnresolvedPlaceholders(''), []);
		assert.deepStrictEqual(findUnresolvedPlaceholders('没有占位符'), []);
	});
});

suite('P2: 端到端未解析告警语义', () => {
	test('resolveTemplateVars 未解析占位符原样保留（供 findUnresolvedPlaceholders 检测）', () => {
		const named = (l: string) => undefined; // 无任何命名解析
		const text = resolveTemplateVars('你是{{角色}}', { named });
		assert.strictEqual(text, '你是{{角色}}'); // 原样保留（延迟解析语义）
		assert.deepStrictEqual(findUnresolvedPlaceholders(text), ['角色']);
	});
});
