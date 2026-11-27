/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { registerPageRouteOnce as loop } from '../vssaros-loop/lib/index.js';
import { registerPageRouteOnce as marketplace } from '../vssaros-marketplace/lib/index.js';
import { registerPageRouteOnce as scheduler } from '../vssaros-scheduler/lib/index.js';

function server() {
	const routes = new Map();
	let calls = 0;
	return {
		routes, get calls() { return calls; },
		register(route) {
			const key = `${route.kind}:${route.path}`;
			assert.ok(!routes.has(key), 'duplicate prefix');
			calls++; routes.set(key, route);
			return () => routes.delete(key);
		},
	};
}
const route = (handler, path = '/x/test', kind = 'prefix') => ({ kind, path, handler });

for (const [name, register] of [['loop', loop], ['marketplace', marketplace], ['scheduler', scheduler]]) {
	test(`${name}: host/persona share one route; handler survives either disposal order`, () => {
		for (const ownerFirst of [true, false]) {
			const webServer = server();
			const a = register({ webServer }, route(() => 'host-auth'));
			const b = register({ webServer }, route(() => 'persona-auth'));
			assert.equal(webServer.calls, 1);
			assert.equal(webServer.routes.get('prefix:/x/test').handler(), 'host-auth');
			(ownerFirst ? a : b)();
			assert.equal(webServer.routes.get('prefix:/x/test').handler(), ownerFirst ? 'persona-auth' : 'host-auth');
			(ownerFirst ? b : a)();
			assert.equal(webServer.routes.size, 0);
			const c = register({ webServer }, route(() => 'new-auth'));
			a(); b();
			assert.equal(webServer.routes.get('prefix:/x/test').handler(), 'new-auth');
			c();
		}
	});

	test(`${name}: different servers and route kinds are isolated`, () => {
		const a = server(); const b = server();
		const off = [register({ webServer: a }, route(() => 1)), register({ webServer: b }, route(() => 2)), register({ webServer: a }, route(() => 3, '/x/test', 'exact'))];
		assert.equal(a.routes.size, 2); assert.equal(b.routes.size, 1);
		for (const dispose of off) { dispose(); }
	});

	test(`${name}: failed registration leaves no ownership reservation`, () => {
		const webServer = server();
		const original = webServer.register;
		webServer.register = () => { throw new Error('register failed'); };
		assert.throws(() => register({ webServer }, route(() => 1)), /register failed/);
		webServer.register = original;
		const off = register({ webServer }, route(() => 2));
		assert.equal(webServer.routes.size, 1); off();
	});
}

test('independently loaded helper copies share a Cordis underlying service, not traced proxies', () => {
	const base = server();
	const trace = () => new Proxy(base, { get(target, key) { return key === Symbol.for('cordis.original') ? target : Reflect.get(target, key); } });
	const a = loop({ webServer: trace() }, route(() => 'a'));
	const b = marketplace({ webServer: trace() }, route(() => 'b'));
	const c = scheduler({ webServer: trace() }, route(() => 'c'));
	assert.equal(base.calls, 1);
	a(); assert.equal(base.routes.get('prefix:/x/test').handler(), 'b');
	b(); assert.equal(base.routes.get('prefix:/x/test').handler(), 'c');
	c(); assert.equal(base.routes.size, 0);
});

test('three actual page effects use the guard; tools and optional injections stay intact', () => {
	for (const name of ['loop', 'marketplace', 'scheduler']) {
		const source = readFileSync(new URL(`../vssaros-${name}/lib/index.js`, import.meta.url), 'utf8');
		assert.match(source, /inject\(\['webServer', 'connection'\], \w+ => \w+\.effect\(\(\) => registerPageRouteOnce\(/);
		assert.match(source, /requestRejection\(req\)/);
		assert.ok(name === 'scheduler' ? source.includes('registerScheduleTools') : source.includes('tools.register'));
	}
});

test('helper works with the actual rc.5 WebServer register/disposer without opening a port', async () => {
	const { WebServer } = await import('../../dsh-runtime/0.2.2-rc.5/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js');
	const webServer = { exact: new Map(), prefixes: new Map(), register: WebServer.prototype.register };
	const a = loop({ webServer }, route(() => 'host'));
	const b = loop({ webServer }, route(() => 'persona'));
	assert.equal(webServer.prefixes.size, 1);
	a(); assert.equal(webServer.prefixes.get('/x/test').handler(), 'persona');
	b(); assert.equal(webServer.prefixes.size, 0);
});
