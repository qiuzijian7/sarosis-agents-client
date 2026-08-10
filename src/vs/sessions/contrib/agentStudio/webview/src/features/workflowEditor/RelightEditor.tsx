/*---------------------------------------------------------------------------------------------
 *  RelightEditor — embedded "light ball" editor for the ComfyTV Relight stage
 *  (P3). A lightweight orthographic light-ball on a 2D canvas (no WebGL): drag
 *  lights around the ball, pick color/intensity, apply ComfyTV's presets, and
 *  let a debounced upload push the reference render to ComfyUI input/.
 *  The data contract (LightInfoEntry[] JSON) matches ComfyTV exactly, so the
 *  stored workflow is portable to ComfyTV itself.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { ComfyRunnerRegistry } from './comfyHost/comfyRunner';
import {
	LIGHT_PRESETS, LIGHT_TYPES, cloneLights, createDefaultLight, lightDirection,
	normalizeLights, orthographicProject, screenToSphere,
	type LightInfoEntry, type LightInfoType,
} from './comfyHost/relightEditor';

export interface RelightEditorProps {
	initialLights: LightInfoEntry[];
	initialPrompt: string;
	runners: ComfyRunnerRegistry;
	preference: string;
	onLightsChange: (lightsJson: string, prompt: string) => void;
	onRenderUploaded: (url: string | null) => void;
}

const BALL_R = 96;
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

export function RelightEditor({
	initialLights, initialPrompt, runners, preference, onLightsChange, onRenderUploaded,
}: RelightEditorProps): React.JSX.Element {
	const [lights, setLights] = React.useState<LightInfoEntry[]>(() => cloneLights(initialLights));
	const [selected, setSelected] = React.useState(0);
	const [prompt, setPrompt] = React.useState(initialPrompt);
	const canvasRef = React.useRef<HTMLCanvasElement>(null);
	const dragRef = React.useRef<{ index: number; len: number } | null>(null);
	const uploadTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const runnersRef = React.useRef(runners); runnersRef.current = runners;
	const preferenceRef = React.useRef(preference); preferenceRef.current = preference;

	const selectedLight = lights[selected] ?? null;

	const commit = React.useCallback((next: LightInfoEntry[]) => {
		setLights(next);
		onLightsChange(JSON.stringify(next), prompt);
		scheduleUpload();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onLightsChange, prompt]);

	const scheduleUpload = React.useCallback(() => {
		if (uploadTimerRef.current) { clearTimeout(uploadTimerRef.current); }
		uploadTimerRef.current = setTimeout(() => { void uploadRender(); }, UPLOAD_DEBOUNCE_MS);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [uploadRender]);

	const uploadRender = React.useCallback(async () => {
		const canvas = canvasRef.current;
		if (!canvas) { return; }
		const runner = runnersRef.current.resolve(preferenceRef.current);
		if (!runner?.fetchApi) { onRenderUploaded(null); return; }
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
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

	// ── draw the light ball ───────────────────────────────────────────────
	React.useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) { return; }
		const ctx = canvas.getContext('2d');
		if (!ctx) { return; }
		const W = canvas.width; const H = canvas.height;
		const cx = W / 2; const cy = H / 2;
		ctx.clearRect(0, 0, W, H);
		ctx.fillStyle = '#17181c';
		ctx.fillRect(0, 0, W, H);
		const grad = ctx.createRadialGradient(cx - BALL_R * 0.3, cy - BALL_R * 0.4, BALL_R * 0.1, cx, cy, BALL_R);
		grad.addColorStop(0, '#5b6470');
		grad.addColorStop(1, '#26282d');
		ctx.fillStyle = grad;
		ctx.beginPath(); ctx.arc(cx, cy, BALL_R, 0, Math.PI * 2); ctx.fill();
		ctx.strokeStyle = 'rgba(255,255,255,.16)';
		ctx.beginPath(); ctx.ellipse(cx, cy, BALL_R, BALL_R * 0.28, 0, 0, Math.PI * 2); ctx.stroke();

		lights.forEach((light, i) => {
			const p = orthographicProject(light.position, BALL_R);
			const x = cx + p.x; const y = cy + p.y;
			const isSel = i === selected;
			const dir = lightDirection(light);
			const len = 26;
			ctx.strokeStyle = light.color;
			ctx.globalAlpha = p.front ? 0.9 : 0.35;
			ctx.lineWidth = isSel ? 2 : 1.4;
			ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dir.x * len, y - dir.y * len); ctx.stroke();
			ctx.globalAlpha = 1;
			const r = 5 + p.size * 3;
			ctx.fillStyle = light.color;
			ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
			if (!p.front) {
				ctx.globalAlpha = 0.5;
				ctx.strokeStyle = light.color;
				ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
				ctx.globalAlpha = 1;
			}
			if (isSel) {
				ctx.strokeStyle = '#fff';
				ctx.lineWidth = 1.5;
				ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke();
			}
			ctx.fillStyle = 'rgba(255,255,255,.75)';
			ctx.font = '9px system-ui, sans-serif';
			ctx.fillText(light.type[0].toUpperCase(), x + 8, y - 8);
		});
	}, [lights, selected]);

	// ── pointer interaction ───────────────────────────────────────────────
	const localPoint = (e: React.PointerEvent<HTMLCanvasElement>): { sx: number; sy: number; cx: number; cy: number } => {
		const rect = e.currentTarget.getBoundingClientRect();
		return { sx: e.clientX - rect.left, sy: e.clientY - rect.top, cx: rect.width / 2, cy: rect.height / 2 };
	};

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const { sx, sy, cx, cy } = localPoint(e);
		for (let i = 0; i < lights.length; i++) {
			const p = orthographicProject(lights[i].position, BALL_R);
			const dx = sx - (cx + p.x);
			const dy = sy - (cy + p.y);
			if (Math.hypot(dx, dy) < 16) {
				setSelected(i);
				const len = Math.hypot(lights[i].position.x, lights[i].position.y, lights[i].position.z);
				dragRef.current = { index: i, len: len || 1 };
				return;
			}
		}
		dragRef.current = null;
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (!dragRef.current) { return; }
		const { sx, sy, cx, cy } = localPoint(e);
		const dir = screenToSphere(sx, sy, cx, cy, BALL_R);
		if (!dir) { return; }
		const len = dragRef.current.len;
		const next = cloneLights(lights);
		next[dragRef.current.index].position = { x: dir.x * len, y: dir.y * len, z: dir.z * len };
		commit(next);
	};

	const onPointerUp = () => { dragRef.current = null; };

	// ── controls ──────────────────────────────────────────────────────────
	const addLight = (type: LightInfoType) => {
		const next = [...cloneLights(lights), createDefaultLight(type)];
		setSelected(next.length - 1);
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
		commit(normalizeLights(entries));
	};

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			<canvas
				ref={canvasRef}
				width={360}
				height={240}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerLeave={onPointerUp}
				style={{ width: '100%', height: 240, borderRadius: 8, touchAction: 'none', cursor: 'grab', background: '#17181c', display: 'block' }}
			/>
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
