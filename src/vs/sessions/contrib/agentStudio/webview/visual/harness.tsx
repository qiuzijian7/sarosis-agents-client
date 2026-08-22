/*---------------------------------------------------------------------------------------------
 *  visual/harness — 节点卡片可视化画廊。
 *
 *  ★ 加载顺序（不可调换）：
 *      1. installBridgeMock()      —— nodeCard 顶层解构 __vssarosBridge，必须先装
 *      2. await import(nodeCard)   —— 动态导入，确保 mock 已生效
 *
 *  渲染两种视图：
 *    - 画廊（默认）：所有节点 × 所有状态的卡片网格
 *    - 聚焦（?only=<type>&state=<s>）：单卡片居中，供 Playwright 逐个截图
 *
 *  每个卡片外层带 `data-vt-*` 属性，作为 DOM 契约断言的锚点。
 *--------------------------------------------------------------------------------------------*/

import { installBridgeMock, installNetworkGuard, fakeImageDataUrl } from './mocks';
import { createRoot } from 'react-dom/client';

// ① mock 先行 —— 在任何 nodeCard 相关模块被求值之前
const bridge = installBridgeMock();
const netGuard = installNetworkGuard();

import {
	buildScenarios,
	upstreamImageRefs,
	ownOutputRefs,
	ALL_RUN_STATES,
	UPSTREAM_IMAGE_COUNT,
	type RunStateName,
	type VisualScenario,
} from './fixtures';

interface HarnessQuery {
	only?: string;
	state?: RunStateName;
	withUpstream: boolean;
}

/** spec 通过 addInitScript 注入的 ComfyTV 真实源码快照（nodeType → {html, css}）。 */
declare global {
	interface Window {
		__comfytvSnapshots?: Record<string, { html: string; css: string }>;
	}
}

function parseQuery(): HarnessQuery {
	const p = new URLSearchParams(location.search);
	const stateRaw = p.get('state');
	return {
		only: p.get('only') ?? undefined,
		state: ALL_RUN_STATES.includes(stateRaw as RunStateName) ? (stateRaw as RunStateName) : undefined,
		withUpstream: p.get('upstream') !== '0',
	};
}

