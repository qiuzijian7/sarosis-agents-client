/*---------------------------------------------------------------------------------------------
 *  workflowNodeDefinitions.test.ts — 声明式节点定义（defineNode / defineNodeRuntime）护栏。
 *
 *  背景（2026-09-07 框架，P0-2「执行路径合一」）：
 *    `runNodeOrStage` 分发首位查 `getNodeDefinition(type)`，命中即执行；未命中则落到
 *    硬编码分支 / 末尾 `runSingleNode`。因此 **type 拼错 = 静默走错路径**，编译期无感。
 *
 *  真实事故（nodeDefinition.ts 注释记录）：`gateNode.ts` 曾把 type 写成不存在的
 *    `'Saros.Gate'`（真名 `Saros.IfElse`/`Saros.Switch`），`loopNode.ts` 漏了
 *    `Saros.Parallel` → 查表未命中 → 拿 ComfyUI runner 执行编排节点（runner 为 null
 *    时崩、非 null 时报 node-not-found），只在真跑控制流时炸。
 *
 *  ★ 本文件为该护栏补上**测试覆盖**（此前 `findMissingRuntimeDefinitions()` /
 *    `REQUIRED_RUNTIME_NODE_TYPES` 零测试 —— 护栏存在但没人调用它）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
// ★ 副作用导入：逐行 import 各节点定义文件 → 触发 defineNode / defineNodeRuntime 注册。
//   与运行时求值序一致（workflowRun.ts 注释：「必须先于 runNodeOrStage 首次调用执行」）。
import '../../webview/src/features/workflowEditor/comfyHost/nodes/index.js';
import {
	getRegisteredDefinitionTypes,
	getAllNodeDefinitions,
	getNodeDefinition,
	findMissingRuntimeDefinitions,
	REQUIRED_RUNTIME_NODE_TYPES,
} from '../../webview/src/features/workflowEditor/comfyHost/nodeDefinition.js';
import {
	getNodeSpec,
	getAllSpecs,
	registerDefaultComfyTVStages,
} from '../../webview/src/features/workflowEditor/comfyHost/registry.js';
// 行为验证用：runNodeOrStage 即「合一后的唯一分发入口」。
import { runNodeOrStage } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { PROVIDER_PICKER_PREFIX } from '../../webview/src/features/workflowEditor/comfyHost/workflowRunShared.js';
import { loadPlugin, unloadPlugin } from '../../webview/src/features/workflowEditor/comfyHost/pluginLoader.js';
import { PROMPT_NODE_KEY } from '../../webview/src/features/workflowEditor/comfyHost/nodeExecutor.js';

// ★ 画布初始化序（与 LiteGraphCanvas / canvasHost / WorkflowEditorPanel 一致）：
//   registry.ts 在**模块作用域**已调用 registerSarosNodes / registerComfyStageNodes /
//   registerToolNodes（导入 registry.js 即生效）；但默认 ComfyTV stage 的 spec 由
//   `registerDefaultComfyTVStages()` **命令式**注册（不在导入副作用里）→ 必须显式调用，
//   否则 `localStageNodes.ts` 收编的 ComfyTV.* 定义会查不到 spec（误报为漂移）。
registerDefaultComfyTVStages();

suite('节点声明式定义 — 完整性护栏', () => {

	test('REQUIRED_RUNTIME_NODE_TYPES 全部已注册执行器', () => {
		// 缺失 → 该类型会静默掉到 runSingleNode（拿 ComfyUI runner 跑编排节点）。
		assert.deepStrictEqual(
			findMissingRuntimeDefinitions(),
			[],
			'编排/控制流节点缺执行器定义 → 会静默走错执行路径',
		);
	});

	/**
	 * 原生 ComfyUI class_type 的声明式收编清单（**无 NodeSpec**，由 /object_info 动态注册，
	 * 见 registryTools.ts 注释「native: ComfyUI native nodes, dynamically registered」）。
	 * 新增原生节点收编时需同步此表 —— 目的是让「多出一个非命名空间类型」必须被显式确认。
	 */
	const NATIVE_DEFINITION_TYPES = new Set(['LoadImage']);
	const NAMESPACED = /^(Saros|ComfyTV)\./;

	test('★ 防漂移：命名空间定义（Saros.* / ComfyTV.*）必须有对应 spec', () => {
		// 比 REQUIRED 清单**更强**的护栏：REQUIRED 只覆盖 12 个编排节点，而
		// 「注册了执行器但 spec 不存在」适用于任何命名空间节点 —— 一旦 type 拼错
		// （如事故中的 'Saros.Gate'），查表会命中该错误定义（执行器被调用），
		// 但画布/registry 里根本没有这个节点类型。
		const missing = getRegisteredDefinitionTypes()
			.filter(t => NAMESPACED.test(t))
			.filter(t => !getNodeSpec(t));
		assert.deepStrictEqual(
			missing,
			[],
			`以下命名空间定义注册了执行器但没有对应 spec（type 拼写漂移）：${missing.join(', ')}`,
		);
	});

	test('★ 非命名空间定义仅限已确认的原生节点', () => {
		const natives = getRegisteredDefinitionTypes().filter(t => !NAMESPACED.test(t));
		assert.deepStrictEqual(
			natives.slice().sort(),
			[...NATIVE_DEFINITION_TYPES].sort(),
			'出现未确认的非命名空间定义类型 —— 若是有意收编原生节点，请同步 NATIVE_DEFINITION_TYPES；否则是 type 拼写漂移',
		);
	});

	test('注册表非空、无空 type、无重复', () => {
		const types = getRegisteredDefinitionTypes();
		assert.ok(types.length >= 20, `应已注册较多定义，实际 ${types.length}`);
		assert.ok(types.every(t => typeof t === 'string' && t.length > 0), '不应出现空 type');
		assert.strictEqual(new Set(types).size, types.length, 'type 不应重复');
		assert.strictEqual(getAllNodeDefinitions().length, types.length, '定义数与 type 数应一致');
	});

	test('控制流节点齐全（IfElse / Switch / Merge / Loop / Parallel）', () => {
		const registered = new Set(getRegisteredDefinitionTypes());
		for (const t of ['Saros.IfElse', 'Saros.Switch', 'Saros.Merge', 'Saros.Loop', 'Saros.Parallel']) {
			assert.ok(REQUIRED_RUNTIME_NODE_TYPES.includes(t), `${t} 应在 REQUIRED_RUNTIME_NODE_TYPES`);
			assert.ok(registered.has(t), `${t} 应有执行器定义`);
		}
	});

	test('REQUIRED 清单不含「无执行器」的纯布局/调度节点', () => {
		// 注释明确排除：Start（无副作用，args 契约由调度器直读）、Group（纯布局容器）、
		// Subflow（执行前被 flattenSubflows 展开，不走单节点分发）。
		for (const t of ['Saros.Start', 'Saros.Group', 'Saros.Subflow']) {
			assert.ok(!REQUIRED_RUNTIME_NODE_TYPES.includes(t), `${t} 不应在 REQUIRED 清单`);
		}
	});

	test('★ provider 类节点（kind=llm / schema+backendKind=provider）必须有声明式定义', () => {
		// 由来（2026-09-11，P0-2 第 2 项）：`runNodeOrStage` 原有硬编码分支
		//   `if (isLLMImageNode(getSpec(type))) { return runProviderImage(input); }`
		// 已随 7 个 provider 类节点**全部收编**而删除。本断言让该前提**持续成立**：
		// 若新增 provider 节点却漏写定义，它会静默掉到兜底 `runSingleNode`
		// （拿 ComfyUI runner 跑纯 RPC 节点 → 崩 / node-not-found）。
		const defs = new Set(getRegisteredDefinitionTypes());
		const providerish = (getAllSpecs() as Array<{ type: string; kind?: string; backendKind?: string }>)
			.filter(s => s.kind === 'llm' || (s.kind === 'schema' && s.backendKind === 'provider'));
		assert.ok(providerish.length > 0, '应能查到 provider 类节点（否则本断言失去意义）');
		const missing = providerish.filter(s => !defs.has(s.type)).map(s => s.type);
		assert.deepStrictEqual(
			missing,
			[],
			`以下 provider 类节点缺声明式定义（会掉到兜底 runSingleNode）：${missing.join(', ')}`,
		);
	});
});

