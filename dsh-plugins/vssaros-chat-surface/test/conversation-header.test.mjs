/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const React = await import('react');
const jsx = await import('react/jsx-runtime');
const { createRoot } = await import('react-dom/client');
let definition;
window.__ModuleLoader__ = { load: value => { definition = value; } };
new Function('window', 'document', readFileSync(new URL('../lib/client.conversationHeader.js', import.meta.url), 'utf8'))(window, document);
const header = definition.factory(name => {
	if (name === 'react') { return React; }
	if (name === 'react/jsx-runtime') { return jsx; }
	throw new Error(`Unexpected shared module: ${name}`);
});
const el = React.createElement;
const prefix = 'vssaros.';
const sourceCorner = 'conversation.session.header.corner';

function fixture(bridge = { surface: 'full' }) {
	const records = new Map();
	const declarations = new Map([['conversation.header', { kind: 'single', scope: 'session-maybe' }]]);
	const subscriptions = new Map();
	const effects = [];
	let sessionId;
	let session;
	const conversation = { activeTargets: new Set() };
	let layout = { expanded: false };
	const layoutListeners = new Set();
	const store = {
		getSnapshot: () => layout,
		subscribe: fn => { layoutListeners.add(fn); return () => layoutListeners.delete(fn); },
		actions: { setExpanded: value => { layout = { expanded: value }; for (const fn of layoutListeners) { fn(); } } },
	};
	const notify = name => { for (const fn of subscriptions.get(name) || []) { fn(); } };
	const slots = {
		entries: name => records.get(name) || [],
		subscribe: (name, fn) => {
			const set = subscriptions.get(name) || new Set(); subscriptions.set(name, set); set.add(fn);
			return () => set.delete(fn);
		},
		inject: (name, fn) => {
			assert.ok(declarations.has(name), `Missing declaration: ${name}`);
			return fn();
		},
		register: (options, component) => {
			assert.ok(declarations.has(options.name), `Missing registration target: ${options.name}`);
			for (const [name, spec] of Object.entries(options.children || {})) {
				assert.ok(!declarations.has(name), `Duplicate child owner: ${name}`);
				declarations.set(name, spec);
			}
			const entry = { options, component, children: options.children, store: options.store, locale: options.locale, inject: options.inject };
			records.set(options.name, [...slots.entries(options.name), entry]);
			notify(options.name);
			let live = true;
			return () => {
				if (!live) { return; } live = false;
				records.set(options.name, slots.entries(options.name).filter(value => value !== entry));
				for (const name of Object.keys(options.children || {})) { declarations.delete(name); }
				notify(options.name);
			};
		},
	};
	function declare(name, spec) { declarations.set(name, spec); }
	function official(options, component) { declare(options.name, { kind: 'single', scope: 'session' }); return slots.register(options, component); }
	const childNames = ['lineage', 'actions', 'utilities', 'corner', 'views.actions'];
	const children = Object.fromEntries(childNames.map(name => [`conversation.session.header.${name}`, { kind: name === 'corner' || name === 'lineage' ? 'single' : 'list', scope: name === 'views.actions' ? 'root' : 'session' }]));
	official({ name: 'conversation.session.header', locale: 'conversation', children, inject: id => ({ injectedSession: id }) }, props => {
		assert.strictEqual(props.injectedSession, sessionId);
		return el(React.Fragment, null,
			el('div', { 'data-session-title': '', style: { gridColumn: 2 } }, !props.hideChrome && '会话标题', !props.hideChrome && props.renderSlot('conversation.session.header.utilities', {}), props.renderSlot(sourceCorner, {})),
			!props.hideChrome && el('nav', { 'data-conversation-tabs': '' }, '会话页签'));
	});
	declare('conversation.header.leading', { kind: 'single', scope: 'root' });
	declare('navigation.extra', { kind: 'list', scope: 'root' });
	const leading = slots.register({ name: 'conversation.header.leading', children: { 'navigation.nested': { kind: 'list', scope: 'root' } } }, props => el('div', { 'data-leading': '' }, props.renderSlot('navigation.nested', {})));
	slots.register({ name: 'navigation.nested', id: 'nested', order: 0 }, () => el('span', { 'data-nested': '' }, '导航'));
	slots.register({ name: sourceCorner, id: 'official-expand', locale: 'sidebarRight', store, inject: (id, actions) => ({ officialSession: id, setExpanded: actions.setExpanded }) }, props => {
		assert.strictEqual(props.officialSession, sessionId);
		assert.strictEqual(props.t('expand'), '打开侧边栏');
		return props.useStore(value => value.expanded) ? null : el('button', { 'data-sidebar-right-expand': '', onClick: () => props.setExpanded(true) }, props.t('expand'));
	});
	slots.register({ name: 'conversation.session.header.utilities', id: 'history', order: -3 }, () => el('button', { 'data-history': '' }, '历史'));
	let bottomOpen = false;
	slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-better-sidebar:bottom-toggle', order: 10 }, () => el('button', {
		'data-dsh-bottom-toggle': '', 'aria-label': '展开底部面板', onClick: () => { bottomOpen = !bottomOpen; },
	}));
	const ctx = { slots };
	const shell = { bridge, state: {} };
	const originalInject = slots.inject;
	slots.inject = (name, fn) => {
		const dispose = originalInject(name, fn);
		if (name === 'conversation.header') { effects.push(dispose); }
		return dispose;
	};
	const mount = document.createElement('div'); document.body.appendChild(mount);
	const root = createRoot(mount);
	function Bound({ entry, owner }) {
		const spec = declarations.get(entry.options.name);
		const scopedId = spec.scope === 'root' ? undefined : sessionId;
		const injected = entry.inject?.(...(scopedId === undefined ? [] : [scopedId]), ...(entry.store ? [entry.store.actions] : [])) || {};
		const props = {
			...owner, ...injected, sessionId: scopedId,
			useSession: select => select(session), useConversation: select => select(conversation),
			t: key => entry.locale === 'sidebarRight' && key === 'expand' ? '打开侧边栏' : key,
			actions: entry.store?.actions,
			useStore: select => select(React.useSyncExternalStore(entry.store.subscribe, entry.store.getSnapshot)),
			renderSlot: (name, values) => {
				assert.ok(entry.children?.[name], `Unauthorized child: ${name}`);
				return renderSlot(name, values);
			},
		};
		return el(entry.component, props);
	}
	function renderSlot(name, owner = {}) {
		const spec = declarations.get(name);
		if (spec.scope === 'session' && sessionId === undefined) { return null; }
		let entries = slots.entries(name);
		if (spec.kind === 'single') { entries = [...entries].sort((a, b) => (a.options.priority || 0) - (b.options.priority || 0)).slice(0, 1); }
		return el('div', { 'data-slot': name, style: { display: 'contents' } },
			entries.map((entry, index) => el(Bound, { entry, owner, key: entry.options.id || index })));
	}
	return {
		ctx, shell, slots, mount, store, leading,
		bottomOpen: () => bottomOpen,
		install: () => header.install(ctx, shell),
		show: async (id, blank = true) => {
			sessionId = id; session = id === undefined ? undefined : { blank, awaitingFirstTurn: false, running: false };
			await React.act(async () => { root.render(el(React.Fragment, null, renderSlot('conversation.header'))); });
		},
		close: async () => { await React.act(async () => root.unmount()); for (const dispose of effects.reverse()) { dispose(); } mount.remove(); },
	};
}

