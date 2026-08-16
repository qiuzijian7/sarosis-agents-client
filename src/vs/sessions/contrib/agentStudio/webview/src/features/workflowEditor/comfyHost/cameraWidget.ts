/**
 * cameraWidget.ts — Multiangle 3D 相机轨道可视化引擎（Three.js）
 *
 * 复刻自 ComfyTV src/widgets/three/CameraWidget.ts
 * 适配 VS Code webview 环境：直接使用 WebGLRenderer（非共享 RendererView）
 *
 * 核心功能：
 *   - 图像平面（subject）+ 粉色发光边框
 *   - 相机指示器（锥体 + 光晕球）
 *   - 方位角圆环（粉色 Torus）+ 可拖拽手柄
 *   - 俯仰角弧线（青色 Tube）+ 可拖拽手柄
 *   - 距离手柄（黄色球体）
 *   - Raycaster 拖拽交互 / Orbit 轨道模式
 *   - Prompt 自动生成
 */

import * as THREE from 'three';

// ── 类型 ───────────────────────────────────────────────────────────

export interface CameraState {
	azimuth: number;
	elevation: number;
	distance: number;
	imageUrl: string | null;
}

export interface CameraWidgetOptions {
	container: HTMLElement;
	initialState?: Partial<CameraState>;
	onStateChange?: (state: CameraState) => void;
}

// ── 常量 ───────────────────────────────────────────────────────────

const CENTER = new THREE.Vector3(0, 0.5, 0);
const AZIMUTH_RADIUS = 1.8;
const ELEVATION_RADIUS = 1.4;
const ELEV_ARC_X = -0.8;

// 颜色
const C_AZIMUTH = 0xE93D82;      // 粉红
const C_ELEVATION = 0x00FFD0;    // 青色
const C_DISTANCE = 0xFFB800;     // 黄色
const BG_COLOR = 0x0a0a0f;

// ── CameraWidget 类 ────────────────────────────────────────────────

export class CameraWidget {
	private container: HTMLElement;
	private state: CameraState;
	private onStateChange?: (state: CameraState) => void;

	// Three.js 对象
	private scene!: THREE.Scene;
	private camera!: THREE.PerspectiveCamera;
	private previewCamera!: THREE.PerspectiveCamera;
	private renderer!: THREE.WebGLRenderer;
	private canvas!: HTMLCanvasElement;
	private activeCamera!: THREE.Camera;

	// 3D 元素
	private cameraIndicator!: THREE.Mesh;
	private camGlow!: THREE.Mesh;
	private azimuthHandle!: THREE.Mesh;
	private azGlow!: THREE.Mesh;
	private elevationHandle!: THREE.Mesh;
	private elGlow!: THREE.Mesh;
	private distanceHandle!: THREE.Mesh;
	private distGlow!: THREE.Mesh;
	private glowRing!: THREE.Mesh;
	private imagePlane!: THREE.Mesh;
	private imageFrame!: THREE.LineSegments;
	private planeMat!: THREE.MeshBasicMaterial;
	private distanceTube: THREE.Mesh | null = null;
	private azimuthRing!: THREE.Mesh;
	private elevationArc!: THREE.Mesh;
	private gridHelper!: THREE.GridHelper;

	// 运行时状态
	private liveAzimuth = 0;
	private liveElevation = 0;
	private liveDistance = 5;
	private isDragging = false;
	private dragTarget: string | null = null;
	private hoveredHandle: { mesh: THREE.Mesh; glow: THREE.Mesh; name: string } | null = null;
	private raycaster = new THREE.Raycaster();
	private mouse = new THREE.Vector2();

	// Orbit 模式
	private useCameraView = false;
	private isOrbitDragging = false;
	private orbitStartX = 0;
	private orbitStartY = 0;
	private orbitStartAzimuth = 0;
	private orbitStartElevation = 0;

	// 动画
	private animationId: number | null = null;
	private time = 0;