// ── P0-2「执行路径合一」迁移验证：Saros.ProviderPicker ─────────────────────
//   迁移前：runNodeOrStage 里有独立硬编码分支 `if (isProviderPickerNode(type))`。
//   迁移后：由 nodes/providerPickerNode.ts 声明式收编，查表首位命中；分支已删除。
//   本套件锁定「迁移后行为与迁移前等价」，防止后续重构把该节点重新甩回兜底路径
//   （兜底 runSingleNode 会拿 ComfyUI runner 跑本地节点 → 崩或 node-not-found）。
suite('P0-2 迁移 — Saros.ProviderPicker 走声明式分发', () => {

	const makeInput = (over: Record<string, unknown> = {}): any => {
		const puts: any[] = [];
		return {
			nodeId: 'n1',
			type: 'Saros.ProviderPicker',
			values: {},
			getSpec: (t: string) => getNodeSpec(t),
			runner: null,                                   // picker 为本地解析，不使用 ComfyUI runner
			store: { put: (e: any) => puts.push(e), byNode: () => [] },
			__puts: puts,
			...over,
		};
	};

	test('定义已注册（硬编码分支已可删除）', () => {
		const def = getNodeDefinition('Saros.ProviderPicker');
		assert.ok(def, 'Saros.ProviderPicker 应有声明式定义');
		assert.strictEqual(typeof def!.run, 'function', '定义应带执行器');
	});

	test('行为等价：values 齐备 → 输出 TEXT 配置 provider:<id>:<model>', async () => {
		const input = makeInput({ values: { providerId: 'openai', modelId: 'gpt-image-1' } });
		const r = await runNodeOrStage(input);
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(r.entries.length, 1);
		assert.strictEqual(r.entries[0].media.kind, 'text');
		assert.strictEqual(r.entries[0].media.ref, `${PROVIDER_PICKER_PREFIX}openai:gpt-image-1`);
		assert.strictEqual(input.__puts.length, 1, '应写入快照库一次');
	});

	test('行为等价：values 缺失 → 经 resolveImageGenDefaults 兜底', async () => {
		const input = makeInput({
			values: {},
			resolveImageGenDefaults: async () => ({ providerId: 'p2', modelId: 'm2' }),
		});
		const r = await runNodeOrStage(input);
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(r.entries[0].media.ref, `${PROVIDER_PICKER_PREFIX}p2:m2`);
	});

	test('行为等价：无 values 且无兜底 → 明确报错（不静默、不掉兜底路径）', async () => {
		const r = await runNodeOrStage(makeInput({ values: {} }));
		assert.strictEqual(r.status, 'error');
		assert.ok(r.error && r.error.includes('Provider'), `应提示选择 Provider，实际：${r.error}`);
	});
});

