/*---------------------------------------------------------------------------------------------
 *  Unit tests for AskUser 动态参数（D1+D2+D3，2026-09-10）。
 *
 *  被测契约：_executeAskUserNode 的「上游 SAROS_JSON 字段级覆盖」纯逻辑（复刻实现）：
 *    - 上游输出 `{question?, options?}` JSON → 字段级覆盖静态配置（T2/T3）；
 *    - 上游无 JSON / 形状不符 / 空数组 → 静默回落静态（T1/T4）；
 *    - options 元素支持字符串与 {label,description} 两种形态，无 label 的丢弃；
 *    - 上游未完成（status≠completed）不参与合并；
 *    - allowCustom/customLabel 从 node.data 透传（D3）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { WorkflowNodeExecutionStatus } from '../../common/workflowExecutionService.js';
import { validateStructuredRefs, parseStructuredRef } from '../../browser/workflow/structuredRefs.js';

interface IAskUserOption { label: string; description?: string }

/** 复刻 _executeAskUserNode 的动态合并逻辑（纯函数化以便单测）。 */
function mergeDynamicAskUser(
	data: { question?: string; options?: IAskUserOption[] },
	upstreams: Array<{ status: string; output?: string }>,
): { question: string; options: IAskUserOption[] } {
	let question = (data.question as string) || '请提供更多输入';
	let options = (data.options as IAskUserOption[]) || [];
	let fields: Array<{ key: string }> = (data.fields as Array<{ key: string }>) || [];
	for (const up of upstreams) {
		if (up.status !== WorkflowNodeExecutionStatus.Completed || !up.output) { continue; }
		try {
			const parsed = JSON.parse(up.output) as { question?: unknown; options?: unknown; fields?: unknown } | null;
			if (!parsed || typeof parsed !== 'object') { continue; }
			if (typeof parsed.question === 'string' && parsed.question.trim()) { question = parsed.question; }
			if (Array.isArray(parsed.fields)) {
				const dynFields = (parsed.fields as unknown[])
					.map(f => f as { key: string })
					.filter(f => f && typeof f.key === 'string' && f.key.trim());
				if (dynFields.length > 0) { fields = dynFields; }
			}
			if (Array.isArray(parsed.options)) {
				const dyn = (parsed.options as unknown[])
					.map(o => typeof o === 'string' ? { label: o } : (o as IAskUserOption))
					.filter(o => o && typeof o.label === 'string' && o.label.trim());
				if (dyn.length > 0) { options = dyn as IAskUserOption[]; }
			}
		} catch { /* 非 JSON → 静默回落 */ }
	}
	return { question, options, fields };
}

