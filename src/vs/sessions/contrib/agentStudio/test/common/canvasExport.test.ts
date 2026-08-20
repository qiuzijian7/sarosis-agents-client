/*---------------------------------------------------------------------------------------------
 *  WF-C4a — M4a 画布→脚本导出测试（实施计划 §2.9 C4.1-C4.6）。
 *  纯生成器 + 导出产物在 WORKER_SOURCE vm 沙箱里真实执行（C4.6：生成器
 *  不自产语法错、agent()/stage() 调用链正确、块作用域不逃逸）。
 *
 *  ★ 铁律：任何「结构化导出」形态（if/else 块、parallel、变量提升）都必须有
 *  **真实执行**用例。曾用 `assert.doesNotThrow(() => { void body; })` 假验证 W2b，
 *  结果分支产物 const 泄漏出块 → 每个含 IfElse 的画布导出必崩，测试全绿。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import vm from 'node:vm';
import { exportCanvasToWorkflowScript } from '../../webview/src/features/workflowEditor/comfyHost/canvasExport.js';
import { WORKER_SOURCE } from '../../browser/workflow/workflowWorkerMain.source.js';

interface TNode { id: string; type: string; data?: { label?: string } }
interface TEdge { source: string; target: string; sourceHandle?: string }

const V = (values: Record<string, unknown>) => () => values;

interface RunR { value?: unknown; stopReason?: string; error?: string }

/**
 * 在 WORKER_SOURCE 沙箱里执行导出脚本。
 * child：默认 prompt 原样回显 `<<prompt>>`；stage：回 `{kind:'media',url:'img://<uid>'}`。
 * ★ `outputByPrompt` 覆写输出文本 —— 导出的 agent() **不带 schema**，所以子代理
 *   结果永远是文本（判定节点要靠脚本侧 asData() 解析），driver 必须复刻这一点。
 */
async function runExported(script: string, opts: { outputByPrompt?: (p: string) => string | undefined } = {}): Promise<RunR> {
	const toHost: Array<Record<string, unknown>> = [];
	let onmsg: ((ev: { data: unknown }) => void) | undefined;
	const self: Record<string, unknown> = {};
	Object.defineProperty(self, 'postMessage', { value: (m: Record<string, unknown>) => { toHost.push(m); } });
	Object.defineProperty(self, 'onmessage', { get: () => onmsg, set: h => { onmsg = h; } });
	vm.runInContext(WORKER_SOURCE, vm.createContext({ self, console, setTimeout, clearTimeout }), { filename: 'w.js' });
	onmsg?.({ data: { type: 'go', init: { meta: { name: 't', description: 'd' }, body: script, args: {}, limits: { maxConcurrentAgents: 4, maxTotalAgents: 20, maxItemsPerCall: 20 } } } });
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		await new Promise(r => setTimeout(r, 5));
		let m: Record<string, unknown> | undefined;
		while ((m = toHost.shift() as Record<string, unknown> | undefined) !== undefined) {
			if (m['type'] === 'result') { return m['result'] as RunR; }
			if (m['type'] === 'child-start') {
				const callId = m['callId'] as number;
				onmsg?.({ data: { type: 'child-started', callId, childId: `c${callId}` } });
				const prompt = (m['request'] as { prompt: string }).prompt;
				const output = opts.outputByPrompt?.(prompt) ?? `<<${prompt.slice(0, 40)}>>`;
				setTimeout(() => {
					onmsg?.({ data: { type: 'child-settled', callId, result: { success: true, output, stopReason: 'completed' } } });
				}, 8);
			} else if (m['type'] === 'child-dispose') {
				onmsg?.({ data: { type: 'child-disposed', callId: m['callId'] as number } });
			} else if (m['type'] === 'stage-run') {
				const req = m['request'] as { stageUid: string };
				onmsg?.({ data: { type: 'stage-run-result', callId: m['callId'] as number, result: { value: { kind: 'media', url: `img://${req.stageUid}` } } } });
			}
		}
	}
	return { stopReason: 'timeout' };
}

