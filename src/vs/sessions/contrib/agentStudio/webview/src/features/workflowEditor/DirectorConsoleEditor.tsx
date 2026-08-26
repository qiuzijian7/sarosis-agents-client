/*---------------------------------------------------------------------------------------------
 *  DirectorConsoleEditor — 导演台编辑器（对齐 ComfyTV StoryboardEditorStage 布局）。
 *
 *  布局（从上到下）：
 *    ┌─ 标题栏（镜头标签 · 共 N 镜 · 总时长）
 *    ├─ 工具栏（播放/循环/字幕 | 洋葱皮 | 辅助线 | 翻转 | 总览）
 *    ├─ 主区域（左右分栏）
 *    │   ├ 左：画布（LayerEditor + overlay）
 *    │   └ 右：BOARD 字段面板（单列垂直表单）
 *    └─ 底部时间线（统计 + 导入导出 + 镜头缩略图条）
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { ComfyRunnerRegistry } from './comfyHost/comfyRunner';
import { LayerEditor, type LayerEditorHandle } from './LayerEditor';
import { useDirectorConsoleEditor, type BoardTextField, type DirectorConsoleEditorController } from './comfyHost/useDirectorConsoleEditor';
import type { StoryboardDoc } from './comfyHost/storyboardEditor';

export interface DirectorConsoleEditorProps {
	initialState: string;
	/** 上游分镜文本（Fountain 剧本）。board_state 为空时自动解析成 boards。 */
	initialFountainText?: string;
	width: number;
	height: number;
	runners: ComfyRunnerRegistry;
	preference: string;
	onStateChange: (json: string) => void;
	onRenderUploaded: (url: string | null) => void;
}

/* ─── 样式常量 ─────────────────────────────────────────────────────────────── */

const inputStyle: React.CSSProperties = {
	background: '#111', color: '#e6e6e6', border: '1px solid rgba(255,255,255,.14)',
	borderRadius: 5, padding: '3px 6px', fontSize: 11, outline: 'none',
	width: '100%', boxSizing: 'border-box',
};

const textareaStyle: React.CSSProperties = {
	...inputStyle,
	resize: 'vertical',
	minHeight: 24,
	fontFamily: 'inherit',
	lineHeight: 1.4,
};

const labelStyle: React.CSSProperties = { fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginBottom: 2 };
const btn: React.CSSProperties = {
	padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10,
	background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)',
	border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit',
};
const btnOn: React.CSSProperties = { ...btn, background: 'rgba(59,130,246,.3)', borderColor: 'rgba(59,130,246,.6)' };

export const BOARD_TEXT_FIELDS: Array<{ key: BoardTextField; label: string; placeholder: string; rows?: number }> = [
	{ key: 'dialogue',     label: '对白',     placeholder: '角色台词' },
	{ key: 'action',       label: '动作',     placeholder: '画面动作描述' },
	{ key: 'scenePurpose', label: '场景目的', placeholder: '这一镜要表达什么', rows: 2 },
	{ key: 'character',    label: '角色',     placeholder: '出场角色' },
	{ key: 'shotSize',     label: '景别',     placeholder: '近景 / 中景 / 远景…' },
	{ key: 'imagePrompt',  label: '图像提示', placeholder: '生成图像的提示词', rows: 2 },
	{ key: 'motionPrompt', label: '运动提示', placeholder: '镜头运动 / 动画描述', rows: 2 },
	{ key: 'notes',        label: '备注',     placeholder: '其他说明' },
];

function guideOverlayStyle(show: boolean): React.CSSProperties {
	return { position: 'absolute', inset: 0, pointerEvents: 'none', opacity: show ? 1 : 0, transition: 'opacity .15s' };
}

/* ─── 右侧 Board 字段面板 ─────────────────────────────────────────────────── */

interface BoardPanelProps {
	ctrl: DirectorConsoleEditorController;
}

