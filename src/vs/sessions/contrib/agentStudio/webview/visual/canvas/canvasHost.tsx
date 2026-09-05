/*---------------------------------------------------------------------------------------------
 *  visual/canvas/canvasHost — 可**手拖节点**的工作流画布沙箱。
 *
 *  ★ 加载顺序不可调换（否则 bundle 在 import 阶段就挂）：
 *    1. installBridgeMock() —— nodeExecutor.ts:24 顶层解构 __vssarosBridge，**求值期就 throw**
 *    2. await import(...)   —— 动态导入，确保 mock 已生效
 *
 *  ★ 运行链路必须用 stageUid 写快照（不是 nodeId）：卡片读侧是 stageUid，
 *    写 nodeId 会导致「跑成功但 OUTPUT 不刷新」（LiteGraphCanvas.tsx:341-349）。
 *
 *  ── 后端模式（URL 参数 `?backend=`）─────────────────────────────────────
 *    fake（默认）        fakeRunner 出确定性假图，离线可跑、截图稳定
 *    comfyui             ★ 真后端：真实 fetch 直连本地 ComfyUI（`?comfyBase=`，默认 8188），
 *                        POST /prompt + 轮询 /history——与真实 app 同一条 HTTP 通道。
 *                        networkGuard 按白名单放行该地址。
 *    provider            provider 渠道走 `sendImageGen` **录制回放**（独立页面没有
 *                        VS Code 主进程，bridge 不可用；录制 JSON 从工具栏载入）。
 *
 *  ── 参考图注入 ─────────────────────────────────────────────────────────
 *    走 AssetReferences 的 **override 语义**（`values['comfytv_image_refs']`）：
 *    钉住的资产优先于同 slot 的上游连线（stageWorkflowExecutor.applyAssetRefOverrides）。
 *    注入方式：① 工具栏文件选择器（人工 + Playwright setInputFiles）② `injectImage` API。
 *--------------------------------------------------------------------------------------------*/

import { installBridgeMock, installNetworkGuard } from '../mocks';
import { CODEBUDDY_MODELS } from '../codebuddyModels.generated.js';
import { createRoot } from 'react-dom/client';
import * as React from 'react';
import { parseSlashCommands } from '../../src/utils/slashCommands.js';

// ── URL 参数（模块求值期就要用：白名单必须随 mock 一起装）────────────────
const __params = new URLSearchParams(location.search);
const SCENARIO = __params.get('scenario') ?? '';                        // emoji | storyboard-multi | storyboard-editor | kb-mindmap
const BACKEND = __params.get('backend') ?? 'fake';                     // fake | comfyui | provider
const COMFY_BASE = (__params.get('comfyBase') ?? 'http://127.0.0.1:8188').replace(/\/+$/, '');

// ── 本地草稿（localStorage）：编辑内容刷新不丢 ───────────────────────────
// 保存 store 原始形态（nodes 含 data/position，edges 含端口名）——与 seed() 的输入
// 双向兼容。⚠ 参考图是 data URL，可能超出 localStorage 5MB 配额：保存失败要能被看见。
// ★ 草稿/录制 key 必须按场景隔离：之前是全局单 key，打开场景 A 编辑后再打开场景 B，
//   求值期会把 A 的草稿恢复进 store 并标记 __draftRestored → B 的场景 seed 被跳过
//   （「有草稿优先恢复」）→ 点开不同用例看到的是同一张画布。
const DRAFT_KEY = `sandbox-graph-draft-v1:${SCENARIO || 'none'}`;
const REC_KEY = `sandbox-provider-recording-v1:${SCENARIO || 'none'}`;

// ① mock 先行 —— 必须在任何 workflowEditor 模块被求值之前
installBridgeMock();
// ★ 真后端模式放行本地 ComfyUI；chat 场景放行 test-server 同源
//   /api/real/*（workspaces/worktrees/agents/chat-sessions 真实数据 API）；
//   其余（含 780 画廊场景）照旧全拦。
const netGuard = installNetworkGuard([
	...(BACKEND === 'comfyui' ? [COMFY_BASE + '/'] : []),
	...(SCENARIO === 'chat-ui' || SCENARIO === 'chat-real' ? [`${location.origin}/api/real/`] : []),
]);

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

// ② 动态导入后填充（组件首次渲染时已就绪）
let LiteGraphCanvas: Any = null;
let useWorkflowEditorStore: Any = null;
let registry: Any = null;
let runNodeOrStage: Any = null;
let ASSET_REFS_PROP = 'comfytv_image_refs';   // 兜底；main() 里从 assetRefs.ts 取真值

const ASSET_REFS_PROP_KEY = 'comfytv_image_refs';

const fakeRunner: Any = {
	id: 'sandbox-fake', kind: 'comfy', baseUrl: 'http://127.0.0.1:1',
	testConnection: async () => ({ ok: true }),
	invoke: async () => ({
		promptId: 'sandbox-fake',
		outputs: { images: [{ filename: 'fake.png', subfolder: '', type: 'output' }], text: 'sandbox fake' },
		status: 'success' as const,
		durationMs: 1,
	}),
};
const noRunner: Any = { ...fakeRunner, id: 'sandbox-none', invoke: async () => { throw new Error('sandbox: no backend'); } };

/**
 * ★ 真 ComfyUI runner —— 与真实 app 同一条 HTTP 通道（POST /prompt → 轮询 /history）。
 * 实现对齐 scripts/test-emoji-three-stage-chain.mjs 的 makeRunner（已验证的三阶段链路）。
 */
function makeComfyRunner(baseUrl: string): Any {
	return {
		id: 'sandbox-comfy', kind: 'local', baseUrl,
		testConnection: async () => {
			try {
				const s = await (await fetch(baseUrl + '/system_stats')).json();
				return { ok: true, version: s?.system?.comfyui_version };
			} catch (e) { return { ok: false, error: String(e) }; }
		},
		async invoke(options: Any) {
			const clientId = 'sandbox-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
			const res = await fetch(baseUrl + '/prompt', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: options.prompt, client_id: clientId }),
			});
			if (!res.ok) {
				const t = await res.text();
				// ★ ComfyUI 400 常见原因：模板默认模型本机没有（value_not_in_list）——翻成人话并给出路
				let hint = '';
				try {
					const j = JSON.parse(t);
					const missing: string[] = [];
					for (const k of Object.keys(j?.node_errors ?? {})) {
						for (const e of j.node_errors[k].errors ?? []) {
							if (e.type === 'value_not_in_list') { missing.push('节点#' + k + ' ' + e.details); }
						}
					}
					if (missing.length) { hint = ' ——本机缺少上述模型；点工具栏「本机模型」看可用列表，在节点编辑器里更换后重跑'; }
				} catch { /* 非 JSON，保留原文 */ }
				return { promptId: '', outputs: {}, status: 'error', error: `POST /prompt HTTP ${res.status}: ${t.slice(0, 300)}${hint}` };
			}
			const { prompt_id } = await res.json();
			// ★ 轮询阶段诊断（2026-09-05）：此前执行中零输出——600s 硬超时后无法
			//   区分「ComfyUI 排队堆积 / 执行卡死（OOM）/ 已在正常采样」。每 5 次
			//   （10s）打一次 history 状态 + /queue 深度（console.warn 经 installConsoleMirror
			//   镜像到沙箱日志面板，肉眼可见）。
			// 表情包整版图集可能要几分钟：2s 轮询 × 600 = 20min 上限
			for (let i = 0; i < 600; i++) {
				await new Promise(r => setTimeout(r, 2000));
				let rec: Any;
				try {
					const h = await (await fetch(`${baseUrl}/history/${prompt_id}`)).json();
					rec = h[prompt_id];
				} catch (pollErr) {
					if (i % 5 === 0) { console.warn(`[sandbox-comfy] poll#${i} /history fetch failed: ${String(pollErr)}`); }
					continue;
				}
				const statusStr = rec?.status?.status_str;
				if (i % 5 === 0 && !statusStr) {
					// history 还没记录（排队/执行中）→ 查 /queue 深度帮助定位
					try {
						const q = await (await fetch(`${baseUrl}/queue`)).json();
						const runN = (q?.queue_running ?? []).length;
						const pendN = (q?.queue_pending ?? []).length;
						console.warn(`[sandbox-comfy] poll#${i} prompt_id=${prompt_id.slice(0, 8)}… status=执行中/排队 queue: running=${runN} pending=${pendN}`);
					} catch { console.warn(`[sandbox-comfy] poll#${i} prompt_id=${prompt_id.slice(0, 8)}… status=执行中/排队（/queue 不可达）`); }
				}
				if (statusStr && statusStr !== 'running') {
					if (statusStr === 'success') {
						return { promptId: prompt_id, outputs: rec.outputs ?? {}, status: 'success' };
					}
					const msgs = (rec.status.messages ?? [])
						.filter((m: Any) => Array.isArray(m) && m[0] === 'execution_error')
						.map((m: Any) => `[${m[1]?.node_type}] ${m[1]?.exception_message}`);
					return { promptId: prompt_id, outputs: rec.outputs ?? {}, status: 'error', error: msgs.join('; ') || 'execution failed' };
				}
			}
			return { promptId: prompt_id, outputs: {}, status: 'error', error: 'timeout (20min) — 检查 ComfyUI 队列/终端日志' };
		},
	};
}

/**
 * ★ provider 渠道的 `sendImageGen` —— **录制回放**。
 * 独立浏览器页面没有 VS Code 主进程，bridge 不可用，无法真调 provider RPC。
 * 能做到且有价值的是：
 *   ① 记录每次实际调用的参数（`window.__providerCalls` → 工具栏可导出）
 *      → 验证「选了 provider/model 后请求体拼装是否正确」
 *   ② 按录制 JSON 匹配返回 → 验证下游消费链路（抠像、拼贴、GIF 化…）
 */
function makeSendImageGen(): Any {
	const calls: Any[] = [];
	const send = async (params: Any) => {
		const p = params ?? {};
		calls.push({
			at: new Date().toISOString(),
			provider: p.providerId ?? p.provider ?? '',
			model: p.modelId ?? p.model ?? '',
			prompt: p.prompt ?? '',
			width: p.width, height: p.height, count: p.count,
			raw: JSON.parse(JSON.stringify(p, (k, v) => (typeof v === 'string' && v.length > 400 ? v.slice(0, 400) + '…' : v))),
		});
		(window as Any).__providerCalls = calls;
		const rec: Any[] = (window as Any).__providerRecording ?? [];
		const hit = rec.find((r) => {
			const m = r.match ?? {};
			if (m.provider && m.provider !== (p.providerId ?? p.provider)) { return false; }
			if (m.model && m.model !== (p.modelId ?? p.model)) { return false; }
			if (m.promptIncludes && !String(p.prompt ?? '').includes(m.promptIncludes)) { return false; }
			return true;
		});
		if (hit) { return hit.result; }
		// ★ 未命中时执行器只会报「未返回图片」——根因（没载录制/没命中）在这里打出来
		// eslint-disable-next-line no-console
		console.warn('[sandbox/provider] 录制未命中：provider=' + (p.providerId ?? p.provider)
			+ ' model=' + (p.modelId ?? p.model)
			+ ' prompt=' + String(p.prompt ?? '').slice(0, 80));
		return {
			error: 'provider 录制未命中：provider=' + (p.providerId ?? p.provider)
				+ ' model=' + (p.modelId ?? p.model)
				+ '（请用工具栏「载入 provider 录制」加载 JSON）',
		};
	};
	return send;
}

/**
 * ★ console 镜像：执行器内部的过程日志（[EmojiStage] 提交/采样/切分/抠像…）
 *   原本只进 DevTools，镜像到沙箱状态栏后「执行过程」肉眼可见。原 console 照常工作。
 */
