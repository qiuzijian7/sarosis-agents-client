/*---------------------------------------------------------------------------------------------
 *  TransformEditor — 旋转/镜像编辑器（复刻 ComfyTV RotateStageCard / MirrorStageCard）。
 *
 *  布局完全对齐 ComfyTV Vue SFC：
 *  ┌────────────────────────────────────┐
 *  │  预览区（黑底 <img> + CSS transform）│  min-h-[140px] max-h-[320px], object-contain
 *  ├────────────────────────────────────┤
 *  │  状态文字（纯文本，无背景框）        │  green=applied, muted=adjusting
 *  ├────────────────────────────────────┤
 *  │  控件区                             │
 *  │  Rotate: ANGLE | ===slider=== | °  │  grid 3-col + 4 预设按钮
 *  │  Mirror: [⇄Horizontal] [⇄Vertical]│  flex 2 等分按钮
 *  └────────────────────────────────────┘
 *
 *  注意：CONTEXT / OUTPUT / ACTIONS 由 nodeCard 通用渲染，不在本组件内重复。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';

export interface TransformEditorProps {
	mode: 'rotate' | 'mirror';
	/** 初始值来自节点 values。 */
	initial: { angle?: number; horizontal?: boolean; vertical?: boolean };
	/** 上游图像 URL（无则显示占位图标）。 */
	imageRef?: string;
	/** 角度变更回调（仅 rotate 模式）。 */
	onAngleChange?: (angle: number) => void;
	/** 翻转变更回调（仅 mirror 模式）。 */
	onMirrorChange?: (horizontal: boolean, vertical: boolean) => void;
	/** 内容高度变化回调（如图片异步加载后 viewH 变化）→ 宿主节点 markFormHeightDirty。 */
	onResize?: () => void;
	/**
	 * 上方预览是否套用 CSS transform 显示「变换后」的样子。
	 *
	 * 默认 `false` = **显示原图**。语义分工：
	 *   上方预览 = 输入原图（参考）   下方 OUTPUT = 变换后的真实结果
	 * ComfyTV 这里是 `true`（rotatePreviewStyle / mirrorPreviewStyle 实时预览），
	 * 但那样上方和 OUTPUT 会显示同一个变换结果、看不到原图，无法对比。
	 */
	livePreview?: boolean;
	/**
	 * 权威状态行（由宿主 nodeCard 从 useTransformPipeline 的真实 phase 推导）。
	 *
	 * ComfyTV 的 RotateStageCard / MirrorStageCard 在「预览」与「控件」之间
	 * 只有**一行**状态文字（computing / applied / adjustToApply）。本组件自身
	 * 只知道「有没有输入图」，不知道变换成功与否，因此真实状态必须由宿主注入
	 * 到这个位置；不传时退化为本组件的输入态描述。
	 */
	status?: { text: string; tone: 'muted' | 'success' | 'error' };
}

// 对齐 ComfyTV 的快捷角度按钮（⟲ 90° / 0° / 180° / ⟳ 90°）
const ANGLE_PRESETS = [
	{ label: '⟲ 90°', value: -90 },
	{ label: '0°', value: 0 },
	{ label: '180°', value: 180 },
	{ label: '⟳ 90°', value: 90 },
];

// 对齐 ComfyTV imageOrientPreview.ts 的 CSS transform 样式。
// `live=false`（默认）时不做任何变换 —— 上方预览保持原图，变换结果看 OUTPUT。
function orientStyle(mode: 'rotate' | 'mirror', angle: number, flipH: boolean, flipV: boolean, live: boolean): React.CSSProperties {
	if (!live) { return {}; }
	if (mode === 'rotate') {
		return {
			transform: `rotate(${angle}deg)`,
			transition: 'transform 80ms linear',
		};
	}
	return {
		transform: `scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})`,
		transition: 'transform 80ms linear',
	};
}

/* ── 共享样式常量（对齐 ComfyTV ctv: 前缀 Tailwind 类）── */
const PREVIEW_CONTAINER: React.CSSProperties = {
	position: 'relative',
	width: '100%',
	/* 对齐 ComfyTV `ctv:min-h-[280px]`（RotateStageCard / MirrorStageCard 的
	   预览容器）。此前的 140 让预览只有参考实现一半高，图片被压成窄条。
	   maxHeight 放宽到 420，配合 flex:1 让预览随节点拉伸而增高。 */
	flex: 1,
	minHeight: 280,
	maxHeight: 420,
	borderRadius: 6,
	overflow: 'hidden',
	border: '1px solid rgba(255,255,255,.12)',
	background: '#000',
};

const PREVIEW_IMG: React.CSSProperties = {
	maxWidth: '100%',
	maxHeight: '100%',
	objectFit: 'contain',
	userSelect: 'none',
	pointerEvents: 'none',
	display: 'block',
	margin: 'auto',
};