function BoardPanel({ ctrl }: BoardPanelProps): React.JSX.Element {
	const b = ctrl.currentBoard;
	if (!b) return <div />;

	return (
		<div
			style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px', overflowY: 'auto', minWidth: 220, maxWidth: 300 }}
			/* 防止面板内滚动/点击冒泡到画布拖拽 */
			onWheel={e => e.stopPropagation()}
			onPointerDown={e => e.stopPropagation()}
		>
			{/* 面板标题 */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
				<span style={{ fontSize: 11, fontWeight: 600, color: 'var(--vscode-foreground)' }}>BOARD</span>
				<span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground)' }}>镜头字段</span>
			</div>

			{/* 镜头名 + 时长 + 操作按钮 */}
			<div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
				<input
					value={b.name ?? ''}
					placeholder={b.uid}
					onChange={e => ctrl.setBoardField(ctrl.currentUid, 'name', e.target.value)}
					style={{ ...inputStyle, width: 80 }}
				/>
				<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', whiteSpace: 'nowrap' }}>
					时长 {((b.durationMs ?? ctrl.doc.defaultBoardTimingMs) / 1000).toFixed(1)}s
				</span>
				<button style={btn} onClick={() => ctrl.applySuggestedDuration(ctrl.currentUid)} title="按对白/动作估算时长">⏱ 建议</button>
			</div>

			{/* 新镜头 + 复制 */}
			<div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
				<button
					style={b.newShot ? btnOn : btn}
					onClick={() => ctrl.toggleNewShot(ctrl.currentUid)}
					title="标记为新镜头"
				>📌 新镜头 ({ctrl.labels[ctrl.currentIndex]})</button>
				<button style={btn} onClick={() => ctrl.duplicateBoard(ctrl.currentUid)} title="复制当前镜头">⧉ 复制</button>
			</div>

			{/* 分隔线 */}
			<div style={{ height: 1, background: 'rgba(255,255,255,.08)' }} />

			{/* 8 个字段 — 单列垂直排列 */}
			{BOARD_TEXT_FIELDS.map(f => (
				<label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
					<span style={labelStyle}>{f.label}</span>
					{(f.rows && f.rows > 1) ? (
						<textarea
							value={(b as unknown as Record<string, string>)[f.key] ?? ''}
							placeholder={f.placeholder}
							rows={f.rows}
							onChange={e => ctrl.setBoardField(ctrl.currentUid, f.key, e.target.value)}
							style={textareaStyle}
						/>
					) : (
						<input
							value={(b as unknown as Record<string, string>)[f.key] ?? ''}
							placeholder={f.placeholder}
							onChange={e => ctrl.setBoardField(ctrl.currentUid, f.key, e.target.value)}
							style={inputStyle}
						/>
					)}
				</label>
			))}
		</div>
	);
}

/* ─── 主组件 ───────────────────────────────────────────────────────────────── */

