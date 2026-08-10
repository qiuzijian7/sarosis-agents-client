/*---------------------------------------------------------------------------------------------
 *  MaterialEditor — PBR material-ball editor for the ComfyTV Material stage
 *  (P3). Sliders for metalness/roughness/transmission/clearcoat + the 8 ComfyTV
 *  presets; a 2D-canvas material ball gives instant feedback, debounce-uploaded
 *  as the stage's `captured_image`. The material_state JSON matches ComfyTV's
 *  MaterialParams contract (portable).
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { ComfyRunnerRegistry } from './comfyHost/comfyRunner';
import {
	applyPreset, MATERIAL_PRESETS, materialStateToJson, normalizeMaterial, parseMaterialState,
	renderMaterialBall, DEFAULT_MATERIAL,
	type MaterialParams,
} from './comfyHost/materialEditor';

export interface MaterialEditorProps {
	initialState: string;
	runners: ComfyRunnerRegistry;
	preference: string;
	onStateChange: (json: string) => void;
	onRenderUploaded: (url: string | null) => void;
}

const BALL_R = 110;
const VIEW = 360;

const inputStyle: React.CSSProperties = {
	background: '#111', color: '#e6e6e6', border: '1px solid rgba(255,255,255,.14)',
	borderRadius: 5, padding: '4px 7px', fontSize: 12, outline: 'none',
};

export function MaterialEditor({ initialState, runners, preference, onStateChange, onRenderUploaded }: MaterialEditorProps): React.JSX.Element {
	const [params, setParams] = React.useState<MaterialParams>(() => parseMaterialState(initialState));
	const canvasRef = React.useRef<HTMLCanvasElement>(null);
	const uploadTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const runnersRef = React.useRef(runners); runnersRef.current = runners;
	const preferenceRef = React.useRef(preference); preferenceRef.current = preference;

	const scheduleUpload = React.useCallback(() => {
		if (uploadTimerRef.current) { clearTimeout(uploadTimerRef.current); }
		uploadTimerRef.current = setTimeout(() => { void uploadRender(); }, 1000);
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
			form.append('image', blob, 'material.png');
			const resp = await runner.fetchApi('/upload/image', { method: 'POST', body: form });
			const data = await resp.json();
			const url = `${runner.baseUrl}/view?filename=${encodeURIComponent(String(data?.name ?? ''))}&subfolder=${encodeURIComponent(String(data?.subfolder ?? ''))}&type=${String(data?.type ?? 'output')}`;
			onRenderUploaded(url);
		} catch {
			onRenderUploaded(null);
		}
	}, [onRenderUploaded]);

	React.useEffect(() => () => { if (uploadTimerRef.current) { clearTimeout(uploadTimerRef.current); } }, []);

	const commit = React.useCallback((next: MaterialParams) => {
		setParams(next);
		onStateChange(materialStateToJson(next));
		scheduleUpload();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onStateChange]);

	React.useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) { return; }
		const ctx = canvas.getContext('2d');
		if (!ctx) { return; }
		renderMaterialBall(ctx, params, VIEW / 2, VIEW / 2, BALL_R);
	}, [params]);

	const patch = (p: Partial<MaterialParams>) => commit({ ...params, ...p });

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			<canvas
				ref={canvasRef}
				width={VIEW}
				height={VIEW}
				style={{ width: '100%', borderRadius: 8, background: '#17181c', display: 'block' }}
			/>
			<div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
				<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>Presets</span>
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
						{p.key}
					</button>
				))}
			</div>
			<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
				<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
					<span style={{ fontSize: 10, color: '#aaa' }}>颜色</span>
					<div style={{ display: 'flex', gap: 5 }}>
						<input type="color" value={params.color} onChange={e => patch({ color: e.target.value })}
							style={{ width: 32, height: 26, padding: 0, border: '1px solid rgba(255,255,255,.2)', borderRadius: 5, background: 'transparent', cursor: 'pointer' }} />
						<input value={params.color} onChange={e => patch({ color: e.target.value })}
							style={{ ...inputStyle, flex: 1 }} />
					</div>
				</label>
				<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
					<span style={{ fontSize: 10, color: '#aaa' }}>Metalness {params.metalness.toFixed(2)}</span>
					<input type="range" min={0} max={1} step={0.01} value={params.metalness} onChange={e => patch({ metalness: Number(e.target.value) })} style={{ accentColor: '#4a9eff' }} />
				</label>
				<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
					<span style={{ fontSize: 10, color: '#aaa' }}>Roughness {params.roughness.toFixed(2)}</span>
					<input type="range" min={0} max={1} step={0.01} value={params.roughness} onChange={e => patch({ roughness: Number(e.target.value) })} style={{ accentColor: '#4a9eff' }} />
				</label>
				<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
					<span style={{ fontSize: 10, color: '#aaa' }}>Transmission {params.transmission.toFixed(2)}</span>
					<input type="range" min={0} max={1} step={0.01} value={params.transmission} onChange={e => patch({ transmission: Number(e.target.value) })} style={{ accentColor: '#4a9eff' }} />
				</label>
				<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
					<span style={{ fontSize: 10, color: '#aaa' }}>Clearcoat {params.clearcoat.toFixed(2)}</span>
					<input type="range" min={0} max={1} step={0.01} value={params.clearcoat} onChange={e => patch({ clearcoat: Number(e.target.value) })} style={{ accentColor: '#4a9eff' }} />
				</label>
				<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
					<span style={{ fontSize: 10, color: '#aaa' }}>Clearcoat Roughness {params.clearcoatRoughness.toFixed(2)}</span>
					<input type="range" min={0} max={1} step={0.01} value={params.clearcoatRoughness} onChange={e => patch({ clearcoatRoughness: Number(e.target.value) })} style={{ accentColor: '#4a9eff' }} />
				</label>
			</div>
			<button
				onClick={() => commit({ ...DEFAULT_MATERIAL })}
				style={{ padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10, background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)', border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit', alignSelf: 'flex-start' }}
			>
				↺ 重置
			</button>
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
				调整后约 1 秒自动渲染材质球并上传；输出 PBR 材质 JSON + 预览图。
			</div>
		</div>
	);
}
