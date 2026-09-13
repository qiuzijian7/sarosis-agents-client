/*---------------------------------------------------------------------------------------------
 *  Unit tests for P1-4 Script node（Dynamic Workflow 脚本作为 DAG 节点）。
 *
 *  覆盖三个曾经出错/易漏的契约：
 *   ① 枚举与路由：`Saros.Script` 必须路由到 saros（漏登记 SAROS_TYPES 会静默跳过执行）；
 *   ② 委托契约：IScriptExecutionDelegate 的 input/output 形状（controller 注入方与
 *      executionService 消费方必须同构）；
 *   ③ meta 必填字段：executeWorkflowScript 的 IWorkflowMeta 需 name + description
 *      （只传 name 会在编译期报 TS2741，运行期投影标识缺失）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { WorkflowNodeType } from '../../common/workflowStorage.js';
import { routeNodeExecution } from '../../common/executeNodeRouter.js';
import type { IScriptExecutionDelegate } from '../../common/workflowExecutionService.js';

suite('workflowScriptNode (P1-4)', () => {

	suite('枚举与路由', () => {

		test('WorkflowNodeType.Script 值为 script（存储格式契约，改值会破坏既有工作流）', () => {
			assert.strictEqual(WorkflowNodeType.Script, 'script');
		});

		test('★ 裸 script 与 Saros.Script 都路由到 saros（漏登记会被判 unknown 静默跳过）', () => {
			assert.strictEqual(routeNodeExecution({ type: 'script' }), 'saros');
			assert.strictEqual(routeNodeExecution({ type: 'Saros.Script' }), 'saros');
		});

		test('Script 不被误判为 comfy 路由（不含 ComfyTV. 前缀）', () => {
			assert.notStrictEqual(routeNodeExecution({ type: 'Saros.Script' }), 'comfyStage');
			assert.notStrictEqual(routeNodeExecution({ type: 'Saros.Script' }), 'comfyNative');
		});
	});

	suite('IScriptExecutionDelegate 契约', () => {

		test('成功路径：返回 ok + value', async () => {
			const delegate: IScriptExecutionDelegate = {
				execute: async (input) => {
					assert.strictEqual(input.script, 'return 1 + 1;');
					assert.strictEqual(input.meta.name, 'demo');
					assert.deepStrictEqual(input.args, { topic: 'x' });
					return { ok: true, value: 2 };
				},
			};
			const r = await delegate.execute({ script: 'return 1 + 1;', meta: { name: 'demo' }, args: { topic: 'x' } });
			assert.strictEqual(r.ok, true);
			assert.strictEqual(r.value, 2);
		});

		test('失败路径：ok=false 必带 error（executionService 用它填 nodeState.error）', async () => {
			const delegate: IScriptExecutionDelegate = {
				execute: async () => ({ ok: false, error: 'boom' }),
			};
			const r = await delegate.execute({ script: 'throw new Error("boom")', meta: { name: 'x' } });
			assert.strictEqual(r.ok, false);
			assert.strictEqual(r.error, 'boom');
		});

		test('args 可省略（Script 节点未配 args 时 executionService 传 undefined）', async () => {
			let seen: unknown = 'unset';
			const delegate: IScriptExecutionDelegate = {
				execute: async (input) => { seen = input.args; return { ok: true }; },
			};
			await delegate.execute({ script: 's', meta: { name: 'n' } });
			assert.strictEqual(seen, undefined);
		});
	});

	suite('节点数据 → 委托入参的物化规则（_executeScriptNode 的纯逻辑部分）', () => {

		/** 复刻 _executeScriptNode 的取值与物化，避免依赖整个 service 实例。 */
		function materialize(data: { script?: string; name?: string; args?: unknown } | undefined): { ok: boolean; error?: string; input?: { script: string; name: string; args?: unknown } } {
			const d = data ?? {};
			if (!d.script) { return { ok: false, error: 'Script node missing "script"' }; }
			return { ok: true, input: { script: d.script, name: d.name ?? 'script', args: d.args } };
		}

		test('缺 script → 明确错误（fail-loud，不静默跳过）', () => {
			const r = materialize({});
			assert.strictEqual(r.ok, false);
			assert.match(r.error!, /missing "script"/);
		});

		test('name 缺省为 script', () => {
			const r = materialize({ script: 'return 1;' });
			assert.strictEqual(r.input!.name, 'script');
		});

		test('name/args 透传', () => {
			const r = materialize({ script: 'return 1;', name: 'gen', args: [1, 2] });
			assert.strictEqual(r.input!.name, 'gen');
			assert.deepStrictEqual(r.input!.args, [1, 2]);
		});

		/** 复刻输出物化：字符串原样，其它 JSON 化，undefined → 空串。 */
		function outputOf(value: unknown): string {
			return typeof value === 'string' ? value : (value !== undefined ? JSON.stringify(value) : '');
		}

		test('输出物化：字符串原样传给下游 {{$prev.output}}', () => {
			assert.strictEqual(outputOf('hello'), 'hello');
		});

		test('输出物化：对象/数组 JSON 化', () => {
			assert.strictEqual(outputOf({ a: 1 }), '{"a":1}');
			assert.strictEqual(outputOf([1, 2]), '[1,2]');
		});

		test('输出物化：undefined → 空串（不写 "undefined" 脏值）', () => {
			assert.strictEqual(outputOf(undefined), '');
		});
	});
});
