/*---------------------------------------------------------------------------------------------
 *  Scene3DEditor — three.js 3D scene editor (ComfyTV Scene3DStage P3).
 *
 *  对齐 ComfyTV widgets/three/scene3d/ 的基础能力（第一阶段）：
 *    - 3D 视口：网格地面 + 环境光 + 网格辅助线 + OrbitControls 旋转/平移/缩放
 *    - primitives：cube/sphere/cylinder/plane（three.js 原生几何体）
 *    - lights：directional/point/spot + helper
 *    - raycaster 拾取选择；拖拽选中 primitive 沿地面（XZ 平面）移动
 *    - 属性面板：名称/颜色/位置/缩放
 *  数据契约 Scene3DState 与 ComfyTV types.ts 一致。
 *
 *  未实现（后续阶段）：characters/models（GLB 加载）、cameras、gizmo 三轴、
 *  timeline 关键帧、undo/redo、capture/record、输出面板。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ComfyRunnerRegistry } from './comfyHost/comfyRunner';
import {
	addCamera, addLight, addPrimitive, cloneScene, cloneTransform, createEmptyScene, lightTarget, parseSceneState,
	patchCamera, patchEnvironment, patchLight, patchOutput, patchPrimitive, quaternionFromYaw, removeCamera, removeLight,
	removePrimitive, rotationYOf, sceneStateToJson,
	type PrimitiveShape, type Scene3DState, type SceneLightType,
} from './comfyHost/scene3dEditor';
import { Scene3dHistory } from './comfyHost/scene3dHistory';
import { SceneTimelineController } from './comfyHost/scene3dTimeline';

export interface Scene3DEditorProps {
	initialState: string;
	runners: ComfyRunnerRegistry;
	preference: string;
	onStateChange: (json: string) => void;
	onRenderUploaded: (url: string | null) => void;
}

const VIEW_H = 340;
const GROUND_Y = 0;
const UPLOAD_DEBOUNCE_MS = 1200;
const HOVER_COLOR = 0x4a9eff;
const SELECTED_COLOR = 0xffffff;

const PRIMITIVE_BUTTONS: Array<{ shape: PrimitiveShape; label: string }> = [
	{ shape: 'cube', label: '+ 立方体' },
	{ shape: 'sphere', label: '+ 球体' },
	{ shape: 'cylinder', label: '+ 圆柱' },
	{ shape: 'plane', label: '+ 平面' },
];
const LIGHT_BUTTONS: Array<{ type: SceneLightType; label: string }> = [
	{ type: 'directional', label: '+ 平行光' },
	{ type: 'point', label: '+ 点光' },
	{ type: 'spot', label: '+ 聚光' },
];

const inputStyle: React.CSSProperties = {
	background: '#111', color: '#e6e6e6', border: '1px solid rgba(255,255,255,.14)',
	borderRadius: 5, padding: '3px 6px', fontSize: 11, outline: 'none',
};
const miniBtn: React.CSSProperties = {
	padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10,
	background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)',
	border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit',
};
const chipStyle = (active: boolean): React.CSSProperties => ({
	...miniBtn, background: active ? 'rgba(59,130,246,.22)' : 'rgba(255,255,255,.05)',
});

interface SceneRig {
	primMeshes: Map<string, THREE.Mesh>;
	lightObjects: Map<string, { light: THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight; helper: THREE.Object3D & { dispose: () => void } }>;
	cameraObjects: Map<string, { group: THREE.Group; helper: THREE.CameraHelper }>;
}

type SceneTool = 'translate' | 'rotate' | 'scale';
interface TranslateDrag { kind: 'translate'; id: string; plane: THREE.Plane; offset: THREE.Vector3 }
interface RotateDrag { kind: 'rotate'; id: string; startClientX: number; startRotationY: number }
interface ScaleDrag { kind: 'scale'; id: string; startClientY: number; startScale: number }

type SelectedKind = 'primitive' | 'camera';

export function Scene3DEditor({ initialState, runners, preference, onStateChange, onRenderUploaded }: Scene3DEditorProps): React.JSX.Element {
	const [scene, setScene] = React.useState<Scene3DState>(() => parseSceneState(initialState));
	const [selectedId, setSelectedId] = React.useState<string | null>(() => {
		const s = parseSceneState(initialState);
		return s.primitives[0]?.id ?? null;
	});
	const [selectedKind, setSelectedKind] = React.useState<SelectedKind>('primitive');
	const [tool, setTool] = React.useState<'translate' | 'rotate' | 'scale'>('translate');
	const [webglFailed, setWebglFailed] = React.useState(false);
	const [canUndo, setCanUndo] = React.useState(false);
	const [canRedo, setCanRedo] = React.useState(false);
	const [timelineFrame, setTimelineFrame] = React.useState(0);
	const [timelinePlaying, setTimelinePlaying] = React.useState(false);
	const [timelineLoop, setTimelineLoop] = React.useState(true);
	const containerRef = React.useRef<HTMLDivElement>(null);
	const timelineRef = React.useRef<SceneTimelineController | null>(null);
	const lastRafTimeRef = React.useRef<number | null>(null);

	const threeRef = React.useRef<{
		renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
		ground: THREE.Mesh; grid: THREE.GridHelper; rig: SceneRig; raycaster: THREE.Raycaster; pointer: THREE.Vector2; animationId: number;
	} | null>(null);
	const dragRef = React.useRef<TranslateDrag | RotateDrag | ScaleDrag | null>(null);
	const uploadTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const historyRef = React.useRef<Scene3dHistory>(new Scene3dHistory());
	const lastCommittedRef = React.useRef<{ json: string; selectedId: string | null }>({ json: '', selectedId: null });
	const runnersRef = React.useRef(runners); runnersRef.current = runners;
	const preferenceRef = React.useRef(preference); preferenceRef.current = preference;
	const sceneRef = React.useRef(scene); sceneRef.current = scene;
	const selectedRef = React.useRef(selectedId); selectedRef.current = selectedId;
	const selectedKindRef = React.useRef(selectedKind); selectedKindRef.current = selectedKind;
	const toolRef = React.useRef(tool); toolRef.current = tool;
	const commitRef = React.useRef<(next: Scene3DState, mergeKey?: string) => void>(() => { });

	const selectedPrimitive = selectedKind === 'primitive' ? (scene.primitives.find(p => p.id === selectedId) ?? null) : null;
	const selectedCamera = selectedKind === 'camera' ? (scene.cameras.find(c => c.id === selectedId) ?? null) : null;
	const selected = selectedPrimitive ?? selectedCamera;

	// 初始化 history baseline + timeline controller
	React.useEffect(() => {
		const json = sceneStateToJson(parseSceneState(initialState));
		lastCommittedRef.current = { json, selectedId: null };
		const ctrl = new SceneTimelineController(24, {
			onTimeUpdate: (frame) => setTimelineFrame(frame),
			onStateChange: (playing) => setTimelinePlaying(playing),
		});
		timelineRef.current = ctrl;
		return () => { timelineRef.current = null; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// timeline 播放 rAF 循环
	React.useEffect(() => {
		if (!timelinePlaying) { return; }
		let rafId = 0;
		const tick = (t: number) => {
			const last = lastRafTimeRef.current ?? t;
			lastRafTimeRef.current = t;
			const delta = (t - last) / 1000;
			timelineRef.current?.update(delta);
			rafId = requestAnimationFrame(tick);
		};
		rafId = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(rafId);
			lastRafTimeRef.current = null;
		};
	}, [timelinePlaying]);

	// timeline duration 跟随 output.frameCount
	React.useEffect(() => {
		const fps = scene.output.fps || 24;
		timelineRef.current?.setTimelineDuration(scene.output.frameCount / fps);
	}, [scene.output.frameCount, scene.output.fps]);

	const refreshHistoryFlags = React.useCallback(() => {
		setCanUndo(historyRef.current.canUndo());
		setCanRedo(historyRef.current.canRedo());
	}, []);

	// ── three.js init ────────────────────────────────────────────────────
	React.useEffect(() => {
		const container = containerRef.current;
		if (!container) { return; }
		let renderer: THREE.WebGLRenderer;
		try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
		catch { setWebglFailed(true); return; }
		const width = container.clientWidth || 360;
		renderer.setSize(width, VIEW_H);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		renderer.domElement.style.display = 'block';
		renderer.domElement.style.touchAction = 'none';
		container.appendChild(renderer.domElement);

		const threeScene = new THREE.Scene();
		threeScene.background = new THREE.Color(0x2a2a2e);

		const camera = new THREE.PerspectiveCamera(50, width / VIEW_H, 0.1, 200);
		camera.position.set(6, 4, 6);

		const controls = new OrbitControls(camera, renderer.domElement);
		controls.target.set(0, 0.5, 0);
		controls.update();

		// 地面 + 网格（对齐 showGrid）
		const ground = new THREE.Mesh(
			new THREE.PlaneGeometry(20, 20),
			new THREE.MeshStandardMaterial({ color: 0x333338, roughness: 1 }),
		);
		ground.rotation.x = -Math.PI / 2;
		ground.position.y = GROUND_Y;
		threeScene.add(ground);

		const grid = new THREE.GridHelper(20, 20, 0x55555a, 0x3c3c42);
		grid.position.y = GROUND_Y + 0.01;
		threeScene.add(grid);

		threeScene.add(new THREE.AmbientLight(0xffffff, 0.4));
		threeScene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.3));

		const raycaster = new THREE.Raycaster();
		const pointer = new THREE.Vector2();
		threeRef.current = {
			renderer, scene: threeScene, camera, controls, ground, grid,
			rig: { primMeshes: new Map(), lightObjects: new Map(), cameraObjects: new Map() },
			raycaster, pointer, animationId: 0,
		};

		const animate = () => {
			threeRef.current!.animationId = requestAnimationFrame(animate);
			controls.update();
			renderer.render(threeScene, camera);
		};
		animate();

		return () => {
			cancelAnimationFrame(threeRef.current?.animationId ?? 0);
			disposeRig(threeRef.current?.rig);
			ground.geometry.dispose(); (ground.material as THREE.Material).dispose();
			grid.geometry.dispose(); (grid.material as THREE.Material).dispose();
			controls.dispose();
			renderer.dispose();
			renderer.domElement.remove();
			threeRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── scene → three 同步 ───────────────────────────────────────────────
	React.useEffect(() => {
		const t = threeRef.current;
		if (!t) { return; }
		syncScene(t, scene, selectedId, tool);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [scene, selectedId, tool]);

	// ── 拾取 / 拖拽 ──────────────────────────────────────────────────────
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
			// 先 hit primitive meshes，再 hit camera markers
			const meshes = Array.from(t.rig.primMeshes.values());
			const cameraGroups = Array.from(t.rig.cameraObjects.values()).map(co => co.group);
			const hits = t.raycaster.intersectObjects(meshes, false);
			const camHits = t.raycaster.intersectObjects(cameraGroups, true);
			if (hits.length > 0) {
				const id = hits[0].object.userData.id as string;
				setSelectedId(id);
				selectedRef.current = id;
				selectedKindRef.current = 'primitive';
				setSelectedKind('primitive');
				const primitive = sceneRef.current.primitives.find(x => x.id === id);
				const tool = toolRef.current;
				if (tool === 'rotate' && primitive) {
					// rotate：水平拖拽 = 绕 Y 轴旋转（记录起始 clientX + 起始 rotationY）
					dragRef.current = { kind: 'rotate', id, startClientX: e.clientX, startRotationY: rotationYOf(primitive) };
				} else if (tool === 'scale' && primitive) {
					// scale：垂直拖拽 = 等比缩放（记录起始 clientY + 起始 scale.x）
					dragRef.current = { kind: 'scale', id, startClientY: e.clientY, startScale: primitive.transform.scale.x };
				} else {
					// translate：沿地面 XZ 移动
					const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
					const hitPoint = new THREE.Vector3();
					t.raycaster.ray.intersectPlane(plane, hitPoint);
					dragRef.current = { kind: 'translate', id, plane, offset: hitPoint ? hitPoint.clone().sub(hits[0].object.position) : new THREE.Vector3() };
				}
				t.controls.enabled = false;
				el.setPointerCapture?.(e.pointerId);
			} else if (camHits.length > 0) {
				// 选中相机（仅选中，不拖拽——相机编辑走属性面板）
				const camId = camHits[0].object.userData.cameraId as string;
				setSelectedId(camId);
				selectedRef.current = camId;
				selectedKindRef.current = 'camera';
				setSelectedKind('camera');
				t.controls.enabled = true;
			} else {
				setSelectedId(null);
				selectedRef.current = null;
			}
		};

		const onPointerMove = (e: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag) { return; }
			const next = cloneScene(sceneRef.current);
			const p = next.primitives.find(x => x.id === drag.id);
			if (!p) { return; }
			if (drag.kind === 'translate') {
				setPointer(e);
				t.raycaster.setFromCamera(t.pointer, t.camera);
				const hitPoint = new THREE.Vector3();
				if (t.raycaster.ray.intersectPlane(drag.plane, hitPoint)) {
					const pos = hitPoint.add(drag.offset);
					p.transform.position.x = pos.x;
					p.transform.position.z = pos.z;
				} else { return; }
			} else if (drag.kind === 'rotate') {
				// 水平拖拽每 100px = 90°，绕 Y 轴
				const delta = (e.clientX - drag.startClientX) / 100 * (Math.PI / 2);
				const yaw = drag.startRotationY + delta;
				p.transform.quaternion = quaternionFromYaw(yaw);
			} else {
				// 垂直拖拽每 100px = 缩放 1.0（向下放大）
				const delta = (drag.startClientY - e.clientY) / 100;
				const s = Math.max(0.05, drag.startScale + delta);
				p.transform.scale = { x: s, y: s, z: s };
			}
			// 走 commit（带 mergeKey 合并连续拖拽为一步撤销）
			commitRef.current(next, 'drag:' + drag.id);
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
			form.append('image', blob, 'scene.png');
			const resp = await runner.fetchApi('/upload/image', { method: 'POST', body: form });
			const data = await resp.json();
			const url = `${runner.baseUrl}/view?filename=${encodeURIComponent(String(data?.name ?? ''))}&subfolder=${encodeURIComponent(String(data?.subfolder ?? ''))}&type=${String(data?.type ?? 'output')}`;
			onRenderUploaded(url);
		} catch {
			onRenderUploaded(null);
		}
	}, [onRenderUploaded]);

	React.useEffect(() => () => { if (uploadTimerRef.current) { clearTimeout(uploadTimerRef.current); } }, []);

	const commit = React.useCallback((next: Scene3DState, mergeKey?: string) => {
		const before = lastCommittedRef.current;
		const json = sceneStateToJson(next);
		// 记录历史（mergeKey 相同 + 窗口内合并，对齐 ComfyTV Scene3dHistory）
		if (json !== before.json) {
			historyRef.current.record(before, mergeKey);
			lastCommittedRef.current = { json, selectedId: selectedRef.current };
		}
		setScene(next);
		sceneRef.current = next;
		onStateChange(json);
		scheduleUpload();
		refreshHistoryFlags();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onStateChange, scheduleUpload, refreshHistoryFlags]);

	commitRef.current = commit;

	const doAddPrimitive = (shape: PrimitiveShape) => {
		const next = addPrimitive(scene, shape);
		setSelectedId(next.primitives[next.primitives.length - 1].id);
		setSelectedKind('primitive');
		commit(next);
	};

	const doAddLight = (type: SceneLightType) => {
		commit(addLight(scene, type));
	};

	const doAddCamera = () => {
		const next = addCamera(scene);
		setSelectedId(next.cameras[next.cameras.length - 1].id);
		setSelectedKind('camera');
		commit(next);
	};

	const doUndo = () => {
		const current = { json: sceneStateToJson(scene), selectedId };
		const entry = historyRef.current.undo(current);
		if (!entry) { return; }
		lastCommittedRef.current = entry;
		const restored = parseSceneState(entry.json);
		sceneRef.current = restored;
		setScene(restored);
		setSelectedId(entry.selectedId);
		setSelectedKind(restored.cameras.some(c => c.id === entry.selectedId) ? 'camera' : 'primitive');
		onStateChange(entry.json);
		refreshHistoryFlags();
	};

	const doRedo = () => {
		const current = { json: sceneStateToJson(scene), selectedId };
		const entry = historyRef.current.redo(current);
		if (!entry) { return; }
		lastCommittedRef.current = entry;
		const restored = parseSceneState(entry.json);
		sceneRef.current = restored;
		setScene(restored);
		setSelectedId(entry.selectedId);
		setSelectedKind(restored.cameras.some(c => c.id === entry.selectedId) ? 'camera' : 'primitive');
		onStateChange(entry.json);
		refreshHistoryFlags();
	};

	const patchSelected = (patch: Partial<{ name: string; color: string; position: { x: number; y: number; z: number }; rotationY: number; scale: number; fov: number }>) => {
		if (!selectedId) { return; }
		if (selectedKind === 'camera') {
			const cur = scene.cameras.find(x => x.id === selectedId);
			if (!cur) { return; }
			commit(patchCamera(scene, selectedId, {
				...(patch.name !== undefined ? { name: patch.name } : {}),
				...(patch.fov !== undefined ? { fov: patch.fov } : {}),
				...(patch.position ? { transform: { position: patch.position, quaternion: cur.transform.quaternion } } : {}),
			}));
			return;
		}
		const cur = scene.primitives.find(x => x.id === selectedId);
		if (!cur) { return; }
		const transform = cloneTransform(cur.transform);
		if (patch.position) { transform.position = patch.position; }
		if (patch.rotationY !== undefined) { transform.quaternion = quaternionFromYaw(patch.rotationY); }
		if (patch.scale !== undefined) { transform.scale = { x: patch.scale, y: patch.scale, z: patch.scale }; }
		commit(patchPrimitive(scene, selectedId, {
			...(patch.name !== undefined ? { name: patch.name } : {}),
			...(patch.color !== undefined ? { color: patch.color } : {}),
			transform,
		}));
	};

	if (webglFailed) {
		return <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>WebGL 不可用，无法渲染 3D 场景。</div>;
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			<div
				ref={containerRef}
				style={{ width: '100%', height: VIEW_H, borderRadius: 8, overflow: 'hidden', background: '#2a2a2e', cursor: 'grab', position: 'relative' }}
			/>
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
				拖拽旋转视角 · 右键平移 · 滚轮缩放 · 选中几何体后按工具模式拖拽（移动/旋转/缩放）
			</div>
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
				{PRIMITIVE_BUTTONS.map(b => (
					<button key={b.shape} style={miniBtn} onClick={() => doAddPrimitive(b.shape)}>{b.label}</button>
				))}
				{LIGHT_BUTTONS.map(b => (
					<button key={b.type} style={miniBtn} onClick={() => doAddLight(b.type)}>{b.label}</button>
				))}
				<button style={miniBtn} onClick={doAddCamera}>+ 相机</button>
			</div>
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
				<button style={miniBtn} onClick={doUndo} disabled={!canUndo}>↶ 撤销</button>
				<button style={miniBtn} onClick={doRedo} disabled={!canRedo}>↷ 重做</button>
				<span style={{ width: 8 }} />
				{([['translate', '移动'], ['rotate', '旋转'], ['scale', '缩放']] as const).map(([m, label]) => (
					<button key={m} style={chipStyle(tool === m)} onClick={() => setTool(m)}>{label}</button>
				))}
				{selected && (
					<button style={miniBtn} onClick={() => {
						if (selectedKind === 'camera') { commit(removeCamera(scene, selected.id)); }
						else { commit(removePrimitive(scene, selected.id)); }
						setSelectedId(null);
					}}>🗑 删除</button>
				)}
			</div>
			{selectedCamera && (
				<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
						<span style={{ fontSize: 10, color: '#aaa' }}>名称</span>
						<input value={selectedCamera.name ?? ''} onChange={e => patchSelected({ name: e.target.value })} style={inputStyle} />
					</label>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
						<span style={{ fontSize: 10, color: '#aaa' }}>FOV {selectedCamera.fov.toFixed(0)}°</span>
						<input type="range" min={10} max={120} step={1} value={selectedCamera.fov}
							onChange={e => patchSelected({ fov: Number(e.target.value) })} style={{ accentColor: '#4a9eff' }} />
					</label>
					{([['x', '位置 X'], ['y', '位置 Y'], ['z', '位置 Z']] as const).map(([k, label]) => (
						<label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
							<span style={{ fontSize: 10, color: '#aaa' }}>{label}</span>
							<input type="number" step={0.1} value={Number(selectedCamera.transform.position[k].toFixed(2))}
								onChange={e => patchSelected({ position: { ...selectedCamera.transform.position, [k]: Number(e.target.value) } })} style={inputStyle} />
						</label>
					))}
				</div>
			)}
			{selectedPrimitive && (
				<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
						<span style={{ fontSize: 10, color: '#aaa' }}>名称</span>
						<input value={selectedPrimitive.name ?? ''} onChange={e => patchSelected({ name: e.target.value })} style={inputStyle} />
					</label>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
						<span style={{ fontSize: 10, color: '#aaa' }}>颜色</span>
						<input type="color" value={selectedPrimitive.color} onChange={e => patchSelected({ color: e.target.value })}
							style={{ width: '100%', height: 26, padding: 0, border: '1px solid rgba(255,255,255,.2)', borderRadius: 5, background: 'transparent', cursor: 'pointer' }} />
					</label>
					<div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
						<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
							<span style={{ fontSize: 10, color: '#aaa' }}>位置 X</span>
							<input type="number" step={0.1} value={Number(selectedPrimitive.transform.position.x.toFixed(2))}
								onChange={e => patchSelected({ position: { ...selectedPrimitive.transform.position, x: Number(e.target.value) } })} style={inputStyle} />
						</label>
						<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
							<span style={{ fontSize: 10, color: '#aaa' }}>位置 Y</span>
							<input type="number" step={0.1} value={Number(selectedPrimitive.transform.position.y.toFixed(2))}
								onChange={e => patchSelected({ position: { ...selectedPrimitive.transform.position, y: Number(e.target.value) } })} style={inputStyle} />
						</label>
						<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
							<span style={{ fontSize: 10, color: '#aaa' }}>位置 Z</span>
							<input type="number" step={0.1} value={Number(selectedPrimitive.transform.position.z.toFixed(2))}
								onChange={e => patchSelected({ position: { ...selectedPrimitive.transform.position, z: Number(e.target.value) } })} style={inputStyle} />
						</label>
					</div>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
						<span style={{ fontSize: 10, color: '#aaa' }}>旋转 Y {(rotationYOf(selectedPrimitive) * 180 / Math.PI).toFixed(0)}°</span>
						<input type="range" min={-180} max={180} step={1} value={Math.round(rotationYOf(selectedPrimitive) * 180 / Math.PI)}
							onChange={e => patchSelected({ rotationY: Number(e.target.value) * Math.PI / 180 })} style={{ accentColor: '#4a9eff' }} />
					</label>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
						<span style={{ fontSize: 10, color: '#aaa' }}>缩放 {selectedPrimitive.transform.scale.x.toFixed(2)}</span>
						<input type="range" min={0.1} max={3} step={0.05} value={selectedPrimitive.transform.scale.x}
							onChange={e => patchSelected({ scale: Number(e.target.value) })} style={{ accentColor: '#4a9eff' }} />
					</label>
				</div>
			)}
			<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,.08)' }}>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
					<span style={{ fontSize: 10, fontWeight: 600, color: '#aaa' }}>环境</span>
					<label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
						<input type="checkbox" checked={scene.environment.showGrid}
							onChange={e => commit(patchEnvironment(scene, { showGrid: e.target.checked }))} style={{ accentColor: '#4a9eff' }} />
						显示网格
					</label>
					<label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
						<input type="checkbox" checked={scene.environment.showRoom}
							onChange={e => commit(patchEnvironment(scene, { showRoom: e.target.checked }))} style={{ accentColor: '#4a9eff' }} />
						显示房间（预留）
					</label>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
						<span style={{ fontSize: 10, color: '#aaa' }}>背景色</span>
						<input type="color" value={scene.environment.background || '#2a2a2e'}
							onChange={e => commit(patchEnvironment(scene, { background: e.target.value }))}
							style={{ width: '100%', height: 26, padding: 0, border: '1px solid rgba(255,255,255,.2)', borderRadius: 5, background: 'transparent', cursor: 'pointer' }} />
					</label>
				</div>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
					<span style={{ fontSize: 10, fontWeight: 600, color: '#aaa' }}>输出</span>
					<label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
						<span>FPS</span>
						<input type="number" min={1} max={120} step={1} value={scene.output.fps}
							onChange={e => commit(patchOutput(scene, { fps: Math.max(1, Number(e.target.value)) }))} style={{ ...inputStyle, width: 70 }} />
					</label>
					<label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
						<span>帧数</span>
						<input type="number" min={0} max={10000} step={1} value={scene.output.frameCount}
							onChange={e => commit(patchOutput(scene, { frameCount: Math.max(0, Number(e.target.value)) }))} style={{ ...inputStyle, width: 70 }} />
					</label>
					<label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
						<span>输出相机</span>
						<select value={scene.output.cameraId}
							onChange={e => commit(patchOutput(scene, { cameraId: e.target.value }))}
							style={{ ...inputStyle, width: 70, cursor: 'pointer' }}>
							<option value="">默认</option>
							{scene.cameras.map(c => <option key={c.id} value={c.id}>{c.name ?? c.id}</option>)}
						</select>
					</label>
				</div>
			</div>
			<div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,.08)' }}>
				<button
					onClick={() => { timelineRef.current?.togglePlayPause(); }}
					disabled={!scene.output.frameCount}
					style={miniBtn}
					title={timelinePlaying ? '暂停' : '播放'}
				>
					{timelinePlaying ? '⏸ 暂停' : '▶ 播放'}
				</button>
				<button
					onClick={() => { const next = !timelineLoop; setTimelineLoop(next); timelineRef.current?.setLoopPlayback(next); }}
					style={chipStyle(timelineLoop)}
					title="循环播放"
				>
					🔁 循环
				</button>
				<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', minWidth: 64 }}>
					{timelineFrame} / {scene.output.frameCount} 帧
				</span>
				<input
					type="range"
					min={0}
					max={Math.max(1, scene.output.frameCount)}
					step={1}
					value={Math.min(timelineFrame, scene.output.frameCount)}
					onChange={e => timelineRef.current?.seekToFrame(Number(e.target.value))}
					style={{ flex: 1, accentColor: '#4a9eff' }}
				/>
			</div>
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
				3D 摆场（几何体 + 灯光 + 相机 + 移动/旋转/缩放 + 撤销 + 时间轴）；调整后约 1.2 秒自动拍摄上传。
			</div>
		</div>
	);
}

// ── scene ↔ three 同步 ─────────────────────────────────────────────────

function createPrimitiveMesh(entry: { shape: PrimitiveShape; color: string }): THREE.Mesh {
	let geometry: THREE.BufferGeometry;
	if (entry.shape === 'cube') { geometry = new THREE.BoxGeometry(1, 1, 1); }
	else if (entry.shape === 'sphere') { geometry = new THREE.SphereGeometry(0.5, 24, 24); }
	else if (entry.shape === 'cylinder') { geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 24); }
	else { geometry = new THREE.PlaneGeometry(1, 1); }
	const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: entry.color, roughness: 0.7, metalness: 0.05 }));
	return mesh;
}

function createSceneLight(type: SceneLightType): { light: THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight; helper: THREE.Object3D & { dispose: () => void } } {
	if (type === 'point') {
		const light = new THREE.PointLight();
		return { light, helper: new THREE.PointLightHelper(light, 0.4) };
	}
	if (type === 'spot') {
		const light = new THREE.SpotLight();
		return { light, helper: new THREE.SpotLightHelper(light) };
	}
	const light = new THREE.DirectionalLight();
	return { light, helper: new THREE.DirectionalLightHelper(light, 0.6) };
}

function disposeRig(rig: SceneRig | undefined): void {
	if (!rig) { return; }
	for (const mesh of rig.primMeshes.values()) {
		mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose();
	}
	for (const lo of rig.lightObjects.values()) {
		lo.helper.dispose(); lo.light.dispose();
	}
	for (const co of rig.cameraObjects.values()) {
		co.group.traverse((obj) => {
			if (obj instanceof THREE.Mesh) {
				obj.geometry.dispose(); (obj.material as THREE.Material).dispose();
			}
		});
		co.helper.dispose();
	}
}

function buildCameraMarker(): THREE.Group {
	const group = new THREE.Group();
	const mat = new THREE.MeshBasicMaterial({ color: 0xe8b84a });
	const body = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.3), mat);
	const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.14, 16), mat);
	lens.rotation.x = -Math.PI / 2;
	lens.position.z = -0.22;
	group.add(body, lens);
	return group;
}

function syncCameras(t: { scene: THREE.Scene; rig: SceneRig }, scene: Scene3DState, selectedId: string | null): void {
	const { rig } = t;
	const seen = new Set<string>();
	for (const c of scene.cameras) {
		seen.add(c.id);
		let co = rig.cameraObjects.get(c.id);
		if (!co) {
			const group = buildCameraMarker();
			group.traverse((obj) => { if (obj instanceof THREE.Mesh) { obj.userData.cameraId = c.id; } });
			const helperCam = new THREE.PerspectiveCamera(c.fov, 1, 0.1, 4);
			const helper = new THREE.CameraHelper(helperCam);
			co = { group, helper };
			rig.cameraObjects.set(c.id, co);
			t.scene.add(group, helper);
		}
		co.group.position.set(c.transform.position.x, c.transform.position.y, c.transform.position.z);
		co.group.quaternion.set(c.transform.quaternion.x, c.transform.quaternion.y, c.transform.quaternion.z, c.transform.quaternion.w);
		co.group.visible = !c.hidden;
		co.helper.update();
		const selected = c.id === selectedId;
		co.group.traverse((obj) => {
			if (obj instanceof THREE.Mesh) {
				(obj.material as THREE.MeshBasicMaterial).color.set(selected ? 0x4a9eff : 0xe8b84a);
			}
		});
		co.helper.visible = selected;
	}
	for (const [id, co] of rig.cameraObjects) {
		if (!seen.has(id)) {
			t.scene.remove(co.group, co.helper);
			co.group.traverse((obj) => {
				if (obj instanceof THREE.Mesh) { obj.geometry.dispose(); (obj.material as THREE.Material).dispose(); }
			});
			co.helper.dispose();
			rig.cameraObjects.delete(id);
		}
	}
}

function syncScene(t: { scene: THREE.Scene; rig: SceneRig; grid: THREE.GridHelper }, scene: Scene3DState, selectedId: string | null, _tool: string): void {
	const { rig } = t;
	// primitives：增量增删
	const seen = new Set<string>();
	for (const p of scene.primitives) {
		seen.add(p.id);
		let mesh = rig.primMeshes.get(p.id);
		if (!mesh) {
			mesh = createPrimitiveMesh(p);
			mesh.userData.id = p.id;
			rig.primMeshes.set(p.id, mesh);
			t.scene.add(mesh);
		}
		(mesh.material as THREE.MeshStandardMaterial).color.set(p.color);
		mesh.position.set(p.transform.position.x, p.transform.position.y, p.transform.position.z);
		mesh.scale.set(p.transform.scale.x, p.transform.scale.y, p.transform.scale.z);
		mesh.visible = !p.hidden;
		if (p.id === selectedId) {
			(mesh.material as THREE.MeshStandardMaterial).emissive?.set(0x222222);
		} else {
			(mesh.material as THREE.MeshStandardMaterial).emissive?.set(0x000000);
		}
	}
	for (const [id, mesh] of rig.primMeshes) {
		if (!seen.has(id)) {
			t.scene.remove(mesh);
			mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose();
			rig.primMeshes.delete(id);
		}
	}
	// lights：增量增删
	const seenLights = new Set<string>();
	for (const l of scene.lights) {
		seenLights.add(l.id);
		let lo = rig.lightObjects.get(l.id);
		if (!lo) {
			lo = createSceneLight(l.type);
			rig.lightObjects.set(l.id, lo);
			t.scene.add(lo.light);
			if (lo.light instanceof THREE.DirectionalLight || lo.light instanceof THREE.SpotLight) {
				t.scene.add(lo.light.target);
			}
			t.scene.add(lo.helper);
		}
		lo.light.color.set(l.color);
		lo.light.intensity = l.intensity;
		lo.light.position.set(l.position.x, l.position.y, l.position.z);
		const target = lightTarget(l);
		if (lo.light instanceof THREE.SpotLight) {
			lo.light.target.position.set(target.x, target.y, target.z);
			lo.light.target.updateMatrixWorld(true);
			lo.light.distance = l.range ?? 0;
			lo.light.angle = (l.outerConeAngle ?? 45) * Math.PI / 180;
			const outer = Math.max(l.outerConeAngle ?? 45, 1e-3);
			const inner = Math.min(l.innerConeAngle ?? 30, outer);
			lo.light.penumbra = Math.min(Math.max(1 - inner / outer, 0), 1);
		} else if (lo.light instanceof THREE.PointLight) {
			lo.light.distance = l.range ?? 0;
		} else {
			lo.light.target.position.set(target.x, target.y, target.z);
			lo.light.target.updateMatrixWorld(true);
		}
	}
	for (const [id, lo] of rig.lightObjects) {
		if (!seenLights.has(id)) {
			t.scene.remove(lo.light, lo.helper);
			lo.helper.dispose(); lo.light.dispose();
			rig.lightObjects.delete(id);
		}
	}
	// cameras：增量增删
	syncCameras(t, scene, selectedId);
	// 环境设置：showGrid 控制网格显隐；background 控制场景背景色
	t.grid.visible = scene.environment.showGrid;
	if (scene.environment.background) {
		t.scene.background = new THREE.Color(scene.environment.background);
	} else {
		t.scene.background = new THREE.Color(0x2a2a2e);
	}
}