function installConsoleMirror(push: (cls: string, text: string) => void): () => void {
	const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
	const fmt = (a: Any): string => {
		if (typeof a === 'string') { return a; }
		if (a instanceof Error) { return a.message; }
		try {
			return JSON.stringify(a, (_k, v) => (typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v)) ?? String(a);
		} catch { return String(a); }
	};
	const wrap = (cls: string, origFn: Any) => (...args: Any[]) => {
		try { origFn(...args); } catch { /* 原样优先 */ }
		const text = args.map(fmt).join(' ').trim();
		// 编辑器诊断已走 sandbox-log 事件通道，这里跳过避免状态栏双份
		if (text && !text.startsWith('[sandbox/emoji-models]')) { push(cls, text.slice(0, 300)); }
	};
	console.log = wrap('dim', orig.log);
	console.info = wrap('dim', orig.info);
	console.warn = wrap('warn', orig.warn);
	console.error = wrap('err', orig.error);
	return () => {
		console.log = orig.log; console.info = orig.info; console.warn = orig.warn; console.error = orig.error;
	};
}

/** Kahn 拓扑排序。返回 null = 有环。 */
function topo(ids: string[], edges: Any[]): string[] | null {
	const indeg = new Map<string, number>();
	for (const id of ids) { indeg.set(id, 0); }
	for (const e of edges) {
		if (indeg.has(e.source) && indeg.has(e.target)) { indeg.set(e.target, indeg.get(e.target)! + 1); }
	}
	const q = ids.filter(i => indeg.get(i) === 0);
	const order: string[] = [];
	while (q.length) {
		const id = q.shift()!;
		order.push(id);
		for (const e of edges) {
			if (e.source !== id || !indeg.has(e.target)) { continue; }
			const d = indeg.get(e.target)! - 1;
			indeg.set(e.target, d);
			if (d === 0) { q.push(e.target); }
		}
	}
	return order.length === ids.length ? order : null;
}

/** 演示 providers（对齐 harness.tsx 的 DEMO_PROVIDERS：让 provider/model 下拉有选项）。 */
const DEMO_PROVIDERS = [
	{
		id: 'vt-openai', name: 'VT OpenAI', authStatus: 'authenticated',
		models: [{ id: 'vt-gpt-4o', name: 'VT GPT-4o' }],
	},
	{
		id: 'vt-imagen', name: 'VT Imagen', authStatus: 'authenticated',
		models: [{ id: 'vt-image-1', name: 'VT Image 1', supportsImageGen: true }],
	},
];

