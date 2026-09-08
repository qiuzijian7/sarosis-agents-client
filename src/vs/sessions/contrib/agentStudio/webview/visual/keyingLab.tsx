/**
 * keyingLab — 抠像算法对比实验室 v2（2026-09-08）。
 *
 * 用法：cd webview && npm run visual → 打开 /keying-lab.html → 拖入绿幕视频
 * （转动态表情包的 I2V 输出）→ 逐帧并排对比 + 一键生成真 GIF 对比。
 *
 * v2 新增（用户反馈「主体黑斑」诊断需求）：
 *   1. 「原始帧」列——对照看抠掉了什么、保留了什么；
 *   2. 诊断高亮 toggle：被抠像素（alpha=0）红色覆盖——直观看到 mask 边界与
 *      主体内部误伤（黑斑若在诊断视图为红色 = 被抠；为黑色实体 = 视频内容
 *      本身或 despill 压暗）；
 *   3. 「🎞 生成 GIF 对比」：当前帧位附近取 12 帧，各算法走产品同一编码链
 *      （medianCut 量化 + encodeGif 240²/128 色）编真 GIF 并排播放 + 体积/耗时
 *      ——端到端效果（含量化对描边的影响）一锤定音。
 *
 * 复用产品执行器真实实现（chromaKeyFrame / encodeGif），非简化复刻。
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { chromaKeyFrame, CHROMA_KEY_ALGOS, type ChromaKeyAlgo, parseHexColor } from '../src/features/workflowEditor/comfyHost/videoToGifExecutor.js';
import { encodeGif, medianCutPalette, mapToPaletteIndicesWithAlpha, type GifFrameInput } from '../src/features/workflowEditor/comfyHost/videoToGif.js';

const ALGOS: ChromaKeyAlgo[] = ['rgb', 'flood', 'ycbcr'];
const PREVIEW_FRAMES = 12;   // GIF 对比取帧数

/** 透明区棋盘底（与产品编辑器同款）。 */
const checkerStyle: React.CSSProperties = {
	backgroundImage:
		'linear-gradient(45deg, #2b2d33 25%, transparent 25%),' +
		'linear-gradient(-45deg, #2b2d33 25%, transparent 25%),' +
		'linear-gradient(45deg, transparent 75%, #2b2d33 75%),' +
		'linear-gradient(-45deg, transparent 75%, #2b2d33 75%)',
	backgroundSize: '12px 12px',
	backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px',
	backgroundColor: '#232428',
};

/** 量化 + 编码一帧序列 → GIF blob URL（与产品 convertVideoToTransparentGif 的
 *  level0 档同参数：240² / 128 色 / 全帧率）。 */
function encodeFramesToGif(
	frames: Uint8Array[], w: number, h: number, delayCs: number,
): { url: string; bytes: number } {
	const gifFrames: GifFrameInput[] = frames.map((rgba) => {
		// 240² 目标：源帧等比缩放已在抽帧时完成（canvas 尺寸即 w×h）
		const palette = medianCutPalette(rgba, 128, 4, true);
		const transparentIndex = palette.length / 3;
		const padded = new Uint8Array((transparentIndex + 1) * 3);
		padded.set(palette);
		return {
			indices: mapToPaletteIndicesWithAlpha(rgba, palette, transparentIndex),
			palette: padded,
			delayCs,
			transparentIndex,
		};
	});
	const gif = encodeGif(gifFrames, w, h, 0);
	const blob = new Blob([gif as unknown as BlobPart], { type: 'image/gif' });
	return { url: URL.createObjectURL(blob), bytes: blob.size };
}