export function DirectorConsoleEditor({ initialState, initialFountainText, width, height, runners, preference, onStateChange, onRenderUploaded }: DirectorConsoleEditorProps): React.JSX.Element {
	const [editor, setEditor] = React.useState<LayerEditorHandle | null>(null);
	const [overall, setOverall] = React.useState(false);

	const ctrl: DirectorConsoleEditorController = useDirectorConsoleEditor({
		initialState,
		initialFountainText,
		width,
		height,
		onStateChange,
		editor: editor ?? undefined,
	});

	const fileInputRef = React.useRef<HTMLInputElement | null>(null);
	const fountainInputRef = React.useRef<HTMLInputElement | null>(null);

	const handleRenderUploaded = React.useCallback((url: string | null) => {
		if (url && ctrl.currentUid) { ctrl.setBoardCompositeUrl(ctrl.currentUid, url); }
		onRenderUploaded(url);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ctrl.currentUid, onRenderUploaded]);

	const handleDocChange = React.useCallback((json: string) => {
		if (ctrl.currentUid) {
			try { ctrl.setBoardLayerState(ctrl.currentUid, JSON.parse(json)); } catch { /* ignore */ }
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ctrl.currentUid]);

	const doExportAnimatic = React.useCallback(async () => {
		const frames = ctrl.boards
			.map(b => ({ url: b.compositeUrl ?? b.refUrl ?? null, ms: Math.max(100, ctrl.doc.defaultBoardTimingMs || 2000) }))
			.filter(f => f.url);
		if (frames.length < 2) {
			window.alert('至少需要 2 个有图的镜头才能导出 animatic。');
			return;
		}
		const load = (url: string) => new Promise<HTMLImageElement>((res, rej) => {
			const img = new Image(); img.crossOrigin = 'anonymous';
			img.onload = () => res(img); img.onerror = rej; img.src = url;
		});
		try {
			const imgs = await Promise.all(frames.map(f => load(f.url!)));
			const cvs = document.createElement('canvas');
			cvs.width = ctrl.doc.width; cvs.height = ctrl.doc.height;
			const ctx = cvs.getContext('2d')!;
			const stream = cvs.captureStream(15);
			const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
			const chunks: Blob[] = [];
			rec.ondataavailable = e => { if (e.data.size) { chunks.push(e.data); } };
			const done = new Promise<void>(res => { rec.onstop = () => res(); });
			rec.start();
			const t0 = performance.now();
			for (const f of frames) {
				const img = imgs[frames.indexOf(f)];
				ctx.drawImage(img, 0, 0, cvs.width, cvs.height);
				const target = t0 + f.ms;
				while (performance.now() < target) { await new Promise(r => setTimeout(r, 16)); }
			}
			rec.stop();
			await done;
			const blob = new Blob(chunks, { type: 'video/webm' });
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = 'storyboard-animatic.webm';
			a.click();
			URL.revokeObjectURL(a.href);
		} catch (err) {
			window.alert(`animatic 导出失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}, [ctrl.boards, ctrl.doc]);

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%', width: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>

			{/* ═══ 标题栏 ═══ */}
			<div style={{
				display: 'flex', alignItems: 'center', gap: 8,
				padding: '4px 8px', borderBottom: '1px solid rgba(255,255,255,.08)',
				fontSize: 11, color: 'var(--vscode-foreground)',
			}}>
				<span style={{ fontWeight: 600 }}>Storyboard Editor</span>
				<span style={{ color: 'var(--vscode-descriptionForeground)' }}>–</span>
				<span style={{ fontFamily: 'monospace', color: '#4a9eff' }}>{ctrl.labels[ctrl.currentIndex]}</span>
				<span style={{ color: 'var(--vscode-descriptionForeground)' }}>· 共 {ctrl.boards.length} 镜</span>
				<span>· 总时长 {(ctrl.totalMs / 1000).toFixed(1)}s</span>
			</div>

			{/* ═══ 工具栏（两行） ═══ */}
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', padding: '0 4px' }}>
				{/* 第一行：播放控制 + 洋葱皮 + 辅助线 + 翻转 */}
				<button style={ctrl.playing ? btnOn : btn} onClick={() => { setOverall(false); ctrl.playing ? ctrl.stopPlayback() : ctrl.play(); }} title="播放 / 停止">
					▶ 播放
				</button>
				<button style={ctrl.loop ? btnOn : btn} onClick={() => ctrl.setLoop(!ctrl.loop)} title="循环播放">🔄 循环</button>
				<button style={ctrl.captions ? btnOn : btn} onClick={() => ctrl.setCaptions(!ctrl.captions)} title="字幕（对白）">💬 字幕</button>
				<span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.14)', margin: '0 2px' }} />
				<button style={ctrl.onionPrev ? btnOn : btn} onClick={() => ctrl.setOnionPrev(!ctrl.onionPrev)} title="洋葱皮（上一镜）">◀▣ 洋葱皮上一镜</button>
				<button style={ctrl.onionNext ? btnOn : btn} onClick={() => ctrl.setOnionNext(!ctrl.onionNext)} title="洋葱皮（下一镜）">▣▷ 洋葱皮下一镜</button>
				<span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.14)', margin: '0 2px' }} />
				<button style={ctrl.guideCenter ? btnOn : btn} onClick={() => ctrl.setGuideCenter(!ctrl.guideCenter)} title="中心辅助线">＋ 中心线</button>
				<button style={ctrl.guideThirds ? btnOn : btn} onClick={() => ctrl.setGuideThirds(!ctrl.guideThirds)} title="三分辅助线">📐 三分线</button>
				<button style={ctrl.guideGrid ? btnOn : btn} onClick={() => ctrl.setGuideGrid(!ctrl.guideGrid)} title="网格"># 网格</button>
				<span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.14)', margin: '0 2px' }} />
				<button style={btn} onClick={() => editor?.flipImage('h')} title="水平翻转">⇄ 水平翻转</button>
				<button style={btn} onClick={() => editor?.flipImage('v')} title="垂直翻转">⇅ 垂直翻转</button>
				<span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.14)', margin: '0 2px' }} />
				<button style={overall ? btnOn : btn} onClick={() => setOverall(!overall)} title="总览（多宫格展示所有镜头）">⊞ 总览</button>
			</div>

			{/* ═══ 主区域（左右分栏：画布 + 字段面板） ═══ */}
			<div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0, overflow: 'hidden' }}>

				{/* ── 左侧画布区 ── */}
				<div style={{ flex: 1, position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,.14)', minHeight: 200 }}>
					{/* 画布尺寸标注 */}
					<div style={{
						position: 'absolute', top: 6, left: 8, zIndex: 5,
						fontSize: 9, color: 'rgba(255,255,255,.45)', fontFamily: 'monospace',
						pointerEvents: 'none',
					}}>
						{width} × {height} · 图层 {ctrl.currentBoard?.layerState ? (ctrl.currentBoard.layerState as { layers?: unknown[] }).layers?.length ?? 1 : 1}
					</div>

					<LayerEditor
						ref={setEditor}
						key={ctrl.currentUid}
						initialDoc={JSON.stringify(ctrl.currentBoard?.layerState ?? { width, height, layers: [] })}
						width={width}
						height={height}
						runners={runners}
						preference={preference}
						onDocChange={handleDocChange}
						onRenderUploaded={handleRenderUploaded}
					/>

					{/* 总览多宫格视图 */}
					{overall && (
						<div style={{ position: 'absolute', inset: 0, zIndex: 10, background: '#0a0d12', display: 'flex', flexWrap: 'wrap', gap: 10, padding: 14, alignContent: 'flex-start', overflow: 'auto' }}>
							{ctrl.boards.map((b, i) => (
								<div
									key={b.uid}
									onClick={() => { ctrl.selectBoard(b.uid); setOverall(false); }}
									title={`${i + 1}·${ctrl.labels[i]} · ${b.name ?? b.uid}`}
									style={{
										flex: '1 1 calc(33.333% - 10px)', minWidth: 110, height: 96, cursor: 'pointer',
										border: b.uid === ctrl.currentUid ? '2px solid #4a9eff' : '1px solid rgba(255,255,255,.14)',
										borderRadius: 8, background: '#161b22', position: 'relative', overflow: 'hidden',
										display: 'flex', alignItems: 'center', justifyContent: 'center',
									}}
								>
									<span style={{ position: 'absolute', top: 4, left: 6, fontSize: 9, color: '#4a9eff', fontFamily: 'monospace', zIndex: 2 }}>{ctrl.labels[i]}</span>
									{(b.compositeUrl || b.refUrl) ? (
										<img src={b.compositeUrl ?? b.refUrl!} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
									) : (
										<span style={{ fontSize: 22, opacity: .4 }}>▦</span>
									)}
									<span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, textAlign: 'center', fontSize: 9, color: 'rgba(255,255,255,.9)', background: 'rgba(0,0,0,.55)', padding: '2px 4px', zIndex: 2 }}>{b.name ?? b.uid}</span>
								</div>
							))}
						</div>
					)}

					{/* 洋葱皮 overlay */}
					{(ctrl.onionPrevUrl || ctrl.onionNextUrl) && (
						<div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
							{ctrl.onionPrevUrl && (
								<img src={ctrl.onionPrevUrl} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', opacity: 0.4, filter: 'hue-rotate(240deg)' }} />
							)}
							{ctrl.onionNextUrl && (
								<img src={ctrl.onionNextUrl} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', opacity: 0.4, filter: 'hue-rotate(120deg)' }} />
							)}
						</div>
					)}

					{/* 辅助线 overlay */}
					<svg style={guideOverlayStyle(ctrl.guideCenter || ctrl.guideThirds || ctrl.guideGrid)} width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
						{ctrl.guideCenter && (
							<g stroke="rgba(255,255,255,.5)" strokeWidth="1" strokeDasharray="6 4">
								<line x1={width / 2} y1={0} x2={width / 2} y2={height} />
								<line x1={0} y1={height / 2} x2={width} y2={height / 2} />
							</g>
						)}
						{ctrl.guideThirds && (
							<g stroke="rgba(255,255,255,.35)" strokeWidth="1" strokeDasharray="6 4">
								<line x1={width / 3} y1={0} x2={width / 3} y2={height} />
								<line x1={(width * 2) / 3} y1={0} x2={(width * 2) / 3} y2={height} />
								<line x1={0} y1={height / 3} x2={width} y2={height / 3} />
								<line x1={0} y1={(height * 2) / 3} x2={width} y2={(height * 2) / 3} />
							</g>
						)}
						{ctrl.guideGrid && (
							<g stroke="rgba(255,255,255,.2)" strokeWidth="1">
								{Array.from({ length: 7 }, (_, i) => <line key={`gx${i}`} x1={(width * (i + 1)) / 8} y1={0} x2={(width * (i + 1)) / 8} y2={height} />)}
								{Array.from({ length: 7 }, (_, i) => <line key={`gy${i}`} x1={0} y1={(height * (i + 1)) / 8} x2={width} y2={(height * (i + 1)) / 8} />)}
							</g>
						)}
					</svg>

					{/* 播放字幕 overlay */}
					{ctrl.playing && ctrl.playingBoard && ctrl.captions && ctrl.playingBoard.dialogue && (
						<div style={{ position: 'absolute', left: 0, right: 0, bottom: 12, textAlign: 'center', pointerEvents: 'none' }}>
							<span style={{ background: 'rgba(0,0,0,.7)', color: '#fff', padding: '3px 10px', borderRadius: 4, fontSize: 12 }}>{ctrl.playingBoard.dialogue}</span>
						</div>
					)}
				</div>

				{/* ── 右侧 Board 字段面板 ── */}
				<div style={{
					flexShrink: 0, width: 260,
					borderLeft: '1px solid rgba(255,255,255,.08)',
					background: 'rgba(17,17,19,.6)', borderRadius: '0 8px 8px 0',
					overflowY: 'auto',
				}}>
					<BoardPanel ctrl={ctrl} />
				</div>
			</div>

			{/* ═══ 底部时间线 ═══ */}
			<div
				style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 4 }}
				onWheel={e => e.stopPropagation()}
				onPointerDown={e => e.stopPropagation()}
			>
				{/* 统计 + 导入导出按钮行 */}
				<div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', padding: '0 4px' }}>
					<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', whiteSpace: 'nowrap' }}>
						共 {ctrl.boards.length} 镜 · {(ctrl.totalMs / 1000).toFixed(1)}s
					</span>
					<span style={{ width: 1, height: 14, background: 'rgba(255,255,255,.12)', margin: '0 2px' }} />

					<button style={btn} onClick={() => ctrl.addBoard(true)}>＋ 镜头</button>
					<button style={btn} onClick={() => ctrl.moveBoard(ctrl.currentUid, -1)} disabled={ctrl.currentIndex <= 0}>←</button>
					<button style={btn} onClick={() => ctrl.moveBoard(ctrl.currentUid, 1)} disabled={ctrl.currentIndex >= ctrl.boards.length - 1}>→</button>
					<button style={btn} onClick={() => ctrl.removeBoard(ctrl.currentUid)} disabled={ctrl.boards.length <= 1}>🗑</button>

					<span style={{ width: 1, height: 14, background: 'rgba(255,255,255,.12)', margin: '0 2px' }} />
					<button style={btn} onClick={() => fileInputRef.current?.click()} title="导入图片文件（每张一个镜头）">🖼 导入图片</button>
					<button style={btn} onClick={() => fountainInputRef.current?.click()} title="导入 Fountain 剧本">📝 导入剧本</button>
					<input
						ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
						onChange={e => { void ctrl.importImageFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }}
					/>
					<input
						ref={fountainInputRef} type="file" accept=".fountain,.txt,text/plain" style={{ display: 'none' }}
						onChange={e => {
							const f = e.target.files?.[0];
							if (f) { const r = new FileReader(); r.onload = () => ctrl.importFountainText(String(r.result ?? '')); r.readAsText(f); }
							e.target.value = '';
						}}
					/>

					<span style={{ width: 1, height: 14, background: 'rgba(255,255,255,.12)', margin: '0 2px' }} />
					<button style={btn} onClick={() => { void doExportAnimatic(); }} title="导出 animatic（WebM，浏览器录制）">🎬 导出动图</button>
					<button style={btn} onClick={() => {
						void ctrl.exportBoardsZip().then(blob => {
							if (!blob) { window.alert('没有可导出的镜头图。'); return; }
							const a = document.createElement('a');
							a.href = URL.createObjectURL(blob);
							a.download = 'storyboard-boards.zip';
							a.click();
							URL.revokeObjectURL(a.href);
						});
					}} title="导出所有镜头图（ZIP）">🗜 导出图包</button>
				</div>

				{/* 镜头缩略图条 */}
				<div style={{ display: 'flex', gap: 4, overflowX: 'auto', padding: '2px 4px' }}>
					{ctrl.boards.map((b, i) => (
						<div
							key={b.uid}
							onClick={() => ctrl.selectBoard(b.uid)}
							title={`${i + 1}·${ctrl.labels[i]} · ${b.name ?? b.uid}`}
							style={{
								flexShrink: 0, width: 72, height: 48, borderRadius: 5, cursor: 'pointer',
								overflow: 'hidden', border: b.uid === ctrl.currentUid ? '2px solid #4a9eff' : '1px solid rgba(255,255,255,.14)',
								background: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center',
								position: 'relative',
							}}
						>
							{(b.compositeUrl || b.refUrl) ? (
								<img src={b.compositeUrl ?? b.refUrl!} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
							) : (
								<span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground)' }}>{ctrl.labels[i]}</span>
							)}
							{/* 镜头标签角标 */}
							<span style={{
								position: 'absolute', top: 1, left: 3,
								fontSize: 8, fontFamily: 'monospace',
								color: (i === 0 || b.newShot) ? '#fff' : 'rgba(255,255,255,.6)',
								background: (i === 0 || b.newShot) ? 'rgba(74,158,255,.85)' : 'rgba(0,0,0,.55)',
								padding: '0 3px', borderRadius: 2, zIndex: 2,
							}}>{ctrl.labels[i]}</span>
							{/* 时长角标 */}
							<span style={{
								position: 'absolute', top: 1, right: 3,
								fontSize: 8, fontFamily: 'monospace',
								color: 'rgba(255,255,255,.75)',
								background: 'rgba(0,0,0,.55)',
								padding: '0 3px', borderRadius: 2, zIndex: 2,
							}}>{((b.durationMs ?? ctrl.doc.defaultBoardTimingMs) / 1000).toFixed(1)}s</span>
						</div>
					))}
					{/* 添加按钮 */}
					<button
						onClick={() => ctrl.addBoard(false)}
						title="添加新镜头"
						style={{
							flexShrink: 0, width: 32, height: 48, borderRadius: 5,
							border: '1px dashed rgba(255,255,255,.2)', background: 'transparent',
							color: 'var(--vscode-descriptionForeground)', cursor: 'pointer',
							fontSize: 16,
						}}>+</button>
				</div>
			</div>
		</div>
	);
}
