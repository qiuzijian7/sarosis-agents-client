/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE 能力**执行**的单元测试（读：`getDiagnostics` / `getSelection`；打开类：`openFile` / `reveal` / `showDiff`）。
 *
 * 输入是"已授权"的请求（授权在 `dshIdeAuthorization` 里测），这里钉两件事：
 * ① 读到的/要展示的东西怎么整形（过滤、排序、上限、truncated 如实标注）；
 * ② **打开类能力的策略**——默认不抢焦点、只开工作区内且存在的文件、错误说清是哪一边（left/right）。
 * 策略是这一版最容易"悄悄放宽"的部分，所以逐条写死在测试里。
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { URI } from '../../../../../base/common/uri.js';
import { IMarker, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IIdeActiveSelection, IIdeCapabilityEnv, IIdeDashboardSummary, IDE_CANVAS_ACTION_OPS, IDE_CANVAS_APPLY_OPS_LIMIT, IDE_CANVAS_EDGES_LIMIT, IDE_CANVAS_GENERATE_FLOW_TYPE, IDE_CANVAS_NODES_LIMIT, IDE_CANVAS_OPS_LIMIT, IDE_CANVAS_REVERSE_PROMPT_TYPE, IDE_DIAGNOSTICS_LIMIT, IDE_MINDMAP_EDGES_LIMIT, IDE_MINDMAP_FILE_BYTES_LIMIT, IDE_MINDMAP_NODES_LIMIT, IDE_MINDMAP_TEXT_LIMIT, IDE_REQUEST_EXECUTE_NODE_TIMEOUT_MS, IDE_REQUEST_INSTALL_TIMEOUT_MS, IDE_REQUEST_SLOW_TIMEOUT_MS, IDE_REQUEST_TIMEOUT_MS, IDE_SELECTION_TEXT_LIMIT, buildExecuteNodeRequest, executeIdeCapability, ideFailureSummary, ideRequestTimeoutMs } from '../../common/dshIdeCapabilities.js';

function marker(path: string, severity: MarkerSeverity, line: number, message: string, code?: string): IMarker {
	return {
		owner: 'test', resource: URI.file(path), severity, message,
		...(code === undefined ? {} : { code }),
		startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 2,
	};
}

/** 记录了适配层被怎么调用的假环境：路径里含 `missing` 视为不存在，含 `outside` 视为工作区外。 */
function envOf(options: {
	markers?: IMarker[];
	allMarkers?: IMarker[];
	active?: string;
	selection?: Omit<IIdeActiveSelection, 'resource'> & { resource?: URI };
	resolve?: (path: string) => URI | undefined;
	/** 按 op 给浏览器只读操作的返回值（status / snapshot 文本 / images 对象）。 */
	browserResults?: Record<string, unknown>;
	/** 给画布读取的快照（缺省 = 没有快照，覆盖"还没跑过 canvas_*"这条常态）。 */
	canvas?: { nodes: { label?: string; type?: string; runState?: string; errorMsg?: string }[]; edges?: { source?: string; target?: string }[]; lastOpsSummary?: string[]; updatedAt?: string };
	/**
	 * 用户是否**允许**这次有副作用的动作。**缺省 = 拒绝**——默认拒绝才让"没确认就不许执行"这条
	 * 不变式在每个用例里自动成立（要测"允许后能跑"才显式给 true）。
	 */
	consent?: boolean;
	/** 画布 `apply_ops` 的桥回执（缺省 = 全部成功，逐条给 summary）。 */
	canvasOpsResult?: unknown;
	/** 文本读取的返回值（缺省 `undefined` = 读不到；思维导图用例给一段 JSON）。 */
	fileText?: string;
	/** 文件的字节数（只由 `statFileSize` 提供；给它是为了测"读**之前**就拒掉超大文件"）。 */
	fileBytes?: number;
	/**
	 * `dashboardStats` 能力的输入（缺省 = IDE 侧没有数据 ⇒ 能力应回 `available: false`）。
	 * ⚠ 类型必须与 `IIdeCapabilityEnv.dashboardSummary()` 的返回**同源**（`IIdeDashboardSummary`）：
	 * 少写这个字段会直接让这里 `options.dashboard` 报 TS2339（2026-10-13 修过一次 ✓）。
	 */
	dashboard?: IIdeDashboardSummary;
	/**
	 * `workflow` 的 `executeNode`（comfy 家族）的执行缝返回值（缺省 = 抛错：让"没给就报错"成立）。
	 */
	executeNode?: { output: string; outputs?: Record<string, unknown> };
	/**
	 * `media`（生图）的执行缝返回值（缺省 = **这个 IDE 没接生图** ⇒ 能力层要报人话，
	 * 而不是抛 `undefined is not a function` ✓）。
	 */
	generateImage?: { images: { url?: string; b64?: string }[] };
	/**
	 * 商城清单（`skills` / `mcp` 两条能力，2026-10-21）：缺省 = 空清单；
	 * 给一个函数就能断言"kind / query / limit 传对了"✓。
	 */
	marketList?: (kind: 'skill' | 'mcp', opts: { q?: string; limit: number }) => Promise<{
		items: { id: string; slug: string; name: string; version: string; description: string; author: string; category: string }[];
		total: number;
	}>;
} = {}) {
	const opened: { resource: URI; options: { focus: boolean; selection?: unknown } }[] = [];
	const revealed: URI[] = [];
	const diffs: { left: URI; right: URI; options: { focus: boolean; title?: string } }[] = [];
	const browserOps: { op: string; params?: Record<string, unknown> }[] = [];
	const canvasReads: string[] = [];
	const canvasOps: (readonly Record<string, unknown>[])[] = [];
	const textReads: string[] = [];
	const consents: { title: string; detail: string }[] = [];
	/** 展示类能力（不写数据）：看板定位 / 工作流画布。留成数组，方便那块能力的作者直接断言。 */
	const taskboardFocused: string[] = [];
	const workflowsOpened: string[] = [];
	const workflowNodeRequests: { nodeId: string; nodeType: string; data?: Record<string, unknown>; workflowId?: string; executionId?: string }[] = [];
	const env: IIdeCapabilityEnv = {
		activeResource: () => (options.active ? URI.file(options.active) : undefined),
		// 商城清单（`skills` / `mcp` 两条能力，2026-10-21）：留成可注入的假实现，
		// 便于断言"kind 映射对了、query/limit 传下去了"✓。
		marketList: async (kind, listOptions) => (options.marketList
			? options.marketList(kind, listOptions)
			: { items: [], total: 0 }),
		readMarkers: resource => (resource ? (options.markers ?? []) : (options.allMarkers ?? options.markers ?? [])),
		activeSelection: () => (options.selection ? { resource: options.selection.resource ?? URI.file(options.active ?? 'a.ts'), ...options.selection } : undefined),
		// `unresolvable` 用于测"路径根本解析不出来"；`missing` 是"解析得出来但文件不在"
		resolvePath: options.resolve ?? (path => (/unresolvable/.test(path) ? undefined : URI.file(path))),
		exists: async resource => !/missing/.test(resource.fsPath),
		isInsideWorkspace: resource => !/outside/.test(resource.fsPath),
		openResource: async (resource, openOptions) => { opened.push({ resource, options: openOptions }); },
		revealInExplorer: async resource => { revealed.push(resource); },
		openDiff: async (left, right, diffOptions) => { diffs.push({ left, right, options: diffOptions }); },
		requestActionConsent: async request => {
			consents.push(request);
			return options.consent === true;
		},
		readCanvas: workflowId => {
			canvasReads.push(workflowId);
			return options.canvas;
		},
		applyCanvasOps: async ops => {
			canvasOps.push(ops);
			return options.canvasOpsResult ?? { ok: true, results: ops.map((_, index) => ({ opIndex: index, summary: `op${index} 完成` })) };
		},
		readTextFile: async resource => {
			textReads.push(resource.fsPath);
			return options.fileText;
		},
		statFileSize: async () => options.fileBytes,
		// 展示类（不写任何数据）：打开看板并定位卡片 / 打开工作流画布。
		// 这里只补桩让 `IIdeCapabilityEnv` 完整（该接口新增这两项）——**用例**留给那块能力的作者，
		// 免得两个会话同时往本文件里塞测试（本仓这些文件是未跟踪状态，没有合并机制）。
		// `dashboardStats`（数据面 E 组）：默认"IDE 侧没有数据" ⇒ 能力应回 `available: false` ✓；
		// 要测投影/截断就传 `options.dashboard` ✓（用例留给需要它的那块 ✓）。
		dashboardSummary: () => options.dashboard,
		focusTaskboard: async title => {
			taskboardFocused.push(title);
		},
		openWorkflow: async id => {
			workflowsOpened.push(id);
			return { id, name: `wf:${id}` };
		},
		executeWorkflowNode: async request => {
			workflowNodeRequests.push(request);
			if (!options.executeNode) {
				throw new Error('假环境没有配置 executeNode 返回值');
			}
			return options.executeNode;
		},
		// 生图（`media`）：缺省 = 这个 IDE 没接 ⇒ 能力层自己报"没接生图能力"（可断言 ✓）。
		generateImage: options.generateImage ? async () => options.generateImage! : undefined,
	};
	return { env, opened, revealed, diffs, browserOps, canvasReads, consents, canvasOps, textReads, taskboardFocused, workflowsOpened, workflowNodeRequests };
}

