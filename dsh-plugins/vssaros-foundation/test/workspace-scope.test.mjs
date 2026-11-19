// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createFoundationService } from '../lib/index.js';
import { createWorkspaceContextStore, sameWorkspaceRootPath } from '../lib/workspaceContext.js';
import { installWorkspaceRootsPrompt } from '../lib/workspacePrompt.js';
import { installMultiRootFs, withMultiRootCheckedTarget } from '../lib/fsMultiRoot.js';

const A = ['/workspaces/a', '/workspaces/a-lib'];
const B = ['/workspaces/b', '/workspaces/b-lib'];
const payload = (windowId, roots) => ({
	...(windowId === undefined ? {} : { windowId }),
	workspaceRoot: roots[0],
	roots: roots.map((root, index) => ({ path: root, name: `root-${index}`, isPrimary: index === 0 })),
});
const policyFor = (workspaceRoot, mode = 'workspace-write') => ({ mode, workspaceRoot, sessionId: 'session-a' });
const paths = roots => roots.map(root => root.path);
const seed = () => {
	const service = createFoundationService();
	service.setWorkspaceContext(payload(1, A));
	service.setWorkspaceContext(payload(2, B));
	return service;
};
const denied = () => Object.assign(new Error('original denial'), { code: 'FS_SANDBOX_DENIED' });
const fixture = () => {
	const calls = [];
	const error = denied();
	const fs = {
		ctx: { sandboxPolicy: { resolve: () => policyFor(A[0]) } },
		async checkedTarget(target, suppliedPolicy) {
			const policy = suppliedPolicy ?? this.ctx.sandboxPolicy.resolve();
			calls.push(policy);
			if (policy.mode === 'danger-full-access') { return target; }
			const file = target.displayPath;
			if (policy.mode === 'workspace-write'
				&& (file === policy.workspaceRoot || file.startsWith(policy.workspaceRoot + '/'))) {
				return { ...target, checkedWith: policy.workspaceRoot };
			}
			throw error;
		},
	};
	return { fs, calls, error };
};
const injectFs = (fs, service) => {
	let dispose;
	const ctx = {
		fs,
		inject: (dependencies, callback) => callback(ctx),
		effect: callback => { dispose = callback(); return dispose; },
	};
	assert.equal(installMultiRootFs(ctx, service), true);
	return () => dispose();
};
const injectPrompt = (service, sandboxPolicy) => {
	let section;
	const ctx = {
		sandboxPolicy,
		inject: (dependencies, callback) => {
			if (dependencies.includes('sandboxPolicy') && !sandboxPolicy) { return; }
			return callback(ctx);
		},
		effect: callback => callback(),
		systemPrompt: { context: definition => { section = definition; return () => {}; } },
	};
	assert.equal(installWorkspaceRootsPrompt(ctx, service), true);
	return section.text;
};
const promptContext = cwd => ({ agent: { session: { id: 'session-a', header: { cwd } } } });

test('store preserves each window and the legacy last-value/idempotent contract', () => {
	const store = createWorkspaceContextStore();
	let notifications = 0;
	store.onDidChange(() => notifications++);
	store.set(payload(1, A));
	store.set(payload(2, A));
	store.set(payload(3, B));
	assert.deepEqual({ windows: store.getAll().map(context => context.windowId), last: store.get().windowId, notifications },
		{ windows: [1, 2, 3], last: 3, notifications: 2 });
	assert.equal(store.set({ windowId: 1, roots: 'invalid' }), undefined);
	assert.equal(store.getAll()[0].workspaceRoot, A[0]);
	store.clear();
	assert.deepEqual([store.get(), store.getAll()], [undefined, []]);
});

test('sessions select their own context after another window pushes last', () => {
	const service = seed();
	assert.deepEqual({ legacy: paths(service.workspaceRoots()), a: paths(service.workspaceRootsFor({ policy: policyFor(A[0]) })),
		b: paths(service.workspaceRootsFor({ cwd: B[0] })), additional: paths(service.workspaceRootsFor({ cwd: A[1] })) },
		{ legacy: B, a: A, b: B, additional: A });
});

test('missing, malformed, unrelated, descendant and conflicting anchors fail closed', () => {
	const service = seed();
	const inputs = [undefined, {}, null, [], { windowId: 1 }, { workspaceId: 'a' }, { cwd: '/unknown' },
		{ cwd: A[0] + '/nested' }, { cwd: 'relative' }, { cwd: A[0] + '\0' }, { policy: null },
		{ policy: {} }, { cwd: A[0], policy: policyFor(B[0]) }, { cwd: '', policy: policyFor(A[0]) }];
	assert.deepEqual(inputs.map(input => service.workspaceRootsFor(input)), inputs.map(() => []));
});