const PLACEHOLDER_STYLE: React.CSSProperties = {
	display: 'flex',
	flexDirection: 'column',
	alignItems: 'center',
	justifyContent: 'center',
	gap: 8,
	color: 'rgba(255,255,255,.5)',
	fontSize: 12,
};

const STATUS_TEXT: React.CSSProperties = {
	fontSize: 10,
	textAlign: 'center',
	paddingTop: 2,
	paddingBottom: 2,
	letterSpacing: '0.3px',
};

/* Mirror 按钮 —— 对齐 ComfyTV ctv:flex-1 + 圆角边框 + 激活态高亮 */
const MIRROR_BTN_BASE: React.CSSProperties = {
	flex: 1,
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: 6,
	padding: '7px 10px',
	borderRadius: 6,
	fontSize: 11,
	cursor: 'pointer',
	border: '1px solid rgba(255,255,255,.1)',
	background: 'rgba(255,255,255,.04)',
	color: '#d4d4d8',
	transition: 'all .15s ease',
	pointerEvents: 'auto' as const,
};

function mirrorBtnStyle(active: boolean): React.CSSProperties {
	if (!active) return MIRROR_BTN_BASE;
	return {
		...MIRROR_BTN_BASE,
		background: 'rgba(168,85,247,.15)',
		borderColor: 'rgba(168,85,247,.5)',
		color: '#c084fc',
		fontWeight: 600,
	};
}

/* Rotate 预设按钮 —— 对齐 ComfyTV ctv:grid-cols-4 + 圆角边框 */
const PRESET_BTN_BASE: React.CSSProperties = {
	padding: '5px 8px',
	borderRadius: 4,
	fontSize: 10,
	fontWeight: 600,
	cursor: 'pointer',
	border: '1px solid rgba(255,255,255,.1)',
	background: 'rgba(255,255,255,.04)',
	color: '#a1a1aa',
	transition: 'all .12s ease',
	pointerEvents: 'auto' as const,
};

function presetBtnStyle(active: boolean): React.CSSProperties {
	if (!active) return PRESET_BTN_BASE;
	return {
		...PRESET_BTN_BASE,
		background: 'rgba(96,165,250,.15)',
		borderColor: 'rgba(96,165,250,.35)',
		color: '#93c5fd',
	};
}

