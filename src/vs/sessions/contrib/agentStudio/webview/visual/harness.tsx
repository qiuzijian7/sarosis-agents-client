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
	const [registry, nodeCardMod, snapMod, cardStateMod, stageCardMod] = await Promise.all([
		import('../src/features/workflowEditor/comfyHost/registry'),
		import('../src/features/workflowEditor/comfyHost/nodeCard'),
		import('../src/features/workflowEditor/comfyHost/mediaSnapshotStore'),
		import('../src/features/workflowEditor/comfyHost/cardState'),
		import('../src/features/workflowEditor/comfyHost/stageCardRegistry'),
	]);

	// 填充 registry（真实注册路径，与运行时一致）
	registry.registerSarosNodes();
	registry.registerDefaultComfyTVStages();

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

		root.appendChild(cell);

		try {
			const meta = mountScenario(sc, host, nodeCardMod, snapMod, cardStateMod, registry);
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
): ReturnType<NodeCardMod['getNodeCardMeta']> {
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
	return meta;
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
	return props;
}

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
