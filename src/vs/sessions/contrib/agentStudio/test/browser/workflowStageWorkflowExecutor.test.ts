/*---------------------------------------------------------------------------------------------
 *  Unit tests for stageWorkflowExecutor — schema-node ComfyTV workflow execution.
 *  主目标：覆盖 ImageStage 等 schema 节点在 ComfyUI 启动但 ComfyTV 扩展未装 /
 *  workflow 未打开 / api_json 缺失等异常路径下的防御式返回（避免
 *  "Cannot convert undefined or null to object"）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	injectWorkflowValues,
	extractResultOutputs,
	pickDefaultWorkflowLabel,
	collectUpstreamRefs,
	findMissingNodeRefs,
	RUNTIME_REQUIRED_INPUTS,
} from '../../webview/src/features/workflowEditor/comfyHost/stageWorkflowExecutor.js';

suite('stageWorkflowExecutor 异常防御', () => {

	suite('injectWorkflowValues — 防御 apiJson 缺失', () => {

		test('apiJson 为 undefined → 返回空 {applied:0} 而非抛错', () => {
			const r = injectWorkflowValues(undefined, undefined, { prompt: 'hello' });
			assert.deepStrictEqual(r, { prompt: {}, applied: 0 });
		});

		test('apiJson 为 null → 返回空 {applied:0}', () => {
			const r = injectWorkflowValues(null as unknown as undefined, undefined, { prompt: 'hello' });
			assert.deepStrictEqual(r, { prompt: {}, applied: 0 });
		});

		test('apiJson 非对象（string/number） → 返回空 {applied:0}', () => {
			const r1 = injectWorkflowValues('garbage' as unknown as Record<string, unknown>, undefined, {});
			assert.deepStrictEqual(r1, { prompt: {}, applied: 0 });
			const r2 = injectWorkflowValues(42 as unknown as Record<string, unknown>, undefined, {});
			assert.deepStrictEqual(r2, { prompt: {}, applied: 0 });
		});

		test('apiJson 是空对象 {} → 返回空 {applied:0}', () => {
			const r = injectWorkflowValues({}, undefined, { prompt: 'x' });
			assert.deepStrictEqual(r, { prompt: {}, applied: 0 });
		});

		test('正常 apiJson → 应用绑定（保留回归覆盖）', () => {
			const apiJson = {
				'1': { class_type: 'Test', inputs: { prompt: '' } },
				'2': { class_type: 'Other', inputs: {} },
			};
			const bindings = {
				'1': { prompt: { from: 'main_prompt' } },
			};
			const r = injectWorkflowValues(apiJson, bindings, { prompt: 'hello world' });
			assert.strictEqual(r.applied, 1);
			assert.strictEqual(r.prompt['1']?.inputs?.['prompt'], 'hello world');
		});
	});

	suite('extractResultOutputs', () => {

		test('undefined outputs → 返回 undefined（不抛错）', () => {
			assert.strictEqual(extractResultOutputs(undefined as unknown as Record<string, unknown>, '1'), undefined);
		});

		test('空 {} outputs + resultNode → 返回原对象（fallback）', () => {
			const out = {};
			const r = extractResultOutputs(out, 'missing');
			assert.deepStrictEqual(r, out);
		});

		test('resultNode 命中 + outputs 为对象 → 返回该子对象', () => {
			const r = extractResultOutputs({ '1': { images: [{ filename: 'x.png' }] } }, '1');
			assert.deepStrictEqual(r, { images: [{ filename: 'x.png' }] });
		});

		test('单节点 outputs → 返回该子对象', () => {
			const r = extractResultOutputs({ '42': { images: [] } }, undefined);
			assert.deepStrictEqual(r, { images: [] });
		});
	});

	suite('pickDefaultWorkflowLabel', () => {

		test('undefined resp → 返回 undefined', () => {
			assert.strictEqual(pickDefaultWorkflowLabel(undefined, 'image'), undefined);
		});

		test('kind 过滤 + 默认标记优先', () => {
			const resp = {
				workflows: [
					{ label: 'a', kind: 'image', default: false },
					{ label: 'b', kind: 'image', default: true },
					{ label: 'c', kind: 'video', default: true },
				],
			};
			assert.strictEqual(pickDefaultWorkflowLabel(resp, 'image'), 'b');
			assert.strictEqual(pickDefaultWorkflowLabel(resp, undefined), 'b');
			assert.strictEqual(pickDefaultWorkflowLabel(resp, 'video'), 'c');
		});

		test('无 default 时取第一个', () => {
			const resp = { workflows: [{ label: 'first', kind: 'image', default: false }] };
			assert.strictEqual(pickDefaultWorkflowLabel(resp, 'image'), 'first');
		});
	});

	suite('required input 兜底（ComfyTV 自定义节点）', () => {

		test('空字符串 inputs 强制为空（避免 ComfyUI Required input is missing）', () => {
			// 模拟 ComfyTV api_json 节点 "1" 的 inputs：含空字符串 required 字段
			// （如 selected_index/aspect_ratio/project_id/force_run_token 等）。
			const apiJson = {
				'1': {
					class_type: 'ImageStage',
					inputs: {
						main_prompt: '',
						selected_index: '',
						aspect_ratio: '',
						project_id: '',
						force_run_token: '',
						resolution: '',
						custom_params: '',
						batch_size: 0,
						width: 512,
						height: 512,
					},
				},
			};
			// bindings 只覆盖 main_prompt（前端 UI 上的"地方答复"控件）
			const bindings = {
				'1': { main_prompt: { from: 'main_prompt' } },
			};
			const { prompt } = injectWorkflowValues(apiJson, bindings, { prompt: 'hello' });
			// main_prompt 已被 bindings 写入
			assert.strictEqual(prompt['1'].inputs['main_prompt'], 'hello');
			// 其它空字符串字段仍为字符串（注入器不动未绑定键），由调用方后续强制空字符串兜底
			assert.strictEqual(prompt['1'].inputs['selected_index'], '');
			// 数字/数字类不被影响
			assert.strictEqual(prompt['1'].inputs['batch_size'], 0);
		});

		test('RUNTIME_REQUIRED_INPUTS 白名单覆盖全部 ComfyTV 已知 required 字段', () => {
			// 出现新的 "Required input is missing: xxx" 时把 xxx 添到这里。
			const required = [
				'main_prompt', 'selected_index', 'aspect_ratio', 'project_id',
				'force_run_token', 'resolution', 'custom_params', 'batch_size',
				'workflow', 'parent_output_id',
			];
			for (const k of required) {
				assert.ok(k in RUNTIME_REQUIRED_INPUTS, `missing whitelist entry: ${k}`);
			}
		});

		test('补 key 兜底：注入器不动未绑定键，但 RUNTIME_REQUIRED_INPUTS 显式补缺', () => {
			// 关键回归：ComfyUI validate_node_inputs 判定 "Required input is missing"
			// 是 `if x not in inputs`（键缺失）；空串/0 不算 missing，但 keys 缺失就算。
			// 必须主动给 inputs 补上缺失键（不只是改已有键）。
			const apiJson = {
				'1': { class_type: 'ImageStage', inputs: { main_prompt: '' } },
			};
			const { prompt } = injectWorkflowValues(apiJson, undefined, { main_prompt: 'x' });
			// 模拟 runStageWorkflow 兜底逻辑（测试代码单独跑一遍）
			for (const [k, v] of Object.entries(RUNTIME_REQUIRED_INPUTS)) {
				if (!(k in prompt['1'].inputs)) { prompt['1'].inputs[k] = v; }
			}
			// 关键断言：缺失键已被白名单补齐
			assert.ok('selected_index' in prompt['1'].inputs);
			assert.ok('project_id' in prompt['1'].inputs);
			assert.ok('parent_output_id' in prompt['1'].inputs);
			assert.ok('force_run_token' in prompt['1'].inputs);
			assert.ok('aspect_ratio' in prompt['1'].inputs);
			assert.ok('resolution' in prompt['1'].inputs);
			// main_prompt 在 RUNTIME_REQUIRED_INPUTS 里，补齐时应是 ''（不在 values 内时）
			// 本测试只断言补齐行为，不依赖 binding 写入逻辑
			assert.strictEqual(typeof prompt['1'].inputs['main_prompt'], 'string');
		});
	});

	suite('findMissingNodeRefs — 引用完整性校验（HTTP 400 KeyError 前置拦截）', () => {

	test('完整 workflow → 返回空数组', () => {
		const apiJson = {
			'1': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
			'2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
		};
		assert.deepStrictEqual(findMissingNodeRefs(apiJson), []);
	});

	test('SaveImage 引用不存在的节点 → 返回缺失 id（LaMa Erase 场景）', () => {
		// 导出脚本跳过未安装插件的自定义节点（INPAINT_*），但下游 SaveImage 仍引用它。
		const apiJson = {
			'1': { class_type: 'LoadImage', inputs: { image: 'example.png' } },
			'2': { class_type: 'LoadImageMask', inputs: { image: 'example.png', channel: 'alpha' } },
			'6': { class_type: 'SaveImage', inputs: { images: ['5', 0] } },
		};
		assert.deepStrictEqual(findMissingNodeRefs(apiJson), ['5']);
	});

	test('source_size 这类非数字「虚拟节点」引用 → 也判定为缺失', () => {
		// multiview/multiangle/sequence 的 ImageScale.upscale_method 被导出脚本
		// 错误转成 ["source_size", 0]，但 api_json 里没有 source_size 节点。
		const apiJson = {
			'1': { class_type: 'ImageScale', inputs: { image: ['2', 0], upscale_method: ['source_size', 0] } },
			'2': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
		};
		assert.deepStrictEqual(findMissingNodeRefs(apiJson), ['source_size']);
	});

	test('多个缺失节点按数字序排序', () => {
		const apiJson = {
			'1': { class_type: 'A', inputs: { a: ['7', 0], b: ['4', 0], c: ['10', 0] } },
		};
		assert.deepStrictEqual(findMissingNodeRefs(apiJson), ['4', '7', '10']);
	});

	test('非引用 input（字符串/数字/对象）不被误判', () => {
		const apiJson = {
			'1': { class_type: 'KSampler', inputs: { steps: 20, sampler_name: 'euler', seed: ['2', 0] } },
			'2': { class_type: 'Checkpoint', inputs: {} },
		};
		// steps=20（number）、sampler_name="euler"（string）都不是引用；seed=["2",0] 引用存在。
		assert.deepStrictEqual(findMissingNodeRefs(apiJson), []);
	});
});

suite('collectUpstreamRefs — store 为 undefined/null 不抛错', () => {

		test('upstreams 为空 → 返回空', () => {
			const r = collectUpstreamRefs(undefined as unknown as never, undefined);
			assert.deepStrictEqual(r, {});
		});

		test('upstreams 为空数组 → 返回空', () => {
			const r = collectUpstreamRefs(undefined as unknown as never, []);
			assert.deepStrictEqual(r, {});
		});
	});
});