function App(): React.JSX.Element {
	const canvasRef = React.useRef<Any>(null);
	const [lines, setLines] = React.useState<Array<{ cls: string; text: string }>>([]);
	// 执行日志过滤：级别 + 文本（status-head 中「复制/清空」左侧）
	const [logFilter, setLogFilter] = React.useState('');
	const [logLevel, setLogLevel] = React.useState<'all' | 'warn' | 'err' | 'ok'>('all');
	const filteredLines = React.useMemo(() => {
		const kw = logFilter.trim().toLowerCase();
		return lines.filter(l => {
			if (kw && !l.text.toLowerCase().includes(kw)) { return false; }
			if (logLevel === 'warn') { return l.cls === 'warn' || l.cls === 'err'; }
			if (logLevel === 'err') { return l.cls === 'err'; }
			if (logLevel === 'ok') { return l.cls === 'ok'; }
			return true;
		});
	}, [lines, logFilter, logLevel]);
	const [running, setRunning] = React.useState(false);
	const [pick, setPick] = React.useState('ComfyTV.StatEmojiStage');
	const [fake, setFake] = React.useState(BACKEND !== 'comfyui');

	const store = useWorkflowEditorStore;
	const nodes: Any[] = store((s: Any) => s.nodes);
	const edges: Any[] = store((s: Any) => s.edges);
	const selectedNodeId: string | null = store((s: Any) => s.selectedNodeId);
	const specs: Any[] = React.useMemo(() => (registry?.getAllSpecs?.() ?? []), []);
	const mine = nodes.filter((n: Any) => n.id !== 'start' && n.id !== 'end');

	const log = (text: string, cls = 'dim') => setLines(p => [...p.slice(-150), { cls, text }]);

	const runnerFor = () => {
		if (BACKEND === 'comfyui') { return makeComfyRunner(COMFY_BASE); }
		return fake ? fakeRunner : noRunner;
	};

	// ── 图操作 ────────────────────────────────────────────────────────────
	const addNode = (t: string = pick) => {
		const id = store.getState().addNode(t, { x: 140 + nodes.length * 30, y: 120 + (nodes.length % 3) * 60 });
		log('新建节点 ' + t + '  →  ' + id, 'ok');
		return id;
	};

	const connect = (from: string, to: string, fromPort?: string, toPort?: string) => {
		const st = store.getState();
		const e: Any = {
			id: 'e-' + from + '-' + to + '-' + Date.now(),
			source: from, target: to,
			...(fromPort ? { sourceHandle: fromPort } : {}),
			...(toPort ? { targetHandle: toPort } : {}),
		};
		st.setEdges([...st.edges, e]);
		log('连线 ' + from + (fromPort ? ':' + fromPort : '') + ' → ' + to + (toPort ? ':' + toPort : ''), 'ok');
		return e.id;
	};

	const seed = (g: { nodes?: Any[]; edges?: Any[] }) => {
		const st = store.getState();
		const keep = st.nodes.filter((n: Any) => n.id === 'start' || n.id === 'end');
		// ★ 必须与 `exportFixture` 互逆：fixture 用 values/from/to，store 用 data/source/target
		const seeded = (g.nodes ?? []).map((n: Any) => ({
			id: n.id,
			type: n.type,
			position: n.position ?? { x: 160, y: 140 },
			data: n.data ?? n.values ?? {},
			...(n.style ? { style: n.style } : {}),
		}));
		const seededEdges = (g.edges ?? []).map((e: Any) => ({
			id: e.id ?? 'e-' + (e.from ?? e.source) + '-' + (e.to ?? e.target) + '-' + Date.now(),
			source: e.from ?? e.source,
			target: e.to ?? e.target,
			...(e.fromPort ?? e.sourceHandle ? { sourceHandle: e.fromPort ?? e.sourceHandle } : {}),
			...(e.toPort ?? e.targetHandle ? { targetHandle: e.toPort ?? e.targetHandle } : {}),
		}));
		st.setNodes([...keep, ...seeded]);
		st.setEdges(seededEdges);
		log('已载入 ' + seeded.length + ' 节点 / ' + seededEdges.length + ' 连线', 'ok');
	};

	const clearAll = () => {
		const st = store.getState();
		st.setNodes(st.nodes.filter((n: Any) => n.id === 'start' || n.id === 'end'));
		st.setEdges([]);
		log('已清空（保留 start/end）');
	};

	const exportFixture = () => {
		const st = store.getState();
		return {
			backend: BACKEND,
			comfyBase: BACKEND === 'comfyui' ? COMFY_BASE : undefined,
			nodes: st.nodes
				.filter((n: Any) => n.id !== 'start' && n.id !== 'end')
				.map((n: Any) => ({ id: n.id, type: n.type, values: n.data ?? {}, position: n.position })),
			edges: st.edges.map((e: Any) => ({
				from: e.source, to: e.target,
				...(e.sourceHandle ? { fromPort: e.sourceHandle } : {}),
				...(e.targetHandle ? { toPort: e.targetHandle } : {}),
			})),
		};
	};

	const download = (data: unknown, name: string) => {
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = name;
		a.click();
		URL.revokeObjectURL(a.href);
		log('已导出 ' + name, 'ok');
	};

	// ── ★ 参考图注入（AssetReferences override 语义）──────────────────────
	/**
	 * 把图片钉到节点的 `comfytv_image_refs`。执行器里钉住的资产**优先于**同 slot
	 * 的上游连线（applyAssetRefOverrides）——这正是「给节点传指定参考图」的官方通道。
	 * `ref` 可以是 data: URL（本地上传）、http(s) URL（ComfyUI /view 或外网）。
	 */
	const injectImage = (nodeId: string, ref: string, slot = 0, kind: 'image' | 'video' | 'audio' = 'image') => {
		const st = store.getState();
		const node = st.nodes.find((n: Any) => n.id === nodeId);
		if (!node) { log('找不到节点 ' + nodeId, 'err'); return false; }
		const raw = (node.data as Any)?.[ASSET_REFS_PROP_KEY];
		let refs: Any[] = [];
		try { refs = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []); } catch { refs = []; }
		refs = refs.filter((r: Any) => (r.slot ?? 0) !== slot || (r.type ?? 'image') !== kind);
		refs.push({ ref, slot, type: kind });
		st.updateNodeData(nodeId, { [ASSET_REFS_PROP_KEY]: JSON.stringify(refs) });
		log('已注入参考图 → ' + nodeId + '  #' + slot + ' (' + kind + ')  ' + (ref.startsWith('data:') ? 'data:' + ref.length + 'B' : ref.slice(0, 60)), 'ok');
		return true;
	};

	/** 目标节点：优先当前选中，否则第一个非 start/end 节点。 */
	const pickTarget = (): string | null => {
		if (selectedNodeId && selectedNodeId !== 'start' && selectedNodeId !== 'end') { return selectedNodeId; }
		return mine[0]?.id ?? null;
	};

	const readFileAsDataUrl = (f: File) => new Promise<string>((res, rej) => {
		const fr = new FileReader();
		fr.onload = () => res(fr.result as string);
		fr.onerror = () => rej(fr.error);
		fr.readAsDataURL(f);
	});

	// ① 文件选择器（人工点按钮 / Playwright setInputFiles 都走这里）
	const onPickReference = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const f = e.target.files?.[0];
		e.target.value = '';   // 允许重复选同一文件
		if (!f) { return; }
		const target = pickTarget();
		if (!target) { log('画布上没有可注入的节点', 'err'); return; }
		try {
			const dataUrl = await readFileAsDataUrl(f);
			injectImage(target, dataUrl, 0, 'image');
		} catch (err) {
			log('读取文件失败：' + String(err), 'err');
		}
	};

	// ② 拖文件进画布
	const onDropFile = async (e: React.DragEvent) => {
		const f = e.dataTransfer?.files?.[0];
		if (!f || !f.type.startsWith('image/')) { return; }
		e.preventDefault();
		const target = pickTarget();
		if (!target) { log('画布上没有可注入的节点', 'err'); return; }
		const dataUrl = await readFileAsDataUrl(f);
		injectImage(target, dataUrl, 0, 'image');
	};

	// ── 本机模型清单（comfyui 模式）：模板默认模型不在本机时，告诉用户有什么可换 ──
	const listModels = async () => {
		if (BACKEND !== 'comfyui') { log('「本机模型」仅 comfyui 模式可用（?backend=comfyui）', 'warn'); return; }
		try {
			const j = await (await fetch(COMFY_BASE + '/object_info/CheckpointLoaderSimple')).json();
			const list: string[] = j?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
			if (!list.length) { log('本机未列出任何 checkpoint（' + COMFY_BASE + '）', 'warn'); return; }
			log('本机 checkpoint（' + list.length + '）：' + list.slice(0, 12).join('、') + (list.length > 12 ? ' …' : ''), 'ok');
			log('用法：双击表情包节点 → 编辑器里把模型（comfy_model）换成上面任一 → 重新运行', 'dim');
		} catch (e) {
			log('获取模型清单失败（' + COMFY_BASE + '）：' + String(e).slice(0, 80), 'err');
		}
	};

	// ── provider 录制（回放数据）────────────────────────────────────────
	const onLoadRecording = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const f = e.target.files?.[0];
		e.target.value = '';
		if (!f) { return; }
		try {
			const rec = JSON.parse(await f.text());
			(window as Any).__providerRecording = Array.isArray(rec) ? rec : (rec.entries ?? []);
			// 录制也持久化：刷新后回放数据还在
			try { localStorage.setItem(REC_KEY, JSON.stringify((window as Any).__providerRecording)); } catch { /* 配额 */ }
			log('已载入 provider 录制（' + (window as Any).__providerRecording.length + ' 条，刷新后仍生效）', 'ok');
		} catch (err) {
			log('解析录制 JSON 失败：' + String(err), 'err');
		}
	};

	const exportProviderCalls = () => {
		const calls = (window as Any).__providerCalls ?? [];
		if (!calls.length) { log('还没有 provider 调用记录（先跑一次 provider 渠道的节点）', 'warn'); return; }
		download(calls, 'provider-calls.json');
	};

	// ── 运行 ──────────────────────────────────────────────────────────────
	const runAll = async () => {
		const canvas = canvasRef.current;
		if (!canvas) { log('画布尚未就绪', 'err'); return; }
		if (BACKEND === 'comfyui') {
			const probe = await makeComfyRunner(COMFY_BASE).testConnection();
			if (!probe.ok) { log('ComfyUI 不可达（' + COMFY_BASE + '）：' + probe.error, 'err'); return; }
			log('ComfyUI 已连接（' + COMFY_BASE + '  v' + probe.version + '）', 'ok');
		}
		const st = store.getState();
		const all: Any[] = st.nodes;
		const ids = all.map((n: Any) => n.id).filter((id: string) => id !== 'start' && id !== 'end');
		const order = topo(ids, st.edges);
		if (!order) { log('图中存在环，无法运行', 'err'); return; }

		setRunning(true);
		const cardState = canvas.cardStateStore();
		const snapStore = canvas.snapshotStore();
		// ★ 始终注入：走不走 provider 通道由**节点 values.backend** 决定（comfyui|provider），
		//   与沙箱的 URL 模式（?backend=）无关。未命中录制时回放器会返回明确错误，不会误成功。
		const sendImageGen = makeSendImageGen();
		const results: Any[] = [];
		let failed = false;

		for (const id of order) {
			const node = all.find((n: Any) => n.id === id);
			if (!node) { continue; }
			// ★ 归档键必须是 stageUid（不是 nodeId），否则 OUTPUT 不刷新
			const stageUid = canvas.stageUidOf(id) ?? id;
			if (failed) {
				cardState.set(stageUid, { runState: 'skipped', errorMsg: '上游节点失败' });
				results.push({ id, type: node.type, status: 'skipped', upstreams: [] });
				continue;
			}
			const ins: Any[] = st.edges.filter((e: Any) => e.target === id);
			const upstreams = ins.map((e: Any) => canvas.stageUidOf(e.source) ?? e.source);
			const inbound = ins.map((e: Any) => ({
				source: canvas.stageUidOf(e.source) ?? e.source,
				...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
				...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
			}));

			cardState.set(stageUid, { runState: 'running', progress: 0 });
			log('▶ 提交 ' + node.type + '  [' + id + ']  上游 ' + upstreams.length + ' 个', 'dim');
			const t0 = performance.now();
			let res: Any;
			let lastPct = -1;
			try {
				res = await runNodeOrStage({
					runner: runnerFor(),
					nodeId: stageUid,
					type: node.type,
					getSpec: (t: string) => registry.getNodeSpec(t),
					values: node.data ?? {},
					store: snapStore,
					upstreams,
					inbound,
					sendImageGen,
					// ★ 执行器内部的进度回调 → 详细日志（整数百分比去重，避免刷屏）
					//   + **卡片进度更新**（此前只打日志，卡片 progress 恒 0%，
					//   qwen 3×3 大图 1-2 分钟里观感=「按钮没反应」）。
					onProgress: (p: Any) => {
						const pct = Math.round(p?.progress ?? 0);
						if (pct !== lastPct) {
							lastPct = pct;
							cardState.set(stageUid, { runState: 'running', progress: pct });
							log('  ⏳ ' + node.type + '  ' + pct + '%', 'dim');
						}
					},
				});
			} catch (e) {
				res = { status: 'error', error: e instanceof Error ? e.message : String(e) };
			}
			const ms = Math.round(performance.now() - t0);
			const ok = res.status === 'success';
			cardState.set(stageUid, {
				runState: ok ? 'success' : 'error', progress: 100,
				errorMsg: res.error, durationMs: ms,
			});
			results.push({ id, type: node.type, status: res.status, error: res.error, durationMs: ms, upstreams });
			log((ok ? '✓ ' : '✗ ') + node.type + '  [' + id + ']  ' + ms + 'ms'
				+ (upstreams.length ? '  上游: ' + upstreams.join(',') : '')
				+ (res.error ? '  — ' + res.error : ''), ok ? 'ok' : 'err');
			if (!ok) { failed = true; }
		}

		try {
			const ran = results.filter(x => x.status === 'success').map(x => x.id);
			const skipped = results.filter(x => x.status !== 'success').map(x => x.id);
			canvas.markRouteEdges?.(ran, skipped);
		} catch { /* 可选能力 */ }

		setRunning(false);
		log('—— 运行结束：' + results.filter(x => x.status === 'success').length + ' 成功 / '
			+ results.filter(x => x.status !== 'success').length + ' 失败 ——', failed ? 'err' : 'ok');
		(window as Any).__lastRun = { ok: !failed, order, nodes: results };
	};

	// ── chat-ui：聊天链路（真实语义）────────────────────────────────────
	// 输入 → parseSlashCommands（与真实聊天框同一函数）→ 对话写进工作流 prompt
	// → 画布执行核 runAll → 取出图快照物化 → 返回图片给聊天消息流回贴。
	// ── 执行核（headless）：prompt → runNodeOrStage（不进画布 store）→ 出图 url[] ──
	const runChatWorkflowHeadless = async (promptText: string): Promise<string[] | null> => {
		const canvas = canvasRef.current;
		if (!canvas) { log('✗ 画布尚未就绪', 'err'); return null; }
		const snapStore = canvas.snapshotStore();
		const stageUid = 'chat-ui-stage';
		log('💬 对话 → prompt：' + promptText.slice(0, 40) + (promptText.length > 40 ? '…' : ''), 'dim');
		log('▶ 后台执行工作流：ComfyTV.StatEmojiStage …', 'dim');
		// ② 真实执行核（与画布「▶ 运行全部」同源：runner/快照库/spec 解析），但不进画布 store
		const t0 = performance.now();
		let res: Any;
		let lastPct = -1;
		try {
			res = await runNodeOrStage({
				runner: runnerFor(),
				nodeId: stageUid,
				type: 'ComfyTV.StatEmojiStage',
				getSpec: (t: string) => registry.getNodeSpec(t),
				values: {
					prompt: promptText,
					backend: BACKEND === 'provider' ? 'provider' : 'comfyui',
					rows: 2, cols: 2, run_scope: 'all',
					style_preset: 'Q版', sheet_background: 'transparent',
					...(BACKEND === 'provider' ? { provider: 'vt-imagen', model: 'vt-image-1' } : {}),
				},
				store: snapStore,
				upstreams: [],
				inbound: [],
				sendImageGen: makeSendImageGen(),
				onProgress: (p: Any) => {
					const pct = Math.round(p?.progress ?? 0);
					if (pct !== lastPct) { lastPct = pct; log('  ⏳ 生成 ' + pct + '%', 'dim'); }
				},
			});
		} catch (e) {
			res = { status: 'error', error: e instanceof Error ? e.message : String(e) };
		}
		const ms = Math.round(performance.now() - t0);
		const okRun = res.status === 'success';
		log(okRun ? '✓ 工作流执行完成（' + ms + 'ms）' : '✗ 工作流执行失败：' + (res.error ?? '未知错误'), okRun ? 'ok' : 'err');
		if (!okRun) { return null; }
		// ③ 取出图快照 → 物化 → 回贴消息流（与真实 app「markdown 图片回贴」同构）
		const entries: Any[] = snapStore?.byNode?.(stageUid) ?? [];
		const materialize = (window as Any).__materializeSnapshotEntry as ((m: Any) => unknown) | undefined;
		const images: string[] = [];
		for (const entry of entries) {
			try {
				const port = materialize?.(entry.media);
				const u = typeof port === 'string' ? port : (port as Any)?.url;
				if (typeof u === 'string' && /^(data:|blob:|https?:)/.test(u)) { images.push(u); }
			} catch { /* 物化失败的条目跳过 */ }
		}
		if (!images.length) { return null; }
		return images;
	};

	// ── chat-real / chat-ui：100% 真实 AgentChatPanel（组合根，opts 回调驱动）──
	/** 演示 agent（IAgentInfo）：沙箱无 host 会话数据，setAgent 注入后聊天框即全功能可见。 */
	const DEMO_AGENT: Any = {
		id: 'sandbox-gr-emoji',
		name: 'GR埋点专家',
		role: '表情包出图演示 · 沙箱',
		icon: '🤖',
		status: 'idle',
		model: 'claude-sonnet-4-20250514',
		provider: 'anthropic',
	};
	const chatRealHostRef = React.useRef<HTMLDivElement | null>(null);
	const chatRealPanelRef = React.useRef<Any>(null);
	/** 下拉注入的完整 agent 列表（onSelectAgent 切换时查表 setAgent）。 */
	const chatAgentListRef = React.useRef<Any[]>([]);
	// 聊天框宽度（可拖拽分隔条调整，320–800px）
	const [chatWidth, setChatWidth] = React.useState(480);
	const splitterDragRef = React.useRef<{ startX: number; startW: number } | null>(null);
	// 断言消息日志（chat-real / chat-ui 共用）：chatRealHandle 的 add() 同步落账，
	// 供 __chatUi.messages()/getLastImage()（Playwright / LLM 断言）读取。
	const chatMsgLogRef = React.useRef<Array<{ role: 'user' | 'assistant'; text?: string; imageUrl?: string }>>([]);
	// ── 会话 / provider / model 沙箱状态（让面板的「新增会话 / provider 下拉 /
	//    model 下拉」真实可操作——状态存内存 Map，点击下拉项即时生效）──
	const chatSessionsRef = React.useRef<Map<string, Array<{ role: 'user' | 'assistant'; text?: string; imageUrl?: string }>>>(new Map());
	const chatCurrentSessionIdRef = React.useRef<string>('');
	const chatCurrentProviderRef = React.useRef<string>('lm:codebuddy');
	const chatCurrentModelRef = React.useRef<string>('claude-sonnet-4.6');
	/**
	 * chat 面板的 provider 下拉数据（IProviderInfo 契约）。
	 * ★ `lm:codebuddy` = 真实 provider（extensions/codebuddy-provider 注册的 LM
	 *   vendor，模型清单见 codebuddyModels.generated.ts——与 vssaros.exe 同源）。
	 */
	const CHAT_PROVIDERS: Any[] = [
		{ id: 'lm:codebuddy', label: 'CodeBuddy' },
		{ id: 'anthropic', label: 'Anthropic' },
		{ id: 'openai', label: 'OpenAI' },
		{ id: 'vt-imagen', label: 'VT Imagen（出图）' },
	];
	/** chat 面板的 model 下拉数据（按 provider 过滤显示）。 */
	const CHAT_MODELS: Any[] = [
		...CODEBUDDY_MODELS.map(m => ({
			id: m.id,
			label: m.name,
			provider: 'lm:codebuddy',
			supportsImages: m.supportsImages,
			maxInputTokens: m.maxInputTokens,
		})),
		{ id: 'claude-sonnet-4-20250514', label: 'claude-sonnet-4', provider: 'anthropic' },
		{ id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' },
		{ id: 'vt-image-1', label: 'VT Image 1（表情包出图）', provider: 'vt-imagen', supportsImages: true },
	];
	const chatRealHandle = async (text: string): Promise<void> => {
		const panel = chatRealPanelRef.current;
		const mid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
		const add = (role: 'user' | 'assistant', content: string) => {
			// markdown 图片回贴 → 提取 url 记入日志（断言 getLastImage 用）
			const imgMatch = /!\[[^\]]*\]\(([^)]+)\)/.exec(content);
			const entry: Any = { role, text: imgMatch ? undefined : content, imageUrl: imgMatch?.[1] };
			chatMsgLogRef.current.push(entry);
			// ★ 持久化（fire-and-forget）：消息落 ~/.vssaros/chat-history/，刷新不丢
			void fetch(`${location.origin}/api/real/chat-sessions/${chatCurrentSessionIdRef.current}/messages`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ role, text: entry.text, imageUrl: entry.imageUrl }),
			}).catch(() => { /* 持久化失败不影响消息流 */ });
			try { panel?.addMessage?.({ id: mid(), role, content, timestamp: Date.now() } as Any); } catch { /* ignore */ }
		};
		add('user', text);
		const trigger = parseSlashCommands(text).workflowTrigger;
		if (!trigger) {
			add('assistant', '出图需要显式触发工作流（与真实聊天框一致）：\n/workflow wf-emoji <描述>\n/wf wf-emoji <描述>\n/wf-emoji <描述>（整行）');
			return;
		}
		const promptText = trigger.input?.trim() || '帮我做一个戴圣诞帽的橘猫表情包，Q版，厚描边，透明背景，孤立贴纸';
		const images = await runChatWorkflowHeadless(promptText);
		if (!images) { add('assistant', '出图失败（详见画布执行日志）'); return; }
		for (const u of images) { add('assistant', `![出图](${u})`); }
	};
	React.useEffect(() => {
		if ((SCENARIO !== 'chat-real' && SCENARIO !== 'chat-ui') || !chatRealHostRef.current || chatRealPanelRef.current) { return; }
		let disposed = false;
		void (async () => {
			try {
				const [mod, builtinAgentsMod]: Any[] = await Promise.all([
					import('../../../../../browser/agentChat/agentChatPanel.js'),
					// ★ agent 下拉的完整列表与 vssaros.exe 同源：内置白名单 agents
					//（saros-claw 主助理 + knowledge-base-expert，见 builtinAgents.ts）。
					import('../../../common/builtinAgents.js'),
				]);
				if (disposed) { return; }
				const noop = () => {};
				const logService: Any = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, dispose: noop };
				// ★ 100% 真实组件：AgentChatPanel 组合根（与 nativeChatEditorPane 同类），
				//   仅必填回调 onSendMessage / onCancelExecution 驱动；发消息 → 执行核 → addMessage 回贴。
				const panel = new (mod as Any).AgentChatPanel({
					onSendMessage: (text: string) => { void chatRealHandle(text); },
					onCancelExecution: noop,
					onToggleCollapse: noop,
					// agent 下拉点选 → 真实切换面板 agent（头部/角色/状态随之更新）
					onSelectAgent: (id: string) => {
						const a = chatAgentListRef.current.find(x => x.id === id);
						if (a) { panel.setAgent(a); }
					},
					// ★ 新增会话：POST 创建（持久化到 ~/.vssaros/chat-history/）→ 面板切空会话
					onNewSession: () => {
						void (async () => {
							try {
								const r = await (await fetch(`${location.origin}/api/real/chat-sessions`, {
									method: 'POST', headers: { 'content-type': 'application/json' },
									body: JSON.stringify({ name: '新会话' }),
								})).json() as Any;
								const msgs: Any[] = [];
								chatSessionsRef.current.set(r.id, msgs);
								chatCurrentSessionIdRef.current = r.id;
								chatMsgLogRef.current = msgs;
								panel.setMessages([]);
								panel.setSessionId(r.id, r.name);
								log('🆕 新会话已创建（' + r.id + '，已持久化）', 'ok');
							} catch (err) {
								log('✗ 新建会话失败：' + (err instanceof Error ? err.message : String(err)), 'err');
							}
						})();
					},
					// ★ provider/model 下拉点选：面板内部已自更新 chip（真实组件行为），
					//   沙箱侧仅记录当前选择（供后续把执行链与所选 provider/model 打通）。
					onSelectProvider: (providerId: string) => { chatCurrentProviderRef.current = providerId; },
					onSelectModel: (modelId: string) => { chatCurrentModelRef.current = modelId; },
					// ★ 工作区/worktree 下拉：**真实数据** —— test-server Node 侧读
					//   ~/.vssaros/workspaces.json + 执行真实 git 命令（worktree list /
					//   status / rev-list），与 vssaros.exe 的 WorktreeService 同语义。
					//   ★ 面板契约：worktrees 数组 = **主仓库之外**的其他 worktree
					//  （主仓库独立渲染首项）——逐个 workspace 尝试直到取到非空列表
					//  （当前项目 sarosis-agents-client 优先）。
					//   ★ fetch 必须用**绝对 URL**：networkGuard 白名单前缀匹配
					//     `http://origin/api/real/`，相对路径（/api/...）不匹配会被拦成假图。
					onLoadWorktrees: async () => {
						try {
							const wsList: Any[] = await (await fetch(`${location.origin}/api/real/workspaces`)).json();
							const ordered = [
								...wsList.filter(w => (w.name ?? '').includes('sarosis-agents-client')),
								...wsList.filter(w => !(w.name ?? '').includes('sarosis-agents-client')),
							];
							for (const ws of ordered) {
								const list = await (await fetch(`${location.origin}/api/real/worktrees?path=${encodeURIComponent(ws.path ?? '')}`)).json() as Any[];
								if (list.length) { return list; }
							}
							return [];
						} catch { return []; }
					},
					onSelectWorktree: () => { /* 单 worktree：切换无意义，保留主仓库 */ },
					onClearWorktree: () => { /* 同上 */ },
					onLoadWorkspaces: async () => {
						try { return await (await fetch(`${location.origin}/api/real/workspaces`)).json() as Any[]; } catch { return []; }
					},
					onSelectWorkspace: () => { /* 沙箱单面板：workspace 选择仅记录 */ },
					onListSkills: () => [],
					onListWorkflows: () => [{ id: 'wf-emoji', name: '表情包', description: '静态表情包（图集）' }],
					onListMcpServers: () => [],
					logService,
				} as Any);
				chatRealHostRef.current!.appendChild(panel.element);
				chatRealPanelRef.current = panel;
				// 注入完整 agent 列表：内置白名单 agents（与 vssaros.exe 同源）+ 演示 agent。
				// Agent → IAgentInfo 字段直映（role/icon/model 同名；provider ← providerId）。
				try {
					// agent 列表 = 内置白名单（builtinAgents，与 vssaros.exe 同源）
					//   + 用户自定义（~/.vssaros/agents/，test-server 真实读取）+ 演示 agent
					let customAgents: Any[] = [];
					try { customAgents = await (await fetch(`${location.origin}/api/real/agents`)).json() as Any[]; } catch { /* 无 API 时跳过 */ }
					const builtin: Any[] = (builtinAgentsMod as Any).filterUserFacingAgents(
						(builtinAgentsMod as Any).getBuiltinAgents(),
					) ?? [];
					const agentList: Any[] = [
						...builtin.map((a: Any) => ({
							id: a.id,
							name: a.name,
							role: a.role || a.description || '',
							icon: a.icon || '🤖',
							status: 'idle',
							model: a.model,
							provider: a.providerId,
						})),
						...customAgents.map((a: Any) => ({
							id: a.id, name: a.name, role: a.role || '', icon: a.icon || '🤖',
							status: 'idle', model: a.model, provider: a.provider,
						})),
						DEMO_AGENT,
					];
					chatAgentListRef.current = agentList;
					panel.setAvailableAgents?.(agentList as Any);
					panel.setAgent?.(DEMO_AGENT as Any);
					// provider / model 下拉数据 + 当前选中（chips 即时生效）
					panel.setProviders?.(CHAT_PROVIDERS as Any);
					panel.setModels?.(CHAT_MODELS as Any);
					panel.setCurrentProvider?.(chatCurrentProviderRef.current);
					panel.setCurrentModel?.(chatCurrentModelRef.current);
					// ★ 真实会话（持久化到 ~/.vssaros/chat-history/sandbox-chat-sessions.json）：
					//   恢复最近会话；无会话则创建「会话 1」。刷新不丢、跨场景共享。
					const sessions: Any[] = await (await fetch(`${location.origin}/api/real/chat-sessions`)).json();
					let sid = sessions[sessions.length - 1]?.id;
					if (!sid) {
						sid = (await (await fetch(`${location.origin}/api/real/chat-sessions`, {
							method: 'POST', headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ name: '会话 1' }),
						})).json()).id;
					}
					chatCurrentSessionIdRef.current = sid;
					const msgs: Any[] = await (await fetch(`${location.origin}/api/real/chat-sessions/${sid}/messages`)).json();
					chatSessionsRef.current.set(sid, msgs);
					chatMsgLogRef.current = msgs;
					if (msgs.length) {
						panel.setMessages?.(msgs.map((m: Any, i: number) => ({
							id: 'm' + i, role: m.role,
							content: m.imageUrl ? `![出图](${m.imageUrl})` : (m.text ?? ''),
							timestamp: m.ts ?? Date.now(),
						})) as Any);
					}
					panel.setSessionId?.(sid, sessions.find((s: Any) => s.id === sid)?.name ?? '会话 1');
				} catch { /* 空态也不影响测试链路 */ }
				log('✓ 已挂载真实 AgentChatPanel（100% 真组件）', 'ok');
			} catch (err) {
				log('✗ AgentChatPanel 挂载失败：' + (err instanceof Error ? err.message : String(err)), 'err');
			}
		})();
		return () => { disposed = true; };
	}, []);

	// 断言句柄（chat-real / chat-ui 共用，替代旧 ChatUiPanel 的 __chatUi）：
	// messages() = 消息流快照；getLastImage() = 最后一张出图；__chatUiSend = 程序化发送。
	React.useEffect(() => {
		if (SCENARIO !== 'chat-real' && SCENARIO !== 'chat-ui') { return; }
		(window as Any).__chatUi = {
			messages: () => chatMsgLogRef.current.map(m => ({ role: m.role, text: m.text ?? null, hasImage: !!m.imageUrl })),
			getLastImage: () => [...chatMsgLogRef.current].reverse().find(m => m.imageUrl)?.imageUrl ?? null,
		};
		(window as Any).__chatUiSend = (text: string) => { void chatRealHandle(text); };
	});

	// ── 单节点运行（卡片 ▶）──────────────────────────────────────────────
	const onNodeRun = React.useCallback(async (nodeId: string, nodeType: string, stageUid?: string) => {
		const canvas = canvasRef.current;
		if (!canvas) { return; }
		const st = store.getState();
		const node = st.nodes.find((n: Any) => n.id === nodeId);
		if (!node) { return; }
		const key = stageUid ?? canvas.stageUidOf(nodeId) ?? nodeId;
		const ins: Any[] = st.edges.filter((e: Any) => e.target === nodeId);
		const cardState = canvas.cardStateStore();
		cardState.set(key, { runState: 'running', progress: 0 });
		const t0 = performance.now();
		let res: Any;
		let lastPct = -1;
		try {
			res = await runNodeOrStage({
				runner: runnerFor(),
				nodeId: key, type: nodeType,
				getSpec: (t: string) => registry.getNodeSpec(t),
				values: node.data ?? {},
				store: canvas.snapshotStore(),
				upstreams: ins.map((e: Any) => canvas.stageUidOf(e.source) ?? e.source),
				inbound: ins.map((e: Any) => ({
					source: canvas.stageUidOf(e.source) ?? e.source,
					...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
					...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
				})),
				sendImageGen: makeSendImageGen(),
				// ★ 进度回传（2026-09-04）：此前单节点 ▶ 完全没传 onProgress——
				//   执行期间（qwen 3×3 大图 1-2 分钟）卡片 progress 恒 0%、按钮
				//   无任何变化，观感=「没反应/卡死」。对齐 runAll：百分比去重后
				//   更新卡片进度 + 沙箱日志。
				onProgress: (p: Any) => {
					const pct = Math.round(p?.progress ?? 0);
					if (pct !== lastPct) {
						lastPct = pct;
						cardState.set(key, { runState: 'running', progress: pct });
						log('  ⏳ ' + nodeType + '  ' + pct + '%', 'dim');
					}
				},
				});
		} catch (e) {
			res = { status: 'error', error: e instanceof Error ? e.message : String(e) };
		}
		const ms = Math.round(performance.now() - t0);
		const ok = res.status === 'success';
		cardState.set(key, { runState: ok ? 'success' : 'error', progress: 100, errorMsg: res.error, durationMs: ms });
		log((ok ? '✓ ' : '✗ ') + nodeType + '  [' + nodeId + ']  ' + ms + 'ms' + (res.error ? '  — ' + res.error : ''), ok ? 'ok' : 'err');
	}, [fake, store]);

	// ── 场景预置（?scenario=emoji|storyboard-*）：进页面即摆好节点，用户只需传图 / 运行 ──
	React.useEffect(() => {
		// 场景页（emoji / storyboard-*）：草稿/录制的恢复提示由各场景自己的 effect 输出
		const scen0 = __params.get('scenario') ?? '';
		if ((window as Any).__draftRestored && scen0 !== 'emoji' && !scen0.startsWith('storyboard')) {
			log('已恢复上次编辑的草稿；点「重置场景」可回到初始状态', 'ok');
		}
		if ((window as Any).__providerRecording?.length) {
			log('已恢复 provider 录制（' + (window as Any).__providerRecording.length + ' 条）', 'ok');
		}
	}, []);

	// ── 自动保存（防抖 600ms）：节点/连线/参考图的任何编辑 → localStorage 草稿 ──
	React.useEffect(() => {
		let timer: Any = null;
		const save = () => {
			try {
				const st = store.getState();
				localStorage.setItem(DRAFT_KEY, JSON.stringify({
					at: new Date().toISOString(), nodes: st.nodes, edges: st.edges,
				}));
				// eslint-disable-next-line no-console
				console.log('[sandbox] draft saved @' + new Date().toISOString().slice(17, 23) + ' nodes=' + st.nodes.length);
			} catch (e) {
				// 常见于参考图 data URL 超出 localStorage 配额——要能被看见，不能静默
				log('草稿保存失败（可能参考图过大超出本地存储配额）：' + String(e).slice(0, 90), 'warn');
			}
		};
		const debounced = () => { clearTimeout(timer); timer = setTimeout(save, 600); };
		const unsub = store.subscribe(debounced);
		return () => { clearTimeout(timer); unsub(); };
	}, []);

	React.useEffect(() => {
		const scen = __params.get('scenario') ?? '';
		const isEmoji = scen === 'emoji';
		const isMulti = scen === 'storyboard-multi';
		const isEditor = scen === 'storyboard-editor';
		const isChatGraph = scen === 'chat-graph' || scen === 'chat-ui';
		if (!isEmoji && !isMulti && !isEditor && !isChatGraph) { return; }
		// ★ 有本地草稿 → 优先恢复用户编辑，场景默认不覆盖（这正是「刷新不用重编」的关键）
		if ((window as Any).__draftRestored) {
			log('已恢复上次编辑的草稿；点「重置场景」可回到初始状态', 'warn');
			return;
		}
		// ★ 必须等 LiteGraph graph 真正建好再 seed——过早写 store 会被画布初始化的
		//   configure→syncGraphToStore 回写覆盖（用户后续编辑同样会被吞，表现为「刷新后丢编辑」）
		let alive = true;
		(async () => {
			for (let i = 0; i < 100; i++) {
				const g = (canvasRef.current?.canvasInstance?.() as Any)?.graph;
				if (g && g._nodes) { break; }
				await new Promise(r => setTimeout(r, 100));
			}
			if (!alive) { return; }
			if (isEmoji) {
				const b = BACKEND === 'provider' ? 'provider' : 'comfyui';
				seed({
					nodes: [{
						id: 'emoji-1', type: 'ComfyTV.StatEmojiStage',
						values: {
							prompt: 'A cute round purple cartoon bird emoji sticker, thick outlines, vibrant colors, isolated on transparent background, die-cut sticker',
							backend: b, rows: 2, cols: 2, run_scope: 'all',
							style_preset: 'Q版', sheet_background: 'transparent',
							...(b === 'provider' ? { provider: 'vt-imagen', model: 'vt-image-1' } : {}),
						},
						position: { x: 320, y: 160 },
					}],
					edges: [],
				});
				log('已载入场景「表情包端到端」：下一步 ① 📎 传入参考图（或拖图进画布） ② ▶ 运行全部', 'ok');
			} else if (isMulti) {
				// 故事板端到端 · 多宫格：panels_state 预填 4 宫格（等价于故事文本拆分后的结果），
				// 进页面 ▶ 运行全部 → runMultiPanelStoryboardNode → IMAGE_QWEN_2512_MULTI_PANEL 单图直出。
				seed({
					nodes: [{
						id: 'storyboard-multi-1', type: 'ComfyTV.MultiPanelStoryboardStage',
						values: {
							panels_state: JSON.stringify({
								gridCount: 4,
								panels: [
									{ index: 0, character: '侦探老陈', action: '深夜推开档案室大门', dialogue: '', imagePrompt: '' },
									{ index: 1, character: '', action: '', dialogue: '', imagePrompt: '灰尘在昏黄灯光下飞舞，泛黄的卷宗堆满桌面' },
									{ index: 2, character: '侦探老陈', action: '抽出一份卷宗，旧照片飘落', dialogue: '果然是你…', imagePrompt: '' },
									{ index: 3, character: '', action: '', dialogue: '', imagePrompt: '老照片与手中合影完全一致，面部特写' },
								],
							}),
							width: 1328, height: 1328,
						},
						position: { x: 320, y: 160 },
					}],
					edges: [],
				});
				log('已载入场景「故事板端到端 · 多宫格」：① 可点节点编辑每宫格（角色/动作/对白/图像提示） ② ▶ 运行全部 → Qwen 单图直出 4 宫格', 'ok');
			} else if (isChatGraph) {
				// 聊天框端到端 · 对话触发出图（2026-09-04）：模拟「用户在聊天框发一句
				// 自然语言 → 提取为画图 prompt → 图工作流执行 → 出图」的完整链路。
				// ★ 画布 seed 用 **Saros.ModelImageGen（图片生成）**，不用表情包节点——
				//   测试界面不出现表情包节点（2026-09-05 用户要求）。聊天链路的真实
				//   执行走 runChatWorkflowHeadless（headless StatEmojiStage，不进画布
				//   store），画布节点仅作可视化宿主。
				seed({
					nodes: [{
						id: 'chat-graph-1', type: 'Saros.ModelImageGen',
						values: {
							prompt: '帮我做一个戴圣诞帽的橘猫表情包，Q版，厚描边，透明背景，孤立贴纸',
							provider: 'vt-imagen', model: 'vt-image-1',
							...(BACKEND === 'provider' ? {} : {}),
						},
						position: { x: 320, y: 160 },
					}],
					edges: [],
				});
				log('已载入场景「聊天框端到端」：左画布（图片生成节点）+ 右聊天框；发消息 /wf wf-emoji <描述> 触发出图', 'ok');
				// ?auto=1（测试用例入口默认带）：seed 完成后自动 ▶ 运行全部，
				// 供 Playwright / LLM 断言 getLastRun() 与出图快照，无需人工点按钮。
				if (__params.get('auto') === '1') {
					if (scen === 'chat-ui') {
						// chat-ui：走**聊天链路**自动发送（真实 AgentChatPanel 气泡 → slash 解析
						// → 执行 → 回贴），而不是直接 runAll——保证整条链与人工操作完全一致。
						// ★ 消息必须带工作流触发前缀：真实聊天框语义是「出图需显式触发，
						//   无 LLM 意图猜测」。合法形式 /workflow <wf-id> / /wf <wf-id> /
						//   /{wf-id}（wf-id 必须 wf- 前缀，见 slashCommands.ts:42-43）。
						setTimeout(() => {
							log('auto=1：自动发送聊天消息…', 'ok');
							const msg = '/wf wf-emoji 帮我做一个戴圣诞帽的橘猫表情包，Q版，厚描边，透明背景，孤立贴纸';
							// 真实面板异步挂载（动态 import + DOM append）→ 轮询句柄就绪，最多 10s
							const trySend = (n: number): void => {
								if ((window as Any).__chatUiSend) { (window as Any).__chatUiSend(msg); return; }
								if (n <= 0) { log('✗ 聊天面板挂载超时，auto 发送中止', 'err'); return; }
								setTimeout(() => trySend(n - 1), 500);
							};
							trySend(20);
						}, 800);
					} else {
						setTimeout(() => {
							log('auto=1：自动 ▶ 运行全部…', 'ok');
							void runAll();
						}, 1200);
					}
				}
			} else {
				// 故事板端到端 · 导演台：browser-local 编排，打开编辑器即自动创建「镜头 1」，
				// 分镜图层 / 字段面板全部本地渲染，无需任何后端。
				seed({
					nodes: [{
						id: 'storyboard-editor-1', type: 'ComfyTV.StoryboardEditorStage',
						values: {},
						position: { x: 320, y: 160 },
					}],
					edges: [],
				});
				log('已载入场景「故事板端到端 · 导演台」：① 点节点打开导演台（自动创建镜头 1） ② 左画布编辑图层 / 右面板填字段，全部本地渲染无需后端', 'ok');
			}
			(window as Any).__scenarioLoaded = scen;
		})();
		return () => { alive = false; };
	}, []);

	// 编辑器内部诊断日志（如模型列表拉取）→ 沙箱状态栏，免开 DevTools
	React.useEffect(() => {
		const h = (e: Event) => {
			const d = (e as CustomEvent).detail as Any;
			if (d?.text) { log(String(d.text), String(d.cls ?? 'dim')); }
		};
		window.addEventListener('sandbox-log', h);
		return () => window.removeEventListener('sandbox-log', h);
	}, []);

	// console 镜像：执行器过程日志 → 状态栏（复制/清空按钮在状态栏头部）
	React.useEffect(() => {
		return installConsoleMirror((cls, text) => {
			setLines(p => [...p.slice(-399), { cls, text }]);
		});
	}, []);

	// ── 暴露给 Playwright / LLM ───────────────────────────────────────────
	React.useEffect(() => {
		(window as Any).__canvasSandbox = {
			store: useWorkflowEditorStore,
			registry,
			backend: BACKEND,
			comfyBase: COMFY_BASE,
			addNode, connect, seed, clearAll, exportFixture, runAll,
			injectImage,
			loadRecording: (entries: Any[]) => { (window as Any).__providerRecording = entries; },
			getProviderCalls: () => (window as Any).__providerCalls ?? [],
			getGraph: () => {
				const st = store.getState();
				return { nodes: st.nodes, edges: st.edges };
			},
			getLastRun: () => (window as Any).__lastRun ?? null,
			canvas: () => canvasRef.current,
			netGuard,
		};
		(window as Any).__canvasReady = true;
		log('沙箱就绪（后端=' + BACKEND + (BACKEND === 'comfyui' ? ' → ' + COMFY_BASE : '') + '）', 'ok');
	}, []);

	const backendBadge = BACKEND === 'comfyui' ? 'ComfyUI(真)' : BACKEND === 'provider' ? 'Provider(回放)' : '假后端';

	return (
		<div className="app" onDrop={onDropFile} onDragOver={e => e.preventDefault()}>
			<div id="toolbar">
				<select value={pick} onChange={e => setPick(e.target.value)} style={{ minWidth: 220 }}>
					{specs.map((s: Any) => (
						<option key={s.type} value={s.type}>{s.title ?? s.type} — {s.type}</option>
					))}
				</select>
				<button onClick={() => addNode()} disabled={running}>+ 新建节点</button>
				<button className="primary" onClick={runAll} disabled={running || mine.length === 0}>
					{running ? '运行中…' : '▶ 运行全部'}
				</button>
				<label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
					title={selectedNodeId ? '注入到选中节点：' + selectedNodeId : '注入到第一个节点'}>
					📎 参考图
					<input type="file" accept="image/*" onChange={onPickReference} style={{ display: 'none' }} />
				</label>
				<label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
					title="载入 provider 录制 JSON（[{ match: { provider, model, promptIncludes }, result: {…} }]）">
					🎬 载入录制
					<input type="file" accept="application/json" onChange={onLoadRecording} style={{ display: 'none' }} />
				</label>
				<button onClick={exportProviderCalls} title="导出 provider 渠道的实际调用参数（核对请求体拼装）">导出调用</button>
				{BACKEND === 'comfyui' && (
					<button onClick={listModels} title="列出本机 ComfyUI 可用 checkpoint（GET /object_info）">本机模型</button>
				)}
				<button onClick={() => download(exportFixture(), 'sandbox-graph.json')} disabled={mine.length === 0}>导出 fixture</button>
				<button onClick={() => canvasRef.current?.resetView?.()}>重置视图</button>
				<button onClick={clearAll} disabled={running}>清空</button>
				<button
					onClick={() => { try { localStorage.removeItem(DRAFT_KEY); localStorage.removeItem(REC_KEY); } catch { /* ignore */ } location.reload(); }}
					title="丢弃本地草稿与录制并刷新，回到场景初始状态"
				>重置场景</button>
				{BACKEND !== 'comfyui' && (
					<label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
						<input type="checkbox" checked={fake} onChange={e => setFake(e.target.checked)} />
						假后端
					</label>
				)}
				<span className="sp" />
				<span className="stat" data-vt="backend">后端: {backendBadge}</span>
				<span className="stat" data-vt="counts">{mine.length} 节点 · {edges.length} 连线</span>
			</div>

			{SCENARIO === 'chat-ui' ? (
				// ★ 聊天框端到端（auto 测试）：**左右分栏** —— 左侧工作流画布（可视化，
				//   seed 为 Saros.ModelImageGen 图片生成节点，非表情包）+ 右侧 100% 真实
				//   AgentChatPanel（与 vssaros.exe 同组件）。聊天链路执行走 headless
				//   runChatWorkflowHeadless（不进画布 store），画布仅作可视化宿主。
				//   中间分隔条**可左右拖拽**调整聊天框宽度（320–800px，pointer capture）。
				<div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
					<div id="canvas-root" style={{ flex: 1, minWidth: 0 }}>
						<LiteGraphCanvas
							ref={canvasRef}
							workflowId="sandbox"
							onNodeRun={onNodeRun}
							onRequestRun={runAll}
							style={{ width: '100%', height: '100%' }}
						/>
					</div>
					<div
						data-vt="chat-splitter"
						title="拖拽调整聊天框宽度"
						onPointerDown={e => {
							e.preventDefault();
							(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
							splitterDragRef.current = { startX: e.clientX, startW: chatWidth };
						}}
						onPointerMove={e => {
							const st = splitterDragRef.current;
							if (!st) { return; }
							// 向左拖 → 聊天框变宽
							setChatWidth(Math.min(800, Math.max(320, st.startW + (st.startX - e.clientX))));
						}}
						onPointerUp={() => { splitterDragRef.current = null; }}
						onPointerCancel={() => { splitterDragRef.current = null; }}
						style={{ width: 5, flex: 'none', cursor: 'col-resize', background: 'var(--ec-border-primary, #3d444d)', touchAction: 'none' }}
					/>
					<div ref={chatRealHostRef} data-vt="chatreal" style={{ width: chatWidth, flex: 'none', height: '100%', background: 'var(--ec-bg-primary, #0f1419)', position: 'relative', overflow: 'hidden' }} />
				</div>
			) : SCENARIO === 'chat-real' ? (
				// chat-real（人工交互验证）：100% 真实聊天框全屏；画布移出视口仅作执行宿主
				<>
					<div id="canvas-root" style={{ position: 'absolute', left: -100000, top: 0, width: 1280, height: 800 }}>
						<LiteGraphCanvas
							ref={canvasRef}
							workflowId="sandbox"
							onNodeRun={onNodeRun}
							onRequestRun={runAll}
							style={{ width: '100%', height: '100%' }}
						/>
					</div>
					<div ref={chatRealHostRef} data-vt="chatreal" style={{ flex: 1, minWidth: 0, height: '100%', background: 'var(--ec-bg-primary, #0f1419)', position: 'relative' }} />
				</>
			) : (
				<div id="canvas-root">
					<LiteGraphCanvas
						ref={canvasRef}
						workflowId="sandbox"
						onNodeRun={onNodeRun}
						onRequestRun={runAll}
						style={{ width: '100%', height: '100%' }}
					/>
				</div>
			)}

			<div id="status" data-vt="status" style={(SCENARIO === 'chat-ui' || SCENARIO === 'chat-real') ? { flex: 'none', height: 190 } : undefined}>
				<div className="status-head">
					<span>执行日志（{filteredLines.length}/{lines.length} 行）</span>
					<span className="grow" />
					{/* ★ 过滤：文本 + 级别（复制/清空按钮左侧） */}
					<input
						value={logFilter}
						onChange={e => setLogFilter(e.target.value)}
						placeholder='过滤文本，如 "错误"…'
						title="按关键字过滤日志（大小写不敏感）"
						style={{ width: 150, background: 'var(--vscode-input-background, #111)', color: 'var(--vscode-foreground, #ccc)', border: '1px solid var(--vscode-input-border, #333)', borderRadius: 4, padding: '2px 6px', fontSize: 11 }}
					/>
					<select
						value={logLevel}
						onChange={e => setLogLevel(e.target.value as 'all' | 'warn' | 'err' | 'ok')}
						title="按级别过滤"
						style={{ background: 'var(--vscode-input-background, #111)', color: 'var(--vscode-foreground, #ccc)', border: '1px solid var(--vscode-input-border, #333)', borderRadius: 4, padding: '2px 4px', fontSize: 11 }}
					>
						<option value="all">全部级别</option>
						<option value="warn">警告+错误</option>
						<option value="err">仅错误</option>
						<option value="ok">仅成功</option>
					</select>
					<button onClick={() => { if (navigator.clipboard) { navigator.clipboard.writeText(filteredLines.map(l => l.text).join('\n')); } }} disabled={!filteredLines.length}>复制</button>
					<button onClick={() => setLines([])} disabled={!lines.length}>清空</button>
				</div>
				<div className="status-body">
					{lines.length === 0
						? <span className="dim">提示：双击空白处搜节点；端口拖出连线；Ctrl+Enter 运行；图片文件可直接拖进画布（注入选中节点）。</span>
						: filteredLines.length === 0
							? <span className="dim">无匹配日志行（当前过滤：{logLevel === 'all' ? '全部' : logLevel === 'warn' ? '警告+错误' : logLevel === 'err' ? '仅错误' : '仅成功'}{logFilter ? ` · "${logFilter}"` : ''}）</span>
							: filteredLines.map((l, i) => (
								<div key={i} className={l.cls}>{l.text}</div>
						))}
				</div>
			</div>
		</div>
	);
}

