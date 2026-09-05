/*---------------------------------------------------------------------------------------------
 *  visual/runtime — 工作流「最小真实测试环境」的**宿主无关**内核。
 *
 *  两套设施（Node mocha / 浏览器 visual）共用这一份：
 *    - Node   : `createSandbox({ mode: 'node' })`    → 只 `run()`（无 DOM）
 *    - 浏览器 : `createSandbox({ mode: 'browser', mountImpl })` → `mount()` + `run()`
 *
 *  ★★ 三条铁律（踩过才知道）：
 *    1. **动态 import 必须字面量路径**。`import(SOME_VAR)` 或模板串 → esbuild 静态
 *       解析不了 → 原样保留到运行时 → bundle 落在临时目录 → ERR_MODULE_NOT_FOUND。
 *    2. **bridge mock 必须先于任何 workflowEditor 模块 import**——nodeCard.tsx 顶层就
 *       解构 `globalThis.__vssarosBridge`（模块求值即抛错）。
 *    3. **本文件绝不 import `nodeCard.tsx`**（.tsx）。Node 侧 runner 的 esbuild 插件只
 *       解析 `.js → .ts`，且把 nodeCard 打进 bundle 会拖进 react。渲染能力一律经
 *       `mountImpl` 由浏览器侧注入（`runtimeDom.ts`）。
 *--------------------------------------------------------------------------------------------*/

import { installBridgeMock, type BridgeMode } from './bridgeStub.mjs';

type AnyRec = Record<string, unknown>;

/** 执行结果（`runNodeOrStage` 的返回，各执行器形状一致的最小公共面）。 */
export interface SandboxRunResult {
	promptId?: string;
	status: string;
	error?: string;
	entries?: unknown[];
	durationMs?: number;
}

/** 浏览器侧注入的渲染实现（见 runtimeDom.ts）。 */
export type SandboxMountImpl = (
	host: HTMLElement,
	ctx: SandboxContext,
	type: string,
	nodeId: string,
) => Promise<{ unmount: () => void; meta: unknown }>;

/** mount/run 共用的上下文（注入给 mountImpl，避免循环依赖）。 */
export interface SandboxContext {
	mode: BridgeMode;
	registry: AnyRec;
	store: AnyRec;
	cardState: AnyRec;
	getSpec(type: string): AnyRec | undefined;
}

export interface SandboxOptions {
	mode?: BridgeMode;
	/** 浏览器渲染实现；不传则 `sandbox.mount` 不可用。 */
	mountImpl?: SandboxMountImpl;
	/**
	 * 是否让 runner 异常**原样抛出**（默认 false → 收敛为 `status:'error'`）。
	 * 扫描发现 223 个节点里 `ComfyTV.MultiPanelStoryboardStage` 是唯一让 runner
	 * 异常冒泡的（其余都自行 catch）。默认收敛，保证测试稳定。
	 */
	strictThrow?: boolean;
	/** runner.invoke 的确定性返回；默认抛错（模拟无后端）。 */
	invoke?: () => Promise<AnyRec>;
}

/** 图里的一个节点声明（测试用，等价于画布上「新建节点」）。 */
export interface GraphNodeSpec {
	id: string;
	type: string;
	values?: AnyRec;
}

/** 一条连线（等价于画布上「拖拽连线」）。 */
export interface GraphEdge {
	from: string;
	to: string;
	fromPort?: string;
}

export interface GraphNodeResult {
	id: string;
	type: string;
	status: string;
	error?: string;
	entries?: unknown[];
	durationMs: number;
	/** 实际传入的上游节点 id —— 联动是否接通，全看这个。 */
	upstreams: string[];
}

export interface GraphRunReport {
	ok: boolean;
	/** 拓扑序（实际执行顺序）。 */
	order: string[];
	nodes: GraphNodeResult[];
	durationMs: number;
	/** 图级错误：未知节点 / 环 / 边指向不存在的节点。 */
	error?: string;
}

export interface Sandbox extends SandboxContext {
	specs: AnyRec[];
	runner: AnyRec;
	/**
	 * 执行单个节点，并把结果状态写回 cardState（驱动 UI）。
	 * `upstreams` 为上游节点 id 列表——**联动的关键**：执行器据此从 store 读上游快照。
	 */
	run(type: string, values?: AnyRec, nodeId?: string, upstreams?: string[]): Promise<SandboxRunResult>;
	/** 渲染节点卡片（需 `mountImpl`）。 */
	mount(host: HTMLElement, type: string, nodeId?: string): Promise<{ unmount: () => void; meta: unknown }>;
	/** 按拓扑序执行整张图（多节点 + 上下游联动）。 */
	runGraph(graph: { nodes: GraphNodeSpec[]; edges?: GraphEdge[] }): Promise<GraphRunReport>;
}

/**
 * 拓扑排序（Kahn）。返回 null 表示有环。
 * ★ 沙箱里的图是测试声明的，环属于**用例写错**，应当显式报错而不是静默跳过。
 */
function topoSort(ids: string[], edges: GraphEdge[]): string[] | null {
	const indeg = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const id of ids) { indeg.set(id, 0); adj.set(id, []); }
	for (const e of edges) {
		if (!indeg.has(e.from) || !indeg.has(e.to)) { continue; }
		adj.get(e.from)!.push(e.to);
		indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
	}
	const queue = ids.filter(id => (indeg.get(id) ?? 0) === 0);
	const order: string[] = [];
	while (queue.length) {
		const id = queue.shift()!;
		order.push(id);
		for (const next of adj.get(id) ?? []) {
			const d = (indeg.get(next) ?? 0) - 1;
			indeg.set(next, d);
			if (d === 0) { queue.push(next); }
		}
	}
	return order.length === ids.length ? order : null;
}