suite('AskUser 动态参数 (D1+D2+D3)', () => {

	test('T1 静态回落：上游无 JSON 输出 → 静态配置原样（旧行为兼容）', () => {
		const r = mergeDynamicAskUser(
			{ question: '选一个', options: [{ label: 'A' }, { label: 'B' }] },
			[{ status: WorkflowNodeExecutionStatus.Completed, output: '纯文本非JSON' }],
		);
		assert.strictEqual(r.question, '选一个');
		assert.deepStrictEqual(r.options, [{ label: 'A' }, { label: 'B' }]);
	});

	test('T2 动态覆盖：上游 JSON options 覆盖静态（字符串与对象两种元素形态）', () => {
		const r = mergeDynamicAskUser(
			{ question: '静态问题', options: [{ label: '静态' }] },
			[{ status: WorkflowNodeExecutionStatus.Completed, output: JSON.stringify({ question: '动态问题', options: ['方案A', { label: '方案B', description: '更稳' }] }) }],
		);
		assert.strictEqual(r.question, '动态问题');
		assert.deepStrictEqual(r.options, [{ label: '方案A' }, { label: '方案B', description: '更稳' }]);
	});

	test('T3 字段级合并：上游只有 question 无 options → question 动态 + options 静态', () => {
		const r = mergeDynamicAskUser(
			{ question: '静态', options: [{ label: 'X' }] },
			[{ status: WorkflowNodeExecutionStatus.Completed, output: JSON.stringify({ question: '动态' }) }],
		);
		assert.strictEqual(r.question, '动态');
		assert.deepStrictEqual(r.options, [{ label: 'X' }]);
	});

	test('T4 容错：上游 JSON 形状不符（数组/标量/null）→ 静默回落', () => {
		const staticCfg = { question: 'q', options: [{ label: 'A' }] };
		for (const bad of ['[1,2]', '"str"', 'null', '42']) {
			const r = mergeDynamicAskUser(staticCfg, [{ status: WorkflowNodeExecutionStatus.Completed, output: bad }]);
			assert.strictEqual(r.question, 'q', `bad=${bad}`);
			assert.deepStrictEqual(r.options, [{ label: 'A' }], `bad=${bad}`);
			assert.deepStrictEqual(r.fields, [], `bad=${bad}`);
		}
	});

	test('上游未完成（Running/Failed）不参与合并', () => {
		const r = mergeDynamicAskUser(
			{ question: '静态', options: [{ label: 'A' }] },
			[{ status: WorkflowNodeExecutionStatus.Running, output: JSON.stringify({ question: '不该生效' }) },
			 { status: WorkflowNodeExecutionStatus.Failed, output: JSON.stringify({ options: ['X'] }) }],
		);
		assert.strictEqual(r.question, '静态');
		assert.deepStrictEqual(r.options, [{ label: 'A' }]);
	});

	test('上游空 options 数组 → 回落静态（不吞掉选项）', () => {
		const r = mergeDynamicAskUser(
			{ question: 'q', options: [{ label: 'A' }] },
			[{ status: WorkflowNodeExecutionStatus.Completed, output: JSON.stringify({ options: [] }) }],
		);
		assert.deepStrictEqual(r.options, [{ label: 'A' }]);
	});

	test('无 label 的动态元素被丢弃（脏数据防护）', () => {
		const r = mergeDynamicAskUser(
			{ options: [{ label: '静态' }] },
			[{ status: WorkflowNodeExecutionStatus.Completed, output: JSON.stringify({ options: [{ label: '' }, 'good', 42] }) }],
		);
		assert.deepStrictEqual(r.options, [{ label: 'good' }]);
	});

	test('D4 上游 JSON fields 覆盖静态字段定义', () => {
		const r = mergeDynamicAskUser(
			{ options: [{ label: 'A' }] },
			[{ status: WorkflowNodeExecutionStatus.Completed, output: JSON.stringify({ fields: [{ key: 'topic', label: '主题' }, { key: 'count', kind: 'number' }] }) }],
		);
		assert.deepStrictEqual(r.fields, [{ key: 'topic', label: '主题' }, { key: 'count', kind: 'number' }]);
	});

	test('D4 fields 脏数据（无 key）丢弃 + 缺失回落静态', () => {
		const r = mergeDynamicAskUser(
			{ options: [{ label: 'A' }] },
			[{ status: WorkflowNodeExecutionStatus.Completed, output: JSON.stringify({ fields: [{ label: '无key' }, { key: 'ok' }] }) }],
		);
		assert.deepStrictEqual(r.fields, [{ key: 'ok' }]);
	});

	/** 复刻执行侧的对象态答案物化（D4）。 */
	function materializeAnswer(userInput: string | string[]): { labels: string[]; params: Record<string, string> | undefined } {
		let obj: { __askUserAnswer?: number; labels?: unknown; params?: unknown } | undefined;
		if (typeof userInput === 'string' && userInput.startsWith('{')) {
			try { obj = JSON.parse(userInput); } catch { /* plain text */ }
		} else if (userInput && typeof userInput === 'object' && !Array.isArray(userInput)) {
			obj = userInput as typeof obj;
		}
		if (obj && obj.__askUserAnswer === 1) {
			return {
				labels: Array.isArray(obj.labels) ? (obj.labels as string[]) : [],
				params: (obj.params && typeof obj.params === 'object') ? obj.params as Record<string, string> : undefined,
			};
		}
		return { labels: Array.isArray(userInput) ? userInput : [userInput], params: undefined };
	}

	test('D4 对象态：JSON 字符串答案解析出 labels + params', () => {
		const r = materializeAnswer(JSON.stringify({ __askUserAnswer: 1, labels: ['方案A'], params: { topic: 'cat' } }));
		assert.deepStrictEqual(r.labels, ['方案A']);
		assert.deepStrictEqual(r.params, { topic: 'cat' });
	});

	test('★ D4 兼容：旧字符串/数组答案不受影响（params 为 undefined）', () => {
		assert.deepStrictEqual(materializeAnswer('方案A').labels, ['方案A']);
		assert.strictEqual(materializeAnswer('方案A').params, undefined);
		assert.deepStrictEqual(materializeAnswer(['A', 'B']).labels, ['A', 'B']);
	});

	test('D4 兼容：普通文本恰以 { 开头但不为合法 JSON → 原样作 label', () => {
		const r = materializeAnswer('{不是JSON');
		assert.deepStrictEqual(r.labels, ['{不是JSON']);
	});

	/** 复刻 _collectAskUserAssets：仅 kind='image' 的字段进入 assets（值为资产引用）。 */
	function collectAssets(fields: Array<{ key: string; kind?: string }>, params: Record<string, string>): Record<string, string> {
		const out: Record<string, string> = {};
		for (const f of fields) {
			if (f.kind !== 'image') { continue; }
			const v = typeof params[f.key] === 'string' ? (params[f.key] as string).trim() : '';
			if (v) { out[f.key] = v; }
		}
		return out;
	}

	/** 复刻 AskUser 输出契约组装（阶段 1）。 */
	function buildContract(labels: string[], params: Record<string, string>, assets: Record<string, string>) {
		return JSON.stringify({
			__askUser: 1,
			labels,
			params,
			...(Object.keys(assets).length > 0 ? { assets } : {}),
		});
	}

	test('阶段1 契约：labels/params 入结构化输出（无 assets 时不带该字段）', () => {
		const c = JSON.parse(buildContract(['猫'], { prompt: 'Q版' }, {}));
		assert.strictEqual(c.__askUser, 1);
		assert.deepStrictEqual(c.labels, ['猫']);
		assert.deepStrictEqual(c.params, { prompt: 'Q版' });
		assert.strictEqual('assets' in c, false);
	});

	test('★ 阶段1 媒体：image 字段进入 assets（资产引用，非内联 data URL）', () => {
		const params = { reference: 'asset://snap/abc', prompt: 'Q版' };
		const assets = collectAssets([{ key: 'reference', kind: 'image' }, { key: 'prompt' }], params);
		assert.deepStrictEqual(assets, { reference: 'asset://snap/abc' });
		const c = JSON.parse(buildContract(['猫'], params, assets));
		assert.strictEqual(c.assets.reference, 'asset://snap/abc');
	});

	test('阶段1 媒体：image 字段值为空 → 不进 assets（不写空引用）', () => {
		const assets = collectAssets([{ key: 'ref', kind: 'image' }], { ref: '   ' });
		assert.deepStrictEqual(assets, {});
	});

	test('阶段1 兼容：非 image 字段永不进 assets（params 保持纯文本）', () => {
		const assets = collectAssets([{ key: 'a', kind: 'text' }, { key: 'b', kind: 'number' }], { a: 'x', b: '9' });
		assert.deepStrictEqual(assets, {});
	});

	/** 复刻 _resolveStructuredRef（阶段 2）：从节点 output 契约按路径取值。 */
	function resolveRef(nodeOutput: string | undefined, path: string): unknown {
		if (nodeOutput === undefined) { return undefined; }
		if (typeof nodeOutput === 'string' && nodeOutput.trim().startsWith('{')) {
			try {
				const obj = JSON.parse(nodeOutput) as unknown;
				if (obj && typeof obj === 'object') {
					if (!path) { return obj; }
					return path.split('.').reduce<unknown>((acc, seg) => {
						if (acc && typeof acc === 'object') { return (acc as Record<string, unknown>)[seg]; }
						return undefined;
					}, obj);
				}
			} catch { /* fallthrough */ }
		}
		return nodeOutput;
	}

	test('阶段2 $ref：params.x 取值（结构化引用，非字符串模板）', () => {
		const out = buildContract(['猫'], { prompt: 'Q版厚描边', count: '9' }, {});
		assert.strictEqual(resolveRef(out, 'params.prompt'), 'Q版厚描边');
		assert.strictEqual(resolveRef(out, 'params.count'), '9');
	});

	test('阶段2 $ref：assets.x 取媒体引用（参考图传参可达）', () => {
		const out = buildContract(['猫'], { reference: 'asset://snap/abc' }, { reference: 'asset://snap/abc' });
		assert.strictEqual(resolveRef(out, 'assets.reference'), 'asset://snap/abc');
	});

	test('阶段2 $ref：labels.0 与空 path（整段契约）', () => {
		const out = buildContract(['猫', '狗'], {}, {});
		assert.strictEqual(resolveRef(out, 'labels.0'), '猫');
		const whole = resolveRef(out, '') as { __askUser: number };
		assert.strictEqual(whole.__askUser, 1);
	});

	test('★ 阶段2 悬空引用：节点无输出 / 路径不存在 → undefined（不静默用字面量）', () => {
		assert.strictEqual(resolveRef(undefined, 'params.x'), undefined);
		const out = buildContract(['猫'], {}, {});
		assert.strictEqual(resolveRef(out, 'params.missing'), undefined);
	});

	test('阶段2 兼容：非 JSON 输出（普通节点）→ 整段文本，旧行为不变', () => {
		assert.strictEqual(resolveRef('纯文本输出', 'params.x'), '纯文本输出');
	});

	suite('$ref 静态预检（validateStructuredRefs）', () => {
		test('悬空节点引用 → error', () => {
			const problems = validateStructuredRefs([
				{ id: 'n1', type: 'Saros.Prompt', data: { bindings: { prompt: { $ref: { node: 'ghost', path: 'params.x' } } } } },
			]);
			assert.strictEqual(problems.length, 1);
			assert.strictEqual(problems[0].severity, 'error');
			assert.match(problems[0].message, /不存在/);
		});

		test('对非契约节点写 path → warning（AskUser 全名归一后不算）', () => {
			const problems = validateStructuredRefs([
				{ id: 'ask', type: 'Saros.AskUser', data: {} },
				{ id: 'n1', type: 'Saros.Prompt', data: { bindings: { a: { $ref: { node: 'ask', path: 'params.x' } } } } },
				{ id: 'n2', type: 'Saros.Prompt', data: { bindings: { b: { $ref: { node: 'n1', path: 'output' } } } } },
			]);
			assert.strictEqual(problems.length, 1, '只应报 n2 对 n1 的 path 警告');
			assert.strictEqual(problems[0].severity, 'warning');
			assert.strictEqual(problems[0].nodeId, 'n2');
		});

		test('$ref 缺 node → error', () => {
			const problems = validateStructuredRefs([
				{ id: 'n1', type: 'Saros.Prompt', data: { bindings: { a: { $ref: { path: 'params.x' } } } } },
			]);
			assert.strictEqual(problems.length, 1);
			assert.strictEqual(problems[0].severity, 'error');
		});

		test('全部合法 → 空数组', () => {
			const problems = validateStructuredRefs([
				{ id: 'ask', type: 'Saros.AskUser', data: {} },
				{ id: 'n1', type: 'Saros.Prompt', data: { bindings: { prompt: { $ref: { node: 'ask', path: 'params.prompt' } } } } },
			]);
			assert.deepStrictEqual(problems, []);
		});

		test('parseStructuredRef：识别/拒绝', () => {
			assert.deepStrictEqual(parseStructuredRef({ $ref: { node: 'a', path: 'p' } }), { node: 'a', path: 'p' });
			assert.strictEqual(parseStructuredRef('{{a}}'), undefined);
			assert.strictEqual(parseStructuredRef({ $ref: { path: 'p' } }), undefined);
		});
	});

	/** 复刻执行侧「params 剥离媒体字段」逻辑（阶段 2 防护）。 */
	function stripAssets(params: Record<string, string>, assets: Record<string, string>): Record<string, string> {
		const textParams: Record<string, string> = { ...params };
		for (const k of Object.keys(assets)) { delete textParams[k]; }
		return textParams;
	}

	test('★ 媒体字段不残留在 params（防 base64 被拼进 prompt）', () => {
		const params = { prompt: 'Q版', reference: 'data:image/png;base64,AAAA…' };
		const assets = collectAssets([{ key: 'reference', kind: 'image' }], params);
		assert.deepStrictEqual(assets, { reference: 'data:image/png;base64,AAAA…' });
		assert.deepStrictEqual(stripAssets(params, assets), { prompt: 'Q版' });
	});

	test('剥离后 params 仍可用于文本模板合成（文本字段保留）', () => {
		const params = { a: '1', b: '2' };
		assert.deepStrictEqual(stripAssets(params, {}), { a: '1', b: '2' });
	});

	test('多上游：后完成的覆盖先完成的（迭代序）', () => {
		const r = mergeDynamicAskUser(
			{ options: [{ label: '静态' }] },
			[{ status: WorkflowNodeExecutionStatus.Completed, output: JSON.stringify({ options: ['first'] }) },
			 { status: WorkflowNodeExecutionStatus.Completed, output: JSON.stringify({ options: ['second'] }) }],
		);
		assert.deepStrictEqual(r.options, [{ label: 'second' }]);
	});
});