async function main(): Promise<void> {
	const q = parseQuery();

	// ② 动态导入真实模块（mock 已就位）
	const [registry, nodeCardMod, snapMod, cardStateMod, stageCardMod, agentStoreMod, picklistStoreMod, providerStoreMod, refMod] = await Promise.all([
		import('../src/features/workflowEditor/comfyHost/registry'),
		import('../src/features/workflowEditor/comfyHost/nodeCard'),
		import('../src/features/workflowEditor/comfyHost/mediaSnapshotStore'),
		import('../src/features/workflowEditor/comfyHost/cardState'),
		import('../src/features/workflowEditor/comfyHost/stageCardRegistry'),
		import('../src/store/useAgentStore'),
		import('../src/features/workflowEditor/picklistStore'),
		import('../src/store/useProviderStore'),
		import('./comfyTvReference'),
	]);

	// 填充 registry（真实注册路径，与运行时一致）
	registry.registerSarosNodes();
	registry.registerDefaultComfyTVStages();

	// ★ 编排节点（Saros.Agent/Skill/Tool …）的 COMBO 下拉与身份卡从三个全局
	//   store 取实时选项（agentId/skillName/toolName → picks；providerId/modelId
	//   → providers）。不喂数据时这些控件永远显示 "—"，截图基线固定为"空下拉"，
	//   无法验证 resolveControlOptions 的双语义路由（LLM 不过滤 / 文生图过滤
	//   supportsImageGen）。seed 必须与 seedProperties 的 ORCH_PROP_SEEDS 对齐
	//   （下拉显示 label，属性值必须是选项 value = id）。
	agentStoreMod.useAgentStore.setState({ agents: DEMO_AGENTS } as never);
	picklistStoreMod.usePicklistStore.setState({
		skills: DEMO_SKILLS, tools: DEMO_TOOLS, skillsLoaded: true, toolsLoaded: true,
	} as never);
	providerStoreMod.useProviderStore.setState({ providers: DEMO_PROVIDERS } as never);

	const specs = registry.getAllSpecs();
	const scenarios = buildScenarios(specs, {
		only: q.only,
		states: q.state ? [q.state] : ALL_RUN_STATES,
		withUpstream: q.withUpstream,
	});

	const root = document.getElementById('root');
	if (!root) { throw new Error('#root missing'); }

	const focus = !!q.only;
	root.className = focus ? 'vt-focus' : 'vt-gallery';

	renderToolbar(specs.map(s => s.type), q, scenarios.length);

	for (const sc of scenarios) {
		const cell = document.createElement('div');
		cell.className = 'vt-cell';
		cell.setAttribute('data-vt-scenario', sc.id);
		cell.setAttribute('data-vt-node-type', sc.nodeType);
		cell.setAttribute('data-vt-state', sc.state);
		cell.setAttribute('data-vt-kind', sc.spec.kind);
		cell.setAttribute('data-vt-webgl', String(sc.needsWebGL));
		// 契约断言用：期望的端口 / widget 数
		cell.setAttribute('data-vt-inputs', String(sc.spec.inputs?.length ?? 0));
		cell.setAttribute('data-vt-outputs', String(sc.spec.outputs?.length ?? 0));
		cell.setAttribute('data-vt-widgets', String(sc.spec.widgets?.length ?? 0));
		cell.setAttribute('data-vt-upstream-images', String(sc.withUpstream ? UPSTREAM_IMAGE_COUNT : 0));

		const label = document.createElement('div');
		label.className = 'vt-label';
		label.textContent = `${sc.nodeType}  ·  ${sc.state}`;
		cell.appendChild(label);

		const host = document.createElement('div');
		host.className = 'vt-card-host';
		host.setAttribute('data-vt-card-host', sc.id);
		cell.appendChild(host);

		// ★ ComfyTV 参考卡（success 态并排渲染）：左参考（真源 token 直出）、
		//   右本项目卡。__vs 对比快照的 DOM 载体 + R15 对参考卡自身的断言锚点。
		if (sc.state === 'success') {
			const refHost = document.createElement('div');
			refHost.className = 'vt-ref-host';
			refHost.setAttribute('data-vt-ref-host', sc.id);
			cell.appendChild(refHost);
		}

		root.appendChild(cell);

		try {
			const { meta, properties } = mountScenario(sc, host, nodeCardMod, snapMod, cardStateMod, registry);
			// ★ 渲染 ComfyTV 参考卡（success 态）：优先用 ComfyTV 真实源码渲染的
			//   HTML 快照（iframe，由 spec 注入 window.__comfytvSnapshots），缺失时
			//   fallback 到手绘 token 参考卡。真实快照 = 「绘制 ComfyTV 源码节点 UI」。
			if (sc.state === 'success') {
				const refHost = cell.querySelector<HTMLElement>('[data-vt-ref-host]');
				if (refHost) {
					const snap = window.__comfytvSnapshots?.[sc.nodeType];
					if (snap) {
						renderComfytvSnapshot(refHost, sc.nodeType, snap);
					} else {
						const controls = (meta.controls ?? []).map(c => ({
							name: c.name,
							type: String(c.type ?? ''),
							value: String(properties[c.name] ?? ''),
						}));
						createRoot(refHost).render(refMod.ComfyTvReferenceCard({
							nodeType: sc.nodeType,
							title: sc.nodeType.replace(/^(ComfyTV|Saros)\./, ''),
							controls,
							hasPrompt: !!meta.hasPrompt,
							width: 280,
						}));
					}
				}
			}
			// ★ 契约期望值一律从 meta 派生（而非 spec）：meta 是卡片的真实渲染输入，
			//   已经过 hidden-fields / 专用编辑器路由过滤。用 spec 会产生大量误报
			//   （例如 material_state 被 MATERIAL_HIDDEN_FIELDS 故意隐藏）。
			cell.setAttribute('data-vt-meta-controls', String(meta.controls?.length ?? 0));
			cell.setAttribute('data-vt-meta-has-prompt', String(!!meta.hasPrompt));
			cell.setAttribute('data-vt-meta-is-picker', String(!!meta.isPicker));
			cell.setAttribute('data-vt-meta-actions', String(meta.actions?.length ?? 0));
			cell.setAttribute('data-vt-meta-inputs', String(meta.inputs?.length ?? 0));
			cell.setAttribute('data-vt-meta-outputs', String(meta.outputs?.length ?? 0));
			cell.setAttribute('data-vt-meta-control-names', (meta.controls ?? []).map(c => c.name).join(','));
			// ★ 由内嵌编辑器接管、故意不渲染通用控件的字段 —— 直接取 stageCardRegistry
			//   这个单一数据源，断言时据此豁免，避免"专用编辑器节点"整片误报。
			cell.setAttribute('data-vt-hidden-fields', [...stageCardMod.stageHiddenFields(sc.nodeType)].join(','));
			cell.setAttribute('data-vt-editor-kind', stageCardMod.stageEditorKind(sc.nodeType));
			// 卡片区块开关（hideOutput / hideActions …）—— 同为 stageCardRegistry 声明
			cell.setAttribute('data-vt-hide-output', String(!!stageCardMod.stageCardFlags(sc.nodeType).hideOutput));
			cell.setAttribute('data-vt-hide-actions', String(!!stageCardMod.stageCardFlags(sc.nodeType).hideActions));
			cell.setAttribute('data-vt-mounted', 'ok');
		} catch (err) {
			cell.setAttribute('data-vt-mounted', 'error');
			cell.setAttribute('data-vt-error', String(err instanceof Error ? err.message : err));
			const banner = document.createElement('pre');
			banner.className = 'vt-mount-error';
			banner.textContent = `MOUNT FAILED\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
			host.appendChild(banner);
		}
	}

	// 供 Playwright 等待：所有卡片挂载完毕 + 图片解码完毕
	await waitForImages(root);
	// ★ 冻结动画/过渡/光标 —— 必须在等图之后、置 ready 之前，
	//   否则 running 态进度条动画会让截图基线永远 diff（实测 98%）。
	document.body.setAttribute('data-vt-freeze', '1');
	// ★ 等布局收敛 —— 必须在 freeze 之后（freeze 本身会改变布局）。
	//   不等的话批量跑（780 场景连续 goto）会截到未收敛的中间态，
	//   卡片高度比稳定值小 17~25px，基线永远 diff。
	const settle = await waitForStableLayout(root);
	document.body.setAttribute('data-vt-settle', settle);
	document.body.setAttribute('data-vt-ready', 'true');
	document.body.setAttribute('data-vt-scenarios', String(scenarios.length));
	document.body.setAttribute('data-vt-blocked-requests', String(netGuard.blocked.length));
	document.body.setAttribute('data-vt-bridge-calls', String(bridge.calls.length));
}

/**
 * 渲染 ComfyTV 真实源码节点 UI 快照（iframe srcdoc）。
 * html/css 来自 ComfyTV 侧 `stageCardRender.test.ts` 导出的真实 StageCard DOM
 * （含 ctv: 前缀 tailwind 类）+ `@tailwindcss/cli` 生成的 ctv CSS。
 * 由 spec 在页面加载前通过 addInitScript 注入 window.__comfytvSnapshots。
 */
function renderComfytvSnapshot(
	refHost: HTMLElement,
	nodeType: string,
	snap: { html: string; css: string },
): void {
	const iframe = document.createElement('iframe');
	iframe.className = 'vt-comfytv-frame';
	iframe.setAttribute('data-vt-ref', 'iframe');
	iframe.setAttribute('title', `ComfyTV ${nodeType} 真源快照`);
	iframe.style.cssText = 'width:280px;border:none;display:block;background:#1e1e1e;';
	// 内容高度自适应：doc.write 完成后读 body.scrollHeight 设 iframe 高度
	iframe.addEventListener('load', () => {
		const body = iframe.contentDocument?.body;
		if (body) { iframe.style.height = `${Math.max(body.scrollHeight, 80)}px`; }
	});
	refHost.appendChild(iframe);
	const doc = iframe.contentDocument!;
	doc.open();
	doc.write(`<!doctype html><html><head><meta charset="utf-8">
<style>${snap.css}</style>
<style>
  html,body{margin:0;padding:0;background:#1e1e1e;color:#e0e0e0;
    font-family:'Segoe UI',system-ui,sans-serif;width:280px;}
  .vt-snap-root{width:280px;}
</style></head><body><div class="vt-snap-root">${snap.html}</div></body></html>`);
	doc.close();
}

type NodeCardMod = typeof import('../src/features/workflowEditor/comfyHost/nodeCard');
type SnapMod = typeof import('../src/features/workflowEditor/comfyHost/mediaSnapshotStore');
type CardStateMod = typeof import('../src/features/workflowEditor/comfyHost/cardState');
type RegistryMod = typeof import('../src/features/workflowEditor/comfyHost/registry');

function mountScenario(
	sc: VisualScenario,
	host: HTMLElement,
	nodeCardMod: NodeCardMod,
	snapMod: SnapMod,
	cardStateMod: CardStateMod,
	_registry: RegistryMod,
): { meta: ReturnType<NodeCardMod['getNodeCardMeta']>; properties: Record<string, unknown> } {
	// 每个场景独立 store，互不污染
	const snapshotStore = new snapMod.MediaSnapshotStore(snapMod.createMemoryBackend(), { persistent: true });
	const cardStateStore = new cardStateMod.CardStateStore();

	// 上游假图（picker pool / 内嵌编辑器背景图来源）
	if (sc.withUpstream) {
		const upId = sc.upstreamNodeIds[0];
		for (const ref of upstreamImageRefs()) {
			// skipImport=true：harness 没有 host 媒体库，避免触发 onAsset
			snapshotStore.put({ nodeId: upId, port: 'output', key: '', media: { kind: 'image', ref } }, true);
		}
	}

	// success 态：节点自身有输出
	if (sc.state === 'success') {
		for (const ref of ownOutputRefs(1)) {
			snapshotStore.put({ nodeId: sc.nodeId, port: 'output', key: '', media: { kind: 'image', ref } }, true);
		}
	}

	// 运行状态
	const stateMap: Record<RunStateName, Parameters<typeof cardStateStore.set>[1]> = {
		idle: { runState: 'idle', progress: 0 },
		running: { runState: 'running', progress: 42 },
		success: { runState: 'success', progress: 100, durationMs: 1234 },
		error: { runState: 'error', progress: 0, errorMsg: 'VISUAL-TEST: 模拟执行失败（后端返回 400）' },
	};
	cardStateStore.set(sc.nodeId, stateMap[sc.state]);

	// 节点属性：给 widget 塞确定性值，让控件都有可见状态
	const properties = seedProperties(sc);
	const meta = nodeCardMod.getNodeCardMeta(sc.spec, properties);

	nodeCardMod.createNodeCard(host, meta, {
		snapshotStore,
		cardStateStore,
		nodeId: sc.nodeId,
		upstreamNodeIds: sc.withUpstream ? sc.upstreamNodeIds : undefined,
	});
	return { meta, properties };
}

/** 给每个 widget 一个确定性值：控件才会渲染出"有值"的样子，且截图稳定。 */
function seedProperties(sc: VisualScenario): Record<string, unknown> {
	const props: Record<string, unknown> = {};
	for (const w of sc.spec.widgets ?? []) {
		if (w.default !== undefined) { props[w.name] = w.default; continue; }
		switch (w.type) {
			case 'INT': props[w.name] = 8; break;
			case 'FLOAT': props[w.name] = 1.5; break;
			case 'BOOLEAN': props[w.name] = false; break;
			case 'COMBO': props[w.name] = w.options?.[0] ?? ''; break;
			default: props[w.name] = '';
		}
	}
	if (sc.spec.widgets?.some(w => w.name === 'prompt')) {
		props.prompt = 'a cinematic portrait of a cat, 85mm, soft light';
	}
	// picker 默认选中第 1 张，pool 高亮才有确定性
	if (sc.spec.type.endsWith('PickerStage')) { props.selected_index = 1; }
	// ★ EmojiStage 每格状态种子（cells 是 TEXT 不进 controls，见 NodeCardMeta.cells
	//   注释）—— 覆盖「重启后 cells 透传」的读回路径。给前 3 格填独立 prompt/seed，
	//   其余格留空，dump 里「编辑 #0」应显示「格子 0 的独立描述」。
	if (sc.spec.type === 'ComfyTV.EmojiStage') {
		props.cells = JSON.stringify([
			{ prompt: '格子 0 的独立描述', seed: 42, text: '格0配文' },
			{ prompt: '格子 1 的独立描述', seed: 7, text: '' },
			{ prompt: '', seed: 0, text: '' },
		]);
	}
	// ★ 编排节点的动态 COMBO（agentId/providerId/modelId/skillName/toolName）
	//   没有静态 options，seedProperties 的 `w.options?.[0] ?? ''` 会给空串 →
	//   控件显示 "—"。这里用与 DEMO_* store 数据对齐的 id 覆盖，让下拉框
	//   渲染出真实选中项（也是 R13 combo-empty 断言的渲染前提）。
	const orchSeed = ORCH_PROP_SEEDS[sc.spec.type];
	if (orchSeed) { Object.assign(props, orchSeed); }
	return props;
}

/**
 * 编排节点属性种子：值 = DEMO_* store 数据里的 id（COMBO 的 value 是 id，
 * 显示的 label 才是 name）。两者错位时控件仍显示 "—"，R13 会拦下。
 */
const ORCH_PROP_SEEDS: Record<string, Record<string, unknown>> = {
	'Saros.Agent': { agentId: 'vt-agent', providerId: 'vt-openai', modelId: 'vt-gpt-4o' },
	'Saros.Skill': { skillName: 'vt-skill', task: '调研 ComfyTV 节点 UI 设计', skillArgs: '{"query":"comfytv"}' },
	'Saros.Tool': { toolName: 'vt-tool', toolParams: '{"pattern":"wf-comfy-card"}' },
};

/** 演示 agent 列表（确定性，与 ORCH_PROP_SEEDS.agentId 对齐）。 */
const DEMO_AGENTS = [{
	id: 'vt-agent',
	name: 'Visual Test Agent',
	role: '通用助手',
	description: 'visual harness 演示 agent（确定性数据）',
	icon: '🤖',
	category: 'builtin',
	systemPrompt: '',
	skills: [] as string[],
	tools: [] as string[],
}];

/** 演示 skills / tools（确定性，id 与 ORCH_PROP_SEEDS.skillName / toolName 对齐）。 */
const DEMO_SKILLS = [{
	id: 'vt-skill', name: 'VT Research Skill', category: 'research',
	activation: 'keyword', description: 'visual harness 演示技能',
}];
const DEMO_TOOLS = [{
	id: 'vt-tool', name: 'vt_search_code', description: 'visual harness 演示工具',
}];

/**
 * 演示 providers（确定性，id 与 ORCH_PROP_SEEDS.providerId/modelId 对齐）。
 * - vt-openai：纯 LLM provider（模型不带 supportsImageGen）—— 验证 Agent 节点
 *   的 LLM 语义「不过滤」（若误用文生图过滤，GPT-4o 会从 modelId 下拉消失）。
 * - vt-imagen：文生图 provider —— 验证 provider/model（文生图语义）的过滤分支。
 */
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

/** 等所有 <img> 解码完成（截图前必须），带超时兜底。 */
async function waitForImages(root: HTMLElement, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	// ★ 字体就绪：首个全新 browser context 打开时字体尚未加载，
	//   fallback 字体的行高与最终字体不同 → 卡片高度不同 → 基线 diff。
	try { await document.fonts?.ready; } catch { /* 不支持则跳过 */ }
	// 先等两帧，让 React effect + rAF 布局稳定
	await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
	for (;;) {
		const imgs = Array.from(root.querySelectorAll('img'));
		const pending = imgs.filter(i => !i.complete);
		if (pending.length === 0 || Date.now() > deadline) { break; }
		await Promise.race([
			Promise.all(pending.map(i => new Promise<void>(r => {
				i.addEventListener('load', () => r(), { once: true });
				i.addEventListener('error', () => r(), { once: true });
			}))),
			new Promise<void>(r => setTimeout(r, 500)),
		]);
	}
	// 再等一帧，让图片加载引起的高度回流（markFormHeightDirty）落地
	await new Promise<void>(r => requestAnimationFrame(() => r()));
}

/**
 * 等布局收敛：轮询所有卡片的高度签名，连续 N 次相同才认为稳定。
 *
 * 为什么必需：卡片高度有多个**异步**来源 —— React effect → `markFormHeightDirty`
 * → rAF 读 scrollHeight、ResizeObserver（TransformEditor / OutpaintEditor 的
 * 自适应宽度）、Three.js 首帧渲染。单节点手动跑时这些早已收敛，但批量跑
 * （780 场景连续 goto）会截到中间态 —— 实测卡片高度比稳定值小 17~25px，
 * 导致「刚生成的基线立刻重跑就全量 diff」。
 *
 * @returns 诊断字符串，写入 `data-vt-settle` 便于排查
 */
async function waitForStableLayout(root: HTMLElement, timeoutMs = 6000): Promise<string> {
	const REQUIRED_STABLE_ROUNDS = 3;
	const deadline = Date.now() + timeoutMs;
	const signature = (): string => Array.from(root.querySelectorAll('[data-vt-card-host]'))
		.map(el => (el as HTMLElement).offsetHeight)
		.join(',');
	let prev = signature();
	let stable = 0;
	let rounds = 0;
	while (Date.now() < deadline) {
		await new Promise<void>(r => requestAnimationFrame(() => r()));
		rounds++;
		const cur = signature();
		if (cur === prev) {
			if (++stable >= REQUIRED_STABLE_ROUNDS) { return `stable@${rounds}`; }
		} else {
			stable = 0;
			prev = cur;
		}
	}
	return `timeout@${rounds}`;
}

function renderToolbar(nodeTypes: string[], q: HarnessQuery, sceneCount: number): void {
	const bar = document.getElementById('toolbar');
	if (!bar) { return; }
	const opts = ['<option value="">（全部节点）</option>']
		.concat(nodeTypes.map(t => `<option value="${t}"${t === q.only ? ' selected' : ''}>${t}</option>`))
		.join('');
	const stateOpts = ['<option value="">（全部状态）</option>']
		.concat(ALL_RUN_STATES.map(s => `<option value="${s}"${s === q.state ? ' selected' : ''}>${s}</option>`))
		.join('');
	bar.innerHTML = `
		<strong>Node UI Visual Harness</strong>
		<select id="vt-only">${opts}</select>
		<select id="vt-state">${stateOpts}</select>
		<label><input type="checkbox" id="vt-upstream" ${q.withUpstream ? 'checked' : ''}/> 注入上游图</label>
		<span class="vt-count">${sceneCount} 场景</span>
		<span class="vt-hint">截图基线：<code>npm run visual:baseline</code></span>
	`;
	const apply = (): void => {
		const only = (document.getElementById('vt-only') as HTMLSelectElement).value;
		const state = (document.getElementById('vt-state') as HTMLSelectElement).value;
		const up = (document.getElementById('vt-upstream') as HTMLInputElement).checked;
		const p = new URLSearchParams();
		if (only) { p.set('only', only); }
		if (state) { p.set('state', state); }
		if (!up) { p.set('upstream', '0'); }
		location.search = p.toString();
	};
	document.getElementById('vt-only')?.addEventListener('change', apply);
	document.getElementById('vt-state')?.addEventListener('change', apply);
	document.getElementById('vt-upstream')?.addEventListener('change', apply);
}

void main().catch((err: unknown) => {
	document.body.setAttribute('data-vt-ready', 'error');
	document.body.setAttribute('data-vt-fatal', String(err instanceof Error ? err.message : err));
	const pre = document.createElement('pre');
	pre.className = 'vt-mount-error';
	pre.textContent = `HARNESS FATAL\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
	document.body.prepend(pre);
});

// 让 fakeImageDataUrl 在 devtools 里可用（手工调试假图）
(globalThis as unknown as Record<string, unknown>).__vtFakeImage = fakeImageDataUrl;
