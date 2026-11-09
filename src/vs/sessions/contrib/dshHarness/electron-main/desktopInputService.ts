/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VsSaros addition (2026-11-09, P1 · background input): the ONLY module in the desktop-control
 * path that performs real input injection. Kept separate from the relay so the relay's policy
 * can be audited without native code (see dsh-plugins/check-computer-control.mjs).
 *
 * ★ The relay calls this ONLY after `desktopControlRefusal()` allowed the method with an
 *   effective level of `background` or higher. With the default `maxLevel: 'view'`, this
 *   module is never called and the whole product stays read-only.
 * ★ nut-js is an N-API addon; a load failure degrades to "not dispatched", never crashes.
 * ★ Every result says "dispatched", not "applied": the caller must observe again.
 */

import { BrowserWindow, screen } from 'electron';

type NutJsModule = {
	mouse: {
		setPosition(p: { x: number; y: number }): Promise<void>;
		move(path: { x: number; y: number }[]): Promise<void>;
		pressButton(b: number): Promise<void>;
		releaseButton(b: number): Promise<void>;
		click(b: number): Promise<void>;
		doubleClick(b: number): Promise<void>;
		scrollUp(amount: number): Promise<void>;
		scrollDown(amount: number): Promise<void>;
		scrollLeft(amount: number): Promise<void>;
		scrollRight(amount: number): Promise<void>;
	};
	keyboard: {
		type(...keys: string[]): Promise<void>;
		pressKey(...keys: string[]): Promise<void>;
		releaseKey(...keys: string[]): Promise<void>;
	};
	Button: { LEFT: number; RIGHT: number; MIDDLE: number };
};

export interface IDesktopInputParams {
	x?: number;
	y?: number;
	amount?: number;
	text?: string;
	keys?: string[];
	windowId?: number;
}

/** P1 = pure input; P2 adds two foreground methods. OS-wide window actions stay unimplemented. */
export const IMPLEMENTED_INPUT_METHODS: ReadonlySet<string> = new Set([
	'click', 'doubleClick', 'rightClick', 'typeText', 'pressKey', 'hotkey', 'scroll', 'drag',
	'movePointer', 'activateApp',
]);

export interface IInputResult {
	readonly dispatched: boolean;
	readonly note?: string;
	readonly error?: string;
}

let cached: NutJsModule | undefined;
let loadError: string | undefined;

export function loadNutJs(): NutJsModule | undefined {
	if (cached) return cached;
	if (loadError) return undefined;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mod = require('@nut-tree/nut-js');
		cached = (mod?.default ?? mod) as NutJsModule;
		return cached;
	} catch (error) {
		loadError = error instanceof Error ? error.message : String(error);
		return undefined;
	}
}

/** Coordinates are physical pixels; reject anything outside the primary display. */
function withinDisplay(x: number, y: number): boolean {
	const bounds = screen.getPrimaryDisplay().bounds;
	return Number.isFinite(x) && Number.isFinite(y)
		&& x >= bounds.x && y >= bounds.y
		&& x <= bounds.x + bounds.width && y <= bounds.y + bounds.height;
}

export async function injectDesktopInput(method: string, params: IDesktopInputParams = {}): Promise<IInputResult> {
	if (!IMPLEMENTED_INPUT_METHODS.has(method)) {
		return { dispatched: false, error: `${method} 在 P1 未实现（窗口/OS 动作属 P2）` };
	}
	const nut = loadNutJs();
	if (!nut) {
		return { dispatched: false, error: `nut-js 不可用：${loadError ?? '未加载'}` };
	}
	const LEFT = nut.Button?.LEFT ?? 0;
	const RIGHT = nut.Button?.RIGHT ?? 2;
	const x = params.x ?? 0;
	const y = params.y ?? 0;
	if (['click', 'doubleClick', 'rightClick', 'drag', 'movePointer'].includes(method) && !withinDisplay(x, y)) {
		return { dispatched: false, error: `坐标 (${x}, ${y}) 超出主屏范围` };
	}
	// P2 `activateApp` deliberately targets only this app's own windows. Raising a third-party
	// window would need OS-level enumeration (P2 UI scope) and a much wider permission.
	if (method === 'activateApp') {
		const win = BrowserWindow.getAllWindows().find((candidate) =>
			candidate.id === params.windowId && !candidate.isDestroyed());
		if (!win) {
			return { dispatched: false, error: `windowId ${String(params.windowId)} 不是本应用的有效窗口（P2 只置前 VsSaros 自己的窗口）` };
		}
		win.show();
		win.focus();
		return { dispatched: true, note: '已置前本应用窗口；请重新观察窗口状态再继续。' };
	}
	try {
		switch (method) {
			case 'movePointer':
				await nut.mouse.setPosition({ x, y });
				break;
			case 'click':
				await nut.mouse.setPosition({ x, y });
				await nut.mouse.click(LEFT);
				break;
			case 'doubleClick':
				await nut.mouse.setPosition({ x, y });
				await nut.mouse.doubleClick(LEFT);
				break;
			case 'rightClick':
				await nut.mouse.setPosition({ x, y });
				await nut.mouse.click(RIGHT);
				break;
			case 'drag':
				await nut.mouse.setPosition({ x, y });
				await nut.mouse.pressButton(LEFT);
				try {
					await nut.mouse.move([{ x: params.amount ?? x, y: params.y ?? y }]);
				} finally {
					await nut.mouse.releaseButton(LEFT);
				}
				break;
			case 'scroll': {
				const amount = Math.abs(params.amount ?? 0) || 1;
				if ((params.amount ?? 0) >= 0) await nut.mouse.scrollDown(amount);
				else await nut.mouse.scrollUp(amount);
				break;
			}
			case 'typeText':
				await nut.keyboard.type(String(params.text ?? ''));
				break;
			case 'pressKey':
				await nut.keyboard.pressKey(...(params.keys ?? []));
				break;
			case 'hotkey':
				await nut.keyboard.pressKey(...(params.keys ?? []));
				await nut.keyboard.releaseKey(...(params.keys ?? []));
				break;
			default:
				return { dispatched: false, error: `未知输入方法 ${method}` };
		}
		return {
			dispatched: true,
			note: '结果只表示「已发出」，不表示「已生效」；请重新观察窗口状态再继续。',
		};
	} catch (error) {
		return { dispatched: false, error: error instanceof Error ? error.message : String(error) };
	}
}