suite('canvasExport — 生成器形态 (C4.1-C4.5)', () => {

	test('C4.1 线性链 Prompt→Agent→Agent：语义变量名 + {{input}} 插值', () => {
		const nodes: TNode[] = [
			{ id: 'a', type: 'Saros.Prompt', data: { label: 'Topic' } },
			{ id: 'b', type: 'Saros.Agent', data: { label: 'Analyze' } },
			{ id: 'c', type: 'Saros.Agent', data: { label: 'Summarize' } },
		];
		const edges: TEdge[] = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
		const values: Record<string, Record<string, unknown>> = {
			a: { prompt: '研究主题：多代理' },
			b: { prompt: '分析：{{input}}' },
			c: { prompt: '汇总：{{input}}', agentId: 'code-explorer' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {}, workflowName: 'Linear Demo' });
		assert.strictEqual(r.meta.name, 'linear-demo');
		// ASCII label → lowerCamel 变量名（不再是 n1/n2/n3）
		assert.match(r.script, /const topic = "研究主题：多代理";/);
		assert.match(r.script, /const analyze = await agent\(`分析：\$\{topic\}`/, '{{input}} → 模板插值');
		assert.match(r.script, /agentId: "code-explorer"/);
		assert.match(r.script, /const summarize = await agent\(`汇总：\$\{analyze\}`/);
		// 身份注释：label · type
		assert.match(r.script, /\/\/ Topic · Saros\.Prompt/);
		// return 只含叶子（summarize），不再倾泻中间量
		assert.match(r.script, /return \{ summarize \};/);
		assert.doesNotMatch(r.script, /return \{[^}]*topic/);
		assert.deepStrictEqual(r.warnings, []);
	});

	test('C4.1c Start 输入契约：{{args.key}} → ${args.key} 模板插值', () => {
		// W1：Prompt/Agent 模板用 {{args.key}}（点路径）引用 Start 输入契约。
		// 导出脚本必须转成 ${args.key}（运行时由 executeScript 注入的全局 args 取值），
		// 而非保留成字符串字面量 "{{args.topic}}"（那会导致「prompt 参数没生效」）。
		const nodes: TNode[] = [
			{ id: 'p', type: 'Saros.Prompt', data: { label: 'Topic' } },
			{ id: 'a', type: 'Saros.Agent', data: { label: 'Analyze' } },
		];
		const edges: TEdge[] = [{ source: 'p', target: 'a' }];
		const values: Record<string, Record<string, unknown>> = {
			p: { prompt: '主题：{{args.topic}}，数量：{{args.count}}' },
			a: { prompt: '分析：{{input}}（风格 {{args.style}}）' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		assert.match(r.script, /const topic = `主题：\$\{args\.topic\}，数量：\$\{args\.count\}`;/);
		assert.match(r.script, /const analyze = await agent\(`分析：\$\{topic\}（风格 \$\{args\.style\}）`/);
		// 不得残留未替换的 {{args...}} 占位符
		assert.doesNotMatch(r.script, /\{\{args\./);
	});

	test('C4.1b 非 ASCII label → 类型缩写变量名（text/reply/verdict/image）', () => {
		const nodes: TNode[] = [
			{ id: 'a', type: 'Saros.Prompt', data: { label: '主题设定' } },
			{ id: 'b', type: 'Saros.Agent', data: { label: '构图评审' } },
			{ id: 'c', type: 'Saros.Agent', data: { label: '色彩评审' } },
		];
		const edges: TEdge[] = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
		const values: Record<string, Record<string, unknown>> = {
			a: { prompt: 'T' }, b: { prompt: 'B:{{input}}' }, c: { prompt: 'C:{{input}}' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		assert.match(r.script, /const text = "T";/);
		assert.match(r.script, /const reply = await agent\("?`?B:/);
		assert.match(r.script, /const reply2 = await agent/, '同类第二个 → 序号后缀');
		// 中文 label 仍出现在注释与 agent label 选项里（信息不丢）
		assert.match(r.script, /\/\/ 主题设定 · Saros\.Prompt/);
		assert.match(r.script, /label: "构图评审"/);
	});

	test('C4.2 菱形 A→(B,C)→D：parallel 两分支 + 多上游注释', () => {
		const nodes: TNode[] = [
			{ id: 'a', type: 'Saros.Agent', data: { label: 'Root' } },
			{ id: 'b', type: 'Saros.Agent', data: { label: 'Left' } },
			{ id: 'c', type: 'Saros.Agent', data: { label: 'Right' } },
			{ id: 'd', type: 'Saros.Agent', data: { label: 'Merge' } },
		];
		const edges: TEdge[] = [
			{ source: 'a', target: 'b' }, { source: 'a', target: 'c' },
			{ source: 'b', target: 'd' }, { source: 'c', target: 'd' },
		];
		const values: Record<string, Record<string, unknown>> = {
			a: { prompt: 'A' }, b: { prompt: 'B' }, c: { prompt: 'C' }, d: { prompt: 'D:{{input}}' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		assert.match(r.script, /const \[left, right\] = await parallel\(\[/);
		assert.match(r.script, /\(\) => agent\("B"/);
		assert.match(r.script, /\(\) => agent\("C"/);
		assert.match(r.script, /const merge = await agent\(`D:\$\{left\}`/); // 主上游 = 第一个数据上游
		assert.match(r.script, /← left, right/, '多上游必须补注释（插值只体现主上游）');
		// 自动 phase 分组
		assert.match(r.script, /phase\("并行：Left ‖ Right"\);/);
	});

	test('C4.3 IfElse 判定：点路径 optional-chaining（合法标识符用点号）', () => {
		const nodes: TNode[] = [
			{ id: 'a', type: 'Saros.Agent', data: { label: 'Src' } },
			{ id: 'g', type: 'Saros.IfElse', data: { label: 'Gate' } },
		];
		const edges: TEdge[] = [{ source: 'a', target: 'g' }];
		const values: Record<string, Record<string, unknown>> = {
			a: { prompt: 'A' }, g: { evaluationTarget: 'verdict.ok' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		assert.match(r.script, /const gate = Boolean\(asData\(src\)\?\.verdict\?\.ok\);/);
	});

	test('C4.3b 非法标识符路径段 → 方括号回退', () => {
		const nodes: TNode[] = [
			{ id: 'a', type: 'Saros.Agent', data: { label: 'Src' } },
			{ id: 'g', type: 'Saros.IfElse', data: { label: 'Gate' } },
		];
		const values: Record<string, Record<string, unknown>> = {
			a: { prompt: 'A' }, g: { evaluationTarget: 'meta.needs-redraw' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges: [{ source: 'a', target: 'g' }], getNodeValue: id => values[id] ?? {} });
		assert.match(r.script, /Boolean\(asData\(src\)\?\.meta\?\.\["needs-redraw"\]\)/);
	});

	test('C4.5 媒体节点无画布 uid → null 占位 + warning（fallback 路径）', () => {
		const nodes: TNode[] = [
			{ id: 'm', type: 'ComfyTV.PosterStage', data: { label: 'Poster' } },
			{ id: 'b', type: 'Saros.Agent', data: { label: 'Review' } },
		];
		const edges: TEdge[] = [{ source: 'm', target: 'b' }];
		const values: Record<string, Record<string, unknown>> = { m: {}, b: { prompt: '评图：{{input}}' } };
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		assert.match(r.script, /const poster = null;/);
		assert.match(r.script, /无画布 uid，脚本无法驱动执行/);
		// 占位上游仍可插值（null 传播，模型可改）
		assert.match(r.script, /评图：\$\{poster\}/);
		assert.ok(r.warnings.some(w => /无画布 uid/.test(w)), 'expected a warning about missing stage uid');
		// 无 stage 节点 → 不生成 UID 表
		assert.doesNotMatch(r.script, /const UID = \{/);
	});

	test('C4.9 媒体节点有画布 uid → await stage(UID.x) + 头部 uid 映射表', () => {
		const nodes: TNode[] = [
			{ id: 'img', type: 'ComfyTV.ImageStage', data: { label: '初稿' } },
			{ id: 'b', type: 'Saros.Agent', data: { label: 'Review' } },
		];
		const edges: TEdge[] = [{ source: 'img', target: 'b' }];
		const values: Record<string, Record<string, unknown>> = { img: {}, b: { prompt: '评图：{{input}}' } };
		const uids: Record<string, string> = { img: 'stage-img-abc123' };
		const r = exportCanvasToWorkflowScript({
			nodes, edges,
			getNodeValue: id => values[id] ?? {},
			getStageUid: id => uids[id],
		});
		// uid 收进头部映射表，正文只见 UID.image（换画布只改一处）
		assert.match(r.script, /const UID = \{/);
		assert.match(r.script, /image: "stage-img-abc123",/);
		assert.match(r.script, /const image = await stage\(UID\.image\);/);
		assert.doesNotMatch(r.script, /stage\("stage-img-abc123"\)/, '正文不得出现裸 uid');
		assert.match(r.script, /评图：\$\{image\}/);
		assert.deepStrictEqual(r.warnings, []);
		// displayScript：hooks 说明 + 无参 run() 签名（旧的 run({agent,…}) 会误导成参数注入）
		assert.match(r.displayScript, /stage\(stageUid, over\?\)/);
		assert.match(r.displayScript, /async function run\(\) \{/);
		assert.doesNotMatch(r.displayScript, /run\(\{ agent/);
		assert.match(r.displayScript, /\/\/ 拓扑：/);
	});

	test('缺 prompt 的 Agent → null + warning（fail-loud 进 warnings）', () => {
		const nodes: TNode[] = [{ id: 'a', type: 'Saros.Agent' }];
		const r = exportCanvasToWorkflowScript({ nodes, edges: [], getNodeValue: V({}) });
		assert.match(r.script, /const reply = null;/);
		assert.strictEqual(r.warnings.length, 1);
		assert.match(r.warnings[0], /缺少提示词/);
	});

	test('环 → 抛错（脚本无法表达）', () => {
		const nodes: TNode[] = [{ id: 'a', type: 'Saros.Agent' }, { id: 'b', type: 'Saros.Agent' }];
		const edges: TEdge[] = [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }];
		assert.throws(() => exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: V({ prompt: 'x' }) }), /环/);
	});

	test('C4.7 palette 产出的命名空间类型完整导出：Prompt/Agent/IfElse', () => {
		// ★ P1：palette 已统一产出命名空间 type（'Saros.Prompt'/'Saros.Agent'/…），
		//   旧小写命名由 store.loadWorkflow/addNode 的 normalizeNodeType 迁移。
		//   本用例锁住「palette 三大编排节点都能导出」（曾因命名双轨制静默丢失）。
		const nodes: TNode[] = [
			{ id: 'p', type: 'Saros.Prompt' },
			{ id: 'a', type: 'Saros.Agent' },
			{ id: 'g', type: 'Saros.IfElse' },
		];
		const edges: TEdge[] = [{ source: 'p', target: 'a' }, { source: 'a', target: 'g' }];
		const values: Record<string, Record<string, unknown>> = {
			p: { prompt: '研究主题' },
			a: { prompt: '分析：{{input}}' },
			g: { evaluationTarget: 'verdict.ok' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {}, workflowName: 'namespaced' });
		assert.match(r.script, /const text = "研究主题";/);
		assert.match(r.script, /const reply = await agent\(`分析：\$\{text\}`/);
		assert.match(r.script, /const verdict = Boolean\(asData\(reply\)\?\.verdict\?\.ok\);/);
		assert.deepStrictEqual(r.warnings, []);
	});

	test('C4.8 Saros.Switch 被识别为 gate（不落 media 占位）', () => {
		const nodes: TNode[] = [
			{ id: 'p', type: 'Saros.Prompt' },
			{ id: 's', type: 'Saros.Switch' },
			{ id: 'a', type: 'Saros.Agent' },
		];
		const edges: TEdge[] = [{ source: 'p', target: 's' }, { source: 's', target: 'a' }];
		const values: Record<string, Record<string, unknown>> = {
			p: { prompt: '{"kind":"a"}' },
			s: { evaluationTarget: 'kind' },
			a: { prompt: '分支结果' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		assert.match(r.script, /const verdict = Boolean\(asData\(text\)\?\.kind\);/);
		assert.doesNotMatch(r.script, /无画布 uid/);
	});

	test('C4.10 节点 label 与 hook 同名 → 加 Node 后缀（绝不遮蔽 hook）', () => {
		// label "agent"/"stage" 若直译成变量名，`const agent = …` 之后再调 agent() 直接 TypeError。
		const nodes: TNode[] = [
			{ id: 'a', type: 'Saros.Prompt', data: { label: 'args' } },
			{ id: 'b', type: 'Saros.Agent', data: { label: 'agent' } },
			{ id: 'c', type: 'Saros.Agent', data: { label: 'return' } },
		];
		const edges: TEdge[] = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
		const values: Record<string, Record<string, unknown>> = {
			a: { prompt: 'X' }, b: { prompt: 'B:{{input}}' }, c: { prompt: 'C:{{input}}' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		assert.match(r.script, /const argsNode = "X";/);
		assert.match(r.script, /const agentNode = await agent\(/);
		assert.match(r.script, /const returnNode = await agent\(/);
	});

	test('★ C4.10b 撞 hook 名的产物真实执行（字符串断言看不出遮蔽 → 必须真跑）', async () => {
		// 若变量名直译成 `const agent = …`，则第二个节点调 agent() 会
		// TypeError: agent is not a function —— 只有真实执行能发现。
		const nodes: TNode[] = [
			{ id: 'a', type: 'Saros.Agent', data: { label: 'agent' } },
			{ id: 'b', type: 'Saros.Agent', data: { label: 'stage' } },
			{ id: 'c', type: 'Saros.Agent', data: { label: 'parallel' } },
		];
		const edges: TEdge[] = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
		const values: Record<string, Record<string, unknown>> = {
			a: { prompt: 'A' }, b: { prompt: 'B:{{input}}' }, c: { prompt: 'C:{{input}}' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		const run = await runExported(r.script);
		assert.strictEqual(run.stopReason, 'completed', `撞名产物必须能跑（error=${run.error}）`);
		assert.strictEqual((run.value as { parallelNode: string }).parallelNode, '<<C:<<B:<<A>>>>>>');
	});
});

suite('canvasExport — 行锚点（脚本行 ↔ 画布节点定位）', () => {

	/** 断言 anchors 精确指向 displayScript 的对应行（行号 1-based）。 */
	function assertAnchorsResolve(r: { displayScript: string; anchors: ReadonlyArray<{ line: number; nodeId: string; kind: 'decl' | 'ref' }> }, expect: Record<string, RegExp>): void {
		const rows = r.displayScript.split('\n');
		for (const [nodeId, re] of Object.entries(expect)) {
			const hit = r.anchors.filter(a => a.nodeId === nodeId);
			assert.ok(hit.length > 0, `节点 ${nodeId} 必须有行锚点`);
			// 至少一条锚点指向的行内容匹配（uid 表与语句行都可能指向同一节点）
			const texts = hit.map(a => rows[a.line - 1] ?? '');
			assert.ok(texts.some(t => re.test(t)), `节点 ${nodeId} 的锚点行不匹配 ${re}；实际=${JSON.stringify(texts)}`);
		}
	}

	test('A1 线性链：每条语句行都能反查回节点 id', () => {
		const nodes: TNode[] = [
			{ id: 'p', type: 'Saros.Prompt', data: { label: 'Topic' } },
			{ id: 'a', type: 'Saros.Agent', data: { label: 'Analyze' } },
		];
		const edges: TEdge[] = [{ source: 'p', target: 'a' }];
		const values: Record<string, Record<string, unknown>> = { p: { prompt: 'T' }, a: { prompt: 'A:{{input}}' } };
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		assertAnchorsResolve(r, { p: /const topic = "T";/, a: /const analyze = await agent\(/ });
		// 锚点行号必须落在 displayScript 范围内且单调（便于 UI 二分/滚动）
		const total = r.displayScript.split('\n').length;
		for (const a of r.anchors) { assert.ok(a.line >= 1 && a.line <= total, `行号越界：${a.line}/${total}`); }
	});

	test('A2 parallel 层：thunk 行分别归属各自节点', () => {
		const nodes: TNode[] = [
			{ id: 'a', type: 'Saros.Agent', data: { label: 'Root' } },
			{ id: 'b', type: 'Saros.Agent', data: { label: 'Left' } },
			{ id: 'c', type: 'Saros.Agent', data: { label: 'Right' } },
		];
		const edges: TEdge[] = [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }];
		const values: Record<string, Record<string, unknown>> = {
			a: { prompt: 'A' }, b: { prompt: 'B' }, c: { prompt: 'C' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		assertAnchorsResolve(r, { b: /\(\) => agent\("B"/, c: /\(\) => agent\("C"/ });
	});

	test('A3 分支 + UID 表 + 空行折叠后行号仍精确（锚点不漂移）', () => {
		const nodes: TNode[] = [
			{ id: 'img', type: 'ComfyTV.ImageStage', data: { label: 'Draft' } },
			{ id: 'a', type: 'Saros.Agent', data: { label: 'Verdict' } },
			{ id: 'g', type: 'Saros.IfElse', data: { label: 'NeedsRedraw' } },
			{ id: 't', type: 'Saros.Agent', data: { label: 'Redo' } },
			{ id: 'f', type: 'Saros.Agent', data: { label: 'Ship' } },
		];
		const edges: TEdge[] = [
			{ source: 'img', target: 'a' }, { source: 'a', target: 'g' },
			{ source: 'g', target: 't', sourceHandle: 'true' },
			{ source: 'g', target: 'f', sourceHandle: 'false' },
		];
		const values: Record<string, Record<string, unknown>> = {
			img: {}, a: { prompt: '裁决：{{input}}' }, g: { evaluationTarget: 'ok' },
			t: { prompt: '重做' }, f: { prompt: '发布' },
		};
		const r = exportCanvasToWorkflowScript({
			nodes, edges,
			getNodeValue: id => values[id] ?? {},
			getStageUid: () => 'stage-draft',
		});
		assertAnchorsResolve(r, {
			img: /draft: "stage-draft",|const draft = await stage\(UID\.draft\);/,
			a: /const verdict = await agent\(/,
			g: /if \(needsRedraw\) \{|\} else \{/,
			t: /redo = await agent\(/,
			f: /ship = await agent\(/,
		});
	});

	test('A4 锚点只走带外通道 —— 脚本正文绝不含 @saros-node 注释或裸 nodeId', () => {
		const nodes: TNode[] = [
			{ id: 'node-internal-id-xyz', type: 'Saros.Agent', data: { label: 'Work' } },
		];
		const r = exportCanvasToWorkflowScript({ nodes, edges: [], getNodeValue: V({ prompt: 'P' }) });
		assert.doesNotMatch(r.script, /@saros-node/, '锚点不得写进脚本（污染 LLM token）');
		assert.doesNotMatch(r.script, /node-internal-id-xyz/, '内部 nodeId 不得出现在脚本正文');
		assert.deepStrictEqual(r.anchors.map(a => a.nodeId), ['node-internal-id-xyz']);
	});

	test('A5 kind 区分：声明行 decl / 引用行 ref（反向定位优先 decl）', () => {
		const nodes: TNode[] = [
			{ id: 'img', type: 'ComfyTV.ImageStage', data: { label: 'Draft' } },
			{ id: 'g', type: 'Saros.IfElse', data: { label: 'Gate' } },
			{ id: 't', type: 'Saros.Agent', data: { label: 'Redo' } },
			{ id: 'f', type: 'Saros.Agent', data: { label: 'Ship' } },
		];
		const edges: TEdge[] = [
			{ source: 'img', target: 'g' },
			{ source: 'g', target: 't', sourceHandle: 'true' },
			{ source: 'g', target: 'f', sourceHandle: 'false' },
		];
		const values: Record<string, Record<string, unknown>> = {
			img: {}, g: { evaluationTarget: 'ok' }, t: { prompt: '重做' }, f: { prompt: '发布' },
		};
		const r = exportCanvasToWorkflowScript({
			nodes, edges, getNodeValue: id => values[id] ?? {}, getStageUid: () => 'stage-d',
		});
		const rows = r.displayScript.split('\n');
		const declOf = (id: string) => r.anchors.find(a => a.nodeId === id && a.kind === 'decl');
		// 媒体节点：UID 表行是 ref，语句行是 decl
		assert.match(rows[declOf('img')!.line - 1], /const draft = await stage\(UID\.draft\);/);
		assert.ok(r.anchors.some(a => a.nodeId === 'img' && a.kind === 'ref'), 'UID 表条目应为 ref');
		// gate：Boolean 声明行是 decl，if/else 行是 ref
		assert.match(rows[declOf('g')!.line - 1], /const gate = Boolean\(/);
		const gateRefs = r.anchors.filter(a => a.nodeId === 'g' && a.kind === 'ref');
		assert.strictEqual(gateRefs.length, 2, 'if 行 + else 行各一个 ref');
		for (const ref of gateRefs) { assert.match(rows[ref.line - 1], /if \(gate\) \{|\} else \{/); }
	});
});

suite('canvasExport — 分支结构化导出 (W2b)', () => {

	/** 海报评审画布：Prompt→Stage→[双评审]→裁决→IfElse→(重绘链 | 交付文案)。 */
	function branchCanvas() {
		const nodes: TNode[] = [
			{ id: 'p1', type: 'Saros.Prompt', data: { label: 'Topic' } },
			{ id: 'img1', type: 'ComfyTV.ImageStage', data: { label: 'Draft' } },
			{ id: 'a1', type: 'Saros.Agent', data: { label: 'LayoutReview' } },
			{ id: 'a2', type: 'Saros.Agent', data: { label: 'ColorReview' } },
			{ id: 'a3', type: 'Saros.Agent', data: { label: 'Verdict' } },
			{ id: 'g1', type: 'Saros.IfElse', data: { label: 'NeedsRedraw' } },
			{ id: 'img2', type: 'ComfyTV.ImageStage', data: { label: 'Redraw' } },
			{ id: 'a4', type: 'Saros.Agent', data: { label: 'RedrawNote' } },
			{ id: 'a5', type: 'Saros.Agent', data: { label: 'DeliveryCopy' } },
		];
		const edges: TEdge[] = [
			{ source: 'p1', target: 'img1' },
			{ source: 'img1', target: 'a1' }, { source: 'img1', target: 'a2' },
			{ source: 'a1', target: 'a3' }, { source: 'a2', target: 'a3' },
			{ source: 'a3', target: 'g1' },
			{ source: 'g1', target: 'img2', sourceHandle: 'true' },
			{ source: 'img2', target: 'a4' },
			{ source: 'g1', target: 'a5', sourceHandle: 'false' },
		];
		const values: Record<string, Record<string, unknown>> = {
			p1: { prompt: '赛博朋克海报' },
			img1: {}, img2: {},
			a1: { prompt: '评构图：{{input}}' },
			a2: { prompt: '评色彩：{{input}}' },
			a3: { prompt: '裁决：{{input}}' },
			g1: { evaluationTarget: 'verdict.needsRedraw' },
			a4: { prompt: '说明重绘：{{input}}' },
			a5: { prompt: '交付文案：{{input}}' },
		};
		const uids: Record<string, string> = { img1: 'stage-draft-1', img2: 'stage-redraw-2' };
		return exportCanvasToWorkflowScript({
			nodes, edges,
			getNodeValue: id => values[id] ?? {},
			getStageUid: id => uids[id],
			workflowName: 'Poster Review',
		});
	}

	test('W2b.1 分支产物 let 提升到块外 + if/else 互斥形态', () => {
		const r = branchCanvas();
		// 提升声明（旧形态是块内 const → return 引用即 ReferenceError）
		assert.match(r.script, /^let redraw = null, redrawNote = null, deliveryCopy = null;$/m);
		// if / else 互斥（旧形态是两条独立 if (g) / if (!(g))）
		assert.match(r.script, /if \(needsRedraw\) \{/);
		assert.match(r.script, /\} else \{/);
		assert.doesNotMatch(r.script, /if \(!\(needsRedraw\)\)/);
		// 块内是赋值而非声明
		assert.match(r.script, /^ {2}redraw = await stage\(UID\.redraw\);/m);
		assert.match(r.script, /^ {2}deliveryCopy = await agent\(/m);
		assert.ok(r.warnings.some(w => /if\/else 块内串行/.test(w)));
	});

	test('★ W2b.2 分支画布导出产物真实执行（BUG-1 回归：块作用域逃逸必崩）', async () => {
		const r = branchCanvas();
		const run = await runExported(r.script, {
			// 裁决 agent 无 schema → 返回 JSON **文本**（真实语义）；脚本侧靠 asData 解析
			outputByPrompt: p => p.startsWith('裁决：') ? '{"verdict":{"needsRedraw":true}}' : undefined,
		});
		assert.strictEqual(run.stopReason, 'completed', `分支脚本必须能跑完（error=${run.error}）`);
		const v = run.value as Record<string, unknown>;
		// true 分支命中 → 有值；false 分支未命中 → null（不是 undefined/崩溃）
		assert.ok(typeof v.redrawNote === 'string', 'true 分支产物必须有值');
		assert.strictEqual(v.deliveryCopy, null, '未命中分支产物必须是 null');
	});

	test('★ W2b.3 false 分支命中时对称成立', async () => {
		const r = branchCanvas();
		const run = await runExported(r.script, {
			outputByPrompt: p => p.startsWith('裁决：') ? '{"verdict":{"needsRedraw":false}}' : undefined,
		});
		assert.strictEqual(run.stopReason, 'completed', `error=${run.error}`);
		const v = run.value as Record<string, unknown>;
		assert.strictEqual(v.redrawNote, null);
		assert.ok(typeof v.deliveryCopy === 'string');
	});

	test('★ W2b.3b BUG-3 回归：判定读文本 JSON（agent 无 schema）而非恒 false', () => {
		const r = branchCanvas();
		// 无 asData 时 `verdict?.verdict?.needsRedraw` 对文本上游恒 undefined → IfElse 永走假分支
		assert.match(r.script, /const asData = \(v\) =>/, '需生成文本兜底解析 helper');
		assert.match(r.script, /Boolean\(asData\(verdict\)\?\.verdict\?\.needsRedraw\)/);
	});

	test('★ W2b.4 gate 下游插值穿透 gate 取数据上游（BUG-2 回归）', () => {
		const r = branchCanvas();
		// 交付文案的上游是 gate；插值必须取 gate 的数据上游（裁决结果），
		// 而不是 gate 自己（Boolean → 子代理会收到字符串 "false"）。
		assert.match(r.script, /deliveryCopy = await agent\(`交付文案：\$\{verdict\}`/);
		assert.doesNotMatch(r.script, /交付文案：\$\{needsRedraw\}/, 'gate 的 Boolean 值绝不能作为数据插值');
	});

	test('W2b.5 返回值只含叶子节点（重绘说明 / 交付文案），中间量不倾泻', () => {
		const r = branchCanvas();
		assert.match(r.script, /return \{ redrawNote, deliveryCopy \};/);
		assert.doesNotMatch(r.script, /return \{[^}]*\bdraft\b/);
		assert.doesNotMatch(r.script, /return \{[^}]*\blayoutReview\b/);
	});

	test('W2b.6 头部 UID 表 + 拓扑摘要（含分支树）', () => {
		const r = branchCanvas();
		assert.match(r.script, /draft: "stage-draft-1",/);
		assert.match(r.script, /redraw: "stage-redraw-2",/);
		assert.match(r.displayScript, /\/\/ 拓扑：Topic → Draft → \[LayoutReview ‖ ColorReview\]/);
		assert.match(r.displayScript, /├─ 是 → Redraw → RedrawNote/);
		assert.match(r.displayScript, /└─ 否 → DeliveryCopy/);
	});

	test('W2b.7 嵌套 gate → 回退 verdict 平铺 + warning（不生成错误的嵌套块）', () => {
		const nodes: TNode[] = [
			{ id: 'p', type: 'Saros.Prompt', data: { label: 'Src' } },
			{ id: 'g1', type: 'Saros.IfElse', data: { label: 'Outer' } },
			{ id: 'g2', type: 'Saros.IfElse', data: { label: 'Inner' } },
			{ id: 'a', type: 'Saros.Agent', data: { label: 'Leaf' } },
		];
		const edges: TEdge[] = [
			{ source: 'p', target: 'g1' },
			{ source: 'g1', target: 'g2', sourceHandle: 'true' },
			{ source: 'g2', target: 'a', sourceHandle: 'true' },
		];
		const values: Record<string, Record<string, unknown>> = {
			p: { prompt: '{"ok":true}' }, g1: { evaluationTarget: 'ok' }, g2: { evaluationTarget: 'ok' }, a: { prompt: 'L' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		assert.ok(r.warnings.some(w => /嵌套/.test(w)));
		// 外层 gate 回退平铺（不生成 if 块）；内层 gate 的子树仍可结构化（其子树无 gate）
		assert.doesNotMatch(r.script, /if \(outer\)/, '外层 gate 必须回退 verdict 平铺');
		assert.match(r.script, /const outer = Boolean\(/);
		assert.match(r.script, /const inner = Boolean\(/);
	});

	test('★ W2b.8 嵌套 gate 回退产物真实执行（混合形态：平铺 + 内层 if 块）', async () => {
		const nodes: TNode[] = [
			{ id: 'p', type: 'Saros.Prompt', data: { label: 'Src' } },
			{ id: 'g1', type: 'Saros.IfElse', data: { label: 'Outer' } },
			{ id: 'g2', type: 'Saros.IfElse', data: { label: 'Inner' } },
			{ id: 'a', type: 'Saros.Agent', data: { label: 'Leaf' } },
		];
		const edges: TEdge[] = [
			{ source: 'p', target: 'g1' },
			{ source: 'g1', target: 'g2', sourceHandle: 'true' },
			{ source: 'g2', target: 'a', sourceHandle: 'true' },
		];
		const values: Record<string, Record<string, unknown>> = {
			p: { prompt: '{"ok":true}' }, g1: { evaluationTarget: 'ok' }, g2: { evaluationTarget: 'ok' }, a: { prompt: 'L' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		const run = await runExported(r.script);
		assert.strictEqual(run.stopReason, 'completed', `嵌套回退产物必须能跑（error=${run.error}）`);
		// Prompt 输出 JSON 文本 → asData 解析 → outer/inner 均 true → 内层 if 块命中
		assert.strictEqual((run.value as { leaf: string }).leaf, '<<L>>');
	});
});

suite('canvasExport — C4.6 导出产物真实执行（vm 沙箱）', () => {

	test('C4.6 线性链导出脚本：completed 且变量链正确', async () => {
		const nodes: TNode[] = [
			{ id: 'a', type: 'Saros.Prompt', data: { label: 'Topic' } },
			{ id: 'b', type: 'Saros.Agent', data: { label: 'Analyze' } },
			{ id: 'c', type: 'Saros.Agent', data: { label: 'Summarize' } },
		];
		const edges: TEdge[] = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
		const values: Record<string, Record<string, unknown>> = {
			a: { prompt: 'TOPIC' },
			b: { prompt: '分析：{{input}}' },
			c: { prompt: '汇总：{{input}}' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		const run = await runExported(r.script);
		assert.strictEqual(run.stopReason, 'completed');
		const v = run.value as { summarize: string };
		// 只返回叶子：汇总 = <<汇总：<<分析：TOPIC>>>>
		assert.strictEqual(v.summarize, '<<汇总：<<分析：TOPIC>>>>');
	});

	test('C4.6b 菱形导出脚本：parallel 分支独立完成', async () => {
		const nodes: TNode[] = [
			{ id: 'a', type: 'Saros.Agent', data: { label: 'Root' } },
			{ id: 'b', type: 'Saros.Agent', data: { label: 'Left' } },
			{ id: 'c', type: 'Saros.Agent', data: { label: 'Right' } },
			{ id: 'd', type: 'Saros.Agent', data: { label: 'Merge' } },
		];
		const edges: TEdge[] = [
			{ source: 'a', target: 'b' }, { source: 'a', target: 'c' },
			{ source: 'b', target: 'd' }, { source: 'c', target: 'd' },
		];
		const values: Record<string, Record<string, unknown>> = {
			a: { prompt: 'ROOT' }, b: { prompt: 'B({{input}})' }, c: { prompt: 'C({{input}})' }, d: { prompt: 'D({{input}})' },
		};
		const r = exportCanvasToWorkflowScript({ nodes, edges, getNodeValue: id => values[id] ?? {} });
		const run = await runExported(r.script);
		assert.strictEqual(run.stopReason, 'completed');
		const v = run.value as Record<string, string>;
		// 叶子 = merge；链式回显 ROOT → <<ROOT>> → B(<<ROOT>>) → …
		assert.strictEqual(v.merge, '<<D(<<B(<<ROOT>>)>>)>>');
	});

	test('C4.6c 含 stage 的画布导出脚本真实执行（UID 表 + await stage）', async () => {
		const nodes: TNode[] = [
			{ id: 'img', type: 'ComfyTV.ImageStage', data: { label: 'Draft' } },
			{ id: 'b', type: 'Saros.Agent', data: { label: 'Review' } },
		];
		const edges: TEdge[] = [{ source: 'img', target: 'b' }];
		const values: Record<string, Record<string, unknown>> = { img: {}, b: { prompt: '评图：{{input}}' } };
		const r = exportCanvasToWorkflowScript({
			nodes, edges,
			getNodeValue: id => values[id] ?? {},
			getStageUid: () => 'stage-xyz',
		});
		const run = await runExported(r.script);
		assert.strictEqual(run.stopReason, 'completed', `error=${run.error}`);
		const v = run.value as { review: string };
		// stage 回 {kind:'media',url:'img://stage-xyz'} → 插值成 [object Object]，
		// 关键是 UID.draft 解析正确、stage() 被真实调用、脚本跑通。
		assert.match(v.review, /^<<评图：/);
	});
});