suite('dshHarness / IDE capability execution', () => {

	test('★ 商城清单（skills / mcp）：kind 映射、query/limit 传下去、回执字段扁平（2026-10-21）', async () => {
		// 这两个能力此前**一直是坏的**（授权缺声明 + 执行端缺 case）⇒ 真机只表现为"市场不可用"✗。
		const calls: { kind: string; q?: string; limit: number }[] = [];
		const { env } = envOf({
			marketList: async (kind, opts) => {
				calls.push({ kind, ...(opts.q ? { q: opts.q } : {}), limit: opts.limit });
				return {
					total: 1,
					items: [{ id: 'p1', slug: 'demo', name: '示例包', version: '1.2.3', description: '说明', author: '张三', category: '工具' }],
				};
			},
		});
		// ① capability 'skills' ⇒ kind 'skill'（**单数**：商城那边是 skill 不是 skills）
		const skills = await executeIdeCapability(
			{ capability: 'skills', params: { op: 'marketList', query: 'demo', limit: 5 } }, env
		) as { kind: string; total: number; items: { name: string; version: string }[] };
		assert.strictEqual(calls[0].kind, 'skill', 'skills ⇒ kind=skill（商城接口用单数）');
		assert.strictEqual(calls[0].q, 'demo', 'query 要传下去');
		assert.strictEqual(calls[0].limit, 5, 'limit 要传下去');
		assert.strictEqual(skills.total, 1);
		assert.deepStrictEqual(skills.items[0], {
			id: 'p1', slug: 'demo', name: '示例包', version: '1.2.3', description: '说明', author: '张三', category: '工具',
		}, '回执字段要扁平（dsh 侧工具的 render 直接吃 name/version/description）');

		// ② capability 'mcp' ⇒ kind 'mcp'；limit 缺省 20、越界夹到 [1,100]
		await executeIdeCapability({ capability: 'mcp', params: { op: 'marketList' } }, env);
		assert.strictEqual(calls[1].kind, 'mcp', 'mcp ⇒ kind=mcp');
		assert.strictEqual(calls[1].limit, 20, 'limit 缺省 20');
		await executeIdeCapability({ capability: 'mcp', params: { op: 'marketList', limit: 9999 } }, env);
		assert.strictEqual(calls[2].limit, 100, 'limit 上限 100（与 dsh 侧工具自己的夹取同口径）');

		// ③ 不认识的 op 要报错（不静默忽略）
		await assert.rejects(
			() => executeIdeCapability({ capability: 'skills', params: { op: 'marketInstall' } }, env),
			/op 不认识/,
		);
	});

	test('getDiagnostics：按文件读诊断，字段整形 + 按行列排序 + 严重级用名字', async () => {
		const { env } = envOf({
			active: 'C:/w/a.ts',
			markers: [
				marker('C:/w/a.ts', MarkerSeverity.Error, 12, '少了一个分号', '1005'),
				marker('C:/w/a.ts', MarkerSeverity.Warning, 3, '未使用的变量'),
			],
		});
		const result = await executeIdeCapability({ capability: 'getDiagnostics' }, env) as { count: number; truncated: boolean; items: { severity: string; line: number; code?: string }[] };
		assert.strictEqual(result.count, 2);
		assert.strictEqual(result.truncated, false);
		assert.deepStrictEqual(result.items.map(i => `${i.severity}@${i.line}`), ['warning@3', 'error@12'], '按行号排序（编辑器口径）');
		assert.strictEqual(result.items[1].code, '1005', 'code 要带给模型');
	});

	test('getDiagnostics：minSeverity 支持名字与数值；不认识的写法要报错（不静默忽略）', async () => {
		const { env } = envOf({
			active: 'C:/w/a.ts',
			markers: [
				marker('C:/w/a.ts', MarkerSeverity.Error, 1, 'e'),
				marker('C:/w/a.ts', MarkerSeverity.Warning, 2, 'w'),
				marker('C:/w/a.ts', MarkerSeverity.Info, 3, 'i'),
			],
		});
		const byName = await executeIdeCapability({ capability: 'getDiagnostics', params: { minSeverity: 'warning' } }, env) as { items: unknown[] };
		assert.strictEqual(byName.items.length, 2, 'warning + error');
		const byNumber = await executeIdeCapability({ capability: 'getDiagnostics', params: { minSeverity: MarkerSeverity.Error } }, env) as { items: unknown[] };
		assert.strictEqual(byNumber.items.length, 1, '只有 error');
		await assert.rejects(() => executeIdeCapability({ capability: 'getDiagnostics', params: { minSeverity: 'fatal' } }, env), /minSeverity 不认识：fatal（可用 hint \/ info \/ warning \/ error）/);
	});

	test('getDiagnostics：没有活动编辑器时不报错，而是给"换个用法"的提示', async () => {
		const result = await executeIdeCapability({ capability: 'getDiagnostics' }, envOf({ markers: [] }).env) as { count: number; items: unknown[]; note?: string };
		assert.deepStrictEqual({ count: result.count, items: result.items }, { count: 0, items: [] });
		assert.match(String(result.note), /没有活动编辑器；请传 params\.path/);
	});

	test('getDiagnostics：scope=workspace 时每条带 path，且**超上限要如实标注 truncated**', async () => {
		const many = Array.from({ length: IDE_DIAGNOSTICS_LIMIT + 7 }, (_, i) => marker(`C:/w/f${i}.ts`, MarkerSeverity.Error, i + 1, `e${i}`));
		const result = await executeIdeCapability({ capability: 'getDiagnostics', params: { scope: 'workspace' } }, envOf({ allMarkers: many }).env) as { count: number; truncated: boolean; items: { path?: string }[] };
		assert.strictEqual(result.count, IDE_DIAGNOSTICS_LIMIT + 7, 'count 是"总共有多少"，不是"给了多少"');
		assert.strictEqual(result.items.length, IDE_DIAGNOSTICS_LIMIT);
		assert.strictEqual(result.truncated, true, '被截断必须说我截断了');
		assert.ok(result.items.every(i => typeof i.path === 'string' && i.path.endsWith('.ts')), '工作区口径要带 path（否则不知道是哪个文件）');
	});

	test('getDiagnostics：参数不合法要报得清楚（找不到文件 / scope 写错）', async () => {
		const { env } = envOf({ markers: [] });
		// 注意：带 path 的 getDiagnostics **刻意不查存在性**（不存在的文件 = 0 条诊断，本来就合法）；
		// 解析不出来才是错——而"文件不存在"的拦截属于打开类能力（见下面的 openFile 用例）。
		await assert.rejects(() => executeIdeCapability({ capability: 'getDiagnostics', params: { path: 'unresolvable.ts' } }, env), /找不到文件：unresolvable.ts/);
		await assert.rejects(() => executeIdeCapability({ capability: 'getDiagnostics', params: { scope: 'everything' } }, env), /scope 只能是 file 或 workspace：everything/);
	});

	test('getSelection：选区文本、位置、超上限截断', async () => {
		const { env } = envOf({ active: 'C:/w/a.ts', selection: { text: 'const a = 1;', startLine: 4, startColumn: 1, endLine: 4, endColumn: 13 } });
		const result = await executeIdeCapability({ capability: 'getSelection' }, env) as { resource: string; text: string; length: number; truncated: boolean; isEmpty: boolean; startLine: number };
		// 注意：`URI.file()` 在 Windows 上会把盘符小写化（`c:/w/a.ts`）——断言按大小写无关比
		assert.strictEqual(result.resource.replace(/\\/g, '/').toLowerCase(), 'c:/w/a.ts');
		assert.strictEqual(result.text, 'const a = 1;');
		assert.strictEqual(result.length, 12);
		assert.strictEqual(result.truncated, false);
		assert.strictEqual(result.isEmpty, false);
		assert.strictEqual(result.startLine, 4);

		const huge = 'x'.repeat(IDE_SELECTION_TEXT_LIMIT + 100);
		const truncated = await executeIdeCapability({ capability: 'getSelection' }, envOf({ active: 'a.ts', selection: { text: huge, startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 } }).env) as { text: string; length: number; truncated: boolean };
		assert.strictEqual(truncated.truncated, true);
		assert.strictEqual(truncated.text.length, IDE_SELECTION_TEXT_LIMIT);
		assert.strictEqual(truncated.length, huge.length, 'length 报真实长度（截断不改变"实际有多少"）');
	});

	test('getSelection：没有活动文本编辑器时给空结果 + 说明（不是异常）', async () => {
		const result = await executeIdeCapability({ capability: 'getSelection' }, envOf().env) as { isEmpty: boolean; text: string; note?: string };
		assert.strictEqual(result.isEmpty, true);
		assert.strictEqual(result.text, '');
		assert.match(String(result.note), /没有活动文本编辑器/);
	});

	test('★ 打开类能力**默认不抢焦点**（`focus` 缺省即 false；只有显式 true 才切）', async () => {
		const a = envOf();
		await executeIdeCapability({ capability: 'openFile', params: { path: 'a.ts' } }, a.env);
		const b = envOf();
		await executeIdeCapability({ capability: 'reveal', params: { path: 'a.ts' } }, b.env);
		const c = envOf();
		await executeIdeCapability({ capability: 'showDiff', params: { left: 'a.ts', right: 'b.ts' } }, c.env);
		assert.deepStrictEqual(
			[a.opened[0]?.options.focus, c.diffs[0]?.options.focus],
			[false, false],
			`openFile/showDiff 缺省必须 focus=false（实际 openFile=${a.opened[0]?.options.focus} showDiff=${c.diffs[0]?.options.focus}）`,
		);
		assert.strictEqual(b.revealed.length, 1, 'reveal 走的是资源管理器定位（它没有 focus 概念）');

		const explicit = envOf();
		await executeIdeCapability({ capability: 'openFile', params: { path: 'a.ts', focus: true } }, explicit.env);
		assert.strictEqual(explicit.opened[0]?.options.focus, true, '显式 focus: true 才切焦点');
	});

	test('openFile：行进范围转成 editor selection（startColumn 缺省 1、endLine 缺省 = startLine）', async () => {
		const { env, opened } = envOf();
		const result = await executeIdeCapability({ capability: 'openFile', params: { path: 'a.ts', startLine: 12, endLine: 14 } }, env) as { opened: boolean; focused: boolean; startLine: number; endLine: number };
		assert.strictEqual(result.opened, true);
		assert.strictEqual(result.focused, false);
		assert.deepStrictEqual(opened[0]?.options.selection, { startLineNumber: 12, startColumn: 1, endLineNumber: 14, endColumn: 1 });

		const one = envOf();
		await executeIdeCapability({ capability: 'openFile', params: { path: 'a.ts', startLine: 7 } }, one.env);
		assert.deepStrictEqual(one.opened[0]?.options.selection, { startLineNumber: 7, startColumn: 1, endLineNumber: 7, endColumn: 1 });

		const none = envOf();
		await executeIdeCapability({ capability: 'openFile', params: { path: 'a.ts' } }, none.env);
		assert.strictEqual(none.opened[0]?.options.selection, undefined, '没给行号就不要 selection（别把光标挪到 1:1）');
	});

	test('★ openFile / reveal / showDiff 只开**工作区内且存在**的文件，错误说清是哪一边', async () => {
		const outside = envOf();
		await assert.rejects(() => executeIdeCapability({ capability: 'openFile', params: { path: 'outside/secret.ts' } }, outside.env), /不在工作区内，工具不会打开它/);
		await assert.rejects(() => executeIdeCapability({ capability: 'reveal', params: { path: 'outside/secret.ts' } }, outside.env), /不在工作区内/);
		assert.strictEqual(outside.opened.length + outside.revealed.length, 0, '被拒时不碰编辑器');

		const missing = envOf();
		await assert.rejects(() => executeIdeCapability({ capability: 'openFile', params: { path: 'missing.ts' } }, missing.env), /openFile 不存在：/);
		// 左右要能分辨：不然模型不知道是哪一边错了
		await assert.rejects(() => executeIdeCapability({ capability: 'showDiff', params: { left: 'a.ts', right: 'missing.ts' } }, missing.env), /showDiff 的 right 不存在：/);
		await assert.rejects(() => executeIdeCapability({ capability: 'showDiff', params: { left: 'missing.ts', right: 'a.ts' } }, missing.env), /showDiff 的 left 不存在：/);
		assert.strictEqual(missing.diffs.length, 0, '有一边不合格就不开 diff');
	});

	test('showDiff：两边都在工作区内时开只读对比，title 透传；缺参数要报错', async () => {
		const { env, diffs } = envOf();
		const result = await executeIdeCapability({ capability: 'showDiff', params: { left: 'a.ts', right: 'b.ts', title: '改动前后' } }, env) as { diffed: boolean; focused: boolean };
		assert.strictEqual(result.diffed, true);
		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(diffs[0].options.title, '改动前后');
		await assert.rejects(() => executeIdeCapability({ capability: 'showDiff', params: { left: 'a.ts' } }, env), /showDiff 需要 params\.left 与 params\.right/);
	});

	test('打开类能力：缺参数 / 行号写错要报得清楚', async () => {
		const { env } = envOf();
		await assert.rejects(() => executeIdeCapability({ capability: 'openFile', params: {} }, env), /openFile 需要 params\.path/);
		await assert.rejects(() => executeIdeCapability({ capability: 'reveal', params: { path: '   ' } }, env), /reveal 需要 params\.path/);
		await assert.rejects(() => executeIdeCapability({ capability: 'openFile', params: { path: 'a.ts', startLine: 0 } }, env), /startLine 必须是正整数：0/);
		await assert.rejects(() => executeIdeCapability({ capability: 'openFile', params: { path: 'a.ts', endLine: -3 } }, env), /endLine 必须是正整数：-3/);
	});

	test('★ canvas：只读两个 op 直接放行；apply_ops **必须用户确认**；generate / reverse_prompt 报"尚未实现"', async () => {
		const snapshot = {
			nodes: [
				{ label: '图像-1', type: 'ModelImageGen', runState: 'success', durationMs: 1200 },
				{ label: '放大-1', type: 'Upscale', runState: 'error', errorMsg: '显存不足' },
			],
			edges: [{ source: '图像-1', target: '放大-1' }],
			lastOpsSummary: ['add_node 图像-1', 'connect 图像-1 → 放大-1'],
			updatedAt: '2026-10-10T12:00:00.000Z',
		};
		const state = envOf({ canvas: snapshot });
		const structure = await executeIdeCapability({ capability: 'canvas', params: { op: 'state' } }, state.env) as { nodeCount: number; edgeCount: number; nodes: { label: string; runState?: string }[]; edges: { source: string }[]; truncated: boolean };
		assert.deepStrictEqual({ nodeCount: structure.nodeCount, edgeCount: structure.edgeCount, truncated: structure.truncated }, { nodeCount: 2, edgeCount: 1, truncated: false });
		assert.deepStrictEqual(structure.nodes.map(n => n.label), ['图像-1', '放大-1']);
		assert.strictEqual(structure.nodes[0].runState, undefined, 'state 是**结构**口径：不带运行状态（那是 task_status 的事，与既有工具分工一致）');
		assert.deepStrictEqual(structure.edges, [{ source: '图像-1', target: '放大-1' }]);

		const status = envOf({ canvas: snapshot });
		const task = await executeIdeCapability({ capability: 'canvas', params: { op: 'task_status' } }, status.env) as { nodes: { label: string; runState: string; errorMsg?: string }[]; lastOps: string[] };
		assert.deepStrictEqual(task.nodes.map(n => `${n.label}:${n.runState}`), ['图像-1:success', '放大-1:error']);
		assert.strictEqual(task.nodes[1].errorMsg, '显存不足', '失败原因要带出来（否则模型不知道该修什么）');
		assert.strictEqual(task.lastOps.length, 2);

		// 不认识的 op vs 参数不对：报错要能分辨（前者"写错了"，后者"缺东西"）。
		// `generate` / `reverse_prompt` 现在**实现了**（见下一条用例）——缺必填参数是校验错误。
		const unsupported = envOf({ canvas: snapshot });
		await assert.rejects(() => executeIdeCapability({ capability: 'canvas', params: { op: 'teleport' } }, unsupported.env), /canvas 的 op 不认识：teleport/);
		await assert.rejects(() => executeIdeCapability({ capability: 'canvas', params: { op: 'generate' } }, unsupported.env), /generate 需要 params\.goal/);
		await assert.rejects(() => executeIdeCapability({ capability: 'canvas', params: { op: 'reverse_prompt' } }, unsupported.env), /reverse_prompt 需要 params\.node/);
		assert.deepStrictEqual(unsupported.consents, [], '不认识的 op / 参数没过校验都不该打扰用户');
		assert.deepStrictEqual(unsupported.canvasOps, [], '也不该动画布');
		await assert.rejects(() => executeIdeCapability({ capability: 'canvas' }, unsupported.env), /canvas 需要 params\.op/);

		// ★ apply_ops：**未获允许 ⇒ 一次都不许改画布**
		const batch = [{ op: 'add_node', type: 'Saros.Prompt', label: '提示-1' }, { op: 'connect', source: '提示-1', target: '图像-1' }];
		const denied = envOf({ canvas: snapshot });
		await assert.rejects(() => executeIdeCapability({ capability: 'canvas', params: { op: 'apply_ops', ops: batch } }, denied.env), /用户未允许这次画布修改：apply_ops/);
		assert.strictEqual(denied.consents.length, 1);
		assert.match(denied.consents[0].title, /add_node ×1、connect ×1/, '确认文案要让人看懂"要改什么"');
		assert.deepStrictEqual(denied.canvasOps, [], '未获允许 ⇒ 不该动画布');

		// 参数校验不过 ⇒ 直接报错，**连问都不问**
		const badOps = envOf();
		await assert.rejects(() => executeIdeCapability({ capability: 'canvas', params: { op: 'apply_ops' } }, badOps.env), /apply_ops 需要 params\.ops/);
		await assert.rejects(() => executeIdeCapability({ capability: 'canvas', params: { op: 'apply_ops', ops: [] } }, badOps.env), /非空/);
		await assert.rejects(() => executeIdeCapability({ capability: 'canvas', params: { op: 'apply_ops', ops: [{ op: 'fly' }] } }, badOps.env), /第 0 条的 op 不认识：fly/);
		await assert.rejects(() => executeIdeCapability({ capability: 'canvas', params: { op: 'apply_ops', ops: Array.from({ length: IDE_CANVAS_APPLY_OPS_LIMIT + 1 }, () => ({ op: 'select' })) } }, badOps.env), /一次最多 50 条：收到 51 条/);
		assert.deepStrictEqual(badOps.consents, [], '参数没过校验就不该问用户');
		assert.deepStrictEqual(badOps.canvasOps, []);

		// 允许之后才真改画布；回执带上逐条 summary 与结果图规模
		const approved = envOf({ consent: true, canvas: snapshot, canvasOpsResult: { ok: true, results: [{ opIndex: 0, summary: '已添加 提示-1' }], model: { nodes: [{ id: 'a' }], edges: [] } } });
		const applied = await executeIdeCapability({ capability: 'canvas', params: { op: 'apply_ops', ops: batch } }, approved.env) as { op: string; allowed: boolean; ok: boolean; opCount: number; summaries: string[]; nodeCount: number };
		assert.deepStrictEqual({ op: applied.op, allowed: applied.allowed, ok: applied.ok, opCount: applied.opCount, nodeCount: applied.nodeCount }, { op: 'apply_ops', allowed: true, ok: true, opCount: 2, nodeCount: 1 });
		assert.deepStrictEqual(applied.summaries, ['已添加 提示-1']);
		assert.deepStrictEqual(approved.canvasOps, [batch], '交给桥的是那一批（顺序不变）');

		// 整批失败时：失败下标（0-based，对应调用方传的 ops）+ 原因都要带出来
		const failed = envOf({ consent: true, canvasOpsResult: { ok: false, error: '端口类型不匹配', failedOpIndex: 1, results: [] } });
		const failedResult = await executeIdeCapability({ capability: 'canvas', params: { op: 'apply_ops', ops: batch } }, failed.env) as { ok: boolean; error?: string; failedOpIndex?: number };
		assert.deepStrictEqual({ ok: failedResult.ok, error: failedResult.error, failedOpIndex: failedResult.failedOpIndex }, { ok: false, error: '端口类型不匹配', failedOpIndex: 1 });
	});

	test('★★ canvas：generate / reverse_prompt 与既有画布工具**同一份 op 形状**（先确认、再走那条已有的桥）', async () => {
		// 它们**不需要"在模块内实现"**：既有工具的宿主侧实现也是"发一条 add_node（type 是魔法字串）"，
		// 真正干活的是画布 webview。这里钉的正是那份 op 形状 + 确认纪律。
		const minimal = envOf({ consent: true, canvasOpsResult: { ok: true, results: [{ summary: '已生成 1 条流程' }] } });
		const generated = await executeIdeCapability({ capability: 'canvas', params: { op: 'generate', goal: '  一只戴帽子的猫  ' } }, minimal.env) as { op: string; allowed: boolean; ok: boolean; opCount: number; summaries: string[] };
		assert.deepStrictEqual(minimal.canvasOps, [[{
			op: 'add_node', type: IDE_CANVAS_GENERATE_FLOW_TYPE,
			// `run` / `layout` 与既有工具一致：**恒在**，缺省 false
			data: { goal: '一只戴帽子的猫', run: false, layout: false },
		}]], 'op 形状必须与 canvas_generate 一模一样（goal 去空白）');
		assert.deepStrictEqual({ op: generated.op, allowed: generated.allowed, ok: generated.ok, opCount: generated.opCount }, { op: 'generate', allowed: true, ok: true, opCount: 1 });
		assert.deepStrictEqual(generated.summaries, ['已生成 1 条流程']);
		assert.strictEqual(minimal.consents.length, 1, '有副作用 ⇒ 必须先问人');
		assert.match(minimal.consents[0].title, /生成流程.*一只戴帽子的猫.*只建流程，不执行/);
		assert.match(minimal.consents[0].detail, /`run` 未开/, '不跑就说不跑——用户据此判断要不要点允许');

		// 全参数 + `run:true`：确认文案必须**明确说会真的跑**（耗时/花钱的事不能藏在参数里）
		const full = envOf({ consent: true });
		await executeIdeCapability({ capability: 'canvas', params: { op: 'generate', goal: 'g', variants: [{ prompt: 'a' }, { prompt: 'b' }], negative_prompt: 'blur', size: '512x512', provider_id: 'p1', model_id: 'm1', run: true, layout: true } }, full.env);
		assert.deepStrictEqual(full.canvasOps[0][0], {
			op: 'add_node', type: IDE_CANVAS_GENERATE_FLOW_TYPE,
			data: { goal: 'g', providerId: 'p1', modelId: 'm1', negativePrompt: 'blur', size: '512x512', variants: [{ prompt: 'a' }, { prompt: 'b' }], run: true, layout: true },
		}, 'snake_case 入参 → camelCase 载荷，与既有工具逐字段一致');
		assert.match(full.consents[0].title, /立即执行/);
		assert.match(full.consents[0].detail, /真的跑生成/);

		// reverse_prompt：目标节点同时作为 `op.id` 与 `data.target`（既有工具就是这么发的）
		const reverse = envOf({ consent: true });
		await executeIdeCapability({ capability: 'canvas', params: { op: 'reverse_prompt', node: ' 图像-1 ' } }, reverse.env);
		assert.deepStrictEqual(reverse.canvasOps, [[{ op: 'add_node', type: IDE_CANVAS_REVERSE_PROMPT_TYPE, id: '图像-1', data: { target: '图像-1' } }]]);
		assert.match(reverse.consents[0].title, /反推提示词：图像-1/);

		// ★ 用户拒绝 ⇒ **一条 op 都不发**（"被拒"与"没执行"必须是一回事）
		const denied = envOf();
		await assert.rejects(() => executeIdeCapability({ capability: 'canvas', params: { op: 'generate', goal: 'x' } }, denied.env), /用户未允许这次画布修改：generate/);
		await assert.rejects(() => executeIdeCapability({ capability: 'canvas', params: { op: 'reverse_prompt', node: 'n' } }, denied.env), /用户未允许这次画布修改：reverse_prompt/);
		assert.deepStrictEqual(denied.canvasOps, [], '被拒 ⇒ 不该动画布');
		assert.strictEqual(denied.consents.length, 2, '两条各自问过一次');

		// 校验：明显错的输入**在打扰用户之前**就被挡住
		const bad = envOf({ consent: true });
		await assert.rejects(() => executeIdeCapability({ capability: 'canvas', params: { op: 'generate', goal: 'g', variants: [] } }, bad.env), /variants 必须是非空数组/);
		await assert.rejects(() => executeIdeCapability({ capability: 'canvas', params: { op: 'generate', goal: 'g', run: 'yes' } }, bad.env), /params\.run 必须是布尔/);
		assert.deepStrictEqual(bad.consents, [], '参数没过校验 ⇒ 不打扰用户');
		assert.deepStrictEqual(bad.canvasOps, []);
	});

	test('★ 跨源码一致性：两个魔法 op 类型与字段映射，与 `canvasTools.ts` 里的既有工具逐条对齐', async () => {
		// 这两个字串是**跨进程契约**（dsh → 画布 webview）：上游改名不会编译报错，只会在真机上变成
		// "加了个看不懂的节点"。字段映射（snake_case → camelCase）抄错一个同样是静默失效。
		// 所以直接读那份源码比对——这也是"复用既有实现"这一口径的**可执行证据**。
		const relative = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/canvasTools.ts';
		const source = path.join(process.cwd(), relative);
		if (!fs.existsSync(source)) {
			assert.ok(true, `（跳过：找不到 ${relative}——测试进程的 cwd 不是仓库根）`);
			return;
		}
		const text = fs.readFileSync(source, 'utf8');
		for (const literal of [
			`'${IDE_CANVAS_GENERATE_FLOW_TYPE}'`, `'${IDE_CANVAS_REVERSE_PROMPT_TYPE}'`,
			'goal: args.goal', 'providerId: args.provider_id', 'modelId: args.model_id',
			'negativePrompt: args.negative_prompt', 'size: args.size', 'variants: args.variants',
			'run: wantsRun', 'layout: args.layout === true', 'id: target', 'data: { target }',
		]) {
			assert.ok(text.includes(literal), `canvasTools.ts 里找不到 \`${literal}\` ⇒ dsh 侧那份映射已与上游脱钩`);
		}
	});

	test('canvas：还没跑过 canvas_* 时是 **available:false + 说明**（正常状态，不是异常）；默认 workflowId=default；超上限如实截断', async () => {
		const empty = envOf();
		const missing = await executeIdeCapability({ capability: 'canvas', params: { op: 'state' } }, empty.env) as { available: boolean; workflowId: string; note?: string };
		assert.strictEqual(missing.available, false);
		assert.strictEqual(missing.workflowId, 'default');
		assert.match(String(missing.note), /暂无画布快照/);
		assert.deepStrictEqual(empty.canvasReads, ['default']);

		const many = {
			nodes: Array.from({ length: IDE_CANVAS_NODES_LIMIT + 5 }, (_, i) => ({ label: `n${i}`, type: 'T', runState: 'idle' })),
			edges: Array.from({ length: IDE_CANVAS_EDGES_LIMIT + 3 }, (_, i) => ({ source: `s${i}`, target: `t${i}` })),
			lastOpsSummary: Array.from({ length: IDE_CANVAS_OPS_LIMIT + 2 }, (_, i) => `op${i}`),
		};
		const capped = envOf({ canvas: many });
		const structure = await executeIdeCapability({ capability: 'canvas', params: { op: 'state', workflowId: 'wf-1' } }, capped.env) as { nodeCount: number; nodes: unknown[]; edges: unknown[]; truncated: boolean };
		assert.strictEqual(structure.nodeCount, IDE_CANVAS_NODES_LIMIT + 5, 'nodeCount 报真实数量');
		assert.strictEqual(structure.nodes.length, IDE_CANVAS_NODES_LIMIT);
		assert.strictEqual(structure.edges.length, IDE_CANVAS_EDGES_LIMIT);
		assert.strictEqual(structure.truncated, true);
		assert.deepStrictEqual(capped.canvasReads, ['wf-1']);

		const cappedStatus = envOf({ canvas: many });
		const task = await executeIdeCapability({ capability: 'canvas', params: { op: 'task_status' } }, cappedStatus.env) as { lastOps: string[]; truncated: boolean; nodes: unknown[] };
		assert.strictEqual(task.lastOps.length, IDE_CANVAS_OPS_LIMIT);
		assert.strictEqual(task.nodes.length, IDE_CANVAS_NODES_LIMIT);
		assert.strictEqual(task.truncated, true);
	});

	test('★ 渲染侧等待预算按操作语义给（慢操作给足，其余保持默认，真卡住才会早暴露）', () => {
		// **需用户确认的 op 一律慢档**：确认（窗口 60s）发生在能力执行内部，算在同一份预算里。
		// 判据与确认闸共用同一份 op 白名单，所以这里直接遍历白名单——以后新增确认类 op 会自动纳入，
		// 不会再出现"加了 op 忘了改预算"（`type` / `pressKey` / `scroll` / `back` / `reset` 就这么漏过）。
		for (const op of IDE_CANVAS_ACTION_OPS) {
			assert.strictEqual(ideRequestTimeoutMs('canvas', { op }), IDE_REQUEST_SLOW_TIMEOUT_MS, `canvas ${op} 要等用户点头`);
		}
		// ⚠ `browser` 那两档已随该族整体删除（README 4.80）⇒ 本侧只剩 canvas；Host 侧插件的预算由 `dshBrowserPlugin.test.ts` 覆盖。
		for (const [capability, params] of [
			['canvas', { op: 'state' }], ['canvas', { op: 'task_status' }],
			['openFile', { path: 'a.ts' }], ['getDiagnostics', undefined],
		] as [string, Record<string, unknown> | undefined][]) {
			assert.strictEqual(ideRequestTimeoutMs(capability, params), IDE_REQUEST_TIMEOUT_MS, `${capability} 用默认预算`);
		}
	});

	test('★★ mindmap：读活动 `.canvas`（JSON Canvas）→ 整形 + 上限；两个字段名都读（`text` 优先 `content`）', async () => {
		const canvas = JSON.stringify({
			mindmap: true, direction: 'both',
			nodes: [
				{ id: 'n1', type: 'text', x: 0, y: 0, width: 1, height: 1, text: '中心主题' },
				// 旧数据（kbMindmapGenerator）的真实形态：**根本没有 `text` 键**，只有 `content`
				//（注意不是 `text: ''` —— 那表示"这个节点确实没文字"，实现会尊重它）
				{ id: 'n2', type: 'text', x: 1, y: 1, width: 1, height: 1, content: '旧数据用 content' },
			],
			edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2', fromSide: 'right', toSide: 'left', label: '分支' }],
		});
		const env = envOf({ active: 'C:/w/思路.canvas', fileText: canvas });
		const result = await executeIdeCapability({ capability: 'mindmap' }, env.env) as { resource: string; mindmap?: boolean; direction?: string; nodeCount: number; edgeCount: number; truncated: boolean; nodes: { id?: string; text: string }[]; edges: { from: string; to: string; label?: string }[] };
		assert.strictEqual(result.nodeCount, 2);
		assert.strictEqual(result.edgeCount, 1);
		assert.strictEqual(result.truncated, false);
		assert.strictEqual(result.mindmap, true, 'mindmap 标记要透传（调用方据此确认这是思维导图）');
		assert.strictEqual(result.direction, 'both');
		assert.deepStrictEqual(result.nodes.map(n => n.text), ['中心主题', '旧数据用 content'], '`text` 优先，缺了回落到 `content`');
		assert.deepStrictEqual(result.edges, [{ from: 'n1', to: 'n2', label: '分支' }], '边用 from/to 短名（回执越大越贵）');
		assert.deepStrictEqual(env.textReads, [URI.file('C:/w/思路.canvas').fsPath], '读的就是活动编辑器那个资源');

		// 给了 path：走与 openFile 同一条门槛（工作区内 + 存在）后读它
		const byPath = envOf({ fileText: canvas });
		await executeIdeCapability({ capability: 'mindmap', params: { path: 'docs/m.canvas' } }, byPath.env);
		assert.strictEqual(byPath.textReads.length, 1);
		assert.match(byPath.textReads[0].replace(/\\/g, '/').toLowerCase(), /docs\/m\.canvas$/);
	});

	test('★ mindmap：上限 + 单节点文本截断；非 JSON / 缺 nodes / 读不到 / 没活动编辑器都给可读错误', async () => {
		const many = JSON.stringify({
			nodes: Array.from({ length: IDE_MINDMAP_NODES_LIMIT + 3 }, (_, i) => ({ id: `n${i}`, text: 'x'.repeat(IDE_MINDMAP_TEXT_LIMIT + 50) })),
			edges: Array.from({ length: IDE_MINDMAP_EDGES_LIMIT + 2 }, (_, i) => ({ fromNode: `a${i}`, toNode: `b${i}` })),
		});
		const capped = await executeIdeCapability({ capability: 'mindmap' }, envOf({ active: 'm.canvas', fileText: many }).env) as { nodeCount: number; edgeCount: number; truncated: boolean; nodes: { text: string }[]; edges: unknown[] };
		assert.deepStrictEqual({ nodeCount: capped.nodeCount, edgeCount: capped.edgeCount, truncated: capped.truncated }, { nodeCount: IDE_MINDMAP_NODES_LIMIT + 3, edgeCount: IDE_MINDMAP_EDGES_LIMIT + 2, truncated: true });
		assert.strictEqual(capped.nodes.length, IDE_MINDMAP_NODES_LIMIT);
		assert.strictEqual(capped.edges.length, IDE_MINDMAP_EDGES_LIMIT);
		assert.strictEqual(capped.nodes[0].text.length, IDE_MINDMAP_TEXT_LIMIT, '单个节点文本也要截');

		await assert.rejects(() => executeIdeCapability({ capability: 'mindmap' }, envOf({ active: 'm.canvas', fileText: '{ 不是 json' }).env), /mindmap 不是合法 JSON：/);
		await assert.rejects(() => executeIdeCapability({ capability: 'mindmap' }, envOf({ active: 'm.canvas', fileText: '{"edges":[]}' }).env), /不是 JSON Canvas 数据（缺 nodes 数组）/);
		await assert.rejects(() => executeIdeCapability({ capability: 'mindmap' }, envOf({ active: 'm.canvas' }).env), /mindmap 读不到文件：/);
		await assert.rejects(() => executeIdeCapability({ capability: 'mindmap' }, envOf().env), /mindmap 需要 params\.path：没有活动编辑器可推断/);

		// ★ 给了工作区外/不存在的 path ⇒ 直接拒，而且**一次都不许读文件**（门槛在读取之前）
		const guarded = envOf({ fileText: '{"nodes":[]}' });
		await assert.rejects(() => executeIdeCapability({ capability: 'mindmap', params: { path: 'outside/x.canvas' } }, guarded.env), /不在工作区内/);
		await assert.rejects(() => executeIdeCapability({ capability: 'mindmap', params: { path: 'missing.canvas' } }, guarded.env), /不存在/);
		await assert.rejects(() => executeIdeCapability({ capability: 'mindmap', params: { path: 'unresolvable.canvas' } }, guarded.env), /无法解析/);
		assert.deepStrictEqual(guarded.textReads, [], '被拒时不该读任何文件');
	});

	test('★ mindmap 的大小上限：**读之前**按字节数拒掉（`.canvas` 要整个进内存 + `JSON.parse`）', async () => {
		// 这是本能力族里唯一"整文件读进内存"的读，所以上限必须在**读之前**生效——
		// 读回来再拒就只剩"少 parse 一次"，内存已经进去了（用例断言 `textReads` 为空就是钉这一点）。
		const big = envOf({ active: 'big.canvas', fileText: '{"nodes":[]}', fileBytes: IDE_MINDMAP_FILE_BYTES_LIMIT + 1 });
		await assert.rejects(() => executeIdeCapability({ capability: 'mindmap' }, big.env), /mindmap 文件太大：.*字节.*上限/);
		assert.deepStrictEqual(big.textReads, [], '按字节数拒掉时一次都不该读文件');

		// 适配层没实现 `statFileSize` 时的兜底：读回来的**字符数**超上限也要拒（至少别送进 `JSON.parse`）
		const overLong = envOf({ active: 'big.canvas', fileText: `{"nodes":[]}${' '.repeat(IDE_MINDMAP_FILE_BYTES_LIMIT)}` });
		await assert.rejects(() => executeIdeCapability({ capability: 'mindmap' }, overLong.env), /mindmap 文件太大：.*字符/);

		// 边界：**刚好等于**上限要放行（别把比较写成 `>=`）
		const atLimit = envOf({ active: 'ok.canvas', fileText: '{"nodes":[]}', fileBytes: IDE_MINDMAP_FILE_BYTES_LIMIT });
		const parsed = await executeIdeCapability({ capability: 'mindmap' }, atLimit.env) as { nodeCount: number };
		assert.strictEqual(parsed.nodeCount, 0);
	});



	test('unreal 的失败是**返回值**（`ok:false`）不是异常 ⇒ 有可判定的摘要（渲染侧据此留痕）', () => {
		// 渲染侧只在 `catch` 里 warn（`dshHarnessService.ts`），而 unreal 的失败根本不抛 ⇒ 没有这个摘要
		// 就完全没有留痕："模型连不上编辑器"这件事在日志里不可见（README 4.45 记的缺口）。
		assert.strictEqual(ideFailureSummary({ tool: 'dump', ok: true, text: 'x' }), undefined, 'ok:true 不算失败');
		assert.strictEqual(ideFailureSummary('一段普通文本'), undefined, '非对象不算失败');
		assert.strictEqual(ideFailureSummary(undefined), undefined);
		const summary = ideFailureSummary({ tool: 'health', ok: false, text: '[Unreal] unreal_health cannot reach the Unreal bridge at http://…' });
		assert.ok(summary, 'ok:false 必须给出摘要');
		assert.match(summary, /unreal health/, '摘要要带工具名（否则不知道是哪一步）');
		assert.match(summary, /cannot reach/, '摘要要带底层那条文案的头部（否则无法判断失败类型）');
	});


	test('workflow executeNode：comfy 节点 ⇒ 交给执行缝（原样透传 nodeId/nodeType/data，回 output）', async () => {
		const e = envOf({ executeNode: { output: '生成完成', outputs: { image: 'a.png' } } });
		const result = await executeIdeCapability({
			capability: 'workflow',
			params: { op: 'executeNode', workflowId: 'wf-1', executionId: 'e-9', nodeId: 'c1', nodeType: 'ComfyTV.EmojiStage', data: { prompt: '画' } },
		}, e.env) as { ok: boolean; output: string; outputs?: Record<string, unknown> };
		assert.deepStrictEqual(e.workflowNodeRequests, [
			{ workflowId: 'wf-1', executionId: 'e-9', nodeId: 'c1', nodeType: 'ComfyTV.EmojiStage', data: { prompt: '画' } },
		]);
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.output, '生成完成');
		assert.deepStrictEqual(result.outputs, { image: 'a.png' });
	});

	test('workflow executeNode：askUser ⇒ 映射成一次审批（拒绝即 fail-closed，绝不假装答案）', async () => {
		// 默认 consent = 拒绝 ⇒ 必须抛，而不是"空答案往下跑"
		const denied = envOf();
		await assert.rejects(
			() => executeIdeCapability({ capability: 'workflow', params: { op: 'executeNode', nodeId: 'q1', nodeType: 'askUser', data: { question: '继续吗？' } } }, denied.env),
			/askUser 节点 q1 未获用户确认/);
		// 允许 ⇒ 回**首选项**并显式标记（多选/自由文本还没有通道，别偷偷编一个）
		const allowed = envOf({ consent: true });
		const ok = await executeIdeCapability({
			capability: 'workflow',
			params: { op: 'executeNode', nodeId: 'q1', nodeType: 'askUser', data: { question: '选哪个', options: [{ label: '甲' }, '乙'] } },
		}, allowed.env) as { ok: boolean; answer: string; output: string };
		assert.strictEqual(ok.ok, true);
		assert.strictEqual(ok.answer, '甲');
		assert.deepStrictEqual(JSON.parse(ok.output), { __askUser: 1, answer: '甲' });
		assert.match(allowed.consents[0]?.detail ?? '', /选哪个[\s\S]*甲 \/ 乙/);
		// askUser **不该**走到节点执行缝（那是给 comfy 家族用的）
		assert.deepStrictEqual(allowed.workflowNodeRequests, []);
	});

	test('workflow executeNode：缺 nodeId/nodeType ⇒ 明确报错（不猜节点）', async () => {
		await assert.rejects(
			() => executeIdeCapability({ capability: 'workflow', params: { op: 'executeNode', nodeId: 'c1' } }, envOf().env),
			/executeNode 需要 params\.nodeId 与 params\.nodeType/);
	});

	test('workflow executeNode：预算是**专门一档**（真跑 + 可能要等确认，20s/120s 都不够）', () => {
		assert.strictEqual(ideRequestTimeoutMs('workflow', { op: 'executeNode' }), IDE_REQUEST_EXECUTE_NODE_TIMEOUT_MS);
		assert.ok(IDE_REQUEST_EXECUTE_NODE_TIMEOUT_MS > IDE_REQUEST_SLOW_TIMEOUT_MS, '必须比通用慢档更大');
		assert.strictEqual(ideRequestTimeoutMs('workflow', { op: 'open' }), IDE_REQUEST_TIMEOUT_MS, 'open 仍是快档');
	});

	test('buildExecuteNodeRequest：stageClass 用原始 type、内部键不进 values、defaults 兜底', () => {
		const built = buildExecuteNodeRequest({
			nodeId: 'c1', nodeType: 'ComfyTV.EmojiStage',
			data: {
				prompt: '画', fps: 12, bindings: { x: '{{a.output}}' }, defaults: { fps: 8, model: 'm' },
				style: { color: 'red' }, position: { x: 1 }, comfy: { stageClass: 'comfyStage' },
			},
		});
		assert.strictEqual(built.node.data['stageClass'], 'ComfyTV.EmojiStage', '归一化占位名会被 resolveStageClass 过滤 ⇒ 必须填原始 type');
		assert.deepStrictEqual(built.values, { prompt: '画', fps: 12, model: 'm' }, '顶层标量优先、defaults 只兜底、内部键与对象字段不进 values');
		assert.deepStrictEqual(built.defaults, { fps: 8, model: 'm' });
		// 已显式给 stageClass ⇒ **不覆盖**（画布写的是真名，比节点 type 更权威）
		const kept = buildExecuteNodeRequest({ nodeId: 'c2', nodeType: 'comfyStage', data: { stageClass: 'X.Y' } });
		assert.strictEqual(kept.node.data['stageClass'], 'X.Y');
	});

	// ★ 2026-10-20：占位名要**当场拒绝且说清是"占位名"**。放过去的话，`resolveStageClass` 过滤后
	//   只会报「缺少 stageClass」—— 而事实是"有值、值是占位名"，用户按字面补怎么补都不对 ✗。
	test('buildExecuteNodeRequest：归一化占位名（comfy / comfyStage）当场拒绝，错误说明是"占位名"', () => {
		for (const nodeType of ['comfy', 'comfyStage']) {
			assert.throws(
				() => buildExecuteNodeRequest({ nodeId: 'c9', nodeType }),
				new RegExp(`归一化占位名「${nodeType}」`),
				`${nodeType} 必须在执行前被拦住（不能让底层报"缺少 stageClass"）`,
			);
		}
		// 老数据的常见形态：nodeType 是占位名，但 data.stageClass 是真名 ⇒ **放行**
		const rescued = buildExecuteNodeRequest({ nodeId: 'c10', nodeType: 'comfy', data: { stageClass: 'ComfyTV.EmojiStage' } });
		assert.strictEqual(rescued.node.data['stageClass'], 'ComfyTV.EmojiStage');
	});

	// ★ 2026-10-20：**跨端超时预算必须配套**（这条守卫是它的唯一防线）。
	//   两边都是"等对方"的预算：dsh 侧（150s）必须**小于** IDE 侧（180s）—— 让**调用方先放弃**，
	//   这样报出来的是"IDE 没回执"这个真因；反过来则是两边同时超时，无法分辨是谁的问题 ✗。
	//   两处注释里都写了这条契约，但注释拦不住漂移 —— 只有断言能。
	test('executeNode 的等待预算跨端配套：dsh 侧 < IDE 侧，且差距 ≥ 20s', () => {
		const file = path.join(process.cwd(), 'dsh-plugins', 'vssaros-workflow', 'lib', 'index.js');
		assert.ok(fs.existsSync(file), `找不到 ${file} —— 请从**仓库根**运行（runner 的 Usage 里写了）`);
		const source = fs.readFileSync(file, 'utf8');
		const matched = /const EXECUTE_NODE_TIMEOUT_MS = ([\d_]+)/.exec(source);
		assert.ok(matched, 'dsh 侧 EXECUTE_NODE_TIMEOUT_MS 没找到（改名了？两处注释是配套契约，改一处必须改另一处）');
		const dshMs = Number(matched[1].replace(/_/g, ''));
		assert.ok(
			dshMs < IDE_REQUEST_EXECUTE_NODE_TIMEOUT_MS,
			`dsh 侧(${dshMs}ms) 必须小于 IDE 侧(${IDE_REQUEST_EXECUTE_NODE_TIMEOUT_MS}ms)：调用方先放弃，否则两边同时超时无法分辨真因`,
		);
		assert.ok(
			IDE_REQUEST_EXECUTE_NODE_TIMEOUT_MS - dshMs >= 20_000,
			`两端差距至少 20s（给 IDE 侧留收尾时间），实际 ${IDE_REQUEST_EXECUTE_NODE_TIMEOUT_MS - dshMs}ms`,
		);
	});

	test('不认识的能力名必须明确失败（授权过了也不该静默成功）', async () => {
		// 白名单里的能力**现在全部实现了**（`taskboard` / `workflow` 是随包插件清单里新增的两项展示类
		// 能力；`unreal` 已在 3b 删除——那族下移到 Host 的 `dsh-plugins/vssaros-unreal`，README 4.68）
		// ⇒ 这条分支只在"名字不认识"时走到：主进程不会放行它，但执行端也不该静默——报出来才知道协议
		// 两头对上了。
		await assert.rejects(() => executeIdeCapability({ capability: 'teleport' }, envOf().env), /IDE 能力未实现：teleport（已实现：getDiagnostics, getSelection, openFile, reveal, showDiff, canvas, mindmap, taskboard, workflow, media）/);
	});

	test('media 的 generateImage：走 IDE 侧执行缝，回执原样带回（★ 生图能力只有 IDE 进程有 ⇒ 凭据只有一份）', async () => {
		const { env } = envOf({ generateImage: { images: [{ b64: 'AAA' }] } });
		const out = await executeIdeCapability(
			{ capability: 'media', params: { op: 'generateImage', prompt: '画一只猫', modelId: 'm1', numImages: 2 } },
			env,
		) as { ok: boolean; count: number; images: { b64?: string }[] };
		assert.strictEqual(out.ok, true);
		assert.strictEqual(out.count, 1, 'count = 实际拿到的图数（不是请求的 numImages）');
		assert.deepStrictEqual(out.images, [{ b64: 'AAA' }], '图原样带回（Host 侧再存进 attachment）');
	});

	test('media 的 generateImage：缺 prompt 要报错；IDE 没接生图能力也要说人话（不许抛 undefined is not a function）', async () => {
		await assert.rejects(
			() => executeIdeCapability({ capability: 'media', params: { op: 'generateImage' } }, envOf({ generateImage: { images: [] } }).env),
			/需要 params\.prompt/,
		);
		await assert.rejects(
			() => executeIdeCapability({ capability: 'media', params: { op: 'generateImage', prompt: 'x' } }, envOf().env),
			/没有接生图能力/,
		);
		await assert.rejects(
			() => executeIdeCapability({ capability: 'media', params: { op: 'generateVideo' } }, envOf({ generateImage: { images: [] } }).env),
			/media 的 op 不认识/,
		);
	});

	test('media 的 editImage：按参考图改图；降级标记必须原样带回（★ 参考图没被采纳要能被上层说出来）', async () => {
	const env = envOf({}).env as any;
	const calls: any[] = [];
	(env as any).editImage = async (params: any) => { calls.push(params); return { images: [{ b64: 'AAA' }], degraded: true, degradedReason: '这个服务不支持图生图' }; };
	const out = await executeIdeCapability(
		{ capability: 'media', params: { op: 'editImage', prompt: '改成水彩', image: 'data:image/png;base64,AAAA' } },
		env,
	) as { op: string; ok: boolean; count: number; images: unknown[]; degraded?: boolean; degradedReason?: string };
	assert.strictEqual(out.op, 'editImage');
	assert.strictEqual(out.ok, true);
	assert.strictEqual(out.count, 1);
	assert.strictEqual(out.degraded, true, '降级标记必须带上来（否则上层会把「重新生成」当成「按参考图改了」而骗用户）');
	assert.match(String(out.degradedReason), /不支持图生图/);
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].image, 'data:image/png;base64,AAAA', '参考图要原样传给执行缝');
});

