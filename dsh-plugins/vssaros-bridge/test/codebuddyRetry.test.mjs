import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildRouteProfile, sameProfile, writeOwnedRoute } from '../lib/providerProfile.js';
import { codebuddyRouteEntry } from '../lib/codebuddy.js';

const load = () => import('../lib/codebuddyRetry.js');
const errorChunk = (retryAfter = 20, extra = {}) => ({ type: 'finish', reason: { kind: 'error', failure: {
	message: `500 ${JSON.stringify({ retry_policy: { retry: true, retry_after: retryAfter } })}`,
	code: 'SERVER', ...extra,
} } });
const options = (extra = {}) => ({ provider: 'vssaros-codebuddy', ...extra });
const streamOf = (...chunks) => (async function* () { yield* chunks; })();
const drain = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };

test('CodeBuddy route persists a bounded retry policy and upgrades an old profile exactly once', async () => {
	const entry = codebuddyRouteEntry({ baseURL: 'https://example.invalid/v1', accessToken: 'fake-token', models: [{ id: 'test' }] });
	assert.deepEqual(entry.retryPolicy, { mode: 'normal', backoff: { maxDelayMs: 30_000 } });
	const wanted = buildRouteProfile(entry);
	assert.deepEqual(wanted.retryPolicy, entry.retryPolicy);
	const old = { ...wanted }; delete old.retryPolicy;
	assert.equal(sameProfile(wanted, old), false);
	let saved = old, writes = 0;
	const settings = {
		describe: () => [{ ns: 'llm-pi-ai', revision: writes, value: { providers: { 'vssaros-codebuddy': saved } } }],
		mutate: async (_ns, ops) => { writes++; saved = structuredClone(ops[0].value); },
	};
	assert.equal((await writeOwnedRoute(settings, 'vssaros-codebuddy', wanted)).changed, true);
	assert.equal((await writeOwnedRoute(settings, 'vssaros-codebuddy', wanted)).changed, false);
	assert.equal(writes, 1);
	const normalized = { ...wanted, retryPolicy: { mode: 'normal', maxRetries: 5,
		retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
		backoff: { initialDelayMs: 500, maxDelayMs: 30_000, jitterRatio: 0.1 } } };
	assert.equal(sameProfile(wanted, normalized), true);
	assert.equal(sameProfile(wanted, { ...normalized, retryPolicy: { ...normalized.retryPolicy, backoff: { ...normalized.retryPolicy.backoff, maxDelayMs: 10_000 } } }), false);
	assert.equal(sameProfile(buildRouteProfile({ api: 'openai-completions', models: [] }), buildRouteProfile({ api: 'openai-completions', models: [] })), true);
});

test('middleware enriches only the target error finish, without mutating chunks or requesting twice', async () => {
	const { codebuddyRetryListener } = await load();
	const chunk = errorChunk(), delta = { type: 'text-delta', text: 'partial' };
	Object.freeze(chunk.reason.failure); Object.freeze(chunk.reason); Object.freeze(chunk);
	let requests = 0;
	const seen = await drain(codebuddyRetryListener(options(), () => { requests++; return streamOf(delta, chunk); }));
	assert.equal(requests, 1); assert.equal(seen[0], delta);
	assert.deepEqual(seen[1], { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, providerRetryAfterMs: 20_000 } } });
	assert.equal(chunk.reason.failure.providerRetryAfterMs, undefined);
	const inner = streamOf(chunk);
	assert.equal(codebuddyRetryListener(options({ provider: 'other' }), () => inner), inner);
	const promise = Promise.resolve(streamOf(chunk));
	assert.equal((await drain(codebuddyRetryListener(options(), () => promise)))[0].reason.failure.providerRetryAfterMs, 20_000);
});

test('invalid, missing or truncated hints pass through, and existing valid provider hints win', async () => {
	const { codebuddyRetryListener } = await load();
	for (const retryAfter of [0, -1, '20', null, false, 3e20]) {
		const chunk = errorChunk(retryAfter);
		assert.equal((await drain(codebuddyRetryListener(options(), () => streamOf(chunk))))[0], chunk);
	}
	for (const message of ['500 {"retry_policy":', '500 unrelated', '500 {"retry_policy":{"retry":false,"retry_after":20}}',
		'400 {"retry_policy":{"retry_after":20}}', '{"retry_policy":{"retry_after":20}}']) {
		const chunk = errorChunk(); chunk.reason.failure.message = message;
		assert.equal((await drain(codebuddyRetryListener(options(), () => streamOf(chunk))))[0], chunk);
	}
	const existing = errorChunk(20, { providerRetryAfterMs: 25_000 });
	assert.equal((await drain(codebuddyRetryListener(options(), () => streamOf(existing))))[0], existing);
	const success = { type: 'finish', reason: { kind: 'stop' } };
	assert.equal((await drain(codebuddyRetryListener(options(), () => streamOf(success))))[0], success);
});

test('rate-limited failures wait for the upstream cooldown even when the relay forwards plain text', async () => {
	const { codebuddyRetryListener } = await load();
	const failure = (message, extra = {}) => ({ type: 'finish', reason: { kind: 'error', failure: {
		message, code: 'RATE_LIMIT', ...extra,
	} } });
	const delayOf = async chunk => (await drain(codebuddyRetryListener(options(), () => streamOf(chunk))))[0]
		.reason.failure.providerRetryAfterMs;
	assert.equal(await delayOf(failure('429 Too Many Requests')), 30_000);
	assert.equal(await delayOf(failure('relay error: too many requests')), 30_000);
	assert.equal(await delayOf(failure('503 model busy', { code: 'SERVER', status: 429 })), 30_000);
	assert.equal(await delayOf(failure(JSON.stringify({
		code: 14003, msg: 'too many requests', retry_policy: { retry: true, retry_after: 45 },
	}))), 45_000);
	assert.equal(await delayOf(failure(JSON.stringify({
		error: { message: '429 Too Many Requests', retry_policy: { retry_after: 12 } },
	}))), 12_000);
	assert.equal(await delayOf(failure('429 {"retry_policy":{"retry":false,"retry_after":20}}')), undefined);
	assert.equal(await delayOf(failure('503 Service Unavailable', { code: 'SERVER' })), undefined);
	assert.equal(await delayOf(failure('429 Too Many Requests', { providerRetryAfterMs: 25_000 })), 25_000);
});