test('shared root ownership is ambiguous even when windowId or last value suggests one window', () => {
	const service = seed();
	service.setWorkspaceContext(payload(3, [A[0], '/other/private']));
	assert.deepEqual(service.workspaceRootsFor({ cwd: A[0], windowId: 1 }), []);
	service.setWorkspaceContext({ windowId: 3 });
	assert.deepEqual(paths(service.workspaceRootsFor({ cwd: A[0] })), A);
	service.setWorkspaceContext({ windowId: 1 });
	assert.deepEqual(service.workspaceRootsFor({ cwd: A[0] }), []);
});

test('legacy payloads without windowId use an independent bucket and never silently override window ownership', () => {
	const service = seed();
	service.setWorkspaceContext(payload(undefined, A));
	assert.deepEqual(service.workspaceRootsFor({ cwd: A[0] }), []);
	service.setWorkspaceContext({});
	assert.deepEqual(paths(service.workspaceRootsFor({ cwd: A[0] })), A);
});

test('path identity handles Windows casing/separators but preserves POSIX case and rejects relative roots', () => {
	assert.deepEqual([
		sameWorkspaceRootPath('C:\\Repo\\', 'c:/repo'),
		sameWorkspaceRootPath('\\\\server\\share\\repo', '//SERVER/share/repo/'),
		sameWorkspaceRootPath('/Repo', '/repo'),
		sameWorkspaceRootPath('/repo', '/repo/nested'),
		sameWorkspaceRootPath('repo', 'repo'),
		sameWorkspaceRootPath('/repo ', '/repo'),
		sameWorkspaceRootPath('/repo\\child', '/repo/child'),
		sameWorkspaceRootPath('/repo/link/..', '/repo'),
	], [true, true, false, false, false, false, false, false]);
	const service = createFoundationService();
	service.setWorkspaceContext(payload(1, ['C:\\Repo', 'C:\\Lib']));
	assert.deepEqual(paths(service.workspaceRootsFor({ policy: policyFor('c:/repo/') })), ['C:\\Repo', 'C:\\Lib']);
});

test('invalid additional paths deny the entire scoped root set without removing ambiguous owners', () => {
	const service = seed();
	service.setWorkspaceContext(payload(1, [A[0], 'relative-additional']));
	assert.deepEqual(service.workspaceRootsFor({ cwd: A[0] }), []);
	service.setWorkspaceContext(payload(3, A));
	assert.deepEqual(service.workspaceRootsFor({ cwd: A[0] }), []);
});

test('installed prompt uses the real agent/session shape and never advertises another window', () => {
	const service = seed();
	const resolvedSessions = [];
	const text = injectPrompt(service, { resolve: ({ session }) => {
		resolvedSessions.push(session);
		return policyFor(session.header.cwd);
	} });
	const context = promptContext(A[0]);
	const first = text(context);
	assert.ok(A.every(root => first.includes(root)) && B.every(root => !first.includes(root)));
	assert.ok(first.includes('not an additional permission grant'));
	assert.equal(resolvedSessions[0], context.agent.session);
	assert.equal(text({}), '');
	assert.equal(text(promptContext('/unknown')), '');
	service.setWorkspaceContext(payload(2, [B[0], '/b-new']));
	assert.equal(text(context), first);
	service.setWorkspaceContext({ windowId: 1 });
	assert.equal(text(context), '');
});

test('prompt and fs use the same scoped resolver; conflicting policy/cwd and missing services fail closed', () => {
	const service = seed();
	const text = injectPrompt(service, { resolve: () => policyFor(B[0]) });
	assert.equal(text(promptContext(A[0])), '');
	const textWithoutPolicy = injectPrompt(service);
	assert.ok(textWithoutPolicy(promptContext(A[0])).includes(A[1]));
	assert.equal(installWorkspaceRootsPrompt({ inject() {} }, { workspaceContext() {} }), false);
	assert.equal(installMultiRootFs({ inject() {} }, { workspaceRoots() {} }), false);
});

test('prompt reads policy only from its declared injection scope and clears it on service disposal', () => {
	const service = seed();
	let definition;
	let livePolicy;
	let releasePolicy;
	let policyReads = 0;
	const injections = new Map();
	const ctx = {
		inject: (dependencies, callback) => {
			const dependency = dependencies[0];
			const child = {
				effect: effect => {
					const dispose = effect();
					if (dependency === 'sandboxPolicy') { releasePolicy = dispose; }
					return dispose;
				},
			};
			Object.defineProperty(child, 'sandboxPolicy', { get: () => {
				if (dependency !== 'sandboxPolicy') { throw new Error('undeclared sandboxPolicy dependency'); }
				policyReads++;
				return livePolicy;
			} });
			Object.defineProperty(child, 'systemPrompt', { get: () => {
				if (dependency !== 'systemPrompt') { throw new Error('undeclared systemPrompt dependency'); }
				return { context: value => { definition = value; return () => {}; } };
			} });
			injections.set(dependency, () => callback(child));
			if (dependency === 'systemPrompt') { callback(child); }
		},
	};
	assert.equal(installWorkspaceRootsPrompt(ctx, service), true);
	assert.ok(definition.text(promptContext(A[0])).includes(A[1]));
	livePolicy = { resolve: () => policyFor(B[0]) };
	injections.get('sandboxPolicy')();
	assert.equal(definition.text(promptContext(A[0])), '');
	releasePolicy();
	assert.ok(definition.text(promptContext(A[0])).includes(A[1]));
	livePolicy = { resolve: () => policyFor(A[0]) };
	injections.get('sandboxPolicy')();
	assert.ok(definition.text(promptContext(A[0])).includes(A[1]));
	assert.equal(policyReads, 2);
});

