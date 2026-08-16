/**
 * cameraViewOptions.ts — Multiangle 节点 H/V/Z 下拉预设选项
 * 复刻自 ComfyTV src/composables/widgets/cameraViewOptions.ts
 */

export interface DropdownOption {
	key: string;
	value: number;
	label: string;
}

/** 水平方位角预设（8 方向，环形匹配） */
export const AZIMUTH_OPTIONS: DropdownOption[] = [
	{ key: 'frontView', value: 0, label: 'front view' },
	{ key: 'frontRightQuarterView', value: 45, label: 'front-right quarter' },
	{ key: 'rightSideView', value: 90, label: 'right side view' },
	{ key: 'backRightQuarterView', value: 135, label: 'back-right quarter' },
	{ key: 'backView', value: 180, label: 'back view' },
	{ key: 'backLeftQuarterView', value: 225, label: 'back-left quarter' },
	{ key: 'leftSideView', value: 270, label: 'left side view' },
	{ key: 'frontLeftQuarterView', value: 315, label: 'front-left quarter' },
];

/** 垂直俯仰角预设 */
export const ELEVATION_OPTIONS: DropdownOption[] = [
	{ key: 'lowAngleShot', value: -30, label: 'low-angle shot' },
	{ key: 'eyeLevelShot', value: 0, label: 'eye-level shot' },
	{ key: 'elevatedShot', value: 30, label: 'elevated shot' },
	{ key: 'highAngleShot', value: 60, label: 'high-angle shot' },
];

/** 距离/景别预设 */
export const DISTANCE_OPTIONS: DropdownOption[] = [
	{ key: 'wideShot', value: 1, label: 'wide shot' },
	{ key: 'mediumShot', value: 4, label: 'medium shot' },
	{ key: 'closeUp', value: 8, label: 'close-up' },
];

/**
 * 找到最接近的预设值。isAzimuth=true 时做 360° 环形匹配。
 */
export function findClosestOption(value: number, options: DropdownOption[], isAzimuth = false): number {
	let closest = options[0].value;
	let minDiff = Math.abs(value - options[0].value);
	for (const opt of options) {
		let diff = Math.abs(value - opt.value);
		if (isAzimuth) {
			diff = Math.min(diff, Math.abs(value - opt.value - 360), Math.abs(value - opt.value + 360));
		}
		if (diff < minDiff) {
			minDiff = diff;
			closest = opt.value;
		}
	}
	return closest;
}

/** 距离最近预设（分段） */
export function findClosestDistanceOption(dist: number): number {
	if (dist < 2) return 1;
	if (dist < 6) return 4;
	return 8;
}