test('middleware preserves failures and closes the upstream iterator on consumer cancellation', async () => {
	const { codebuddyRetryListener } = await load();
	const error = new Error('transport failed');
	await assert.rejects(drain(codebuddyRetryListener(options(), () => Promise.reject(error))), e => e === error);
	let closed = 0;
	const inner = (async function* () { try { yield { type: 'text-delta', text: 'first' }; throw error; } finally { closed++; } })();
	for await (const _chunk of codebuddyRetryListener(options(), () => inner)) break;
	assert.equal(closed, 1);
	const controller = new AbortController(); controller.abort(error);
	await assert.rejects(drain(codebuddyRetryListener(options({ signal: controller.signal }), () => streamOf(errorChunk()))), e => e === error);
});

test('cancellation interrupts a still pending Promise stream', async t => {
	const { codebuddyRetryListener } = await load();
	for (const preAborted of [true, false]) {
		const controller = new AbortController(), error = new Error('cancelled');
		if (preAborted) controller.abort(error);
		const pending = drain(codebuddyRetryListener(options({ signal: controller.signal }), () => new Promise(() => {})));
		if (!preAborted) controller.abort(error);
		let timer;
		try {
			const outcome = await Promise.race([pending.then(() => 'resolved', e => e),
				new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 100); })]);
			assert.equal(outcome, error);
		} finally { clearTimeout(timer); }
	}
});

test('actual bundled retry plugin waits the upstream 20 seconds and aborts cleanly', async t => {
	const { codebuddyRetryListener } = await load();
	const { bundled } = JSON.parse(readFileSync(new URL('../../dsh-compat.json', import.meta.url), 'utf8'));
	const nm = new URL(`../../../dsh-runtime/${bundled}/node_modules/`, import.meta.url);
	if (!existsSync(new URL('@deepseek-ai/dsh-llm-retry/lib/index.js', nm))) {
		t.skip(`Bundled runtime ${bundled} is not installed; middleware tests still run`); return;
	}
	const require = createRequire(new URL('@deepseek-ai/dsh-llm/package.json', nm));
	const llm = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
	const retry = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-retry')).href);
	const policy = llm.resolveRetryPolicy(codebuddyRouteEntry({ baseURL: 'https://example.invalid', accessToken: 'fake', models: [] }).retryPolicy, 'test');
	const listeners = new Map(), effects = [], events = [];
	let projection, state = {};
	const ctx = { fiber: { uid: 'test' }, logger: { warn() {} },
		sessionProjections: { register: async spec => { projection = spec; return { stateOf: () => state }; } },
		on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); },
		effect: fn => { effects.push(fn()); },
	};
	await retry.apply(ctx, {}, { random: () => 0.5 });
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const [chunk] = await drain(codebuddyRetryListener(options(), () => streamOf(errorChunk())));
	const controller = new AbortController();
	const payload = { agent: { session: { append: (type, data) => { events.push({ type, data }); state = projection.apply(state, { type, data }); } } },
		turn: 1, step: 1, provider: 'vssaros-codebuddy', failure: chunk.reason.failure, retryPolicy: policy, signal: controller.signal };
	const recover = listeners.get('agent/request-error');
	let settled = false;
	const result = recover(payload, async () => undefined).then(r => { settled = true; return r; });
	await Promise.resolve(); await Promise.resolve();
	assert.equal(events[0].type, 'llm/retry'); assert.equal(events[0].data.delayMs, 20_000);
	t.mock.timers.tick(19_999); await Promise.resolve(); assert.equal(settled, false); assert.equal(events.length, 1);
	t.mock.timers.tick(1); assert.deepEqual(await result, { kind: 'retry' });
	assert.equal(events[1].type, 'llm/retry-started');
	state = {};
	const withoutHint = recover({ ...payload, failure: errorChunk().reason.failure }, async () => undefined);
	await Promise.resolve();
	assert.equal(events.at(-1).data.delayMs, 500, 'Without the middleware, the same server body still uses local backoff');
	t.mock.timers.tick(500); assert.deepEqual(await withoutHint, { kind: 'retry' });
	state = {};
	const rateLimited = { type: 'finish', reason: { kind: 'error', failure: {
		message: 'relay error: too many requests', code: 'RATE_LIMIT',
	} } };
	const [limitedChunk] = await drain(codebuddyRetryListener(options(), () => streamOf(rateLimited)));
	const cooldown = recover({ ...payload, failure: limitedChunk.reason.failure, signal: new AbortController().signal }, async () => undefined);
	await Promise.resolve();
	assert.equal(events.at(-1).data.delayMs, 30_000, 'Plain-text 429 from the relay waits the upstream cooldown');
	t.mock.timers.tick(30_000); assert.deepEqual(await cooldown, { kind: 'retry' });
	const cancelled = recover(payload, async () => undefined);
	await Promise.resolve(); controller.abort(); assert.equal(await cancelled, undefined);
	for (const dispose of effects) await dispose?.();
});

test('bridge entry installs the retry middleware', async () => {
	const text = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.equal(/ctx\.on\('llm\/stream',\s*codebuddyRetryListener\)/.test(text), true);
});