function App(): React.ReactElement {
	const [videoUrl, setVideoUrl] = React.useState<string>('');
	const [videoName, setVideoName] = React.useState<string>('');
	const [frameIdx, setFrameIdx] = React.useState(0);
	const [similarity, setSimilarity] = React.useState(0.4);
	const [smoothness, setSmoothness] = React.useState(0.1);
	const [keyColor, setKeyColor] = React.useState('#00FF00');
	const [diag, setDiag] = React.useState(false);          // 诊断高亮（透明区标红）
	const [durations, setDurations] = React.useState(0);
	const [gifBusy, setGifBusy] = React.useState(false);
	const [gifResults, setGifResults] = React.useState<Array<{ algo: ChromaKeyAlgo; url: string; bytes: number; ms: number } | null>>([]);
	const videoRef = React.useRef<HTMLVideoElement | null>(null);
	const canvasRefs = React.useRef<Array<HTMLCanvasElement | null>>([null, null, null]);
	const rawCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
	const [msStats, setMsStats] = React.useState<Array<number | null>>([null, null, null]);

	const loadVideo = (file: File): void => {
		if (videoUrl) { URL.revokeObjectURL(videoUrl); }
		setVideoUrl(URL.createObjectURL(file));
		setVideoName(file.name);
		setFrameIdx(0);
		setGifResults([]);
	};

	React.useEffect(() => {
		const v = videoRef.current;
		if (!v || !videoUrl) { return; }
		const onMeta = (): void => setDurations(v.duration || 0);
		v.addEventListener('loadedmetadata', onMeta);
		return () => v.removeEventListener('loadedmetadata', onMeta);
	}, [videoUrl]);

	/** seek 到帧位并等待 seeked。 */
	const seekTo = async (v: HTMLVideoElement, t: number): Promise<void> => {
		await new Promise<void>((res) => {
			const onSeek = (): void => { v.removeEventListener('seeked', onSeek); res(); };
			v.addEventListener('seeked', onSeek);
			v.currentTime = t;
		});
	};

	// 帧渲染（原始帧 + 三算法并排）
	React.useEffect(() => {
		const v = videoRef.current;
		if (!v || !videoUrl || durations <= 0) { return; }
		let canceled = false;
		const run = async (): Promise<void> => {
			const t = durations * (frameIdx + 0.5) / 64;
			await seekTo(v, Math.min(t, Math.max(0, durations - 0.05)));
			if (canceled) { return; }
			const srcW = v.videoWidth || 640;
			const srcH = v.videoHeight || 360;
			const key = parseHexColor(keyColor);
			// 原始帧
			const raw = rawCanvasRef.current;
			if (raw) {
				raw.width = srcW; raw.height = srcH;
				raw.getContext('2d')?.drawImage(v, 0, 0, srcW, srcH);
			}
			const stats: Array<number | null> = [];
			for (let a = 0; a < ALGOS.length; a++) {
				const cv = canvasRefs.current[a];
				if (!cv) { continue; }
				cv.width = srcW; cv.height = srcH;
				const ctx = cv.getContext('2d', { willReadFrequently: true });
				if (!ctx) { continue; }
				ctx.drawImage(v, 0, 0, srcW, srcH);
				const data = ctx.getImageData(0, 0, srcW, srcH);
				const rgba = new Uint8Array(data.data.buffer.slice(0));
				const t0 = performance.now();
				chromaKeyFrame(rgba, key, similarity, smoothness, ALGOS[a]);
				stats.push(Math.round((performance.now() - t0) * 10) / 10);
				if (diag) {
					// 诊断视图：被抠像素（alpha=0）覆盖红色半透明
					for (let p = 0; p < rgba.length; p += 4) {
						if (rgba[p + 3] === 0) {
							rgba[p] = 255; rgba[p + 1] = 40; rgba[p + 2] = 40; rgba[p + 3] = 160;
						}
					}
				}
				ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), srcW, srcH), 0, 0);
			}
			setMsStats(stats);
		};
		void run();
		return () => { canceled = true; };
	}, [videoUrl, durations, frameIdx, similarity, smoothness, keyColor, diag]);

	/** 🎞 GIF 端到端对比：当前帧位附近取 PREVIEW_FRAMES 帧 → 各算法编码真 GIF。 */
	const runGifCompare = async (): Promise<void> => {
		const v = videoRef.current;
		if (!v || !videoUrl || durations <= 0 || gifBusy) { return; }
		setGifBusy(true);
		setGifResults([]);
		try {
			const srcW = v.videoWidth || 640;
			const srcH = v.videoHeight || 360;
			// 预览统一缩到 240²（与产品输出一致），等比
			const scale = Math.min(1, 240 / Math.max(srcW, srcH));
			const w = Math.max(16, Math.round(srcW * scale / 2) * 2);
			const h = Math.max(16, Math.round(srcH * scale / 2) * 2);
			const key = parseHexColor(keyColor);
			const results: Array<{ algo: ChromaKeyAlgo; url: string; bytes: number; ms: number } | null> = [];
			for (let a = 0; a < ALGOS.length; a++) {
				const t0 = performance.now();
				const frames: Uint8Array[] = [];
				for (let f = 0; f < PREVIEW_FRAMES; f++) {
					const fi = (frameIdx + f) % 64;
					await seekTo(v, Math.min(durations * (fi + 0.5) / 64, Math.max(0, durations - 0.05)));
					const cv = document.createElement('canvas');
					cv.width = w; cv.height = h;
					const ctx = cv.getContext('2d', { willReadFrequently: true });
					if (!ctx) { continue; }
					ctx.drawImage(v, 0, 0, w, h);
					const data = ctx.getImageData(0, 0, w, h).data;
					const rgba = new Uint8Array(data.buffer.slice(0));
					chromaKeyFrame(rgba, key, similarity, smoothness, ALGOS[a]);
					frames.push(rgba);
				}
				const enc = encodeFramesToGif(frames, w, h, 8);
				results.push({ algo: ALGOS[a], url: enc.url, bytes: enc.bytes, ms: Math.round(performance.now() - t0) });
			}
			setGifResults(results);
		} finally {
			setGifBusy(false);
		}
	};

	// 拖放支持
	const onDrop = (e: React.DragEvent): void => {
		e.preventDefault();
		const f = Array.from(e.dataTransfer.files).find(f => f.type.startsWith('video/'));
		if (f) { loadVideo(f); }
	};

	return (
		<div onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
			style={{ fontFamily: 'system-ui, sans-serif', color: '#e8e8e8', background: '#141518', minHeight: '100vh', padding: 16 }}>
			<h2 style={{ margin: '0 0 4px', fontSize: 16 }}>🧪 抠像算法对比实验室
				<span style={{ fontSize: 11, color: '#9a9a9a', marginLeft: 8 }}>原始帧 / rgb / flood / ycbcr — 产品真实实现 + GIF 端到端</span>
			</h2>
			<div style={{ fontSize: 11, color: '#9a9a9a', marginBottom: 10 }}>
				拖入绿幕视频 → 逐帧对比三算法。<b style={{ color: '#fbbf24' }}>诊断模式</b>：被抠像素标红
				（主体内部出现红色 = 误伤，即 GIF 里的「黑斑/破洞」来源）。
			</div>

			<div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
				<input type="file" accept="video/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) { loadVideo(f); } }} style={{ fontSize: 11, color: '#ccc' }} />
				{videoName && <span style={{ fontSize: 11, color: '#8fd' }}>{videoName}（{durations.toFixed(1)}s）</span>}
			</div>

			<div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10, fontSize: 11 }}>
				<label>相似度 {similarity.toFixed(2)}
					<input type="range" min={0.05} max={0.8} step={0.01} value={similarity}
						onChange={(e) => setSimilarity(Number(e.target.value))} style={{ accentColor: '#a855f7', marginLeft: 6 }} />
				</label>
				<label>平滑带 {smoothness.toFixed(2)}
					<input type="range" min={0} max={0.4} step={0.01} value={smoothness}
						onChange={(e) => setSmoothness(Number(e.target.value))} style={{ accentColor: '#a855f7', marginLeft: 6 }} />
				</label>
				<label>幕色 <input type="color" value={keyColor} onChange={(e) => setKeyColor(e.target.value)} style={{ verticalAlign: 'middle', marginLeft: 4 }} /></label>
				<label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
					<input type="checkbox" checked={diag} onChange={(e) => setDiag(e.target.checked)} style={{ accentColor: '#ef4444' }} />
					<span style={{ color: diag ? '#f87171' : '#9a9a9a' }}>诊断高亮（被抠=红）</span>
				</label>
				{videoUrl && (
					<span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
						<button onClick={() => setFrameIdx(v => Math.max(0, v - 1))} style={{ cursor: 'pointer' }}>◀</button>
						<span style={{ fontFamily: 'monospace' }}>{frameIdx + 1}/64</span>
						<button onClick={() => setFrameIdx(v => Math.min(63, v + 1))} style={{ cursor: 'pointer' }}>▶</button>
					</span>
				)}
				{videoUrl && (
					<button onClick={() => void runGifCompare()} disabled={gifBusy}
						style={{ padding: '4px 10px', borderRadius: 5, cursor: gifBusy ? 'wait' : 'pointer', fontSize: 11, fontWeight: 600, border: '1px solid rgba(168,85,247,.5)', background: gifBusy ? 'rgba(148,163,184,.2)' : 'rgba(168,85,247,.2)', color: gifBusy ? '#94a3b8' : '#d8b4fe' }}>
						{gifBusy ? '⏳ 编码中…' : `🎞 生成 GIF 对比（${PREVIEW_FRAMES} 帧）`}
					</button>
				)}
			</div>

			{!videoUrl ? (
				<div style={{ border: '2px dashed #3a3b40', borderRadius: 10, padding: 60, textAlign: 'center', color: '#777', fontSize: 13 }}>
					← 选择/拖入绿幕视频开始对比
				</div>
			) : (
				<>
					<video ref={videoRef} src={videoUrl} muted style={{ display: 'none' }} />
					<div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(220px, 1fr))', gap: 12 }}>
						{/* 原始帧（对照） */}
						<div style={{ border: '1px solid rgba(255,255,255,.12)', borderRadius: 8, padding: 8, background: '#1b1c20' }}>
							<div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: '#9a9a9a' }}>原始帧（对照）</div>
							<canvas ref={rawCanvasRef} style={{ width: '100%', borderRadius: 6, display: 'block', background: '#000' }} />
							<div style={{ fontSize: 10, color: '#777', marginTop: 6, lineHeight: 1.5 }}>绿幕源帧。对照看各算法抠掉了什么。</div>
						</div>
						{ALGOS.map((algo, a) => {
							const meta = CHROMA_KEY_ALGOS.find(m => m.id === algo);
							return (
								<div key={algo} style={{ border: '1px solid rgba(255,255,255,.12)', borderRadius: 8, padding: 8, background: '#1b1c20' }}>
									<div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>
										{meta?.label}
										<span style={{ float: 'right', color: '#9a9a9a', fontFamily: 'monospace', fontSize: 10 }}>
											{msStats[a] != null ? `${msStats[a]}ms` : ''}
										</span>
									</div>
									<div style={{ fontSize: 10, color: '#9a9a9a', lineHeight: 1.5, marginBottom: 6, minHeight: 42 }}>{meta?.tip}</div>
									<canvas
										ref={(el) => { canvasRefs.current[a] = el; }}
										style={{ ...checkerStyle, width: '100%', borderRadius: 6, display: 'block' }}
									/>
									{gifResults[a] && (
										<div style={{ marginTop: 8, borderTop: '1px solid rgba(255,255,255,.1)', paddingTop: 8 }}>
											<div style={{ fontSize: 10, color: '#9a9a9a', fontFamily: 'monospace', marginBottom: 4 }}>
												GIF {PREVIEW_FRAMES}帧 · {(gifResults[a]!.bytes / 1024).toFixed(0)}KB · 编码{gifResults[a]!.ms}ms
											</div>
											<img src={gifResults[a]!.url} alt={`gif-${algo}`} style={{ ...checkerStyle, width: '100%', borderRadius: 6, display: 'block' }} />
										</div>
									)}
								</div>
							);
						})}
					</div>
					{gifResults.some(Boolean) && (
						<div style={{ marginTop: 10, fontSize: 11, color: '#9a9a9a', lineHeight: 1.7, maxWidth: 960, border: '1px solid rgba(255,255,255,.08)', borderRadius: 8, padding: 10, background: '#191a1e' }}>
							<b style={{ color: '#d8b4fe' }}>怎么选</b>：
							① 看<b>主体内部</b>——GIF 里的「黑斑/破洞」若在诊断视图（勾选诊断高亮）显示为<b style={{ color: '#f87171' }}>红色</b> = 被误抠（rgb 的绿色主导清除/flood 之外的算法都可能）；不红 = 视频内容本身，与抠像无关；
							② 看<b>描边外缘</b>——绒毛/灰白带宽度（平滑带调小可收紧）；
							③ 看<b>发丝/细小结构</b>的保留度；
							④ GIF 列对比<b>量化后的最终观感</b>（色阶阶梯、体积）。
							选定后回编辑器「绿幕抠像 → 算法」下拉选择即可。
						</div>
					)}
				</>
			)}
		</div>
	);
}

const rootEl = document.getElementById('root');
if (rootEl) {
	createRoot(rootEl).render(<App />);
}
