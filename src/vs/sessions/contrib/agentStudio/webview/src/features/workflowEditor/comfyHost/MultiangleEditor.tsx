/**
 * MultiangleEditor.tsx — Multiangle 节点可视化交互编辑器（React 组件）
 *
 * 复刻自 ComfyTV MultiangleStageCard.vue 的核心 UI：
 *   - Three.js 3D Canvas 轨道球 + 可拖拽手柄
 *   - Prompt 自动生成覆盖层
 *   - CameraControlPanel（H/V/Z 下拉 + 重置）
 *
 * 集成方式：nodeCard.tsx 检测 ComfyTV.MultiangleStage → 渲染此组件替代默认控件
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { CameraWidget, type CameraState } from './cameraWidget';
import { CameraControlPanel } from './CameraControlPanel';

interface MultiangleEditorProps {
	/** 初始状态 */
	initialState?: Partial<CameraState>;
	/** 状态变化回调（用于回写 widget 值） */
	onStateChange?: (state: CameraState) => void;
	/** 高度（像素） */
	height?: number;
}

export function MultiangleEditor({ initialState, onStateChange, height = 320 }: MultiangleEditorProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const widgetRef = useRef<CameraWidget | null>(null);

	const [state, setState] = useState<CameraState>({
		azimuth: initialState?.azimuth ?? 0,
		elevation: initialState?.elevation ?? 0,
		distance: initialState?.distance ?? 5.0,
		imageUrl: initialState?.imageUrl ?? null,
	});

	const [prompt, setPrompt] = useState('');

	// ── 初始化 CameraWidget ──────────────────────────────────────

	useEffect(() => {
		if (!containerRef.current) return;

		const widget = new CameraWidget({
			container: containerRef.current,
			initialState: state,
			onStateChange: (newState) => {
				setState(newState);
				setPrompt(widget.generatePrompt());
				onStateChange?.(newState);
			},
		});
		widgetRef.current = widget;
		setPrompt(widget.generatePrompt());

		return () => {
			widget.dispose();
			widgetRef.current = null;
		};
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	// ── 外部更新（widget 已存在时） ───────────────────────────────

	useEffect(() => {
		if (!widgetRef.current) return;
		widgetRef.current.setState(initialState ?? {});
		setPrompt(widgetRef.current.generatePrompt());
	}, [initialState]); // eslint-disable-line react-hooks/exhaustive-deps

	// ── 控制面板回调 ─────────────────────────────────────────────

	const handleAzimuthChange = useCallback((value: number) => {
		widgetRef.current?.setState({ azimuth: value });
		setState(prev => ({ ...prev, azimuth: value }));
		setPrompt(widgetRef.current?.generatePrompt() ?? '');
		onStateChange?.(widgetRef.current?.getState() ?? state);
	}, [onStateChange, state]);

	const handleElevationChange = useCallback((value: number) => {
		widgetRef.current?.setState({ elevation: value });
		setState(prev => ({ ...prev, elevation: value }));
		setPrompt(widgetRef.current?.generatePrompt() ?? '');
		onStateChange?.(widgetRef.current?.getState() ?? state);
	}, [onStateChange, state]);

	const handleDistanceChange = useCallback((value: number) => {
		widgetRef.current?.setState({ distance: value });
		setState(prev => ({ ...prev, distance: value }));
		setPrompt(widgetRef.current?.generatePrompt() ?? '');
		onStateChange?.(widgetRef.current?.getState() ?? state);
	}, [onStateChange, state]);

	const handleReset = useCallback(() => {
		widgetRef.current?.resetToDefaults();
		const s = widgetRef.current?.getState() ?? { azimuth: 0, elevation: 0, distance: 5.0, imageUrl: null };
		setState(s);
		setPrompt(widgetRef.current?.generatePrompt() ?? '');
		onStateChange?.(s);
	}, [onStateChange]);

	// ── 渲染 ──────────────────────────────────────────────────────

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 0, width: '100%' }}>
			{/* 3D Canvas 容器 */}
			<div
				ref={containerRef}
				style={{
					position: 'relative',
					width: '100%',
					height,
					borderRadius: 6,
					overflow: 'hidden',
					background: '#0a0a0f',
				}}
			>
				{/* Prompt 覆盖层 */}
				{prompt && (
					<div
						style={{
							position: 'absolute',
							top: 6,
							left: 6,
							right: 6,
							zIndex: 10,
							padding: '4px 8px',
							background: 'rgba(18, 18, 26, 0.85)',
							border: '1px solid rgba(233, 61, 130, 0.35)',
							borderRadius: 4,
							color: '#E93D82',
							fontFamily: 'monospace',
							fontSize: 11.5,
							lineHeight: 1.4,
							whiteSpace: 'nowrap',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							pointerEvents: 'none',
						}}
					>
						{prompt}
					</div>
				)}
			</div>

			{/* 控制面板 */}
			<CameraControlPanel
				azimuth={state.azimuth}
				elevation={state.elevation}
				distance={state.distance}
				onAzimuthChange={handleAzimuthChange}
				onElevationChange={handleElevationChange}
				onDistanceChange={handleDistanceChange}
				onReset={handleReset}
			/>
		</div>
	);
}