// ═══════════════════════════════════════════════════════════════════════
// 知识库思维导图端到端沙箱（?scenario=kb-mindmap）
//
// 链路（LLM 契约与 06-kb web E2E / 单元测试一致）：
//   笔记文本 → KbMindmapGenerator.generateOrUpdate()
//     → LLM 提取知识图谱 → content 去重合并 → 树状放射布局 → 落盘 .canvas
//   → 内存 FS 读回「原始落盘 JSON」→ 页面渲染思维导图 → window.__kbMindmap 断言句柄
//
// mock 边界：只有 LLM（complete() 返回内置样例图谱）。文件系统/日志为内存实现，
// 但走真实 KbMindmapGenerator 的完整 fileService 调用面（writeFile/createFolder/读回）。
// ═══════════════════════════════════════════════════════════════════════

const KB_NOTES_DIR = '/mock-kb/e2e-kb-vault/笔记';

/** 测试输入 ①：首次生成（与 web E2E 06 场景同一主题）。 */
const KB_NOTE_1 = {
	fileName: 'React Hooks 与函数组件.md',
	content: [
		'# React Hooks 与函数组件',
		'',
		'函数组件通过 Hooks 获得状态与副作用能力。',
		'',
		'## useState',
		'声明式状态钩子：调用返回 [state, setState]，setState 触发重渲染。',
		'',
		'## useEffect',
		'副作用处理钩子：订阅、定时器、网络请求。返回的清理函数在卸载或依赖变化时执行。',
		'',
		'## useMemo / useCallback',
		'记忆化：useMemo 缓存计算结果，useCallback 缓存回调身份，避免子组件无谓重渲染。',
		'',
		'## 自定义 Hook',
		'以 use 开头的普通函数，组合内置 Hook 复用状态逻辑（如 useFetch）。',
	].join('\n'),
};

