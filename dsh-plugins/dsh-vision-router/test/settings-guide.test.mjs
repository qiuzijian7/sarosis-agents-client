/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function createGuide(t) {
	const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
		url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
	});
	t.after(() => {
		try { plugin?.finishVisionSettingsGuide(); } finally { dom.window.close(); }
	});
	const { window } = dom;
	const { document } = window;
	window.HTMLElement.prototype.getBoundingClientRect = function () {
		return { x: 20, y: 50, left: 20, top: 50, right: 200, bottom: 82, width: 180, height: 32 };
	};
	const frames = new Map();
	let frameId = 0;
	window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
	window.cancelAnimationFrame = id => frames.delete(id);
	let plugin;
	window.__ModuleLoader__ = {
		load: chunk => {
			plugin = chunk.factory(name => {
				if (name === 'react' || name === '@deepseek-ai/dsh-client-ui-attachment') { return {}; }
				throw new Error(`Unexpected module: ${name}`);
			});
		},
	};
	window.eval(source);
	const next = () => document.querySelector('.vr-guide-prompt .vr-btn-save');
	const phase = () => document.querySelector('.vr-guide-prompt')?.dataset.vrPhase;
	const settle = async () => {
		for (let i = 0; i < 4; i++) {
			await Promise.resolve();
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) { callback(); }
		}
	};
	const startStep2 = async () => {
		plugin.startVisionSettingsGuide(key => key);
		next().click();
		await settle();
	};
	return { window, document, plugin, next, phase, settle, startStep2 };
}

function installAccountMenu(guide) {
	const { document } = guide;
	const trigger = document.createElement('button');
	trigger.dataset.vssarosAccountTrigger = '1';
	document.body.append(trigger);
	const counts = { launch: 0, settings: 0, outside: 0, vision: 0 };
	const open = () => {
		counts.launch++;
		const menu = document.createElement('div');
		menu.dataset.vssarosAccountMenu = '1';
		menu.setAttribute('role', 'menu');
		const settings = document.createElement('div');
		settings.dataset.vssarosAccountItem = 'settings';
		settings.setAttribute('role', 'menuitem');
		settings.innerHTML = '<span>⚙</span><span>设置</span><span>Ctrl+,</span>';
		const outside = event => {
			if (!menu.contains(event.target)) { counts.outside++; close(); }
		};
		const close = () => {
			menu.remove();
			document.removeEventListener('mousedown', outside, true);
		};
		settings.addEventListener('click', () => {
			counts.settings++;
			close();
			const panel = document.createElement('div');
			panel.setAttribute('role', 'dialog');
			panel.setAttribute('aria-modal', 'true');
			panel.innerHTML = '<nav><button>Vision Router</button></nav>';
			panel.querySelector('button').addEventListener('click', () => {
				counts.vision++;
				const target = document.createElement('div');
				target.dataset.vrGuideTarget = 'vision-backend';
				panel.append(target);
			});
			document.body.append(panel);
		});
		menu.append(settings);
		document.body.append(menu);
		document.addEventListener('mousedown', outside, true);
	};
	trigger.addEventListener('click', open);
	return { trigger, counts, open };
}

test('custom account launcher advances through Settings to the vision model', async t => {
	const guide = createGuide(t);
	const account = installAccountMenu(guide);
	await guide.startStep2();
	assert.equal(guide.phase(), 'launcher');
	guide.next().click();
	await guide.settle();
	assert.equal(guide.phase(), 'menu');
	const pointer = new guide.window.Event('pointerdown', { bubbles: true, cancelable: true });
	guide.next().dispatchEvent(pointer);
	assert.equal(pointer.defaultPrevented, true);
	guide.next().click();
	await guide.settle();
	assert.equal(guide.phase(), 'nav');
	guide.next().click();
	await guide.settle();
	assert.deepEqual({ ...account.counts, state: guide.plugin.guideState(), prompt: guide.phase() }, {
		launch: 1, settings: 1, outside: 0, vision: 1, state: guide.plugin.GUIDE_STATE.VISION_MODEL, prompt: undefined,
	});
});

