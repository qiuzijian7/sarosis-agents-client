/**
 * CameraControlPanel.tsx — Multiangle H/V/Z 控制条
 * 复刻自 ComfyTV src/components/widgets/CameraControlPanel.vue
 *
 * 三个下拉选择器（方位角/俯仰角/距离）+ 数值显示 + 重置按钮
 */

import React, { useCallback } from 'react';
import {
	AZIMUTH_OPTIONS, ELEVATION_OPTIONS, DISTANCE_OPTIONS,
	findClosestOption, findClosestDistanceOption,
	type DropdownOption,
} from './cameraViewOptions';

interface CameraControlPanelProps {
	azimuth: number;
	elevation: number;
	distance: number;
	onAzimuthChange: (value: number) => void;
	onElevationChange: (value: number) => void;
	onDistanceChange: (value: number) => void;
	onReset: () => void;
}

/** 单行控件：`[色标 label | 下拉 | 数值]`，随卡片宽度自适应。
 *
 *  ★ `select` 必须同时给 `minWidth: 0` + `width: '100%'`：
 *    grid/flex item 的 `min-width` 默认是 `auto`，对 `<select>` 而言等于
 *    min-content —— 即**最长 option 的文字宽度**（"front-right quarter" ≈ 117px）。
 *    不显式压成 0，下拉就无法收缩，在 280px 的节点卡片里必定横向溢出。
 */
function CameraDropdown({
	label,
	value,
	options,
	isAzimuth = false,
	readout,
	onChange,
}: {
	label: string;
	value: number;
	options: DropdownOption[];
	isAzimuth?: boolean;
	/** 右侧数值显示（如 "30°" / "1.0"） */
	readout: string;
	onChange: (v: number) => void;
}) {
	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLSelectElement>) => {
			onChange(Number(e.target.value));
		},
		[onChange],
	);
	const color = isAzimuth ? '#E93D82' : label === 'V' ? '#00FFD0' : '#FFB800';

	return (
		<div style={{
			display: 'grid',
			gridTemplateColumns: '14px minmax(0, 1fr) 42px',
			alignItems: 'center',
			gap: 6,
			minWidth: 0,
		}}>
			<span style={{
				color, fontWeight: 700, fontSize: 13, fontFamily: 'monospace', textAlign: 'center',
			}}>
				{label}
			</span>
			<select
				value={findClosestOption(value, options, isAzimuth)}
				onChange={handleChange}
				style={{
					// 见组件顶部注释：min-width:auto 会锁死在最长 option 宽度
					minWidth: 0,
					width: '100%',
					boxSizing: 'border-box',
					background: '#1a1a2e',
					color: '#e0e0e8',
					border: '1px solid #2a2a3e',
					borderRadius: 4,
					padding: '3px 6px',
					fontSize: 12,
					outline: 'none',
					cursor: 'pointer',
				}}
			>
				{options.map(opt => (
					<option key={opt.key} value={opt.value}>{opt.label}</option>
				))}
			</select>
			<span style={{
				color, fontWeight: 600, fontSize: 12, fontFamily: 'monospace',
				textAlign: 'right', whiteSpace: 'nowrap',
			}}>
				{readout}
			</span>
		</div>
	);
}

export function CameraControlPanel({
	azimuth, elevation, distance,
	onAzimuthChange, onElevationChange, onDistanceChange, onReset,
}: CameraControlPanelProps) {
	return (
		// ★ 竖排（每个控件一行）而非 ComfyTV 原版的单行横排：
		//   原版 7 个 flex 项（3 下拉 + 3 数值 + 1 按钮）需要 ~605px，而本项目的节点
		//   卡片固定 280px（内容区 256px）→ 必定溢出。改为竖排 3 行 + 底部重置按钮，
		//   信息完全等价。回归守护：visual/visual.spec.mjs 的 horizontal-overflow 规则。
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: 5,
				padding: '6px 8px',
				background: '#12121a',
				borderRadius: 6,
				minWidth: 0,
				boxSizing: 'border-box',
			}}
		>
			<CameraDropdown
				label="H"
				value={azimuth}
				options={AZIMUTH_OPTIONS}
				isAzimuth
				readout={`${Math.round(azimuth)}°`}
				onChange={onAzimuthChange}
			/>
			<CameraDropdown
				label="V"
				value={elevation}
				options={ELEVATION_OPTIONS}
				readout={`${Math.round(elevation)}°`}
				onChange={onElevationChange}
			/>
			<CameraDropdown
				label="Z"
				value={distance}
				options={DISTANCE_OPTIONS}
				readout={distance.toFixed(1)}
				onChange={onDistanceChange}
			/>

			{/* 重置按钮：单独一行右对齐，避免与下拉抢宽度 */}
			<button
				onClick={onReset}
				title="Reset camera to defaults"
				style={{
					alignSelf: 'flex-end',
					width: 26, height: 22, borderRadius: 5,
					border: '1px solid #333', background: '#1a1a2e', color: '#888',
					display: 'flex', alignItems: 'center', justifyContent: 'center',
					cursor: 'pointer', padding: 0, flexShrink: 0,
				}}
				onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#555'; }}
				onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#333'; }}
			>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
					<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
					<path d="M3 3v5h5" />
				</svg>
			</button>
		</div>
	);
}
