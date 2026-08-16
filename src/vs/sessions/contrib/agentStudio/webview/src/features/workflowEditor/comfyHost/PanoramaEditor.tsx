/**
 * PanoramaEditor — 复刻 ComfyTV PanoramaStageCard UI
 *
 * 布局（从上到下，严格对齐截图）：
 *   1. Workflow 下拉选择器
 *   2. ↑ Upload workflow / 🔗 Link workflow 按钮
 *   3. 大型预览区（白色背景，支持拖放/点击上传全景图）
 *   4. ⬆ Upload panorama 按钮
 *   5. Prompt 文本框（"type @ to insert a saved fragment"）
 *   6. 工具栏图标行（target / image / @ / bookmark / list）
 *
 * 对齐 ComfyTV 源码：
 * - PanoramaStageCard.vue → 整体布局 + StageCard 基类提供的 prompt/run
 * - PanoramaCanvas.vue → 预览区 + 上传交互（拖放/点击/file input）
 */
import React from 'react';

export interface PanoramaEditorProps {
	/** 当前 workflow 值 */
	workflow: string;
	/** 当前 prompt 值 */
	prompt: string;
	/** 上游图像 URL（用于预览区占位提示） */
	upstreamImageUrl?: string | null;
	/** 全景图结果 URL（运行成功后显示） */
	resultImageUrl?: string | null;
	/** 已上传的 workflow 数量（显示在 Upload workflow 按钮上） */
	workflowCount?: number;
	/** workflow 变更回调 */
	onWorkflowChange: (value: string) => void;
	/** prompt 变更回调 */
	onPromptChange: (value: string) => void;
	/** 上传全景图文件回调 */
	onPanoramaUpload: (file: File) => void;
	/** 上传 workflow JSON 回调 */
	onWorkflowUpload: (file: File) => void;
	/** 链接 workflow 回调（打开文件选择器选 JSON） */
	onLinkWorkflow: () => void;
}

/**
 * Panorama 预览区组件 — 白色背景画布，支持：
 * - 显示已生成的全景图结果
 * - 拖放上传全景图文件
 * - 点击触发 file input
 * - 空态时显示虚线边框 + 提示文字
 */
function PanoramaPreview({
	resultImageUrl,
	upstreamImageUrl,
	onUpload,
}: {
	resultImageUrl?: string | null;
	upstreamImageUrl?: string | null;
	onUpload: (file: File) => void;
}): React.JSX.Element {
	const fileInputRef = React.useRef<HTMLInputElement>(null);
	const [isDragOver, setIsDragOver] = React.useState(false);

	const handleDrop = React.useCallback((e: React.DragEvent) => {
		e.preventDefault();
		setIsDragOver(false);
		const file = e.dataTransfer.files[0];
		if (file) onUpload(file);
	}, [onUpload]);

	const handleDragOver = React.useCallback((e: React.DragEvent) => {
		e.preventDefault();
		setIsDragOver(true);
	}, []);

	const handleDragLeave = React.useCallback(() => {
		setIsDragOver(false);
	}, []);

	const handleClick = React.useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	const handleFileChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (file) onUpload(file);
		// 重置 input 以允许重复选择同一文件
		if (fileInputRef.current) fileInputRef.current.value = '';
	}, [onUpload]);

	/* 有结果图时显示图像，否则显示空态拖放区 */
	if (resultImageUrl) {
		return (
			<div style={{
				position: 'relative',
				width: '100%',
				height: 260,
				borderRadius: 8,
				overflow: 'hidden',
				background: '#fff',
			}}>
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img
					src={resultImageUrl}
					alt="Panorama result"
					style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
					draggable={false}
				/>
			</div>
		);
	}

	return (
		<div
			onClick={handleClick}
			onDrop={handleDrop}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			style={{
				width: '100%',
				height: 260,
				borderRadius: 8,
				border: isDragOver
					? '2px dashed #3b82f6'
					 : '2px dashed rgba(255,255,255,.20)',
				background: isDragOver
					? 'rgba(59,130,246,.06)'
					: '#fff',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				cursor: 'pointer',
				transition: 'border-color .15s, background .15s',
				boxSizing: 'border-box',
			}}
		>
			<div style={{ textAlign: 'center', color: 'var(--vscode-descriptionForeground, #858585)' }}>
				<div style={{ fontSize: 28, marginBottom: 8, opacity: .4 }}>🖼️</div>
				<div style={{ fontSize: 12, opacity: .7 }}>
					{upstreamImageUrl ? 'Drop panorama or click to upload' : 'Run Generate Panorama or upload result'}
				</div>
			</div>
			<input
				ref={fileInputRef}
				type="file"
				accept="image/*"
				onChange={handleFileChange}
				style={{ display: 'none' }}
			/>
		</div>
	);
}

/**
 * Prompt 下方工具栏图标行 — 对齐 ComfyTV 截图中的图标按钮组。
 * 图标：target(十字准星) / image(图片) / @(片段引用) / bookmark(收藏) / list(列表)
 */