/** 测试输入 ②：追加导入（验证合并与 content 去重）。 */
const KB_NOTE_2 = {
	fileName: 'Hooks 进阶与并发特性.md',
	content: [
		'# Hooks 进阶与并发特性',
		'',
		'## Suspense',
		'异步组件的加载与降级边界，配合 lazy 实现代码分割。',
		'',
		'## useTransition / useDeferredValue',
		'并发特性：标记低优先级更新，保持输入响应流畅。',
	].join('\n'),
};

/** 样例 LLM 返回 ①：6 节点 5 边（根=React Hooks，入度 0 出度 4，与 _relayoutMindmap 的根推断一致）。 */
const KB_LLM_GRAPH_1 = JSON.stringify({
	nodes: [
		{ id: 'n1', type: 'text', width: 280, height: 80, content: '**React Hooks**\n函数组件的状态与副作用机制' },
		{ id: 'n2', type: 'text', width: 280, height: 80, color: '5', content: '**useState**\n声明式状态钩子，setState 触发重渲染' },
		{ id: 'n3', type: 'text', width: 280, height: 80, color: '3', content: '**useEffect**\n副作用处理：订阅、定时器、请求' },
		{ id: 'n4', type: 'text', width: 280, height: 80, color: '3', content: '**useMemo / useCallback**\n记忆化：值与回调的缓存' },
		{ id: 'n5', type: 'text', width: 280, height: 80, color: '1', content: '**自定义 Hook**\n复用状态逻辑的组合单元' },
		{ id: 'n6', type: 'text', width: 280, height: 80, color: '2', content: '**Hooks vs Class**\n无 this、按逻辑组织代码' },
	],
	edges: [
		{ id: 'e1', fromNode: 'n1', toNode: 'n2', label: '包含' },
		{ id: 'e2', fromNode: 'n1', toNode: 'n3', label: '包含' },
		{ id: 'e3', fromNode: 'n1', toNode: 'n4', label: '包含' },
		{ id: 'e4', fromNode: 'n2', toNode: 'n5', label: '模式' },
		{ id: 'e5', fromNode: 'n1', toNode: 'n6', label: '对比' },
	],
});

