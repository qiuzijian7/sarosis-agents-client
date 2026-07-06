/*---------------------------------------------------------------------------------------------
 *  Dropdown position & outside-click helpers — extracted from agentChatPanel.ts
 *  Pure utility functions, no class state needed.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';

/** Position a dropdown below a trigger element (fixed positioning) */
export function positionDropdownBelow(
	el: HTMLElement,
	trigger: HTMLElement | null,
	rightAlign = false,
): void {
	if (!trigger) { return; }
	const rect = trigger.getBoundingClientRect();
	el.style.position = 'fixed';
	el.style.top = (rect.bottom + 4) + 'px';
	el.style.right = '';
	el.style.left = '';

	if (rightAlign) {
		el.style.right = (mainWindow.innerWidth - rect.right) + 'px';
	} else {
		const minWidth = Math.max(220, rect.width);
		let leftPos = rect.left;
		if (leftPos + minWidth > mainWindow.innerWidth - 8) {
			leftPos = mainWindow.innerWidth - minWidth - 8;
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
	el.style.position = 'fixed';
	el.style.bottom = (mainWindow.innerHeight - rect.top + 6) + 'px';

	const minWidth = Math.max(180, rect.width);
	let leftPos = rect.left;
	if (leftPos + minWidth > mainWindow.innerWidth - 8) {
		leftPos = mainWindow.innerWidth - minWidth - 8;
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
	const handler = addDisposableListener(mainWindow.document.body, EventType.CLICK, (e: MouseEvent) => {
		if (panel.contains(e.target as Node)) { return; }
		if (trigger && trigger.contains(e.target as Node)) { return; }
		onClose();
	});
	return registerFn(handler);
}
