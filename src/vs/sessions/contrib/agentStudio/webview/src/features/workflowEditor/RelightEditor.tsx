/*---------------------------------------------------------------------------------------------
 *  RelightEditor — three.js 3D light-ball editor (ComfyTV RelightStage P3).
 *
 *  对齐 ComfyTV widgets/three/light/*（LightBallWidget + LightStudioScene）：
 *    - 3D 球体（SphereGeometry radius=1）+ 地面 + 环境光
 *    - 灯光 rig：DirectionalLight / PointLight / SpotLight + 原生 helper + marker 小球
 *    - OrbitControls 旋转视角（2D 版没有的核心能力）
 *    - raycaster 拾取 marker → 选中；拖拽 marker 沿球面移动（保持 distance，改 yaw/pitch）
 *    - 灯光数据契约 LightInfoEntry[] 不变（与 ComfyTV types.ts 一致，workflow portable）
 *  渲染 + 上传参考图沿用原逻辑（debounce 1s）。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ComfyRunnerRegistry } from './comfyHost/comfyRunner';
import {
	LIGHT_PRESETS, LIGHT_TYPES, cloneLights, createDefaultLight, lightTarget,
	normalizeLights, type LightInfoEntry, type LightInfoType,
} from './comfyHost/relightEditor';

export interface RelightEditorProps {
	initialLights: LightInfoEntry[];
	initialPrompt: string;
	runners: ComfyRunnerRegistry;
	preference: string;
	onLightsChange: (lightsJson: string, prompt: string) => void;
	onRenderUploaded: (url: string | null) => void;
}

const SPHERE_RADIUS = 1;
const SPHERE_SEGMENTS = 64;
const SPHERE_COLOR = 0xcccccc;
const GROUND_SIZE = 40;
const GROUND_Y = -1;
const GROUND_COLOR = 0x8a8a8a;
const AMBIENT_INTENSITY = 0.2;
const MARKER_RADIUS = 0.1;
const MARKER_SELECTED_SCALE = 1.4;
const DEG2RAD = Math.PI / 180;
const UPLOAD_DEBOUNCE_MS = 1000;

const inputStyle: React.CSSProperties = {
	background: '#111', color: '#e6e6e6', border: '1px solid rgba(255,255,255,.14)',
	borderRadius: 5, padding: '4px 7px', fontSize: 12, outline: 'none',
};
const chipStyle = (active: boolean): React.CSSProperties => ({
	padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10,
	background: active ? 'rgba(59,130,246,.22)' : 'rgba(255,255,255,.05)',
	color: 'var(--vscode-foreground)', border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit',
});

interface LightRig {
	type: LightInfoType;
	light: THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight;
	helper: THREE.Object3D & { dispose: () => void };
	marker: THREE.Mesh;
}

export function RelightEditor({
	initialLights, initialPrompt, runners, preference, onLightsChange, onRenderUploaded,
}: RelightEditorProps): React.JSX.Element {
	const [lights, setLights] = React.useState<LightInfoEntry[]>(() => cloneLights(initialLights));
	const [selected, setSelected] = React.useState(0);
	const [prompt, setPrompt] = React.useState(initialPrompt);
	const [webglFailed, setWebglFailed] = React.useState(false);
	const containerRef = React.useRef<HTMLDivElement>(null);

	// three.js 实例（命令式，与 React 状态解耦）
	const threeRef = React.useRef<{
		renderer: THREE.WebGLRenderer;
		scene: THREE.Scene;
		camera: THREE.PerspectiveCamera;
		controls: OrbitControls;
		sphere: THREE.Mesh;
		rigs: LightRig[];
		raycaster: THREE.Raycaster;
		pointer: THREE.Vector2;
		markers: THREE.Mesh[];
		animationId: number;
	} | null>(null);
	const dragRef = React.useRef<{ index: number; distance: number } | null>(null);
	const uploadTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const runnersRef = React.useRef(runners); runnersRef.current = runners;
	const preferenceRef = React.useRef(preference); preferenceRef.current = preference;
	const lightsRef = React.useRef(lights); lightsRef.current = lights;
	const selectedRef = React.useRef(selected); selectedRef.current = selected;

	const selectedLight = lights[selected] ?? null;

	// ── 初始化 three.js ──────────────────────────────────────────────────
	React.useEffect(() => {
		const container = containerRef.current;
		if (!container) { return; }
		let renderer: THREE.WebGLRenderer;
		try {
			renderer = new THREE.WebGLRenderer({ antialias: true });
		} catch {
			setWebglFailed(true);
			return;
		}
		const width = container.clientWidth || 360;
		const height = container.clientHeight || 320;
		renderer.setSize(width, height);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		renderer.domElement.style.display = 'block';
		renderer.domElement.style.touchAction = 'none';
		container.appendChild(renderer.domElement);

		const scene = new THREE.Scene();
		scene.background = new THREE.Color(0x282828);

		const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 200);
		camera.position.set(0, 6, 8);

		const controls = new OrbitControls(camera, renderer.domElement);
		controls.target.set(0, -0.5, 0);
		controls.update();

		// 球体 + 地面 + 环境光（对齐 LightStudioScene）
		const sphere = new THREE.Mesh(
			new THREE.SphereGeometry(SPHERE_RADIUS, SPHERE_SEGMENTS, SPHERE_SEGMENTS),
			new THREE.MeshStandardMaterial({ color: SPHERE_COLOR, roughness: 0.8, metalness: 0 }),
		);
		const ground = new THREE.Mesh(
			new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
			new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 1, metalness: 0 }),
		);
		ground.rotation.x = -Math.PI / 2;
		ground.position.y = GROUND_Y;
		scene.add(sphere, ground);
		scene.add(new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY));

		const raycaster = new THREE.Raycaster();
		const pointer = new THREE.Vector2();
		threeRef.current = { renderer, scene, camera, controls, sphere, rigs: [], raycaster, pointer, markers: [], animationId: 0 };

		// 动画循环
		const animate = () => {
			threeRef.current!.animationId = requestAnimationFrame(animate);
			controls.update();
			renderer.render(scene, camera);
		};
		animate();

		return () => {
			cancelAnimationFrame(threeRef.current?.animationId ?? 0);
			disposeRigs(threeRef.current?.rigs ?? []);
			controls.dispose();
			sphere.geometry.dispose();
			(sphere.material as THREE.Material).dispose();
			ground.geometry.dispose();
			(ground.material as THREE.Material).dispose();
			renderer.dispose();
			renderer.domElement.remove();
			threeRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── 灯光 rig 同步（lights / selected 变化时）───────────────────────
	React.useEffect(() => {
		const t = threeRef.current;
		if (!t) { return; }
		syncRigs(t, lights, selected);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [lights, selected]);

	// ── 指针拾取 / 拖拽（在 three 容器上监听）──────────────────────────
	React.useEffect(() => {
		const t = threeRef.current;
		if (!t) { return; }
		const el = t.renderer.domElement;

		const setPointer = (e: PointerEvent) => {
			const rect = el.getBoundingClientRect();
			t.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
		};

		const onPointerDown = (e: PointerEvent) => {
			setPointer(e);
			t.raycaster.setFromCamera(t.pointer, t.camera);
			const hits = t.raycaster.intersectObjects(t.markers, false);
			if (hits.length > 0) {
				const idx = hits[0].object.userData.lightIndex as number;
				setSelected(idx);
				selectedRef.current = idx;
				const light = lightsRef.current[idx];
				const target = lightTarget(light);
				const distance = Math.hypot(light.position.x - target.x, light.position.y - target.y, light.position.z - target.z) || 1;
				dragRef.current = { index: idx, distance };
				t.controls.enabled = false;
				el.setPointerCapture?.(e.pointerId);
			}
		};

		const onPointerMove = (e: PointerEvent) => {
			if (!dragRef.current) { return; }
			setPointer(e);
			t.raycaster.setFromCamera(t.pointer, t.camera);
			const hit = t.raycaster.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(0, 0, 0), SPHERE_RADIUS), new THREE.Vector3());
			if (!hit) { return; }
			const d = dragRef.current.distance;
			const next = cloneLights(lightsRef.current);
			next[dragRef.current.index].position = { x: hit.x * d, y: hit.y * d, z: hit.z * d };
			lightsRef.current = next;
			setLights(next);
			onLightsChange(JSON.stringify(next), prompt);
			scheduleUpload();
		};

		const onPointerUp = (e: PointerEvent) => {
			if (dragRef.current) {
				dragRef.current = null;
				t.controls.enabled = true;
				el.releasePointerCapture?.(e.pointerId);
			}
		};

		el.addEventListener('pointerdown', onPointerDown);
		el.addEventListener('pointermove', onPointerMove);
		el.addEventListener('pointerup', onPointerUp);
		el.addEventListener('pointercancel', onPointerUp);
		return () => {
			el.removeEventListener('pointerdown', onPointerDown);
			el.removeEventListener('pointermove', onPointerMove);
			el.removeEventListener('pointerup', onPointerUp);
			el.removeEventListener('pointercancel', onPointerUp);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const scheduleUpload = React.useCallback(() => {
		if (uploadTimerRef.current) { clearTimeout(uploadTimerRef.current); }
		uploadTimerRef.current = setTimeout(() => { void uploadRender(); }, UPLOAD_DEBOUNCE_MS);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [uploadRender]);

	const uploadRender = React.useCallback(async () => {
		const t = threeRef.current;
		if (!t) { return; }
		const runner = runnersRef.current.resolve(preferenceRef.current);
		if (!runner?.fetchApi) { onRenderUploaded(null); return; }
		const blob = await new Promise<Blob | null>((resolve) => t.renderer.domElement.toBlob(resolve, 'image/png'));
		if (!blob) { return; }
		try {
			const form = new FormData();
			form.append('image', blob, 'lightball.png');
			const resp = await runner.fetchApi('/upload/image', { method: 'POST', body: form });
			const data = await resp.json();
			const url = `${runner.baseUrl}/view?filename=${encodeURIComponent(String(data?.name ?? ''))}&subfolder=${encodeURIComponent(String(data?.subfolder ?? ''))}&type=${String(data?.type ?? 'output')}`;
			onRenderUploaded(url);
		} catch {
			onRenderUploaded(null);
		}
	}, [onRenderUploaded]);

	React.useEffect(() => () => { if (uploadTimerRef.current) { clearTimeout(uploadTimerRef.current); } }, []);

	const commit = React.useCallback((next: LightInfoEntry[]) => {
		setLights(next);
		lightsRef.current = next;
		onLightsChange(JSON.stringify(next), prompt);
		scheduleUpload();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onLightsChange, prompt, scheduleUpload]);

	const addLight = (type: LightInfoType) => {
		const next = [...cloneLights(lights), createDefaultLight(type)];
		setSelected(next.length - 1);
		selectedRef.current = next.length - 1;
		commit(next);
	};

	const removeSelected = () => {
		if (!lights.length) { return; }
		const next = cloneLights(lights);
		next.splice(selected, 1);
		setSelected(Math.min(selected, Math.max(0, next.length - 1)));
		commit(next);
	};

	const patchSelected = (patch: Partial<LightInfoEntry>) => {
		if (!selectedLight) { return; }
		const next = cloneLights(lights);
		next[selected] = normalizeLights([{ ...next[selected], ...patch }])[0];
		commit(next);
	};

	const applyPreset = (entries: LightInfoEntry[]) => {
		setSelected(0);
		selectedRef.current = 0;
		commit(normalizeLights(entries));
	};

	if (webglFailed) {
		return <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>WebGL 不可用，无法渲染 3D 光球。</div>;
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			<div
				ref={containerRef}
				style={{ width: '100%', height: 320, borderRadius: 8, overflow: 'hidden', background: '#282828', cursor: 'grab', position: 'relative' }}
			/>
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
				拖拽旋转视角 · 拖动彩色小球调整灯光方向 · 点击小球选中
			</div>
			<div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
				<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>Presets</span>
				{LIGHT_PRESETS.map(p => (
					<button key={p.key} style={chipStyle(false)} onClick={() => applyPreset(p.lights)}>{p.key}</button>
				))}
			</div>
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
				{LIGHT_TYPES.map(t => (
					<button key={t} style={chipStyle(false)} onClick={() => addLight(t)}>+ {t}</button>
				))}
				<button style={chipStyle(false)} onClick={removeSelected} disabled={!lights.length}>🗑 Remove</button>
			</div>
			{selectedLight && (
				<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
						<span style={{ fontSize: 10, color: '#aaa' }}>Color</span>
						<div style={{ display: 'flex', gap: 5 }}>
							<input type="color" value={selectedLight.color} onChange={e => patchSelected({ color: e.target.value })}
								style={{ width: 30, height: 26, padding: 0, border: '1px solid rgba(255,255,255,.2)', borderRadius: 5, background: 'transparent', cursor: 'pointer' }} />
							<input value={selectedLight.color} onChange={e => patchSelected({ color: e.target.value })}
								style={{ ...inputStyle, flex: 1 }} />
						</div>
					</label>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
						<span style={{ fontSize: 10, color: '#aaa' }}>Intensity</span>
						<input type="number" min={0} step={0.1} value={selectedLight.intensity}
							onChange={e => patchSelected({ intensity: Number(e.target.value) })} style={{ ...inputStyle, width: '100%' }} />
					</label>
					{selectedLight.type === 'spot' && (
						<>
							<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
								<span style={{ fontSize: 10, color: '#aaa' }}>Inner cone</span>
								<input type="number" min={0} max={90} value={selectedLight.innerConeAngle ?? 30}
									onChange={e => patchSelected({ innerConeAngle: Number(e.target.value) })} style={{ ...inputStyle, width: '100%' }} />
							</label>
							<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
								<span style={{ fontSize: 10, color: '#aaa' }}>Outer cone</span>
								<input type="number" min={0} max={120} value={selectedLight.outerConeAngle ?? 45}
									onChange={e => patchSelected({ outerConeAngle: Number(e.target.value) })} style={{ ...inputStyle, width: '100%' }} />
							</label>
						</>
					)}
				</div>
			)}
			<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
				<span style={{ fontSize: 10, color: '#aaa' }}>Lighting prompt（透传到 light_prompt 输出）</span>
				<textarea
					rows={2}
					value={prompt}
					onChange={e => { setPrompt(e.target.value); onLightsChange(JSON.stringify(lights), e.target.value); }}
					style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
				/>
			</label>
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
				编辑后约 1 秒自动渲染参考图并上传；无 Run 按钮，点击节点外部即可生效。
			</div>
		</div>
	);
}

// ── rig 管理（对齐 LightStudioScene）──────────────────────────────────

function createSceneLight(type: LightInfoType): LightRig['light'] {
	if (type === 'point') { return new THREE.PointLight(); }
	if (type === 'spot') { return new THREE.SpotLight(); }
	return new THREE.DirectionalLight();
}

function createHelper(light: LightRig['light']): LightRig['helper'] {
	if (light instanceof THREE.PointLight) { return new THREE.PointLightHelper(light, 0.3); }
	if (light instanceof THREE.SpotLight) { return new THREE.SpotLightHelper(light); }
	return new THREE.DirectionalLightHelper(light, 0.5);
}

function disposeRigs(rigs: LightRig[]): void {
	for (const rig of rigs) {
		rig.helper.dispose();
		rig.marker.geometry.dispose();
		(rig.marker.material as THREE.Material).dispose();
		rig.light.dispose();
	}
}

function syncRigs(t: { scene: THREE.Scene; rigs: LightRig[]; markers: THREE.Mesh[] }, lights: LightInfoEntry[], selected: number): void {
	// 类型变化 → 重建 rig
	const typesMatch = t.rigs.length === lights.length && t.rigs.every((rig, i) => rig.type === lights[i].type);
	if (!typesMatch) {
		disposeRigs(t.rigs);
		t.rigs = [];
		t.markers = [];
		for (const entry of lights) {
			const light = createSceneLight(entry.type);
			const marker = new THREE.Mesh(
				new THREE.SphereGeometry(MARKER_RADIUS, 16, 16),
				new THREE.MeshBasicMaterial({ color: 0xffffff }),
			);
			marker.name = `LightBallEmitterMarker${t.rigs.length}`;
			const helper = createHelper(light);
			t.scene.add(light);
			if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
				t.scene.add(light.target);
			}
			t.scene.add(marker, helper);
			t.rigs.push({ type: entry.type, light, helper, marker });
			t.markers.push(marker);
		}
	}
	// 应用灯光数据
	lights.forEach((entry, i) => {
		const rig = t.rigs[i];
		if (!rig) { return; }
		const color = new THREE.Color(entry.color);
		rig.light.color.copy(color);
		rig.light.intensity = entry.intensity;
		rig.light.position.set(entry.position.x, entry.position.y, entry.position.z);
		const target = lightTarget(entry);
		if (rig.light instanceof THREE.SpotLight) {
			rig.light.target.position.set(target.x, target.y, target.z);
			rig.light.target.updateMatrixWorld(true);
			rig.light.distance = entry.range ?? 0;
			rig.light.angle = (entry.outerConeAngle ?? 45) * DEG2RAD;
			const outer = Math.max(entry.outerConeAngle ?? 45, 1e-3);
			const inner = Math.min(entry.innerConeAngle ?? 30, outer);
			rig.light.penumbra = Math.min(Math.max(1 - inner / outer, 0), 1);
		} else if (rig.light instanceof THREE.PointLight) {
			rig.light.distance = entry.range ?? 0;
		} else {
			rig.light.target.position.set(target.x, target.y, target.z);
			rig.light.target.updateMatrixWorld(true);
		}
		rig.marker.position.set(entry.position.x, entry.position.y, entry.position.z);
		rig.marker.userData.lightIndex = i;
		(rig.marker.material as THREE.MeshBasicMaterial).color.copy(color);
		rig.marker.scale.setScalar(i === selected ? MARKER_SELECTED_SCALE : 1);
		rig.marker.visible = true;
		rig.helper.visible = i === selected;
	});
}