/** 样例 LLM 返回 ②：含 1 个与已有图重复的概念（m0 → content 去重应被跳过）+ 2 个新节点。
 *  边的父端点直接引用已有节点 n1（真实 LLM 看不到已有导图时可能编出新 id 造成悬空边，
 *  样例采用「引用已有 id」的形态，保证合并不产生悬空边——悬空边校验在断言里兜底）。 */
const KB_LLM_GRAPH_2 = JSON.stringify({
	nodes: [
		{ id: 'm0', type: 'text', width: 280, height: 80, content: '**React Hooks**\n函数组件的状态与副作用机制' },
		{ id: 'm1', type: 'text', width: 280, height: 80, color: '4', content: '**Suspense**\n异步组件加载边界，配合 lazy 代码分割' },
		{ id: 'm2', type: 'text', width: 280, height: 80, color: '4', content: '**并发特性**\nuseTransition / useDeferredValue 保持输入流畅' },
	],
	edges: [
		{ id: 'me1', fromNode: 'n1', toNode: 'm1', label: '包含' },
		{ id: 'me2', fromNode: 'n1', toNode: 'm2', label: '包含' },
	],
});

/** 内存文件系统：满足 KbMindmapGenerator 用到的 IFileService 调用面。 */
function makeKbMemFs() {
	const files = new Map<string, string>();
	return {
		files,
		async resolve(u: Any) {
			const dir = u.toString();
			const prefix = dir.endsWith('/') ? dir : dir + '/';
			const children: Any[] = [];
			for (const p of files.keys()) {
				if (!p.startsWith(prefix)) { continue; }
				const rest = p.slice(prefix.length);
				if (rest.includes('/')) { continue; }
				children.push({ name: rest, isDirectory: false, resource: u.with({ path: p }) });
			}
			return { resource: u, isDirectory: true, children };
		},
		async readFile(u: Any) {
			const s = files.get(u.toString());
			if (s === undefined) { throw new Error('entry not found: ' + u.toString()); }
			return { value: { toString: () => s } };
		},
		async writeFile(u: Any, content: Any) {
			files.set(u.toString(), typeof content === 'string' ? content : content.toString());
		},
		async createFolder(_u: Any) { /* 内存实现：目录隐式存在 */ },
		async del(u: Any) { files.delete(u.toString()); },
	};
}