test('an already-open custom account menu is recognized without launcher ARIA attributes', async t => {
	const guide = createGuide(t);
	const account = installAccountMenu(guide);
	account.open();
	await guide.startStep2();
	assert.equal(guide.phase(), 'menu');
	guide.next().click();
	await guide.settle();
	assert.deepEqual(account.counts, { launch: 1, settings: 1, outside: 0, vision: 0 });
});

test('Next uses live menu state before the prompt has resynchronized', async t => {
	const guide = createGuide(t);
	const account = installAccountMenu(guide);
	await guide.startStep2();
	account.open();
	assert.equal(guide.phase(), 'launcher');
	const next = guide.next();
	const pointer = new guide.window.Event('pointerdown', { bubbles: true, cancelable: true });
	next.dispatchEvent(pointer);
	assert.equal(pointer.defaultPrevented, true);
	next.click();
	await guide.settle();
	assert.deepEqual(account.counts, { launch: 1, settings: 1, outside: 0, vision: 0 });
	assert.equal(guide.phase(), 'nav');
});

test('legacy account menus support non-button menuitems', async t => {
	const guide = createGuide(t);
	guide.document.body.innerHTML = '<div data-slot="sidebar.settings"><button aria-haspopup="menu" aria-expanded="true"></button></div><div role="menu"><div role="menuitem">Settings</div></div>';
	let opened = 0;
	guide.document.querySelector('[role="menuitem"]').addEventListener('click', () => { opened++; });
	await guide.startStep2();
	assert.equal(guide.phase(), 'menu');
	guide.next().click();
	assert.equal(opened, 1);
});

test('legacy direct Settings launchers remain supported', async t => {
	const guide = createGuide(t);
	guide.document.body.innerHTML = '<div data-slot="sidebar.settings"><button aria-haspopup="dialog">Settings</button></div>';
	let opened = 0;
	guide.document.querySelector('button').addEventListener('click', () => { opened++; });
	await guide.startStep2();
	assert.equal(guide.phase(), 'launcher');
	guide.next().click();
	assert.equal(opened, 1);
});

test('a Host first-run notice is not mistaken for the Settings panel', async t => {
	const guide = createGuide(t);
	const notice = guide.document.createElement('div');
	notice.setAttribute('role', 'dialog');
	notice.setAttribute('aria-modal', 'true');
	notice.innerHTML = '<h2>预览版说明</h2><button>继续</button>';
	guide.document.body.append(notice);
	await guide.startStep2();
	assert.equal(guide.phase(), 'blocked');
	guide.next().click();
	await guide.settle();
	assert.equal(guide.phase(), 'blocked');
	assert.equal(guide.document.querySelector('.vr-guide-prompt-body')?.textContent, 'guideBlockedBody');
	notice.remove();
	await guide.settle();
	assert.equal(guide.phase(), 'launcher');
	assert.equal(guide.document.querySelector('.vr-guide-prompt-body')?.textContent, 'guidePromptLauncherBody');
});

test('Next reports a failure when the Settings nav has no Vision Router row', async t => {
	const guide = createGuide(t);
	await guide.startStep2();
	const panel = guide.document.createElement('div');
	panel.setAttribute('role', 'dialog');
	panel.setAttribute('aria-modal', 'true');
	panel.innerHTML = '<nav><button>General</button><button>Models</button></nav>';
	guide.document.body.append(panel);
	await guide.settle();
	assert.equal(guide.phase(), 'nav');
	guide.next().click();
	await guide.settle();
	assert.equal(guide.phase(), 'nav');
	assert.equal(guide.document.querySelector('.vr-guide-prompt-body')?.textContent, 'guideBlockedBody');
});
