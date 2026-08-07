/*---------------------------------------------------------------------------------------------
 *  Dropdown position & outside-click helpers — extracted from agentChatPanel.ts
 *  Pure utility functions, no class state needed.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';

/** Get the owner window of an element (falls back to mainWindow). */
function _winOf(trigger: HTMLElement | null | undefined): Window {
	return trigger?.ownerDocument?.defaultView ?? mainWindow;
}

/** Position a dropdown below a trigger element (fixed positioning) */
export function positionDropdownBelow(
	el: HTMLElement,
	trigger: HTMLElement | null,
	rightAlign = false,
): void {
	if (!trigger) { return; }
	const rect = trigger.getBoundingClientRect();
	const win = _winOf(trigger); // popout 窗口时取 popout 的 viewport 尺寸
	el.style.position = 'fixed';
	el.style.top = (rect.bottom + 4) + 'px';
	el.style.right = '';
	el.style.left = '';

	if (rightAlign) {
		el.style.right = (win.innerWidth - rect.right) + 'px';
	} else {
		const minWidth = Math.max(220, rect.width);
		let leftPos = rect.left;
		if (leftPos + minWidth > win.innerWidth - 8) {
			leftPos = win.innerWidth - minWidth - 8;
		}
		leftPos = Math.max(8, leftPos);
		el.style.left = leftPos + 'px';
	}
	el.style.minWidth = Math.max(220, rect.width) + 'px';
	el.style.zIndex = '10000';
}

/** Position a dropdown above a trigger element */
export function positionDropdownAbove(
	el: HTMLElement,
	trigger: HTMLElement | null,
): void {
	if (!trigger) { return; }
	const rect = trigger.getBoundingClientRect();
	const win = _winOf(trigger); // popout 窗口时取 popout 的 viewport 尺寸
	el.style.position = 'fixed';
	el.style.bottom = (win.innerHeight - rect.top + 6) + 'px';

	const minWidth = Math.max(180, rect.width);
	let leftPos = rect.left;
	if (leftPos + minWidth > win.innerWidth - 8) {
		leftPos = win.innerWidth - minWidth - 8;
	}
	leftPos = Math.max(8, leftPos);
	el.style.left = leftPos + 'px';
	el.style.minWidth = minWidth + 'px';
	el.style.zIndex = '10000';
}

/** Dispose a disposable if non-null */
export function disposeOutsideClick(d: IDisposable | null): void {
	if (d) { d.dispose(); }
}

/** Register a click listener that calls onClose when clicking outside panel+trigger */
export function registerOutsideClickClose(
	panel: HTMLElement,
	trigger: HTMLElement | null,
	onClose: () => void,
	registerFn: (d: IDisposable) => IDisposable,
): IDisposable {
	// 同样要用 trigger 所在 window 的 document，否则 popout 中点击 panel/trigger 不会被识别为"outside"
	const doc = trigger?.ownerDocument ?? mainWindow.document;
	const handler = addDisposableListener(doc.body, EventType.CLICK, (e: MouseEvent) => {
		if (panel.contains(e.target as Node)) { return; }
		if (trigger && trigger.contains(e.target as Node)) { return; }
		onClose();
	});
	return registerFn(handler);
}