test('真正无会话的 Hero 也有唯一分屏按钮，无伪造的官方 Session 控件', async () => {
	const f = fixture(); f.install();
	try {
		await f.show(undefined);
		assert.strictEqual(f.mount.querySelectorAll('[data-vssaros-new-window]').length, 1);
		assert.ok(f.mount.querySelector('[data-vssaros-conversation-header-actions] [data-vssaros-new-window]'));
		assert.ok(!f.mount.querySelector('[data-sidebar-right-expand]'));
		assert.ok(f.mount.querySelector('[data-nested]'));
	} finally { await f.close(); }
});

test('绑定空会话到 active 保留同一颗按钮，官方侧栏与历史入口不重复', async () => {
	const f = fixture(); f.install();
	try {
		await f.show('session-1');
		const button = f.mount.querySelector('[data-vssaros-new-window]');
		const actions = button.closest('[data-vssaros-conversation-header-actions]');
		assert.deepStrictEqual([...actions.querySelectorAll('button')].map(node => node.hasAttribute('data-vssaros-new-window') ? 'split' : node.hasAttribute('data-dsh-bottom-toggle') ? 'bottom' : 'right'), ['split', 'bottom', 'right']);
		assert.strictEqual(button.textContent, '');
		assert.ok(button.querySelector('svg[aria-hidden="true"]'));
		assert.strictEqual(button.getAttribute('aria-label'), '新增窗口');
		assert.ok(!f.mount.querySelector('[data-dsh-dock-fallback]'));
		await f.show('session-1', false);
		assert.strictEqual(f.mount.querySelector('[data-vssaros-new-window]'), button);
		assert.strictEqual(f.mount.querySelectorAll('[data-sidebar-right-expand]').length, 1);
		assert.strictEqual(f.mount.querySelectorAll('[data-history]').length, 1);
		assert.strictEqual(f.mount.querySelectorAll('[data-dsh-bottom-toggle]').length, 1);
		assert.ok(!f.mount.querySelector('[data-session-title] [data-dsh-bottom-toggle]'));
		await React.act(async () => f.mount.querySelector('[data-dsh-bottom-toggle]').click());
		assert.strictEqual(f.bottomOpen(), true);
		assert.ok(f.mount.querySelector('[data-conversation-tabs]'));
		assert.strictEqual(button.style.position, '');
	} finally { await f.close(); }
});