export function TransformEditor({ mode, initial, imageRef, onAngleChange, onMirrorChange, onResize, livePreview = false, status }: TransformEditorProps): React.JSX.Element {
	const [imgReady, setImgReady] = React.useState(false);
	const containerRef = React.useRef<HTMLDivElement>(null);

	// ── Rotate state ──
	const [angle, setAngle] = React.useState(initial.angle ?? 0);
	// ── Mirror state ──
	// 默认 false（对齐 ComfyTV `useBoolWidget(node, 'flip_horizontal', false)`）。
	// 此前默认 true 会让新建的 Mirror 节点一落下就水平翻转，与参考实现不符。
	const [flipH, setFlipH] = React.useState(initial.horizontal ?? false);
	const [flipV, setFlipV] = React.useState(initial.vertical ?? false);

	// 加载上游图像
	React.useEffect(() => {
		// 只认 http(s) 会漏掉 `data:` 与 `blob:` —— 变换结果回写快照后常以这两种
		// 形式出现（instantExecutor 上传前先生成 blob），此时预览会误判「无输入图」。
		const loadable = !!imageRef && /^(?:https?:|data:|blob:)/i.test(imageRef);
		if (!loadable) {
			setImgReady(false);
			return;
		}
		const img = new Image();
		// data:/blob: 是同源的，设 crossOrigin 反而可能让部分环境加载失败。
		if (/^https?:/i.test(imageRef)) { img.crossOrigin = 'anonymous'; }
		img.onload = () => { setImgReady(true); };
		img.onerror = () => { setImgReady(false); };
		img.src = imageRef;
		return () => { img.onload = null; img.onerror = null; };
	}, [imageRef]);

	// 图片加载后通知宿主重新测量高度
	const onResizeRef = React.useRef(onResize);
	onResizeRef.current = onResize;
	React.useEffect(() => {
		onResizeRef.current?.();
	}, [imgReady]);

	// ── 回调 ──
	const fireAngleChange = React.useCallback((deg: number) => {
		setAngle(deg);
		onAngleChange?.(deg);
	}, [onAngleChange]);

	const fireMirrorChange = React.useCallback((h: boolean, v: boolean) => {
		setFlipH(h);
		setFlipV(v);
		onMirrorChange?.(h, v);
	}, [onMirrorChange]);

	// 状态判定（对齐 ComfyTV 三态：noInput / computing / applied / adjustToApply）。
	// 注意：本组件只知道「有没有输入图」，**不知道变换是否真的成功**（那由
	// useTransformPipeline 掌握，nodeCard 在下方渲染真实三态文案）。因此这里
	// 不能说 "applied" —— 之前无条件显示「Rotation applied」，在 fetch 失败、
	// OUTPUT 根本没产出时也照说「已应用」，与紧邻的红色报错自相矛盾。
	const hasImage = imgReady && !!imageRef;
	// 宿主注入的权威状态优先（ComfyTV 的单行状态语义）；缺省时退化为输入态描述。
	const fallbackText = !hasImage
		? 'No input image'
		: livePreview
			? (mode === 'rotate' ? 'Preview — rotated' : 'Preview — mirrored')
			: 'Source image — result shown in OUTPUT';
	const statusText = hasImage && status ? status.text : fallbackText;
	const statusColor = hasImage && status
		? (status.tone === 'success' ? '#4ade80' : status.tone === 'error' ? '#fca5a5' : 'rgba(161,161,170,.8)')
		: 'rgba(161,161,170,.8)';

	const previewStyle = orientStyle(mode, angle, flipH, flipV, livePreview);

	return (
		<div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
			{/* ═══ 预览图区域（对齐 ComfyTV：黑底 + <img> CSS transform + min-h-280px）═══ */}
			<div style={PREVIEW_CONTAINER}>
				<div style={{
					position: 'absolute', inset: 0,
					display: 'flex', alignItems: 'center', justifyContent: 'center',
				}}>
					{!hasImage ? (
						<div style={PLACEHOLDER_STYLE}>
							{/* 占位图标 */}
							<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: .6 }}>
								<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
								<circle cx="8.5" cy="8.5" r="1.5" />
								<polyline points="21 15 16 10 5 21" />
							</svg>
							<span>No input image</span>
						</div>
					) : (
						<img
							src={imageRef}
							draggable={false}
							style={{ ...PREVIEW_IMG, ...previewStyle }}
							onDragStart={e => e.preventDefault()}
						/>
					)}
				</div>
			</div>

			{/* ═══ 状态文字（对齐 ComfyTV：纯文本，无背景框）═══ */}
			<div style={{ ...STATUS_TEXT, color: statusColor }}>
				{statusText}
			</div>

			{/* ═══ 控件区 ═══ */}
			{mode === 'rotate' ? (
				/* ── Rotate 控件（对齐 ComfyTV：grid [64px|1fr|48px] + 4列预设）── */
				<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
					{/* 行1: ANGLE 标签 | 滑块 | 数值 */}
					<div style={{
						display: 'grid',
						gridTemplateColumns: '64px 1fr 48px',
						alignItems: 'center',
						gap: 6,
						fontSize: 11,
					}}>
						<span style={{
							fontSize: 10, fontWeight: 700, letterSpacing: '1px',
							textTransform: 'uppercase', color: 'rgba(161,161,170,.9)',
						}}>
							ANGLE
						</span>
						<input
							type="range"
							min={-180}
							max={180}
							step={1}
							value={angle}
							onChange={e => fireAngleChange(Number(e.target.value))}
							style={{ width: '100%', accentColor: '#60a5fa', pointerEvents: 'auto' as const }}
						/>
						<span style={{
							textAlign: 'right', fontFamily: 'Consolas, monospace',
							fontSize: 11, fontWeight: 600, color: '#e4e4e7',
						}}>
							{angle}°
						</span>
					</div>
					{/* 行2: 快捷角度按钮（4 列网格） */}
					<div style={{
						display: 'grid',
						gridTemplateColumns: '1fr 1fr 1fr 1fr',
						gap: 6,
					}}>
						{ANGLE_PRESETS.map(p => (
							<button
								key={p.value}
								type="button"
								onClick={() => fireAngleChange(p.value)}
								style={presetBtnStyle(angle === p.value)}
							>
								{p.label}
							</button>
						))}
					</div>
				</div>
			) : (
				/* ── Mirror 控件（对齐 ComfyTV：flex 2 等分按钮）── */
				<div style={{ display: 'flex', gap: 6 }}>
					<button
						type="button"
						onClick={() => fireMirrorChange(!flipH, flipV)}
						style={mirrorBtnStyle(flipH)}
					>
						<span style={{ fontSize: 13 }}>⇄</span> Horizontal flip
					</button>
					<button
						type="button"
						onClick={() => fireMirrorChange(flipH, !flipV)}
						style={mirrorBtnStyle(flipV)}
					>
						<span style={{ fontSize: 13 }}>⇅</span> Vertical flip
					</button>
				</div>
			)}
		</div>
	);
}
