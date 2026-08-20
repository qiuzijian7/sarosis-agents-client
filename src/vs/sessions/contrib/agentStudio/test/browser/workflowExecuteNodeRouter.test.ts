/*---------------------------------------------------------------------------------------------
 *  Unit tests for executeNodeRouter — node execution route classification.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	routeNodeExecution,
	routeLabel,
	validateComfyNodeConfig,
	type RouteNodeLike,
} from '../../common/executeNodeRouter.js';

suite('executeNodeRouter', () => {

	suite('routeNodeExecution', () => {

		test('saros types route to saros executor（裸小写）', () => {
			for (const t of ['start', 'end', 'task', 'prompt', 'agent', 'skill', 'tool', 'ifElse', 'switch', 'askUser', 'group']) {
				assert.strictEqual(routeNodeExecution({ type: t }), 'saros', `type ${t}`);
			}
		});

		test('★ Saros.* 全名同样路由到 saros（P1 全名化后的画布真实形态）', () => {
			// 不归一化前缀时全名节点会落到 'unknown' → 编排节点被静默跳过执行。
			for (const t of ['Saros.Start', 'Saros.End', 'Saros.Task', 'Saros.Prompt', 'Saros.Agent',
				'Saros.Skill', 'Saros.Tool', 'Saros.IfElse', 'Saros.Switch', 'Saros.AskUser', 'Saros.Group']) {
				assert.strictEqual(routeNodeExecution({ type: t }), 'saros', `type ${t}`);
			}
		});

		test('ComfyTV.* → comfyStage', () => {
			assert.strictEqual(routeNodeExecution({ type: 'ComfyTV.ImageStage' }), 'comfyStage');
			assert.strictEqual(routeNodeExecution({ type: 'comfyStage' }), 'comfyStage');
		});

		test('comfy node stage mode → comfyStage', () => {
			const n: RouteNodeLike = { type: 'comfy', data: { comfy: { mode: 'stage' } } };
			assert.strictEqual(routeNodeExecution(n), 'comfyStage');
		});

		test('comfy node workflow mode → comfyNative', () => {
			const n: RouteNodeLike = { type: 'comfy', data: { comfy: { mode: 'workflow' } } };
			assert.strictEqual(routeNodeExecution(n), 'comfyNative');
		});

		test('comfy node without mode defaults to comfyNative', () => {
			assert.strictEqual(routeNodeExecution({ type: 'comfy' }), 'comfyNative');
		});

		test('unnamespaced native node types → comfyNative', () => {
			assert.strictEqual(routeNodeExecution({ type: 'KSampler' }), 'comfyNative');
			assert.strictEqual(routeNodeExecution({ type: 'LoadImage' }), 'comfyNative');
		});

		test('unknown namespaced types → unknown', () => {
			assert.strictEqual(routeNodeExecution({ type: 'Something.Else' }), 'unknown');
			assert.strictEqual(routeNodeExecution({ type: '' }), 'unknown');
		});
	});

	suite('routeLabel', () => {

		test('labels all routes', () => {
			assert.match(routeLabel('saros'), /Saros/);
			assert.match(routeLabel('comfyStage'), /stage/);
			assert.match(routeLabel('comfyNative'), /原生/);
			assert.match(routeLabel('unknown'), /未注册/);
		});
	});

	suite('validateComfyNodeConfig', () => {

		test('stage mode missing stageClass flagged', () => {
			const n: RouteNodeLike = { type: 'comfy', data: { comfy: { mode: 'stage' } } };
			const issues = validateComfyNodeConfig(n);
			assert.ok(issues.some(i => i.includes('stageClass')));
		});

		test('stage mode with stageClass passes', () => {
			const n: RouteNodeLike = { type: 'comfy', data: { comfy: { mode: 'stage', stageClass: 'ComfyTV.ImageStage' } } };
			assert.deepStrictEqual(validateComfyNodeConfig(n), []);
		});

		test('workflow mode missing workflowId flagged', () => {
			const n: RouteNodeLike = { type: 'comfy', data: { comfy: { mode: 'workflow' } } };
			const issues = validateComfyNodeConfig(n);
			assert.ok(issues.some(i => i.includes('workflowId')));
		});

		test('workflow mode with workflowId passes', () => {
			const n: RouteNodeLike = { type: 'comfy', data: { comfy: { mode: 'workflow', workflowId: 'wf-img' } } };
			assert.deepStrictEqual(validateComfyNodeConfig(n), []);
		});

		test('non-comfy types produce no issues', () => {
			assert.deepStrictEqual(validateComfyNodeConfig({ type: 'agent' }), []);
		});
	});
});