test('installed fs passes the real call policy and limits canonical retries to the session window', async () => {
	const service = seed();
	const { fs, calls, error } = fixture();
	const original = fs.checkedTarget;
	const dispose = injectFs(fs, service);
	const policy = policyFor(A[0]);
	assert.equal((await fs.checkedTarget({ displayPath: A[1] + '/file' }, policy)).checkedWith, A[1]);
	assert.deepEqual(calls.map(call => [call.workspaceRoot, call.mode, call.sessionId]),
		A.map(root => [root, 'workspace-write', 'session-a']));
	calls.length = 0;
	await assert.rejects(fs.checkedTarget({ displayPath: B[1] + '/file' }, policy), thrown => thrown === error);
	assert.deepEqual(calls.map(call => call.workspaceRoot), A);
	dispose();
	assert.equal(fs.checkedTarget, original);
});

test('fs keeps read-only/full-access/missing-policy behavior and never retries unrelated or ambiguous roots', async () => {
	const service = seed();
	const { fs, calls, error } = fixture();
	injectFs(fs, service);
	for (const policy of [undefined, policyFor(A[0], 'read-only'), policyFor('/unknown'), policyFor(A[0] + '/nested')]) {
		calls.length = 0;
		await assert.rejects(fs.checkedTarget({ displayPath: A[1] + '/file' }, policy), thrown => thrown === error);
		assert.equal(calls.length, 1);
	}
	calls.length = 0;
	const target = { displayPath: '/outside/file' };
	assert.equal(await fs.checkedTarget(target, policyFor(A[0], 'danger-full-access')), target);
	assert.equal(calls.length, 1);
	service.setWorkspaceContext(payload(3, [A[0], '/private']));
	calls.length = 0;
	await assert.rejects(fs.checkedTarget({ displayPath: A[1] + '/file' }, policyFor(A[0])), thrown => thrown === error);
	assert.equal(calls.length, 1);
});

test('non-sandbox errors and resolver failures keep the original error without widening', async () => {
	const ioError = Object.assign(new Error('I/O failure'), { code: 'FS_IO_ERROR' });
	let lookedUp = false;
	const wrapped = withMultiRootCheckedTarget(async () => { throw ioError; }, () => { lookedUp = true; return []; });
	await assert.rejects(wrapped({}, policyFor(A[0])), thrown => thrown === ioError);
	assert.equal(lookedUp, false);
	const error = denied();
	const throwing = withMultiRootCheckedTarget(async () => { throw error; }, () => { throw new Error('unavailable'); });
	await assert.rejects(throwing({}, policyFor(A[0])), thrown => thrown === error);
});

test('actual rc.2 sandbox policy and provider enforce the scoped roots without modifying files',
	{ skip: !process.env.DSH_RUNTIME_NM && 'set DSH_RUNTIME_NM to run the upstream contract test' }, async () => {
		const moduleOf = name => pathToFileURL(path.join(process.env.DSH_RUNTIME_NM, '@deepseek-ai', name, 'lib', 'index.js')).href;
		const { SandboxedFileSystem } = await import(moduleOf('dsh-fs-sandbox'));
		const { SandboxPolicyService } = await import(moduleOf('dsh-sandbox-policy'));
		const base = path.join(process.cwd(), '__vssaros_scope_fixture__');
		const a = [path.join(base, 'a'), path.join(base, 'a-lib')];
		const b = [path.join(base, 'b'), path.join(base, 'b-lib')];
		const service = createFoundationService();
		service.setWorkspaceContext(payload(1, a));
		service.setWorkspaceContext(payload(2, b));
		const session = { id: 'real-policy-session', header: { cwd: a[0] } };
		const policyService = Object.assign(Object.create(SandboxPolicyService.prototype), {
			workspaceRoot: b[0], defaultMode: 'read-only', overrideOf: () => 'workspace-write',
			writableRootRegistrations: new WeakMap(),
		});
		const policy = policyService.resolve({ session });
		assert.deepEqual(policy, { mode: 'workspace-write', workspaceRoot: a[0], sessionId: session.id });
		const fs = { checkedTarget: SandboxedFileSystem.prototype.checkedTarget,
			resolve: async displayPath => ({ displayPath, targetKey: displayPath }) };
		injectFs(fs, service);
		const own = { displayPath: path.join(a[1], 'file.txt') };
		assert.equal((await fs.checkedTarget(own, policy)).targetKey, own.displayPath);
		await assert.rejects(fs.checkedTarget({ displayPath: path.join(b[1], 'file.txt') }, policy),
			thrown => thrown.code === 'FS_SANDBOX_DENIED');
	});