/**
 * 建立最小沙箱：装 bridge mock → 注册全部节点 → 建内存快照库 + 卡片状态库。
 */
export async function createSandbox(opts: SandboxOptions = {}): Promise<Sandbox> {
	const mode: BridgeMode = opts.mode ?? 'node';

	// ★ 铁律 2：mock 先行
	if (!(globalThis as unknown as AnyRec).__vssarosBridge) {
		installBridgeMock(mode);
	}

	// ★ 铁律 1：字面量路径的动态 import（esbuild 静态解析）
	const [registry, snapMod, cardStateMod, wr] = await Promise.all([
		import('../src/features/workflowEditor/comfyHost/registry.js'),
		import('../src/features/workflowEditor/comfyHost/mediaSnapshotStore.js'),
		import('../src/features/workflowEditor/comfyHost/cardState.js'),
		import('../src/features/workflowEditor/comfyHost/workflowRun.js'),
	]);

	const reg = registry as unknown as AnyRec;
	if (typeof reg.registerSarosNodes === 'function') { reg.registerSarosNodes(); }
	if (typeof reg.registerDefaultComfyTVStages === 'function') { reg.registerDefaultComfyTVStages(); }

	const store = new (snapMod as unknown as {
		MediaSnapshotStore: new (b: unknown) => AnyRec;
	}).MediaSnapshotStore((snapMod as unknown as { createMemoryBackend(): unknown }).createMemoryBackend());

	const cardState = new (cardStateMod as unknown as {
		CardStateStore: new () => AnyRec;
	}).CardStateStore();

	const runner: AnyRec = {
		id: 'sandbox-fake',
		kind: 'comfy',
		baseUrl: 'http://127.0.0.1:1',
		testConnection: async () => ({ ok: true }),
		invoke: opts.invoke ?? (async () => { throw new Error('sandbox: no backend (fake runner)'); }),
	};

	const getSpec = (type: string) => (reg.getNodeSpec as (t: string) => AnyRec | undefined)(type);
	const specs = (reg.getAllSpecs as () => AnyRec[])();

	const ctx: SandboxContext = { mode, registry: reg, store, cardState, getSpec };

	const setRunState = (nodeId: string, runState: string, errorMsg?: string) => {
		(cardState.set as (id: string, s: unknown) => void)(nodeId, {
			runState, progress: runState === 'running' ? 0 : 100, errorMsg,
		});
	};

	const sandbox: Sandbox = {
		...ctx,
		specs,
		runner,

		async run(type: string, values: AnyRec = {}, nodeId = 'sb-node', upstreams: string[] = []): Promise<SandboxRunResult> {
			setRunState(nodeId, 'running');
			let res: SandboxRunResult;
			try {
				res = await (wr.runNodeOrStage as (i: unknown) => Promise<SandboxRunResult>)({
					runner,
					nodeId,
					type,
					getSpec,
					values,
					store,
					upstreams,
				});
			} catch (e) {
				if (opts.strictThrow) { throw e; }
				// 收敛：个别节点（MultiPanelStoryboardStage）会让 runner 异常冒泡
				res = {
					promptId: '',
					status: 'error',
					error: e instanceof Error ? e.message : String(e),
					entries: [],
				};
			}
			const st = res.status === 'success' ? 'success' : (res.status === 'error' ? 'error' : 'idle');
			setRunState(nodeId, st, res.error);
			return res;
		},

		async mount(host: HTMLElement, type: string, nodeId = 'sb-node') {
			if (!opts.mountImpl) {
				throw new Error('sandbox.mount 需要 mountImpl（浏览器侧 runtimeDom.mountCard）');
			}
			return opts.mountImpl(host, ctx, type, nodeId);
		},

		async runGraph(graph: { nodes: GraphNodeSpec[]; edges?: GraphEdge[] }): Promise<GraphRunReport> {
			const t0 = Date.now();
			const nodes = graph.nodes ?? [];
			const edges = graph.edges ?? [];
			const ids = nodes.map(n => n.id);
			const empty = (error: string): GraphRunReport =>
				({ ok: false, order: [], nodes: [], durationMs: Date.now() - t0, error });

			if (new Set(ids).size !== ids.length) {
				return empty('节点 id 重复：' + ids.join(', '));
			}
			const idSet = new Set(ids);
			for (const e of edges) {
				if (!idSet.has(e.from) || !idSet.has(e.to)) {
					return empty(`连线指向不存在的节点：${e.from} → ${e.to}`);
				}
			}
			const order = topoSort(ids, edges);
			if (!order) { return empty('图中存在环（cycle）'); }

			// 上游索引：to → [from...]
			const upMap = new Map<string, string[]>();
			for (const id of ids) { upMap.set(id, []); }
			for (const e of edges) { upMap.get(e.to)!.push(e.from); }

			const byId = new Map(nodes.map(n => [n.id, n]));
			const results: GraphNodeResult[] = [];
			let failed = false;

			for (const id of order) {
				const n = byId.get(id)!;
				const ups = upMap.get(id) ?? [];
				if (failed) {
					// 与真实执行语义一致：上游失败 → 下游 skipped
					results.push({ id, type: n.type, status: 'skipped',
						error: '上游节点失败', durationMs: 0, upstreams: ups });
					continue;
				}
				const t = Date.now();
				const res = await sandbox.run(n.type, n.values ?? {}, id, ups);
				results.push({
					id, type: n.type, status: res.status, error: res.error,
					entries: res.entries, durationMs: Date.now() - t, upstreams: ups,
				});
				if (res.status === 'error') { failed = true; }
			}

			return {
				ok: results.every(r => r.status === 'success'),
				order,
				nodes: results,
				durationMs: Date.now() - t0,
			};
		},
	};

	return sandbox;
}