test('media 的 editImage：缺参考图要报错；IDE 没接图生图能力要说人话', async () => {
	const env = envOf({}).env as any;
	(env as any).editImage = async () => ({ images: [{ b64: 'AAA' }] });
	await assert.rejects(
		() => executeIdeCapability({ capability: 'media', params: { op: 'editImage', prompt: 'x' } }, env),
		/需要 params\.image/,
	);
	const bare = envOf({}).env;
	await assert.rejects(
		() => executeIdeCapability({ capability: 'media', params: { op: 'editImage', prompt: 'x', image: 'data:image/png;base64,AA' } }, bare),
		/没有接图生图能力/,
	);
});
test('media 的 capabilities：返回 IDE 侧的能力表（provider/模型/档位）；没接就报错', async () => {
	// ★ 2026-10-21（三批⑨）：能力表是"这台 IDE 谁能生图"的真源 ⇒ 由 IDE 暴露，Host 只读。
	const env = envOf({}).env as any;
	(env as any).imageCapabilities = async () => ({
		providers: [{ id: 'prov-a', name: 'A 家', models: [{ id: 'm1' }], qualities: ['standard'] }],
	});
	const out = await executeIdeCapability(
		{ capability: 'media', params: { op: 'capabilities' } },
		env,
	) as { op: string; ok: boolean; providers: unknown[] };
	assert.strictEqual(out.op, 'capabilities');
	assert.strictEqual(out.ok, true);
	assert.strictEqual(out.providers.length, 1, 'provider 清单要原样带回（Host 侧只读不加工）');
	// ⚠ capabilities **不需要 prompt**（查表不该先编个提示词 ✗）—— 用例里没给 prompt 也能过 ✓
	const bare = envOf({}).env;
	await assert.rejects(
		() => executeIdeCapability({ capability: 'media', params: { op: 'capabilities' } }, bare),
		/没有接图像能力表/,
	);
});
test('media 的等待预算必须是慢档（生图几十秒到几分钟 ⇒ 20s 默认预算会误判超时）', () => {
		const media = ideRequestTimeoutMs('media', { op: 'generateImage' });
		assert.ok(media > IDE_REQUEST_SLOW_TIMEOUT_MS, `生图预算(${media}ms) 必须大于慢档(${IDE_REQUEST_SLOW_TIMEOUT_MS}ms)`);
	});

	// ── ★ 2026-10-22：`workbenches.install`（工作台市场的安装按钮）────────────────
	suite('workbenches.install', () => {
		const base = { op: 'install', name: 'dsh-deck-workbench', version: '1.0.13', title: '演示动画工作台', source: 'github-release', dir: 'C:/data/market/packages/dsh-deck-workbench-1.0.13' };
		const withInstaller = (consent: boolean, result = { ok: true, changed: true, version: '1.0.13' }) => {
			const made = envOf({ consent });
			const calls: { dir?: string; spec?: string; name: string }[] = [];
			(made.env as any).installWorkbenchPackage = async (req: { dir?: string; spec?: string; name: string }) => { calls.push(req); return result; };
			// ★ 2026-10-22 真机：安装确认走原生框（confirmUserAction），**不许**再走 Host 审批服务（界面点击没有回合 ⇒ 当场被拒）
			const approvalCalls: unknown[] = [];
			(made.env as any).requestActionConsent = async (req: unknown) => { approvalCalls.push(req); return true; };
			(made.env as any).confirmUserAction = async (req: { title: string; detail: string }) => { made.consents.push(req); return consent; };
			return { ...made, calls, approvalCalls };
		};
		test('★ 安装确认走原生确认框，不走 Host 审批服务（真机：后者当场被拒，点安装没反应）', async () => {
			const { env, approvalCalls, consents } = withInstaller(true) as any;
			await executeIdeCapability({ capability: 'workbenches', params: base }, env);
			assert.strictEqual(approvalCalls.length, 0, '不许调用 requestActionConsent');
			assert.strictEqual(consents.length, 1, '必须调用 confirmUserAction 一次');
			const bare = envOf({ consent: true }).env as any;
			bare.installWorkbenchPackage = async () => ({ ok: true, changed: true });
			await assert.rejects(() => executeIdeCapability({ capability: 'workbenches', params: base }, bare), /confirmUserAction 缺失/, '没有确认框 ⇒ fail-closed');
		});
		test('ideFailureSummary：非 unreal 回执按 op 标注并带 error 原因（真机日志曾是 "unreal ? 判定失败：" + 空）', () => {
			assert.strictEqual(ideFailureSummary({ op: 'install', ok: false, declined: true, error: '用户取消了安装' }), 'install 判定失败：用户取消了安装');
			assert.match(ideFailureSummary({ ok: false }) ?? '', /回执没有原因/);
		});
		test('先问用户；拒绝 ⇒ 不装（fail-closed），回执 declined', async () => {
			const { env, calls, consents } = withInstaller(false) as any;
			const out = await executeIdeCapability({ capability: 'workbenches', params: base }, env) as { ok: boolean; declined?: boolean };
			assert.strictEqual(out.ok, false);
			assert.strictEqual(out.declined, true);
			assert.strictEqual(calls.length, 0, '没确认就不许装');
			assert.strictEqual(consents.length, 1);
			assert.match(consents[0].title, /演示动画工作台/);
			assert.match(consents[0].detail, /dsh-deck-workbench@1\.0\.13/);
			assert.match(consents[0].detail, /完整权限/, '确认框必须讲清服务端的权限');
		});
		test('同意 ⇒ 按目录装，回执带版本与 restartRequired', async () => {
			const { env, calls } = withInstaller(true);
			const out = await executeIdeCapability({ capability: 'workbenches', params: base }, env) as { ok: boolean; version: string; restartRequired: boolean };
			assert.deepStrictEqual(calls, [{ dir: base.dir, name: base.name }]);
			assert.strictEqual(out.ok, true);
			assert.strictEqual(out.version, '1.0.13');
			assert.strictEqual(out.restartRequired, true);
		});
		test('装上的版本与目录不一致 ⇒ ok:false', async () => {
			const { env } = withInstaller(true, { ok: true, changed: true, version: '9.9.9' });
			const out = await executeIdeCapability({ capability: 'workbenches', params: base }, env) as { ok: boolean; error: string };
			assert.strictEqual(out.ok, false);
			assert.match(out.error, /9\.9\.9/);
		});
		test('参数校验：包名 / dir 与 spec 二选一 / spec 只收锁版本形态 / dir 必须绝对路径', async () => {
			const { env } = withInstaller(true);
			const bad: Array<[Record<string, unknown>, RegExp]> = [
				[{ ...base, name: '../evil' }, /包名不合法/],
				[{ ...base, spec: 'x@1' }, /二选一|之一/],
				[{ ...base, dir: undefined }, /二选一|之一/],
				[{ ...base, dir: undefined, spec: 'github:o/r#main' }, /锁死 commit/],
				[{ ...base, dir: undefined, spec: 'other-pkg@1.0.13' }, /只收/],
				[{ ...base, dir: 'relative/path' }, /绝对路径/],
				[{ ...base, version: undefined }, /version/],
				[{ ...base, op: 'uninstall' }, /op 不认识/],
			];
			for (const [params, re] of bad) {
				await assert.rejects(() => executeIdeCapability({ capability: 'workbenches', params }, env), re, JSON.stringify(params));
			}
			// 合法的两种 spec
			for (const spec of [`${base.name}@${base.version}`, 'github:sara2398/xiaohongshu-note-workbench#60e0de77c58f92e6319212df33ad2ece53898726']) {
				const out = await executeIdeCapability({ capability: 'workbenches', params: { ...base, dir: undefined, spec } }, env) as { ok: boolean };
				assert.strictEqual(out.ok, true, spec);
			}
		});
		test('确认框列出服务端能力审计：有清单逐条列；空清单说没发现；null 说看不到代码', async () => {
			const cases: Array<[unknown, RegExp]> = [
				[['启动子进程（可执行任意本机程序）', '向 AI 注册工具（模型可以调用它）'], /静态扫描到[\s\S]*启动子进程[\s\S]*注册工具/],
				[[], /没发现启动进程/],
				[null, /看不到这个包的代码/],
			];
			for (const [capabilities, re] of cases) {
				const { env, consents } = withInstaller(false) as any;
				await executeIdeCapability({ capability: 'workbenches', params: { ...base, capabilities } }, env);
				assert.match(consents[0].detail, re, JSON.stringify(capabilities));
			}
		});
		test('IDE 没接安装通道 ⇒ 报人话', async () => {
			const env = envOf({ consent: true }).env;
			await assert.rejects(() => executeIdeCapability({ capability: 'workbenches', params: base }, env), /没有接工作台安装通道/);
		});
		test('等待预算：不短于确认窗口 + 装包上限', () => {
			assert.strictEqual(ideRequestTimeoutMs('workbenches', { op: 'install' }), IDE_REQUEST_INSTALL_TIMEOUT_MS);
			assert.ok(IDE_REQUEST_INSTALL_TIMEOUT_MS >= 6 * 60 * 1000);
		});
	});
});