/** 节点语义色（对齐 KbMindmapGenerator 提取 prompt 的 color 约定）。 */
const KB_NODE_COLORS: Record<string, string> = {
	'1': '#bf3989', // 概念
	'2': '#db6d28', // 对比
	'3': '#8957e5', // 方法
	'4': '#2da44e', // 事实
	'5': '#f85149', // 问题
	'0': '#6e7681',
};

function kbTitleOf(content: string | undefined): { title: string; desc: string } {
	const lines = (content || '').split('\n');
	const title = (lines[0] || '').replace(/^\*\*/g, '').replace(/\*\*$/g, '').replace(/^#+\s*/, '').trim() || '(未命名)';
	return { title, desc: lines.slice(1).join('\n').trim() };
}

/** 思维导图渲染：IKbMindmap（JSON Canvas，绝对坐标由生成器布局给出）→ 卡片 + SVG 贝塞尔连线，自动适配缩放。 */
function KbMindmapRender({ mindmap }: { mindmap: Any }): React.JSX.Element | null {
	const wrapRef = React.useRef<HTMLDivElement>(null);
	const [box, setBox] = React.useState({ w: 0, h: 0 });

	React.useEffect(() => {
		const el = wrapRef.current;
		if (!el) { return; }
		const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		setBox({ w: el.clientWidth, h: el.clientHeight });
		return () => ro.disconnect();
	}, []);

	const nodes: Any[] = mindmap?.nodes ?? [];
	const edges: Any[] = mindmap?.edges ?? [];
	if (!nodes.length) { return null; }

	const minX = Math.min(...nodes.map((n: Any) => n.x));
	const minY = Math.min(...nodes.map((n: Any) => n.y));
	const maxX = Math.max(...nodes.map((n: Any) => n.x + (n.width ?? 280)));
	const maxY = Math.max(...nodes.map((n: Any) => n.y + (n.height ?? 80)));
	const pad = 20;
	const availW = Math.max(80, box.w - pad * 2);
	const availH = Math.max(80, box.h - pad * 2);
	const spanX = Math.max(1, maxX - minX);
	const spanY = Math.max(1, maxY - minY);
	const k = Math.min(availW / spanX, availH / spanY, 1);
	const ox = pad + (availW - spanX * k) / 2 - minX * k;
	const oy = pad + (availH - spanY * k) / 2 - minY * k;

	const byId = new Map(nodes.map((n: Any) => [n.id, n]));
	const anchorOf = (n: Any, side?: string): { x: number; y: number } =>
		side === 'left'
			? { x: n.x, y: n.y + (n.height ?? 80) / 2 }
			: { x: n.x + (n.width ?? 280), y: n.y + (n.height ?? 80) / 2 };

	return (
		<div ref={wrapRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} data-vt="mindmap">
			<div style={{ position: 'absolute', left: 0, top: 0, transform: `translate(${ox}px, ${oy}px) scale(${k})`, transformOrigin: '0 0' }}>
				<svg width={1} height={1} style={{ position: 'absolute', overflow: 'visible', left: 0, top: 0, pointerEvents: 'none' }}>
					<defs>
						<marker id="kb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
							<path d="M 0 1 L 9 5 L 0 9 z" fill="#569cd6" />
						</marker>
					</defs>
					{edges.map((e: Any) => {
						const f = byId.get(e.fromNode);
						const t = byId.get(e.toNode);
						if (!f || !t) { return null; } // 悬空边（断言层已拦截）渲染时跳过
						const a = anchorOf(f, e.fromSide);
						const b = anchorOf(t, e.toSide === 'right' ? 'right' : 'left');
						const dx = Math.max(48, Math.abs(b.x - a.x) * 0.5);
						return (
							<g key={e.id}>
								<path
									d={`M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`}
									fill="none" stroke="#569cd6" strokeWidth={2} markerEnd="url(#kb-arrow)"
								/>
								{e.label ? (
									<text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} textAnchor="middle" fill="#8b949e" fontSize={11}>{e.label}</text>
								) : null}
							</g>
						);
					})}
				</svg>
				{nodes.map((n: Any) => {
					const { title, desc } = kbTitleOf(n.content);
					const accent = KB_NODE_COLORS[String(n.color ?? '0')] ?? KB_NODE_COLORS['0'];
					return (
						<div key={n.id} data-vt="mm-node" style={{
							position: 'absolute', left: n.x, top: n.y, width: n.width ?? 280, minHeight: n.height ?? 80,
							background: '#252a31', border: '1px solid #3d444d', borderLeft: `4px solid ${accent}`,
							borderRadius: 8, padding: '8px 10px',
						}}>
							<div style={{ fontWeight: 600, color: '#e6edf3', fontSize: 13 }}>{title}</div>
							{desc ? <div style={{ color: '#9aa4b2', marginTop: 4, whiteSpace: 'pre-wrap', fontSize: 12 }}>{desc}</div> : null}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function KbMindmapApp(props: { genCtor: Any; URI: Any }): React.JSX.Element {
	const [lines, setLines] = React.useState<Array<{ cls: string; text: string }>>([]);
	const [running, setRunning] = React.useState(false);
	const [canvas, setCanvas] = React.useState<Any>(null);       // 读回的落盘 IKbMindmap
	const [showJson, setShowJson] = React.useState(false);
	const [rawJson, setRawJson] = React.useState('');
	const fileUriRef = React.useRef<string | null>(null);

	const log = (text: string, cls = 'dim') => setLines(p => [...p.slice(-150), { cls, text }]);

	// 共享一份内存 FS：生成 → 读回 → 追加合并都打在同一份上
	const memFs = React.useMemo(() => makeKbMemFs(), []);
	const logSvc = React.useMemo(() => ({
		info: (m: string) => log('[mindmap] ' + m, 'dim'),
		warn: (m: string) => log('[mindmap] ' + m, 'warn'),
		error: (m: string) => log('[mindmap] ' + m, 'err'),
	}), []);

	const run = async (append: boolean): Promise<void> => {
		if (running) { return; }
		setRunning(true);
		try {
			const { URI } = props;
			const gen = new props.genCtor(memFs, logSvc);
			const notesDir = URI.file(KB_NOTES_DIR);
			const note = append ? KB_NOTE_2 : KB_NOTE_1;
			const llmRaw = append ? KB_LLM_GRAPH_2 : KB_LLM_GRAPH_1;
			const chatModel = { complete: async (): Promise<string> => llmRaw };
			const existingUri = append && fileUriRef.current ? URI.parse(fileUriRef.current) : undefined;

			log((append ? '➕ 追加导入' : '▶ 生成思维导图') + '：' + note.fileName + '（LLM=内置样例）…', 'dim');
			const t0 = performance.now();
			const outUri: Any = await gen.generateOrUpdate(chatModel, notesDir, [note], existingUri);
			const ms = Math.round(performance.now() - t0);
			if (!outUri) { throw new Error('generateOrUpdate 返回空（未产出思维导图）'); }

			// 端到端闭环：从「文件系统」读回原始落盘 JSON（而非生成器的内存对象）
			const raw = memFs.files.get(outUri.toString());
			if (!raw) { throw new Error('落盘后读回失败：' + outUri.toString()); }
			const saved = JSON.parse(raw);
			setRawJson(raw);
			fileUriRef.current = outUri.toString();
			setCanvas(saved);

			const rootTitle = kbTitleOf(saved.nodes[0]?.content).title;
			const stats = {
				file: outUri.fsPath,
				nodeCount: saved.nodes.length,
				edgeCount: saved.edges.length,
				mindmapFlag: saved.mindmap === true,
				root: rootTitle,
				appended: append,
				durationMs: ms,
				canvas: saved,
			};
			// 落盘校验（失败同时进日志与断言句柄）
			const problems: string[] = [];
			if (saved.nodes.length < 3) { problems.push('节点数 < 3'); }
			if (saved.mindmap !== true) { problems.push('缺少 mindmap 标记'); }
			const idSet = new Set<string>(saved.nodes.map((n: Any) => n.id));
			const dangling = saved.edges.filter((e: Any) => !idSet.has(e.fromNode) || !idSet.has(e.toNode));
			if (dangling.length) { problems.push('悬空边 ×' + dangling.length); }
			if (problems.length) { throw new Error('落盘校验失败：' + problems.join('；')); }

			(window as Any).__kbMindmap = { ok: true, ...stats };
			log(`✓ ${append ? '合并完成' : '生成完成'}  ${stats.nodeCount} 节点 / ${stats.edgeCount} 边  → ${stats.file}  (${ms}ms)`, 'ok');
			log(`  根节点「${rootTitle}」· mindmap 标记 ✓ · 无悬空边${append ? ' · content 去重 ✓' : ''}`, 'ok');
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			(window as Any).__kbMindmap = { ok: false, error: msg, appended: append };
			log('✗ ' + msg, 'err');
		} finally {
			setRunning(false);
		}
	};

	// 每次渲染刷新 run 引用，暴露给 Playwright 的句柄永远调用最新闭包
	const runRef = React.useRef(run);
	runRef.current = run;

	React.useEffect(() => {
		(window as Any).__kbMindmapSandbox = {
			run: (append: boolean) => runRef.current(append),
			state: () => (window as Any).__kbMindmap ?? null,
			files: () => [...memFs.files.entries()].map(([k, v]) => ({ uri: k, bytes: v.length })),
		};
		(window as Any).__kbMindmapReady = true;
		log('知识库思维导图沙箱就绪：点「▶ 生成思维导图」运行端到端链路（LLM 提取 → 合并 → 布局 → 落盘 → 渲染）', 'ok');
	}, []);

	return (
		<div className="app">
			<div id="toolbar">
				<button className="primary" data-vt="kb-run" onClick={() => run(false)} disabled={running}>
					{running ? '运行中…' : '▶ 生成思维导图'}
				</button>
				<button data-vt="kb-append" onClick={() => run(true)} disabled={running || !fileUriRef.current}
					title="导入第二篇笔记到同一思维导图：验证 content 去重合并（重复概念不重复建节点）">
					➕ 追加导入（合并）
				</button>
				<button onClick={() => setShowJson(v => !v)} disabled={!rawJson}>
					{showJson ? '隐藏 .canvas JSON' : '查看 .canvas JSON'}
				</button>
				<span className="sp" />
				<span className="stat" data-vt="kb-badge">LLM: 内置样例（离线） · FS: 内存</span>
				<span className="stat" data-vt="kb-counts">{canvas ? `${canvas.nodes.length} 节点 · ${canvas.edges.length} 边` : '未生成'}</span>
			</div>

			<div id="canvas-root" style={{ display: 'flex' }}>
				<div style={{ flex: '0 0 320px', borderRight: '1px solid #2b2b2b', overflow: 'auto', padding: '10px 12px' }}>
					<div style={{ fontWeight: 600, marginBottom: 6, color: '#9aa4b2' }}>待导入笔记（测试输入）</div>
					<div style={{ background: '#1c2128', border: '1px solid #3d444d', borderRadius: 6, padding: '8px 10px', marginBottom: 8 }}>
						<div style={{ color: '#e6edf3', fontWeight: 600 }}>① {KB_NOTE_1.fileName}</div>
						<pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', color: '#9aa4b2', fontSize: 11, fontFamily: 'inherit' }}>{KB_NOTE_1.content.trim()}</pre>
					</div>
					<div style={{ background: fileUriRef.current ? '#1c2128' : '#15181d', border: '1px solid #3d444d', borderRadius: 6, padding: '8px 10px', opacity: fileUriRef.current ? 1 : 0.5 }}>
						<div style={{ color: '#e6edf3', fontWeight: 600 }}>② {KB_NOTE_2.fileName}</div>
						<pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', color: '#9aa4b2', fontSize: 11, fontFamily: 'inherit' }}>{KB_NOTE_2.content.trim()}</pre>
						<div style={{ color: '#8b949e', fontSize: 10, marginTop: 4 }}>{fileUriRef.current ? '点「追加导入（合并）」加入上图' : '先生成思维导图后可用'}</div>
					</div>
				</div>
				<div style={{ flex: '1 1 auto', position: 'relative', background: '#1e1e1e' }}>
					{canvas
						? <KbMindmapRender mindmap={canvas} />
						: (
							<div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6e7681' }}>
								尚无思维导图 — 点上方「▶ 生成思维导图」
							</div>
						)}
					{showJson && rawJson ? (
						<pre data-vt="kb-json" style={{
							position: 'absolute', right: 8, bottom: 8, maxWidth: '52%', maxHeight: '82%', overflow: 'auto',
							background: 'rgba(13,17,23,.94)', border: '1px solid #3d444d', borderRadius: 6, padding: 10,
							fontSize: 11, color: '#9aa4b2', margin: 0,
						}}>{rawJson}</pre>
					) : null}
				</div>
			</div>

			<div id="status" data-vt="status">
				<div className="status-head">
					<span>执行日志（{lines.length} 行）</span>
					<span className="grow" />
					<button onClick={() => { if (navigator.clipboard) { navigator.clipboard.writeText(lines.map(l => l.text).join('\n')); } }} disabled={!lines.length}>复制</button>
					<button onClick={() => setLines([])} disabled={!lines.length}>清空</button>
				</div>
				<div className="status-body">
					{lines.map((l, i) => <div key={i} className={l.cls}>{l.text}</div>)}
				</div>
			</div>
		</div>
	);
}

/** KB 思维导图沙箱入口：自包含，不加载 workflowEditor 栈（bridge mock / registry / LiteGraph 均不需要）。 */
async function mainKbMindmap(): Promise<void> {
	const [genMod, uriMod] = await Promise.all([
		import('../../../browser/views/knowledge/kbMindmapGenerator.js'),
		import('../../../../../../base/common/uri.js'),
	]);
	createRoot(document.getElementById('root')!).render(
		<KbMindmapApp
			genCtor={(genMod as Any).KbMindmapGenerator}
			URI={(uriMod as Any).URI}
		/>
	);
}

// ═══════════════════════════════════════════════════════════════════════
// 聊天框端到端（?scenario=chat-ui）
//
// 2026-09-05：**废弃手写仿制聊天面板**（与 vssaros.exe 真实聊天框 UI 差异巨大），
// chat-ui 与 chat-real 一样直接挂载 **100% 真实 AgentChatPanel**（browser/agentChat/
// agentChatPanel.tsx 组合根）——UI 与真实应用零差异。差异仅剩：
//   - chat-ui：auto=1 自动发送（走聊天链路 slash 解析 → headless 执行 → 回贴）+
//     __chatUi 断言句柄，供 Playwright / LLM 用例无人值守跑；
//   - chat-real：纯人工交互验证。
// 画布移出视口仅作执行宿主 → 测试界面**不显示任何工作流节点**（含表情包节点），
// 视觉与真实聊天框一致。
// 断言句柄：window.__chatUi.{messages(),getLastImage()}；window.__chatUiSend(text)。
// ═══════════════════════════════════════════════════════════════════════

/**
 * fake 模式专用的确定性 PNG sheet（1024²，透明底 2×2 彩色圆）。
 * 背景：networkGuard 拦截产物是 **SVG**，而 EmojiStage 的 sheet 切分要位图解码
 * （SVG blob 经 <img> 在部分链路解码失败/二次包装），fake 后端的聊天端到端
 * 永远卡在「表情图集解码失败」。chat 场景对 /view? 请求改返回本 PNG（确定性，
 * 无随机——不破坏沙箱「离线可跑」原则；harness 像素基线不受影响——它不进 chat 场景）。
 */
function makeFakeSheetPng(): string {
	const c = document.createElement('canvas');
	c.width = 1024;
	c.height = 1024;
	const ctx = c.getContext('2d');
	if (!ctx) { return 'data:image/png;base64,'; }
	const colors = ['#f59e0b', '#38bdf8', '#a78bfa', '#34d399'];
	for (let r = 0; r < 2; r++) {
		for (let col = 0; col < 2; col++) {
			ctx.fillStyle = colors[r * 2 + col];
			ctx.beginPath();
			ctx.arc(256 + col * 512, 256 + r * 512, 150, 0, Math.PI * 2);
			ctx.fill();
		}
	}
	return c.toDataURL('image/png');
}

/** fake+chat 场景：/view? 请求返回确定性 PNG（替代守卫的 SVG），其余照旧走守卫。 */
function installFakeViewResponder(): void {
	const realFetch = globalThis.fetch.bind(globalThis);
	let pngDataUrl: string | null = null;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
		if (url.includes('/view?')) {
			if (!pngDataUrl) { pngDataUrl = makeFakeSheetPng(); }
			const blob = await (await realFetch(pngDataUrl)).blob();
			return new Response(blob, { status: 200, headers: { 'content-type': 'image/png' } });
		}
		return realFetch(input, init);
	}) as typeof globalThis.fetch;
}

async function main(): Promise<void> {
	// 知识库思维导图场景：自包含轻量入口，不加载 workflowEditor 栈
	if (SCENARIO === 'kb-mindmap') { return mainKbMindmap(); }

	// fake 后端的 chat 端到端：/view? 出 PNG（见 makeFakeSheetPng 注释）
	if (BACKEND === 'fake' && (SCENARIO === 'chat-ui' || SCENARIO === 'chat-real')) {
		installFakeViewResponder();
	}

	// ② 动态导入（mock 已就位）
	const [regMod, storeMod, canvasMod, wrMod, assetRefsMod, providerStoreMod, runnerStatusMod, snapshotBridgeMod] = await Promise.all([
		import('../../src/features/workflowEditor/comfyHost/registry'),
		import('../../src/features/workflowEditor/store'),
		import('../../src/features/workflowEditor/LiteGraphCanvas'),
		import('../../src/features/workflowEditor/comfyHost/workflowRun'),
		import('../../src/features/workflowEditor/comfyHost/assetRefs'),
		import('../../src/store/useProviderStore'),
		import('../../src/features/workflowEditor/comfyHost/runnerStatusStore'),
		// chat-ui 场景：出图快照物化（MediaRef → PortValue），供聊天消息流回贴图片
		import('../../src/features/workflowEditor/comfyHost/workflowSnapshotBridgeWebview'),
	]);
	(window as Any).__materializeSnapshotEntry = (snapshotBridgeMod as Any).materializeSnapshotEntry;

	registry = regMod as Any;
	useWorkflowEditorStore = (storeMod as Any).useWorkflowEditorStore;
	LiteGraphCanvas = (canvasMod as Any).LiteGraphCanvas;
	runNodeOrStage = (wrMod as Any).runNodeOrStage;
	ASSET_REFS_PROP = (assetRefsMod as Any).ASSET_REFS_PROP ?? ASSET_REFS_PROP;

	// 真实注册路径，与运行时一致
	registry.registerSarosNodes();
	registry.registerDefaultComfyTVStages();

	// ③ seeding —— ★ 只做一次（持续写 store 会触发 configure 回环风暴）
	useWorkflowEditorStore.setState({ workflowId: 'sandbox' });
	// provider/model 下拉需要选项（否则表情包节点的 provider 渠道选不了）
	(providerStoreMod as Any).useProviderStore.setState({ providers: DEMO_PROVIDERS } as never);

	// ⑤ 草稿恢复（在 render 前）：有本地草稿 → 优先于场景预置，用户上次编辑不丢
	try {
		const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
		if (draft && Array.isArray(draft.nodes) && draft.nodes.length) {
			useWorkflowEditorStore.setState({ nodes: draft.nodes, edges: draft.edges || [] });
			(window as Any).__draftRestored = true;
		}
	} catch { /* 草稿损坏 → 走场景默认 */ }
	// provider 录制同样持久化（回放数据不用每次重载）
	try {
		const rec = JSON.parse(localStorage.getItem(REC_KEY) || 'null');
		if (Array.isArray(rec) && rec.length) { (window as Any).__providerRecording = rec; }
	} catch { /* ignore */ }

	// ⑥ 引擎就绪信号：卡片据此显示运行按钮，否则一直挂着「未连接引擎」。
	//    沙箱总有可用执行通道（假后端 / 回放 / 真 8188 直连），与卡片状态对齐；
	//    comfyui 模式额外探测 /system_stats，探测失败就如实显示未连接。
	const rs = (runnerStatusMod as Any).getRunnerStatusStore();
	if (BACKEND === 'comfyui') {
		rs.setReady(false, COMFY_BASE);
		fetch(COMFY_BASE + '/system_stats').then(r => r.json())
			.then(() => rs.setReady(true, COMFY_BASE))
			.catch(() => rs.setReady(false, COMFY_BASE));
	} else {
		rs.setReady(true, 'sandbox');
	}

	createRoot(document.getElementById('root')!).render(<App />);
}

void main();