	constructor(options: CameraWidgetOptions) {
		this.container = options.container;
		this.onStateChange = options.onStateChange;
		this.state = {
			azimuth: options.initialState?.azimuth ?? 0,
			elevation: options.initialState?.elevation ?? 0,
			distance: options.initialState?.distance ?? 5,
			imageUrl: options.initialState?.imageUrl ?? null,
		};

		this.liveAzimuth = this.state.azimuth;
		this.liveElevation = this.state.elevation;
		this.liveDistance = this.state.distance;

		this.initThreeJS();
		this.bindEvents();
		this.animate();
	}

	// ── 初始化 ───────────────────────────────────────────────────

	private initThreeJS(): void {
		const width = this.container.clientWidth || 300;
		const height = this.container.clientHeight || 300;

		// Scene
		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(BG_COLOR);

		// 观察相机（固定视角看整个场景）
		this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
		this.camera.position.set(4, 3.5, 4);
		this.camera.lookAt(0, 0.3, 0);

		// 预览相机（跟随轨道位置，用于 camera-view 模式）
		this.previewCamera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
		this.activeCamera = this.camera;

		// Renderer（直接渲染到 canvas，不用共享 RendererView）
		this.canvas = document.createElement('canvas');
		this.canvas.style.position = 'absolute';
		this.canvas.style.inset = '0';
		this.canvas.style.width = '100%';
		this.canvas.style.height = '100%';
		this.canvas.style.outline = 'none';
		this.container.appendChild(this.canvas);

		const dpr = Math.min(window.devicePixelRatio, 2);
		this.renderer = new THREE.WebGLRenderer({
			canvas: this.canvas,
			antialias: true,
			alpha: false,
			preserveDrawingBuffer: false,
		});
		this.renderer.setSize(width * dpr, height * dpr, false);
		this.renderer.setPixelRatio(dpr);
		this.renderer.setClearColor(BG_COLOR, 1);

		// 灯光
		this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
		const mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
		mainLight.position.set(5, 10, 5);
		this.scene.add(mainLight);
		const fillLight = new THREE.DirectionalLight(C_AZIMUTH, 0.3);
		fillLight.position.set(-5, 5, -5);
		this.scene.add(fillLight);

		// 地面网格
		this.gridHelper = new THREE.GridHelper(5, 20, 0x1a1a2e, 0x12121a);
		this.gridHelper.position.y = -0.01;
		this.scene.add(this.gridHelper);

		// 创建 3D 元素
		this.createSubject();
		this.createCameraIndicator();
		this.createAzimuthRing();
		this.createElevationArc();
		this.createDistanceHandle();
		this.updateVisuals();
	}

	// ── 创建场景元素 ─────────────────────────────────────────────

	private createGridTexture(): THREE.CanvasTexture {
		const canvas = document.createElement('canvas');
		const size = 256;
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d')!;
		ctx.fillStyle = '#1a1a2a';
		ctx.fillRect(0, 0, size, size);
		ctx.strokeStyle = '#2a2a3a';
		ctx.lineWidth = 1;
		const gridSize = 16;
		for (let i = 0; i <= size; i += gridSize) {
			ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.stroke();
			ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(0, size); ctx.stroke();
		}
		const tex = new THREE.CanvasTexture(canvas);
		tex.wrapS = THREE.RepeatWrapping;
		tex.wrapT = THREE.RepeatWrapping;
		tex.repeat.set(4, 4);
		return tex;
	}

