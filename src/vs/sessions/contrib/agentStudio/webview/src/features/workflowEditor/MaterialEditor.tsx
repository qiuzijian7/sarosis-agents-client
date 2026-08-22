/*---------------------------------------------------------------------------------------------
 *  MaterialEditor — PBR material-ball editor (ComfyTV MaterialStage P3).
 *
 *  对齐 ComfyTV MaterialSphere.vue：three.js MeshPhysicalMaterial + RoomEnvironment
 *  环境贴图（PMREMGenerator），真实 PBR 材质球（金属/玻璃/clearcoat/ior/emissive）。
 *  数据契约 MaterialParams 11 字段对齐 ComfyTV types.ts。
 *  WebGL 不可用时降级 2D canvas renderMaterialBall。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { ComfyRunnerRegistry } from './comfyHost/comfyRunner';
import {
	applyPreset, DEFAULT_MATERIAL, MATERIAL_PRESETS, MATERIAL_SLIDERS,
	materialStateToJson, parseMaterialState, renderMaterialBall,
	type MaterialParams,
} from './comfyHost/materialEditor';

/** 预设显示名称（对齐 ComfyTV 截图中的 PRESETS 行标签） */
const PRESET_LABELS: Record<string, string> = {
	plasticGlossy: 'Glossy plastic',
	plasticMatte: 'Matte plastic',
	metalPolished: 'Polished metal',
	metalBrushed: 'Brushed metal',
	glassClear: 'Clear glass',
	glassFrosted: 'Frosted glass',
	rubber: 'Rubber',
	ceramic: 'Ceramic',
};

export interface MaterialEditorProps {
	initialState: string;
	/** runner 未连接时可为空：材质球编辑（本地 WebGL）不依赖后端，
	 *  只有「上传渲染图」这一步需要 runner，缺失时静默跳过。 */
	runners?: ComfyRunnerRegistry;
	preference: string;
	onStateChange: (json: string) => void;
	onRenderUploaded: (url: string | null) => void;
}

const VIEW = 320;
const UPLOAD_DEBOUNCE_MS = 1000;
const BALL_R_2D = 110;

const inputStyle: React.CSSProperties = {
	background: '#111', color: '#e6e6e6', border: '1px solid rgba(255,255,255,.14)',
	borderRadius: 5, padding: '4px 7px', fontSize: 12, outline: 'none',
	// ★ flex/grid 收缩：input 默认 min-width（浏览器 UA ~170px）会撑破窄列
	//   （COLOR 行 flex:1 的 hex 输入在 80px 标签列的 1fr 里溢出 4px，visual
	//   R2 实测）。minWidth:0 让 flex:1 的 input 能收缩到列宽。
	minWidth: 0,
};

function applyMaterialParams(mat: THREE.MeshPhysicalMaterial, p: MaterialParams): void {
	mat.color.set(p.color);
	mat.metalness = p.metalness;
	mat.roughness = p.roughness;
	mat.transmission = p.transmission;
	mat.opacity = p.opacity;
	mat.transparent = p.opacity < 1;
	mat.clearcoat = p.clearcoat;
	mat.clearcoatRoughness = p.clearcoatRoughness;
	mat.ior = p.ior;
	mat.emissive.set(p.emissive);
	mat.emissiveIntensity = p.emissiveIntensity;
}

