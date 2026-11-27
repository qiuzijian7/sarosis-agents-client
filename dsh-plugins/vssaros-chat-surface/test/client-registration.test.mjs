/*---------------------------------------------------------------------------------------------
 * Copyright (c) Saros. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import React from 'react';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const owner = '@vssaros/dsh-chat-surface';
const chunks = ['client.promptTransport.js', 'client.interactionRecovery.js', 'client.submissionControls.js'];
const { bundled } = JSON.parse(fs.readFileSync(path.join(ROOT, 'dsh-plugins/dsh-compat.json'), 'utf8'));
const result = await build({ entryPoints: [path.join(ROOT, `dsh-runtime/${bundled}/node_modules/@deepseek-ai/dsh-client-modules/src/client/system.ts`)], bundle: true, format: 'esm', platform: 'browser', write: false });
const { ClientModuleSystem } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

function fixture(mutate = value => value) {
	const window = {};
	const requests = [];
	const target = { mode: 'queue', pendingQueue: [] };
	const system = new ClientModuleSystem({
		manifest: { version: 1, modules: [{ id: owner, rev: 'test-rev', url: `/??${owner}/client.js&rev=test-rev`, external: ['react'], inject: [] }] },
		staticModules: { react: React },
		bootstrapModule: { id: '@deepseek-ai/dsh-client-modules', exports: {} },
		registrationTarget: target,
		loadBundle: async url => {
			requests.push(url);
			const name = url.match(/\/(client\.[\w.-]+\.js)\?/)?.[1];
			assert.ok(chunks.includes(name));
			const source = fs.readFileSync(path.join(ROOT, 'dsh-plugins/vssaros-chat-surface/lib', name), 'utf8');
			runInNewContext(source, { window });
		},
	});
	window.__ModuleLoader__ = { load: registration => target.load(mutate(registration)) };
	target.load({ id: owner, factory: require => ({ loadChunk: name => require.async(`./${name}`) }) });
	return { system, requests };
}

test('three critical chunks register and materialize through the actual bundled module loader', async () => {
	const f = fixture();
	const main = await f.system.import(owner);
	for (const name of chunks) {
		const first = await main.loadChunk(name);
		assert.equal(typeof first.install, 'function');
		assert.ok(first.__test);
		assert.equal(await main.loadChunk(name), first);
	}
	assert.equal(f.requests.length, 3);
});

test('the real loader rejects missing owner, wrong owner and wrong chunk instead of tests accepting any factory', async () => {
	for (const mutate of [
		value => { const { id, ...rest } = value; return rest; },
		value => ({ ...value, id: '@vssaros/wrong-owner' }),
		value => ({ ...value, chunk: 'client.wrong.js' }),
	]) {
		const f = fixture(mutate);
		const main = await f.system.import(owner);
		await assert.rejects(main.loadChunk(chunks[0]), /endsWith|without registering/);
	}
});