test('打开侧栏仅改变官方控件状态，不更换分屏按钮的父容器或写坐标', async () => {
	const f = fixture(); f.install();
	try {
		await f.show('session-2');
		const button = f.mount.querySelector('[data-vssaros-new-window]'); const parent = button.parentElement;
		await React.act(async () => f.mount.querySelector('[data-sidebar-right-expand]').click());
		assert.strictEqual(f.mount.querySelector('[data-vssaros-new-window]'), button);
		assert.strictEqual(button.parentElement, parent);
		assert.ok(!f.mount.querySelector('[data-sidebar-right-expand]'));
		assert.deepStrictEqual([button.style.position, button.style.top, button.style.right], ['', '', '']);
		await React.act(async () => f.store.actions.setExpanded(false));
		assert.strictEqual(f.mount.querySelectorAll('[data-sidebar-right-expand]').length, 1);
	} finally { await f.close(); }
});

test('镜像保留官方 store / locale / inject，源贡献更新后同步并清理私有声明', async () => {
	const f = fixture(); f.install();
	try {
		const original = f.slots.entries(sourceCorner)[0]; const mirrored = f.slots.entries(prefix + sourceCorner)[0];
		assert.strictEqual(mirrored.store, original.store); assert.strictEqual(mirrored.locale, original.locale); assert.strictEqual(mirrored.inject, original.inject);
		f.slots.register({ name: 'conversation.session.header.utilities', id: 'additional', order: 0 }, () => el('i', { 'data-additional': '' }));
		await f.show('session-3', false);
		assert.strictEqual(f.mount.querySelectorAll('[data-additional]').length, 1);
	} finally { await f.close(); }
	assert.strictEqual(f.slots.entries(prefix + sourceCorner).length, 0);
	assert.strictEqual(f.slots.entries(sourceCorner).length, 1);
});

test('重复 install / 重绑不重复注册，chat-only、独立格子、工作台 surface 排除', async () => {
	for (const bridge of [{ surface: 'chat', chatOnly: true }, { surface: 'full', viewId: 'dsh-desk-split-1' }, { surface: 'workbench' }]) {
		const f = fixture(bridge); f.install();
		try { assert.strictEqual(f.slots.entries(header.ACTIONS_SLOT).length, 0); } finally { await f.close(); }
	}
	const f = fixture({ surface: 'chat', chatOnly: false }); f.install(); f.install();
	try { assert.strictEqual(f.slots.entries(header.ACTIONS_SLOT).length, 1); } finally { await f.close(); }
});

test('切到非会话页面不留下根浮层入口', async () => {
	const f = fixture(); f.install();
	try { await f.show('session-4'); } finally { await f.close(); }
	assert.ok(!document.querySelector('[data-vssaros-new-window]'));
	assert.ok(!document.querySelector('[data-vssaros-hero-split-host]'));
});

test('分屏桥只调用一次，异步失败和旧宿主仍反馈诊断与警告', async () => {
	let called = 0; const notes = [];
	window.__vssarosChatSurface = {};
	window.vssarosDsh = { splitChatPane: () => { called++; return Promise.reject(new Error('窗口宽度不足')); }, notify: (...args) => notes.push(args) };
	header.NewWindowChip().props.onClick(); await Promise.resolve();
	assert.strictEqual(called, 1);
	assert.strictEqual(window.__vssarosChatSurface.newWindowEntry, 'failed');
	assert.match(notes[0][1], /窗口宽度不足/);
	window.vssarosDsh = { bridgeVersion: 21, notify: (...args) => notes.push(args) };
	header.NewWindowChip().props.onClick();
	assert.strictEqual(window.__vssarosChatSurface.newWindowEntry, 'unsupported');
	assert.match(notes[1][1], /不支持/);
});

test('常驻动作样式采用 Flex，入口源码不再含测量、轮询或全局选择器', () => {
	const css = document.querySelector('[data-vssaros-conversation-header-style]').textContent;
	assert.match(css, /grid-column:3;grid-row:1;display:flex;align-items:center;gap:8px/);
	assert.match(css, /\[data-slot="vssaros\.conversation\.session\.header"\]>:first-child\{grid-column:2;grid-row:1/);
	assert.match(css, /width:28px;height:28px;padding:0;border:none/);
	const source = readFileSync(new URL('../src/conversationHeader.js', import.meta.url), 'utf8');
	assert.ok(!/getBoundingClientRect|querySelector|setInterval|position:\s*['"](?:absolute|fixed)/.test(source));
});
