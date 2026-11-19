/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createElement, useLayoutEffect, useRef } from 'react';
import { SessionNodeItem } from '@vssaros/official-session-row';
import css from './sessionRow.module.css';

export const OFFICIAL_VERSION = __DSH_SESSION_ROW_VERSION__;

export function toSessionNode(row, list, statuses) {
	const summary = list.byId?.[row.id] ?? {};
	const status = statuses.get(row.id);
	const pending = status?.pendingInteraction;
	return {
		id: row.id,
		title: row.title,
		blank: row.blank === true,
		pinned: row.pinned === true,
		archived: row.archived === true,
		updatedAt: row.at,
		cwd: summary.cwd || undefined,
		running: status?.running ?? summary.running ?? row.status === 'running',
		pendingInteraction: pending === 'approval' || pending === 'plan-review' || pending === 'question' ? pending : undefined,
		completed: status?.completionUnread === true,
		runningSubagentCount: list.projectionsBySession?.[row.id]?.values.subagentCatalog?.reduce(
			(count, child) => count + ((statuses.get(child.id)?.running ?? list.byId?.[child.id]?.running) === true ? 1 : 0), 0,
		) ?? 0,
	};
}

export function OfficialSessionRow({ row, list, statuses, slotProps, onOpen, onRenameRequest, drag, acceptDrop, dragging, unread, decorations, keyProps }) {
	const wrapper = useRef(null);
	useLayoutEffect(() => {
		const element = wrapper.current?.querySelector('[data-row-key]');
		if (!element) { return; }
		element.classList.add('vssaros-ws-row');
		element.dataset.sessionItem = row.id;
		element.dataset.vssarosKeyRow = keyProps['data-vssaros-key-row'];
		element.dataset.vssarosKeyId = row.id;
		if (keyProps['data-key-focus']) { element.dataset.keyFocus = '1'; }
		else { delete element.dataset.keyFocus; }
	});
	const renderSlot = (name, args) => {
		const contributed = slotProps.renderSlot(name, args);
		if (name === 'sidebar.session.row.leading' && unread) {
			return createElement('span', { className: css.unreadDot, role: 'img', 'aria-label': '未读', 'data-ws-unread': '1' });
		}
		if (name === 'sidebar.session.row.trailing') {
			return createElement('span', { className: css.decorations }, contributed, decorations);
		}
		return contributed;
	};
	return createElement('div', {
		ref: wrapper,
		className: css.wrapper,
		'data-manual-unread': unread ? '1' : undefined,
		'data-dragging': dragging ? '1' : undefined,
		onFocusCapture: keyProps.onFocus,
		onDragOverCapture: event => {
			if (!drag?.active || acceptDrop) { return; }
			event.preventDefault(); event.stopPropagation();
			event.dataTransfer.dropEffect = 'none';
		},
		onDropCapture: event => {
			if (!drag?.active || acceptDrop) { return; }
			event.preventDefault(); event.stopPropagation();
			drag.end();
		},
	}, createElement(SessionNodeItem, {
		node: toSessionNode(row, list, statuses),
		currentId: row.isCurrent ? row.id : undefined,
		now: Date.now(),
		onOpen,
		onRenameRequest,
		drag,
		renderSlot,
		renderFactorySlot: slotProps.renderFactorySlot,
		useContextMenu: slotProps.useContextMenu,
		useContextMenuTarget: slotProps.useContextMenuTarget,
		useSessionAccess: slotProps.useSessionAccess,
		t: slotProps.t,
	}));
}

export function install(_ctx, shell) {
	shell.state.officialSessionRow = OfficialSessionRow;
	shell.state.officialSessionRowVersion = OFFICIAL_VERSION;
	if (typeof window.Event === 'function') { window.dispatchEvent(new window.Event('vssaros-official-session-row-ready')); }
}