function PromptToolbar(): React.JSX.Element {
	const buttons = [
		{ icon: '⊕', label: 'Target', title: 'Set target region' },
		{ icon: '🖼️', label: 'Image', title: 'Insert image reference' },
		{ icon: '@', label: 'Fragment', title: 'Insert saved fragment' },
		{ icon: '🔖', label: 'Bookmark', title: 'Bookmarks' },
		{ icon: '☰', label: 'List', title: 'Fragment list' },
	];
	return (
		<div style={{
			display: 'flex', gap: 2, marginTop: 2,
		}}>
			{buttons.map((btn) => (
				<button
					key={btn.label}
					title={btn.title}
					style={{
						width: 26, height: 26, borderRadius: 4,
						border: '1px solid rgba(255,255,255,.10)',
						background: 'rgba(255,255,255,.04)', color: 'inherit',
						cursor: 'pointer', fontSize: 12, display: 'flex',
						alignItems: 'center', justifyContent: 'center',
						padding: 0, fontFamily: 'inherit',
						flexShrink: 0,
					}}
				>
					{btn.icon}
				</button>
			))}
		</div>
	);
}

/**
 * 主组件 — Panorama 节点的完整内嵌编辑器（严格对齐 ComfyTV 截图）
 *
 * 在 nodeCard.tsx 中替代通用控件渲染，提供对齐 ComfyTV 的专用 UI。
 */
export function PanoramaEditor({
	workflow,
	prompt,
	upstreamImageUrl,
	resultImageUrl,
	workflowCount = 0,
	onWorkflowChange,
	onPromptChange,
	onPanoramaUpload,
	onWorkflowUpload,
	onLinkWorkflow,
}: PanoramaEditorProps): React.JSX.Element {
	const workflowInputRef = React.useRef<HTMLInputElement>(null);

	const handleWorkflowFileChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (file) onWorkflowUpload(file);
		if (workflowInputRef.current) workflowInputRef.current.value = '';
	}, [onWorkflowUpload]);

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
			{/* 1. Workflow 下拉选择器 */}
			<div style={{
				display: 'flex', alignItems: 'center', gap: 6,
				padding: '6px 8px', borderRadius: 6,
				background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.10)',
			}}>
				<span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--vscode-descriptionForeground, #858585)', flexShrink: 0, minWidth: 52 }}>
					Workflow
				</span>
				<select
					value={workflow}
					onChange={(e) => onWorkflowChange(e.target.value)}
					style={{
						flex: 1, fontSize: 11, padding: '3px 6px', borderRadius: 4,
						border: '1px solid rgba(255,255,255,.12)', background: 'transparent',
						color: 'inherit', fontFamily: 'inherit', cursor: 'pointer',
						appearance: 'auto', minWidth: 0,
					}}
				>
					<option value={workflow}>{workflow}</option>
				</select>
			</div>

			{/* 2. Upload / Link workflow 按钮 */}
			<div style={{ display: 'flex', gap: 6 }}>
				<button
					onClick={() => workflowInputRef.current?.click()}
					style={{
						flex: 1, fontSize: 10, padding: '5px 8px', borderRadius: 5,
						border: '1px solid rgba(255,255,255,.12)',
						background: 'rgba(255,255,255,.05)', color: 'inherit',
						cursor: 'pointer', fontFamily: 'inherit', display: 'flex',
						alignItems: 'center', justifyContent: 'center', gap: 4,
					}}
				>
					<span>↑</span>
					<span>{workflowCount > 0 ? `${workflowCount} ` : ''}Upload workflow</span>
				</button>
				<input
					ref={workflowInputRef}
					type="file"
					accept=".json"
					onChange={handleWorkflowFileChange}
					style={{ display: 'none' }}
				/>
				<button
					onClick={onLinkWorkflow}
					style={{
						flex: 1, fontSize: 10, padding: '5px 8px', borderRadius: 5,
						border: '1px solid rgba(255,255,255,.12)',
						background: 'rgba(255,255,255,.05)', color: 'inherit',
						cursor: 'pointer', fontFamily: 'inherit', display: 'flex',
						alignItems: 'center', justifyContent: 'center', gap: 4,
					}}
				>
					<span>🔗</span>
					<span>Link workflow</span>
				</button>
			</div>

			{/* 3. 大型预览区（白色背景） */}
			<PanoramaPreview
				resultImageUrl={resultImageUrl}
				upstreamImageUrl={upstreamImageUrl}
				onUpload={onPanoramaUpload}
			/>

			{/* 4. Upload panorama 按钮 */}
			<button
				onClick={() => {
					const evt = new MouseEvent('click', { bubbles: true });
					document.querySelector('.panorama-preview-input')?.dispatchEvent(evt);
				}}
				style={{
					fontSize: 10, padding: '5px 10px', borderRadius: 5,
					border: '1px solid rgba(255,255,255,.12)',
					background: 'rgba(255,255,255,.05)', color: 'inherit',
					cursor: 'pointer', fontFamily: 'inherit', display: 'flex',
					alignItems: 'center', justifyContent: 'center', gap: 5,
					alignSelf: 'flex-start',
				}}
			>
				<span>⬆</span>
				<span>Upload panorama</span>
			</button>

			{/* 5. Prompt 输入框 */}
			<div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
				<textarea
					value={prompt}
					onChange={(e) => onPromptChange(e.target.value)}
					placeholder="Prompt — type @ to insert a saved fragment"
					rows={2}
					spellCheck={false}
					style={{
						width: '100%', fontSize: 11, lineHeight: 1.5,
						padding: '7px 9px', borderRadius: 6,
						border: '1px solid rgba(255,255,255,.10)',
						background: 'rgba(255,255,255,.04)', color: 'inherit',
						fontFamily: 'inherit', resize: 'vertical',
						minHeight: 42, boxSizing: 'border-box',
						outline: 'none',
					}}
				/>
			</div>

			{/* 6. 工具栏图标行 */}
			<PromptToolbar />
		</div>
	);
}
