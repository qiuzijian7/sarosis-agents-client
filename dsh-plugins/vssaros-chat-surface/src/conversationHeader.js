/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createElement } from 'react';
import { ConversationHeader } from '@vssaros/official-conversation-header';

export const HEADER_SLOT = 'conversation.header';
export const ACTIONS_SLOT = 'vssaros.conversation.header.actions';
export const OFFICIAL_VERSION = __DSH_CONVERSATION_HEADER_VERSION__;
const privateSlot = name => `vssaros.${name}`;
const CORNER_SLOT = 'conversation.session.header.corner';
const UTILITIES_SLOT = 'conversation.session.header.utilities';
const BOTTOM_SLOT = 'vssaros.conversation.header.bottom';
const BOTTOM_ENTRY_ID = 'dsh-better-sidebar:bottom-toggle';

function splitPane() {
	const api = window.vssarosDsh;
	const state = window.__vssarosChatSurface;
	const fail = error => {
		const why = String(error?.message || error || '未知错误');
		if (state) { state.newWindowEntry = 'failed'; state.newWindowEntryError = why; }
		console.warn('[vssaros-ws] splitChatPane failed:', why);
		try { api?.notify?.('warn', `分屏失败：${why}`); } catch { /* notification unavailable */ }
	};
	if (typeof api?.splitChatPane === 'function') {
		try {
			const result = api.splitChatPane();
			if (result && typeof result.then === 'function') {
				result.then(() => {
					if (state) { state.newWindowEntry = 'ok'; state.newWindowEntryError = null; }
				}, fail);
			} else if (state) { state.newWindowEntry = 'called'; }
		} catch (error) { fail(error); }
		return;
	}
	if (state) {
		state.newWindowEntry = 'unsupported';
		state.newWindowEntryError = `splitChatPane unavailable (bridgeVersion=${api?.bridgeVersion})`;
	}
	try { api?.notify?.('warn', '当前宿主不支持「分屏窗格」（需要页面桥 23）'); } catch { /* notification unavailable */ }
}

export function NewWindowChip() {
	return createElement('button', {
		type: 'button',
		'data-vssaros-new-window': '1',
		title: '新增一个聊天窗口（在当前窗口里分屏，不影响这个会话）',
		'aria-label': '新增窗口',
		onClick: splitPane,
	}, createElement('svg', {
		width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none',
		stroke: 'currentColor', strokeWidth: 1.25, 'aria-hidden': 'true', focusable: 'false',
	},
		createElement('path', { d: 'M9 2.5H2.5v11h11V7 M11.5 1v5 M9 3.5h5' }),
	));
}

/** Mirror registrations, not bare components, so store, locale and injected hooks retain their scope. */
export function mirrorHeaderSlot(slots, source, target, omitCorner = false, onlyEntryId) {
	return slots.inject(target, () => slots.inject(source, () => {
		let copies = [];
		const clear = () => { for (const dispose of copies.splice(0).reverse()) { dispose(); } };
		const refresh = () => {
			clear();
			try {
				for (const entry of slots.entries(source)) {
					const id = entry.options?.id;
					if (onlyEntryId !== undefined && id !== onlyEntryId) { continue; }
					if (source === UTILITIES_SLOT && target !== BOTTOM_SLOT && id === BOTTOM_ENTRY_ID) { continue; }
					const children = {};
					for (const [name, spec] of Object.entries(entry.children || {})) {
						if (omitCorner && name === CORNER_SLOT) { continue; }
						children[privateSlot(name)] = spec;
					}
					const Component = props => createElement(entry.component, {
						...props,
						renderSlot: (name, ...args) => omitCorner && name === CORNER_SLOT
							? null : props.renderSlot(privateSlot(name), ...args),
						renderSlotChain: (name, ...args) => props.renderSlotChain(privateSlot(name), ...args),
					});
					copies.push(slots.register({
						...entry.options, name: target,
						children: Object.keys(children).length ? children : undefined,
						inject: entry.inject, locale: entry.locale, store: entry.store,
					}, Component));
					for (const name of Object.keys(entry.children || {})) {
						if (omitCorner && name === CORNER_SLOT) { continue; }
						copies.push(mirrorHeaderSlot(slots, name, privateSlot(name)));
					}
				}
			} catch (error) { clear(); throw error; }
		};
		refresh();
		let unsubscribe;
		try { unsubscribe = slots.subscribe(source, refresh); } catch (error) { clear(); throw error; }
		return () => { unsubscribe(); clear(); };
	}));
}

export function install(ctx, { bridge, state }) {
	if (state.conversationHeaderInstalled) { return; }
	const desktop = bridge?.surface === 'full' || bridge?.surface === 'chat' && bridge.chatOnly === false;
	if (!desktop || String(bridge?.viewId || '').startsWith('dsh-desk-split-')) { return; }
	ctx.slots.inject(HEADER_SLOT, () => {
		const effects = [];
		try {
			effects.push(ctx.slots.register({
				name: HEADER_SLOT, id: 'vssaros-conversation-header', priority: -10,
				children: {
					'vssaros.conversation.header.leading': { kind: 'single', scope: 'root' },
					'vssaros.conversation.session.header': { kind: 'single', scope: 'session' },
					[ACTIONS_SLOT]: { kind: 'list', scope: 'session-maybe' },
					[BOTTOM_SLOT]: { kind: 'list', scope: 'session' },
					'vssaros.conversation.session.header.corner': { kind: 'single', scope: 'session' },
				},
			}, ConversationHeader));
			effects.push(mirrorHeaderSlot(ctx.slots, 'conversation.header.leading', privateSlot('conversation.header.leading')));
			effects.push(mirrorHeaderSlot(ctx.slots, 'conversation.session.header', privateSlot('conversation.session.header'), true));
			effects.push(mirrorHeaderSlot(ctx.slots, UTILITIES_SLOT, BOTTOM_SLOT, false, BOTTOM_ENTRY_ID));
			effects.push(mirrorHeaderSlot(ctx.slots, CORNER_SLOT, privateSlot(CORNER_SLOT)));
			effects.push(ctx.slots.register({ name: ACTIONS_SLOT, id: 'vssaros-new-window', order: 0 }, NewWindowChip));
		} catch (error) { for (const dispose of effects.reverse()) { dispose(); } throw error; }
		return () => { for (const dispose of effects.reverse()) { dispose(); } };
	});
	state.conversationHeaderInstalled = true;
}