export function MaterialEditor({ initialState, runners, preference, onStateChange, onRenderUploaded }: MaterialEditorProps): React.JSX.Element {
	const [params, setParams] = React.useState<MaterialParams>(() => parseMaterialState(initialState));
	const [webglFailed, setWebglFailed] = React.useState(false);
	const containerRef = React.useRef<HTMLDivElement>(null);
	const canvas2dRef = React.useRef<HTMLCanvasElement>(null);
	const uploadTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const runnersRef = React.useRef(runners); runnersRef.current = runners;
	const preferenceRef = React.useRef(preference); preferenceRef.current = preference;
	const paramsRef = React.useRef(params); paramsRef.current = params;

	const threeRef = React.useRef<{
		renderer: THREE.WebGLRenderer;
		scene: THREE.Scene;
		camera: THREE.PerspectiveCamera;
		material: THREE.MeshPhysicalMaterial;
		sphere: THREE.Mesh;
		envTexture: THREE.Texture;
		animationId: number;
	} | null>(null);

	// ── three.js init（对齐 MaterialSphere.vue）────────────────────────────
	React.useEffect(() => {
		const container = containerRef.current;
		if (!container) { return; }
		let renderer: THREE.WebGLRenderer;
		try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
		catch { setWebglFailed(true); return; }
		renderer.setSize(VIEW, VIEW);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		renderer.domElement.style.display = 'block';
		container.appendChild(renderer.domElement);

		const scene = new THREE.Scene();
		scene.background = new THREE.Color(0x1c1c22);

		const pmrem = new THREE.PMREMGenerator(renderer);
		const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		pmrem.dispose();
		scene.environment = envTexture;

		const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
		camera.position.set(0, 0.35, 3.6);
		camera.lookAt(0, 0, 0);

		const material = new THREE.MeshPhysicalMaterial({ thickness: 1 });
		const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), material);
		scene.add(sphere);
		applyMaterialParams(material, paramsRef.current);

		threeRef.current = { renderer, scene, camera, material, sphere, envTexture, animationId: 0 };

		const animate = () => {
			threeRef.current!.animationId = requestAnimationFrame(animate);
			renderer.render(scene, camera);
		};
		animate();

		return () => {
			cancelAnimationFrame(threeRef.current?.animationId ?? 0);
			sphere.geometry.dispose();
			material.dispose();
			envTexture.dispose();
			renderer.dispose();
			renderer.domElement.remove();
			threeRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// params 变化 → 应用材质
	React.useEffect(() => {
		const t = threeRef.current;
		if (t) { applyMaterialParams(t.material, params); }
	}, [params]);

	// ── 2D fallback 绘制 ──────────────────────────────────────────────────
	React.useEffect(() => {
		if (!webglFailed) { return; }
		const canvas = canvas2dRef.current;
		if (!canvas) { return; }
		const ctx = canvas.getContext('2d');
		if (!ctx) { return; }
		renderMaterialBall(ctx, params, VIEW / 2, VIEW / 2, BALL_R_2D);
	}, [params, webglFailed]);

	// ★ 声明顺序：uploadRender 必须在 scheduleUpload 之前。
	//   scheduleUpload 的 useCallback 依赖数组里引用 uploadRender，依赖数组在组件
	//   渲染时**立即求值**，若 uploadRender 还在 TDZ（后面才 const 声明）就会抛
	//   `Cannot access 'uploadRender' before initialization`，整个编辑器白屏。
	const uploadRender = React.useCallback(async () => {
		const runner = runnersRef.current?.resolve(preferenceRef.current);
		if (!runner?.fetchApi) { onRenderUploaded(null); return; }
		let blob: Blob | null = null;
		const t = threeRef.current;
		if (t && !webglFailed) {
			blob = await new Promise<Blob | null>((resolve) => t.renderer.domElement.toBlob(resolve, 'image/png'));
		} else if (canvas2dRef.current) {
			blob = await new Promise<Blob | null>((resolve) => canvas2dRef.current!.toBlob(resolve, 'image/png'));
		}
		if (!blob) { return; }
		try {
			const form = new FormData();
			form.append('image', blob, 'material.png');
			const resp = await runner.fetchApi('/upload/image', { method: 'POST', body: form });
			const data = await resp.json();
			const url = `${runner.baseUrl}/view?filename=${encodeURIComponent(String(data?.name ?? ''))}&subfolder=${encodeURIComponent(String(data?.subfolder ?? ''))}&type=${String(data?.type ?? 'output')}`;
			onRenderUploaded(url);
		} catch {
			onRenderUploaded(null);
		}
	}, [onRenderUploaded, webglFailed]);

	const scheduleUpload = React.useCallback(() => {
		if (uploadTimerRef.current) { clearTimeout(uploadTimerRef.current); }
		uploadTimerRef.current = setTimeout(() => { void uploadRender(); }, UPLOAD_DEBOUNCE_MS);
	}, [uploadRender]);

	React.useEffect(() => () => { if (uploadTimerRef.current) { clearTimeout(uploadTimerRef.current); } }, []);

	// ★ 首次打开自动渲染一次默认材质并上传，确保节点有 image 快照——
	//   否则 runMaterialNode 因 store.byNode(snapKey) 无 image 而报
	//   「请先在节点弹窗中编辑材质」（用户不动任何参数也必须有预览图）。
	//   800ms 延迟等 three.js 首帧渲染完成；runner 未连接时 uploadRender
	//   内部静默走 onRenderUploaded(null)，安全。
	React.useEffect(() => {
		const t = setTimeout(() => { void uploadRender(); }, 800);
		return () => clearTimeout(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const commit = React.useCallback((next: MaterialParams) => {
		setParams(next);
		paramsRef.current = next;
		onStateChange(materialStateToJson(next));
		scheduleUpload();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onStateChange, scheduleUpload]);

	const patch = (p: Partial<MaterialParams>) => commit({ ...params, ...p });

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			{/* ① 3D 材质球预览区（对齐 ComfyTV MaterialSphere.vue） */}
			<div
				ref={containerRef}
				style={{ width: '100%', height: VIEW, borderRadius: 8, overflow: 'hidden', background: '#1c1c22' }}
			/>
			{webglFailed && (
				<canvas ref={canvas2dRef} width={VIEW} height={VIEW} style={{ width: '100%', borderRadius: 8, background: '#17181c', display: 'block' }} />
			)}

			{/* ② PRESETS 预设行（对齐 ComfyTV 截图：Glossy plastic / Matte plastic / …） */}
			<div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
				<span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--vscode-descriptionForeground)' }}>PRESETS</span>
				{MATERIAL_PRESETS.map(p => (
					<button
						key={p.key}
						onClick={() => commit(applyPreset(params, p.params))}
						style={{
							padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10,
							background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)',
							border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit',
						}}
					>
						{PRESET_LABELS[p.key] ?? p.key}
					</button>
				))}
			</div>

			{/* ③ COLOR 颜色选择器（对齐截图：COLOR + #hex 输入）。
			    ★ minmax(0,1fr) 而非 1fr：grid 1fr 的 min 是 auto（内容 min-content），
			    内部 flex div 的 min-content（36+5+hex 输入固有宽 ≈182px）会撑破窄列
			    （visual R2 实测溢出 4px）。minmax(0,1fr) 让列可收缩到 0。 */}
			<div style={{ display: 'grid', gridTemplateColumns: '80px minmax(0, 1fr)', gap: 6, alignItems: 'center' }}>
				<span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, color: '#aaa' }}>COLOR</span>
				<div style={{ display: 'flex', gap: 5, minWidth: 0 }}>
					<input type="color" value={params.color} onChange={e => patch({ color: e.target.value })}
						style={{ width: 36, height: 26, padding: 0, border: '1px solid rgba(255,255,255,.2)', borderRadius: 5, background: 'transparent', cursor: 'pointer', flexShrink: 0 }} />
					<input value={params.color} onChange={e => patch({ color: e.target.value })}
						style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: 11 }} />
				</div>
			</div>

			{/* ④ PBR 滑块（METALNESS / ROUGHNESS / TRANSMISSION / OPACITY / CLEARCOAT / IOR）
			    对齐截图：两列网格，每行 label + 滑块 + 数值（minmax(0,1fr) 防滑块撑破） */}
			<div style={{ display: 'grid', gridTemplateColumns: '80px minmax(0, 1fr) auto', gap: '4px 6px', alignItems: 'center' }}>
				{MATERIAL_SLIDERS.filter(s => s.key !== 'clearcoatRoughness' && s.key !== 'emissiveIntensity').map(s => (
					<React.Fragment key={s.key}>
						<span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, color: '#aaa' }}>{s.label}</span>
						<input type="range" min={s.min} max={s.max} step={s.step}
							value={params[s.key] as number}
							onChange={e => patch({ [s.key]: Number(e.target.value) } as Partial<MaterialParams>)}
							style={{ accentColor: '#4a9eff', width: '100%' }} />
						<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', textAlign: 'right', minWidth: 36, fontVariantNumeric: 'tabular-nums' }}>
							{Number(params[s.key]).toFixed(s.key === 'ior' ? 2 : 2)}
						</span>
					</React.Fragment>
				))}
			</div>

			{/* ⑤ Generate Material 按钮（对齐截图蓝色主按钮） */}
			<button
				onClick={() => { /* 触发节点运行（由 nodeCard.tsx 的 run 机制处理） */ }}
				style={{
					padding: '8px 16px', borderRadius: 6, cursor: 'pointer',
					fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
					background: 'var(--vscode-button-background, #4a9eff)',
					color: 'var(--vscode-button-foreground, #fff)',
					border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
				}}
			>
				<span>▶</span>
				<span>Generate Material</span>
			</button>
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
				调整后约 1 秒自动渲染材质球并上传；输出 PBR 材质 JSON + 预览图。
			</div>
		</div>
	);
}