	private createSubject(): void {
		const cardThickness = 0.02;
		const cardGeo = new THREE.BoxGeometry(1.2, 1.2, cardThickness);
		const frontMat = new THREE.MeshBasicMaterial({ color: 0x3a3a4a });
		const backMat = new THREE.MeshBasicMaterial({ map: this.createGridTexture() });
		const edgeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a2a });
		const materials = [edgeMat, edgeMat, edgeMat, edgeMat, frontMat, backMat];
		this.imagePlane = new THREE.Mesh(cardGeo, materials);
		this.imagePlane.position.copy(CENTER);
		this.scene.add(this.imagePlane);
		this.planeMat = frontMat;

		// 粉色边框
		const frameGeo = new THREE.EdgesGeometry(cardGeo);
		const frameMat = new THREE.LineBasicMaterial({ color: C_AZIMUTH });
		this.imageFrame = new THREE.LineSegments(frameGeo, frameMat);
		this.imageFrame.position.copy(CENTER);
		this.scene.add(this.imageFrame);

		// 底部发光环
		const glowGeo = new THREE.RingGeometry(0.55, 0.58, 64);
		const glowMat = new THREE.MeshBasicMaterial({
			color: C_AZIMUTH, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
		});
		this.glowRing = new THREE.Mesh(glowGeo, glowMat);
		this.glowRing.position.set(0, 0.01, 0);
		this.glowRing.rotation.x = -Math.PI / 2;
		this.scene.add(this.glowRing);
	}

	private createCameraIndicator(): void {
		const geo = new THREE.ConeGeometry(0.15, 0.4, 4);
		const mat = new THREE.MeshStandardMaterial({
			color: C_AZIMUTH, emissive: C_AZIMUTH, emissiveIntensity: 0.5,
			metalness: 0.8, roughness: 0.2,
		});
		this.cameraIndicator = new THREE.Mesh(geo, mat);
		this.scene.add(this.cameraIndicator);

		const gGeo = new THREE.SphereGeometry(0.08, 16, 16);
		const gMat = new THREE.MeshBasicMaterial({ color: 0xff6ba8, transparent: true, opacity: 0.8 });
		this.camGlow = new THREE.Mesh(gGeo, gMat);
		this.scene.add(this.camGlow);
	}

	private createAzimuthRing(): void {
		const ringGeo = new THREE.TorusGeometry(AZIMUTH_RADIUS, 0.04, 16, 100);
		const ringMat = new THREE.MeshBasicMaterial({ color: C_AZIMUTH, transparent: true, opacity: 0.7 });
		this.azimuthRing = new THREE.Mesh(ringGeo, ringMat);
		this.azimuthRing.rotation.x = Math.PI / 2;
		this.azimuthRing.position.y = 0.02;
		this.scene.add(this.azimuthRing);

		const hGeo = new THREE.SphereGeometry(0.16, 32, 32);
		const hMat = new THREE.MeshStandardMaterial({
			color: C_AZIMUTH, emissive: C_AZIMUTH, emissiveIntensity: 0.6,
			metalness: 0.3, roughness: 0.4,
		});
		this.azimuthHandle = new THREE.Mesh(hGeo, hMat);
		this.scene.add(this.azimuthHandle);

		const gGeo = new THREE.SphereGeometry(0.22, 16, 16);
		const gMat = new THREE.MeshBasicMaterial({ color: C_AZIMUTH, transparent: true, opacity: 0.2 });
		this.azGlow = new THREE.Mesh(gGeo, gMat);
		this.scene.add(this.azGlow);
	}

	private createElevationArc(): void {
		const points: THREE.Vector3[] = [];
		for (let i = 0; i <= 32; i++) {
			const angle = (-30 + (90 * i / 32)) * Math.PI / 180;
			points.push(new THREE.Vector3(
				ELEV_ARC_X,
				ELEVATION_RADIUS * Math.sin(angle) + CENTER.y,
				ELEVATION_RADIUS * Math.cos(angle),
			));
		}
		const curve = new THREE.CatmullRomCurve3(points);
		const arcGeo = new THREE.TubeGeometry(curve, 32, 0.04, 8, false);
		const arcMat = new THREE.MeshBasicMaterial({ color: C_ELEVATION, transparent: true, opacity: 0.8 });
		this.elevationArc = new THREE.Mesh(arcGeo, arcMat);
		this.scene.add(this.elevationArc);

		const hGeo = new THREE.SphereGeometry(0.16, 32, 32);
		const hMat = new THREE.MeshStandardMaterial({
			color: C_ELEVATION, emissive: C_ELEVATION, emissiveIntensity: 0.6,
			metalness: 0.3, roughness: 0.4,
		});
		this.elevationHandle = new THREE.Mesh(hGeo, hMat);
		this.scene.add(this.elevationHandle);

		const gGeo = new THREE.SphereGeometry(0.22, 16, 16);
		const gMat = new THREE.MeshBasicMaterial({ color: C_ELEVATION, transparent: true, opacity: 0.2 });
		this.elGlow = new THREE.Mesh(gGeo, gMat);
		this.scene.add(this.elGlow);
	}

	private createDistanceHandle(): void {
		const hGeo = new THREE.SphereGeometry(0.15, 32, 32);
		const hMat = new THREE.MeshStandardMaterial({
			color: C_DISTANCE, emissive: C_DISTANCE, emissiveIntensity: 0.7,
			metalness: 0.5, roughness: 0.3,
		});
		this.distanceHandle = new THREE.Mesh(hGeo, hMat);
		this.scene.add(this.distanceHandle);

		const gGeo = new THREE.SphereGeometry(0.22, 16, 16);
		const gMat = new THREE.MeshBasicMaterial({ color: C_DISTANCE, transparent: true, opacity: 0.25 });
		this.distGlow = new THREE.Mesh(gGeo, gMat);
		this.scene.add(this.distGlow);
	}

	// ── 视觉更新 ─────────────────────────────────────────────────

	private updateDistanceLine(start: THREE.Vector3, end: THREE.Vector3): void {
		if (this.distanceTube) {
			this.scene.remove(this.distanceTube);
			this.distanceTube.geometry.dispose();
			(this.distanceTube.material as THREE.Material).dispose();
		}
		const path = new THREE.LineCurve3(start, end);
		const tubeGeo = new THREE.TubeGeometry(path, 1, 0.025, 8, false);
		const tubeMat = new THREE.MeshBasicMaterial({ color: C_DISTANCE, transparent: true, opacity: 0.8 });
		this.distanceTube = new THREE.Mesh(tubeGeo, tubeMat);
		this.scene.add(this.distanceTube);
	}

	private updateVisuals(): void {
		const azRad = (this.liveAzimuth * Math.PI) / 180;
		const elRad = (this.liveElevation * Math.PI) / 180;
		const visualDist = 2.6 - (this.liveDistance / 10) * 2.0;

		// 相机位置（球坐标 → 笛卡尔）
		const camX = visualDist * Math.sin(azRad) * Math.cos(elRad);
		const camY = CENTER.y + visualDist * Math.sin(elRad);
		const camZ = visualDist * Math.cos(azRad) * Math.cos(elRad);

		this.cameraIndicator.position.set(camX, camY, camZ);
		this.cameraIndicator.lookAt(CENTER);
		this.cameraIndicator.rotateX(Math.PI / 2);
		this.camGlow.position.copy(this.cameraIndicator.position);

		// 方位角手柄（在水平圆环上）
		const azX = AZIMUTH_RADIUS * Math.sin(azRad);
		const azZ = AZIMUTH_RADIUS * Math.cos(azRad);
		this.azimuthHandle.position.set(azX, 0.16, azZ);
		this.azGlow.position.copy(this.azimuthHandle.position);

		// 俯仰角手柄（在垂直弧线上）
		const elY = CENTER.y + ELEVATION_RADIUS * Math.sin(elRad);
		const elZ = ELEVATION_RADIUS * Math.cos(elRad);
		this.elevationHandle.position.set(ELEV_ARC_X, elY, elZ);
		this.elGlow.position.copy(this.elevationHandle.position);

		// 距离手柄（在中心→相机连线上）
		const distT = 0.15 + ((10 - this.liveDistance) / 10) * 0.7;
		this.distanceHandle.position.lerpVectors(CENTER, this.cameraIndicator.position, distT);
		this.distGlow.position.copy(this.distanceHandle.position);

		this.updateDistanceLine(CENTER.clone(), this.cameraIndicator.position.clone());

		// 同步预览相机
		this.previewCamera.position.copy(this.cameraIndicator.position);
		this.previewCamera.lookAt(CENTER);

		// 动画：旋转发光环
		this.glowRing.rotation.z += 0.005;
	}

	// ── 事件处理 ─────────────────────────────────────────────────

	private bindEvents(): void {
		const canvas = this.canvas;

		canvas.addEventListener('mousedown', this.onPointerDown.bind(this));
		canvas.addEventListener('mousemove', this.onPointerMove.bind(this));
		canvas.addEventListener('mouseup', this.onPointerUp.bind(this));
		canvas.addEventListener('mouseleave', this.onPointerUp.bind(this));

		canvas.addEventListener('touchstart', (e) => {
			e.preventDefault();
			this.onPointerDown({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY } as MouseEvent);
		}, { passive: false });

		canvas.addEventListener('touchmove', (e) => {
			e.preventDefault();
			this.onPointerMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY } as MouseEvent);
		}, { passive: false });

		canvas.addEventListener('touchend', () => this.onPointerUp());
		canvas.addEventListener('wheel', this.onWheel.bind(this), { passive: false });

		const ro = new ResizeObserver(() => this.onResize());
		ro.observe(this.container);
	}

	private getMousePos(event: MouseEvent): void {
		const rect = this.canvas.getBoundingClientRect();
		this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
	}

	private setHandleScale(handle: THREE.Mesh, glow: THREE.Mesh | null, scale: number): void {
		handle.scale.setScalar(scale);
		if (glow) glow.scale.setScalar(scale);
	}

	private onPointerDown(event: MouseEvent): void {
		this.getMousePos(event);

		if (this.useCameraView) {
			this.isOrbitDragging = true;
			this.orbitStartX = event.clientX;
			this.orbitStartY = event.clientY;
			this.orbitStartAzimuth = this.liveAzimuth;
			this.orbitStartElevation = this.liveElevation;
			this.canvas.style.cursor = 'grabbing';
			return;
		}

		this.raycaster.setFromCamera(this.mouse, this.camera);
		const handles = [
			{ mesh: this.azimuthHandle, glow: this.azGlow, name: 'azimuth' },
			{ mesh: this.elevationHandle, glow: this.elGlow, name: 'elevation' },
			{ mesh: this.distanceHandle, glow: this.distGlow, name: 'distance' },
		];
		for (const h of handles) {
			if (this.raycaster.intersectObject(h.mesh).length > 0) {
				this.isDragging = true;
				this.dragTarget = h.name;
				this.setHandleScale(h.mesh, h.glow, 1.3);
				this.canvas.style.cursor = 'grabbing';
				return;
			}
		}
	}

	private onPointerMove(event: MouseEvent): void {
		this.getMousePos(event);

		// Orbit 模式拖拽
		if (this.useCameraView && this.isOrbitDragging) {
			const dx = event.clientX - this.orbitStartX;
			const dy = event.clientY - this.orbitStartY;
			const sens = 0.5;
			let az = this.orbitStartAzimuth - dx * sens;
			while (az < 0) az += 360;
			while (az >= 360) az -= 360;
			this.liveAzimuth = az;
			this.state.azimuth = Math.round(this.liveAzimuth);
			let el = this.orbitStartElevation + dy * sens;
			el = Math.max(-30, Math.min(60, el));
			this.liveElevation = el;
			this.state.elevation = Math.round(this.liveElevation);
			this.updateVisuals();
			this.notifyStateChange();
			return;
		}

		this.raycaster.setFromCamera(this.mouse, this.camera);

		// Hover 检测（非拖拽时）
		if (!this.isDragging) {
			const handles = [
				{ mesh: this.azimuthHandle, glow: this.azGlow, name: 'azimuth' },
				{ mesh: this.elevationHandle, glow: this.elGlow, name: 'elevation' },
				{ mesh: this.distanceHandle, glow: this.distGlow, name: 'distance' },
			];
			let found: typeof handles[0] | null = null;
			for (const h of handles) {
				if (this.raycaster.intersectObject(h.mesh).length > 0) { found = h; break; }
			}
			if (this.hoveredHandle && this.hoveredHandle !== found) {
				this.setHandleScale(this.hoveredHandle.mesh, this.hoveredHandle.glow, 1.0);
			}
			if (found) {
				this.setHandleScale(found.mesh, found.glow, 1.15);
				this.canvas.style.cursor = 'grab';
				this.hoveredHandle = found;
			} else {
				this.canvas.style.cursor = 'default';
				this.hoveredHandle = null;
			}
			return;
		}

		// 拖拽中 —— 投射到对应平面计算新值
		const plane = new THREE.Plane();
		const intersect = new THREE.Vector3();

		if (this.dragTarget === 'azimuth') {
			plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0));
			if (this.raycaster.ray.intersectPlane(plane, intersect)) {
				let angle = Math.atan2(intersect.x, intersect.z) * (180 / Math.PI);
				if (angle < 0) angle += 360;
				this.liveAzimuth = Math.max(0, Math.min(360, angle));
				this.state.azimuth = Math.round(this.liveAzimuth);
				this.updateVisuals();
				this.notifyStateChange();
			}
		} else if (this.dragTarget === 'elevation') {
			const elevPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -ELEV_ARC_X);
			if (this.raycaster.ray.intersectPlane(elevPlane, intersect)) {
				const relY = intersect.y - CENTER.y;
				const relZ = intersect.z;
				let angle = Math.atan2(relY, relZ) * (180 / Math.PI);
				angle = Math.max(-30, Math.min(60, angle));
				this.liveElevation = angle;
				this.state.elevation = Math.round(this.liveElevation);
				this.updateVisuals();
				this.notifyStateChange();
			}
		} else if (this.dragTarget === 'distance') {
			const newDist = 5 - this.mouse.y * 5;
			this.liveDistance = Math.max(0, Math.min(10, newDist));
			this.state.distance = Math.round(this.liveDistance * 10) / 10;
			this.updateVisuals();
			this.notifyStateChange();
		}
	}

	private onPointerUp(): void {
		if (this.isOrbitDragging) {
			this.isOrbitDragging = false;
			this.canvas.style.cursor = this.useCameraView ? 'grab' : 'default';
			return;
		}
		if (this.isDragging) [
			{ mesh: this.azimuthHandle, glow: this.azGlow },
			{ mesh: this.elevationHandle, glow: this.elGlow },
			{ mesh: this.distanceHandle, glow: this.distGlow },
		].forEach(h => this.setHandleScale(h.mesh, h.glow, 1.0));

		this.isDragging = false;
		this.dragTarget = null;
		this.canvas.style.cursor = 'default';
	}

	private onWheel(event: WheelEvent): void {
		if (!this.useCameraView) return;
		event.preventDefault();
		const sens = 0.01;
		let d = this.liveDistance - event.deltaY * sens;
		d = Math.max(0, Math.min(10, d));
		this.liveDistance = d;
		this.state.distance = Math.round(this.liveDistance * 10) / 10;
		this.updateVisuals();
		this.notifyStateChange();
	}

	private onResize(): void {
		const w = this.container.clientWidth;
		const h = this.container.clientHeight;
		if (w === 0 || h === 0) return;
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.previewCamera.aspect = w / h;
		this.previewCamera.updateProjectionMatrix();
		const dpr = Math.min(window.devicePixelRatio, 2);
		this.renderer.setSize(w * dpr, h * dpr, false);
	}

	// ── 动画循环 ─────────────────────────────────────────────────

	private animate(): void {
		this.animationId = requestAnimationFrame(() => this.animate());
		this.time += 0.01;
		const pulse = 1 + Math.sin(this.time * 2) * 0.03;
		this.camGlow.scale.setScalar(pulse);
		this.glowRing.rotation.z += 0.003;
		this.renderer.render(this.scene, this.activeCamera);
	}

	private notifyStateChange(): void {
		this.onStateChange?.({ ...this.state });
	}

	// ── 公共 API ──────────────────────────────────────────────────

	/** 根据 azimuth/elevation/distance 自动生成 prompt 文本 */
	public generatePrompt(): string {
		const hAngle = this.state.azimuth % 360;

		let hDir: string;
		if (hAngle < 22.5 || hAngle >= 337.5) hDir = 'front view';
		else if (hAngle < 67.5) hDir = 'front-right quarter view';
		else if (hAngle < 112.5) hDir = 'right side view';
		else if (hAngle < 157.5) hDir = 'back-right quarter view';
		else if (hAngle < 202.5) hDir = 'back view';
		else if (hAngle < 247.5) hDir = 'back-left quarter view';
		else if (hAngle < 292.5) hDir = 'left side view';
		else hDir = 'front-left quarter view';

		let vDir: string;
		if (this.state.elevation < -15) vDir = 'low-angle shot';
		else if (this.state.elevation < 15) vDir = 'eye-level shot';
		else if (this.state.elevation < 45) vDir = 'elevated shot';
		else vDir = 'high-angle shot';

		let dist: string;
		if (this.state.distance < 2) dist = 'wide shot';
		else if (this.state.distance < 6) dist = 'medium shot';
		else dist = 'close-up';

		return `<sks> ${hDir} ${vDir} ${dist}`;
	}

	public setState(newState: Partial<CameraState>): void {
		if (newState.azimuth !== undefined) { this.state.azimuth = newState.azimuth; this.liveAzimuth = newState.azimuth; }
		if (newState.elevation !== undefined) { this.state.elevation = newState.elevation; this.liveElevation = newState.elevation; }
		if (newState.distance !== undefined) { this.state.distance = newState.distance; this.liveDistance = newState.distance; }
		if (newState.imageUrl !== undefined) { this.state.imageUrl = newState.imageUrl; this.updateImage(newState.imageUrl); }
		this.updateVisuals();
	}

	public getState(): CameraState {
		return { ...this.state };
	}

	public getPrompt(): string {
		return this.generatePrompt();
	}

	public resetToDefaults(): void {
		this.state.azimuth = 0; this.state.elevation = 0; this.state.distance = 5.0;
		this.liveAzimuth = 0; this.liveElevation = 0; this.liveDistance = 5.0;
		this.updateVisuals();
		this.notifyStateChange();
	}

	public setCameraView(enabled: boolean): void {
		this.useCameraView = enabled;
		this.isOrbitDragging = false;
		const handles: (THREE.Object3D | null)[] = [
			this.azimuthRing, this.azimuthHandle, this.azGlow,
			this.elevationArc, this.elevationHandle, this.elGlow,
			this.distanceHandle, this.distGlow, this.distanceTube,
			this.cameraIndicator, this.camGlow, this.glowRing,
			this.gridHelper, this.imageFrame,
		];
		for (const obj of handles) { if (obj) obj.visible = !enabled; }
		this.canvas.style.cursor = enabled ? 'grab' : 'default';
	}

	public updateImage(url: string | null): void {
		if (url) {
			const img = new Image();
			if (!url.startsWith('data:')) img.crossOrigin = 'anonymous';
			img.onload = () => {
				const tex = new THREE.Texture(img);
				tex.colorSpace = THREE.SRGBColorSpace;
				tex.needsUpdate = true;
				this.planeMat.map = tex;
				this.planeMat.color.set(0xffffff);
				this.planeMat.needsUpdate = true;
				const ar = img.width / img.height;
				const maxS = 1.5;
				let sx: number, sy: number;
				if (ar > 1) { sx = maxS; sy = maxS / ar; }
				else { sy = maxS; sx = maxS * ar; }
				this.imagePlane.scale.set(sx, sy, 1);
				this.imageFrame.scale.set(sx, sy, 1);
			};
			img.onerror = () => {
				this.planeMat.map = null;
				this.planeMat.color.set(C_AZIMUTH);
				this.planeMat.needsUpdate = true;
			};
			img.src = url;
		} else {
			this.planeMat.map = null;
			this.planeMat.color.set(0x3a3a4a);
			this.planeMat.needsUpdate = true;
			this.imagePlane.scale.set(1, 1, 1);
			this.imageFrame.scale.set(1, 1, 1);
		}
	}

	public dispose(): void {
		if (this.animationId !== null) {
			try { cancelAnimationFrame(this.animationId); } catch { /* noop */ }
			this.animationId = null;
		}
		try { this.renderer.dispose(); } catch { /* noop */ }
		try { this.scene.clear(); } catch { /* noop */ }
		try { this.canvas.remove(); } catch { /* noop */ }
	}
}
