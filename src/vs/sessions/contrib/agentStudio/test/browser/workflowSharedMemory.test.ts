/*---------------------------------------------------------------------------------------------
 *  工作流「共享内存」读路径 + 语义名发布 测试。
 *
 *  背景（2026-09-11）：`executionState.sharedMemory` 的注释承诺「Agent 间共享、
 *  所有节点可见」，但全服务只有**一处写入**（每节点成功后 `set(nodeId, output)`）、
 *  **零读取点** —— 又一处「只写不读」（与 checkpoint 同族缺陷）。
 *
 *  本文件钉住补齐后的两条通路：
 *    ① 键 = nodeId → 下游 `{{<nodeId>}}`（等价既有 nodeStates 通路）
 *    ② `data.publishes` 语义名 → 下游 `{{shared.<key>}}`
 *       ★ 关键：下游**无需知道是哪个节点产出的**（多 Agent 协同按语义引用的基础）
 *       ★ 且键名必须能被真实替换出来 —— 不可替换的键**必须丢弃**（否则静默失效）
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	buildRuntimeValueMap,
	substituteHostVariables,
	parseSharedPublishKeys,
	isSubstitutableSharedKey,
	collectWorkflowVariables,
	SHARED_VAR_PREFIX,
} from '../../browser/utils/templateUtils.js';
import {
	buildSarosEditorFields,
	sarosValuesToData,
	sarosDataToValues,
} from '../../webview/src/features/workflowEditor/comfyHost/nodeEditorForm.js';

suite('共享内存 / 发布键解析（parseSharedPublishKeys）', () => {

	test('字符串 → 单键；数组 → 多键', () => {
		assert.deepStrictEqual(parseSharedPublishKeys('verdict'), ['verdict']);
		assert.deepStrictEqual(parseSharedPublishKeys(['verdict', 'plan']), ['verdict', 'plan']);
	});

	test('trim + 去重（同一键声明两次只发布一次）', () => {
		assert.deepStrictEqual(parseSharedPublishKeys([' verdict ', 'verdict']), ['verdict']);
	});

	test('合法键形态：单词 / 连字符 / 下划线 / 点分（均可被 {{shared.<key>}} 替换）', () => {
		for (const key of ['verdict', 'plan-v2', 'k_1', 'a.b']) {
			assert.strictEqual(isSubstitutableSharedKey(key), true, key);
			assert.deepStrictEqual(parseSharedPublishKeys(key), [key], key);
		}
	});

	test('★ 非 ASCII 键被丢弃（否则写进共享内存却永远替换不出来 = 静默失效）', () => {
		// HOST_VARIABLE_PATTERN 的变量名是 `[\w-]`（ASCII）→ `{{shared.我的裁决}}` 匹配不到
		assert.strictEqual(isSubstitutableSharedKey('我的裁决'), false);
		assert.deepStrictEqual(parseSharedPublishKeys(['我的裁决', 'ok']), ['ok']);
	});

	test('含空格 / 空串 / 纯符号 → 丢弃', () => {
		for (const key of ['has space', '', '  ', '!!!', '{{x}}']) {
			assert.strictEqual(isSubstitutableSharedKey(key), false, JSON.stringify(key));
		}
		assert.deepStrictEqual(parseSharedPublishKeys('has space'), []);
	});

	test('非字符串项 / 非字符串非数组入参 → 安全跳过（节点 data 不可信）', () => {
		assert.deepStrictEqual(parseSharedPublishKeys([42, null, { a: 1 }, 'ok']), ['ok']);
		assert.deepStrictEqual(parseSharedPublishKeys(undefined), []);
		assert.deepStrictEqual(parseSharedPublishKeys(null), []);
		assert.deepStrictEqual(parseSharedPublishKeys(42), []);
	});

	test('前缀常量与替换正则一致（防止两处漂移）', () => {
		const values = { [`${SHARED_VAR_PREFIX}k`]: 'v' };
		assert.strictEqual(substituteHostVariables('{{shared.k}}', values), 'v');
	});
});

suite('共享内存 / 运行时取值（buildRuntimeValueMap）', () => {

	const base = { context: undefined, nodeVariables: undefined, upstreamOutputs: undefined, workflowName: 'wf' };

	test('★ sharedMemory 暴露为 {{shared.<key>}}（端到端可替换）', () => {
		const values = buildRuntimeValueMap({
			...base,
			sharedMemory: new Map([['verdict', 'PASS'], ['plan', 'step1']]),
		});
		assert.strictEqual(values['shared.verdict'], 'PASS');
		assert.strictEqual(substituteHostVariables('裁决结果：{{shared.verdict}}', values), '裁决结果：PASS');
	});

	test('★ 命名空间隔离：context 里的同名键不会变成 shared.<key>', () => {
		const values = buildRuntimeValueMap({ ...base, context: { verdict: 'from-context' } });
		assert.strictEqual(values['verdict'], 'from-context');
		assert.strictEqual(values['shared.verdict'], undefined, 'context 键不得泄漏进 shared 命名空间');
	});

	test('未发布的键保留字面量（不静默替换为空）', () => {
		const values = buildRuntimeValueMap({ ...base, sharedMemory: new Map([['a', 'A']]) });
		assert.strictEqual(substituteHostVariables('{{shared.a}} / {{shared.nope}}', values), 'A / {{shared.nope}}');
	});

	test('缺省不传 sharedMemory → 无 shared.* 键（存量行为零变化）', () => {
		const values = buildRuntimeValueMap({ ...base, context: { k: 'v' } });
		assert.strictEqual(Object.keys(values).some(k => k.startsWith(SHARED_VAR_PREFIX)), false);
	});

	test('同键后写覆盖前写（Map 语义：最新发布者胜）', () => {
		const values = buildRuntimeValueMap({
			...base,
			sharedMemory: new Map([['verdict', 'FAIL'], ['verdict2', 'PASS']]),
		});
		assert.strictEqual(values['shared.verdict'], 'FAIL');
		assert.strictEqual(values['shared.verdict2'], 'PASS');
	});

	test('★ 与上游产出共存：{{nodeA.output}} 与 {{shared.x}} 同时可用（两条通路不互相遮蔽）', () => {
		const values = buildRuntimeValueMap({
			...base,
			upstreamOutputs: { nodeA: 'OUT-A' },
			sharedMemory: new Map([['summary', 'SUM']]),
		});
		assert.strictEqual(substituteHostVariables('{{nodeA.output}}|{{nodeA}}|{{shared.summary}}', values), 'OUT-A|OUT-A|SUM');
	});

	test('空 sharedMemory → 无键（等价于不传）', () => {
		const values = buildRuntimeValueMap({ ...base, sharedMemory: new Map() });
		assert.strictEqual(Object.keys(values).some(k => k.startsWith(SHARED_VAR_PREFIX)), false);
	});
});

suite('共享内存 / 变量收集不得把 {{shared.*}} 当「需用户填写」', () => {

	test('★ collectWorkflowVariables 不收集 shared.<key>（否则参数表单会问用户「shared.verdict 填什么」）', () => {
		const names = collectWorkflowVariables([
			{ data: { prompt: '按 {{shared.verdict}} 生成，主题 {{topic}}' } },
		]).map(v => v.name);
		assert.deepStrictEqual(names, ['topic']);
	});

	test('★ 点分名一律视为字段访问器，不进参数表（nodeA.output / $prev.output / shared.x）', () => {
		const names = collectWorkflowVariables([
			{ data: { prompt: '{{nodeA.output}} {{$prev.output}} {{shared.x}} {{a.b}}' } },
		]).map(v => v.name);
		assert.deepStrictEqual(names, []);
	});

	test('连字符变量名会被收集（旧正则漏掉 → 既不进参数表也替换不出来，静默失效）', () => {
		const names = collectWorkflowVariables([{ data: { prompt: '{{my-var}}' } }]).map(v => v.name);
		assert.deepStrictEqual(names, ['my-var']);
	});

	test('普通用户变量与 {{input}} 仍照常收集（本次改动零回归）', () => {
		const names = collectWorkflowVariables([
			{ data: { prompt: '{{topic}} {{input}} {{taskDescription}}' } },
		]).map(v => v.name).sort();
		assert.deepStrictEqual(names, ['input', 'topic']);
	});
});

suite('共享内存 / 编辑表单 → 执行层 端到端（防「值静默丢失」）', () => {

	test('逗号分隔（弹窗单行文本框的自然写法）→ 多键', () => {
		assert.deepStrictEqual(parseSharedPublishKeys('verdict, plan'), ['verdict', 'plan']);
		assert.deepStrictEqual(parseSharedPublishKeys(' a , b ,a '), ['a', 'b']);
	});

	test('★ 发布字段已登记在可发布节点类型的弹窗表单上', () => {
		for (const type of ['Saros.Prompt', 'Saros.Agent', 'Saros.Task', 'Saros.Skill', 'Saros.Tool']) {
			const fields = buildSarosEditorFields(type);
			assert.ok(fields.some(f => f.key === 'publishes'), `${type} 应可发布共享变量`);
		}
		// 不该出现在无输出的控制流节点上（避免无效字段）
		assert.strictEqual(buildSarosEditorFields('Saros.IfElse').some(f => f.key === 'publishes'), false);
	});

	test('★★ 端到端：表单值 → data.publishes → 解析为发布键（链路任一处键名写错即失败）', () => {
		// 链路：sarosValuesToData（弹窗保存）→ node.data.publishes → host 执行时 parseSharedPublishKeys
		const data = sarosValuesToData('Saros.Agent', { agentId: 'a', prompt: 'p', publishes: 'verdict, plan' });
		assert.strictEqual(data.publishes, 'verdict, plan');
		assert.deepStrictEqual(parseSharedPublishKeys(data.publishes), ['verdict', 'plan']);
	});

	test('★ 反向：已保存的 data.publishes 回填到表单（重开弹窗能看到原值）', () => {
		const values = sarosDataToValues('Saros.Agent', { publishes: 'verdict' });
		assert.strictEqual(values.publishes, 'verdict');
	});

	test('未填 publishes → 存为空串且解析为空（不发布，零行为变化）', () => {
		const data = sarosValuesToData('Saros.Agent', { agentId: 'a', prompt: 'p' });
		assert.strictEqual(data.publishes, '');
		assert.deepStrictEqual(parseSharedPublishKeys(data.publishes), []);
	});
});