// ── 分发链的「通用分支」契约（P0-2 剩余三项，此前无集成测试）────────────────
//   合一后 runNodeOrStage 的完整链路为：
//     ① 声明式定义表命中 → definition.run
//     ② spec.kind==='schema' → runStageWorkflow（不可用则降级 runSingleNode）
//     ③ plugin onRun hook（仅 kind='native' 的插件节点可达）→ ④
//     ④ 兜底 runSingleNode
//   ②③④ 是**通用机制**（按 spec/插件动态判定），不是逐节点硬编码分支；
//   本套件锁定它们的契约，防止后续重构把某条路径改成抛异常或静默跳过。
suite('分发链通用分支（schema / plugin / 兜底）', () => {

	const stubRunner = (onInvoke?: (req: any) => void) => ({
		baseUrl: 'http://stub',
		invoke: async (req: any) => {
			onInvoke?.(req);
			return { status: 'error', promptId: '', error: 'stub' };
		},
	});

	const dispatchInput = (over: Record<string, unknown> = {}): any => ({
		nodeId: 'n1',
		type: 'X',
		values: {},
		getSpec: (t: string) => getNodeSpec(t),
		store: { put: () => { }, byNode: () => [] },
		...over,
	});

	test('未知 type → 兜底 runSingleNode（不抛异常）', async () => {
		let invoked = 0;
		const r = await runNodeOrStage(dispatchInput({
			type: 'Totally.Unknown.Node',
			runner: stubRunner(() => { invoked++; }),
		}));
		assert.strictEqual(invoked, 1, '未知 type 应走兜底 runSingleNode（runner.invoke 调用一次）');
		assert.strictEqual(r.status, 'error');
		assert.ok(Array.isArray(r.entries), '应返回结果形状而非抛出');
	});

	test('★ plugin 节点（kind=native）→ onRun hook 结果并入 values 后再执行', async () => {
		await loadPlugin(
			{ pluginId: 'p02probe', name: 'P02 Probe', version: '1.0.0', scriptURL: 'https://cdn.example.com/p02.js' },
			{
				loadModule: async () => ({
					register: (api: any) => {
						api.defineNode({ name: 'Hooked', onRun: async () => ({ injectedFlag: 'from-hook' }) });
					},
				}),
			},
		);
		// 插件节点注册为 kind='native' → 天然跳过 schema 分支，正确到达 hook。
		assert.strictEqual((getNodeSpec('p02probe:Hooked') as any)?.kind, 'native', '插件节点应为 kind=native');

		let seenPrompt: any = null;
		await runNodeOrStage(dispatchInput({
			type: 'p02probe:Hooked',
			values: { base: 1 },
			runner: stubRunner((req) => { seenPrompt = req.prompt; }),
		}));

		assert.ok(seenPrompt, '应调用 runner.invoke');
		const inputs = seenPrompt[PROMPT_NODE_KEY].inputs;
		assert.strictEqual(inputs.injectedFlag, 'from-hook', 'hook 返回的字段应并入 values');
		assert.strictEqual(inputs.base, 1, '原有 values 应保留');
		unloadPlugin('p02probe');
	});

	test('plugin hook 抛错 → 明确报错且**不**继续调用 backend', async () => {
		await loadPlugin(
			{ pluginId: 'p02boom', name: 'P02 Boom', version: '1.0.0', scriptURL: 'https://cdn.example.com/p02b.js' },
			{
				loadModule: async () => ({
					register: (api: any) => {
						api.defineNode({ name: 'Boom', onRun: async () => { throw new Error('hook 爆炸'); } });
					},
				}),
			},
		);
		let invoked = 0;
		const r = await runNodeOrStage(dispatchInput({
			type: 'p02boom:Boom',
			runner: stubRunner(() => { invoked++; }),
		}));
		assert.strictEqual(r.status, 'error');
		assert.ok(r.error && r.error.includes('插件节点执行失败'), `应报插件执行失败，实际：${r.error}`);
		assert.strictEqual(invoked, 0, 'hook 失败后不应继续调用 backend');
		unloadPlugin('p02boom');
	});

	test('schema 节点：stage workflow 不可用 → 降级 runSingleNode（文档化契约，不抛）', async () => {
		// 取一个「有 schema spec 但未被声明式收编」的节点 —— 正是通用 schema 分支的覆盖对象。
		const defs = new Set(getRegisteredDefinitionTypes());
		const schemaSpec = (getAllSpecs() as any[])
			.find(s => s.kind === 'schema' && !defs.has(s.type));
		assert.ok(schemaSpec, '应存在未收编的 schema 节点（否则本断言失去意义）');

		let invoked = 0;
		const r = await runNodeOrStage(dispatchInput({
			type: schemaSpec.type,
			runner: stubRunner(() => { invoked++; }),
		}));
		assert.strictEqual(invoked, 1, 'stage workflow 不可用时应降级到 runSingleNode（而不是直接失败）');
		assert.strictEqual(r.status, 'error');
		assert.ok(Array.isArray(r.entries), '应返回结果形状而非抛出');
	});
});
