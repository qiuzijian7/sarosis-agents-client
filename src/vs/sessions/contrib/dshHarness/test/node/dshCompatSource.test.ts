/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 兼容清单来源：随包清单、远端签名清单（真实 Ed25519 密钥，临时生成）、缓存回退，
 * 以及 `build/saros/dsh-compat-manifest.mjs` 的 keygen → sign → 应用侧验签往返。
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import { generateKeyPairSync, sign } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { parseCompatManifest, satisfiesRange } from '../../common/dshCompat.js';
import { loadCompatManifest, verifyManifestEnvelope } from '../../electron-main/dshCompatSource.js';
import { FetchLike } from '../../electron-main/dshNodeInstaller.js';

const REPO = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();

function keypair(keyId: string) {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	return { keyId, privateKey, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

function envelope(manifest: object, k: ReturnType<typeof keypair>) {
	const payload = Buffer.from(JSON.stringify(manifest));
	return { keyId: k.keyId, payload: payload.toString('base64'), signature: sign(null, payload, k.privateKey).toString('base64') };
}

const fetchText = (map: Record<string, string | number>): FetchLike => async url => {
	const v = map[url];
	if (v === undefined) {
		throw new Error('offline');
	}
	const text = typeof v === 'number' ? '' : v;
	return { ok: typeof v !== 'number', status: typeof v === 'number' ? v : 200, text: async () => text, arrayBuffer: async () => new ArrayBuffer(0) };
};

suite('dshHarness / compat manifest sources', () => {
	let dir: string;
	const k = keypair('ci-2026');
	const trusted = [{ keyId: k.keyId, publicKey: k.publicKey }];
	const bundled = { schema: 1, generatedAt: '2026-10-09T00:00:00Z', versions: [{ version: '0.2.0-rc.2' }] };
	const remote = { schema: 1, generatedAt: '2026-10-12T00:00:00Z', versions: [{ version: '0.2.0-rc.2' }, { version: '0.2.1' }] };
	const URL = 'https://example.invalid/dsh-compat.signed.json';

	setup(() => {
		dir = mkdtempSync(join(tmpdir(), 'vssaros-compat-'));
		writeFileSync(join(dir, 'bundled.json'), JSON.stringify(bundled));
	});
	teardown(() => rmSync(dir, { recursive: true, force: true }));

	const load = (fetch: FetchLike, remoteUrl: string | undefined = URL, keys = trusted) =>
		loadCompatManifest({ bundledPath: join(dir, 'bundled.json'), remoteUrl, cachePath: join(dir, 'cache.json'), fetch, log: () => { }, trustedKeys: keys });

	// ── 可信密钥为空（本仓现状）──────────────────────────────────────────────
	// 与"密钥配错"是两件事：前者是**功能未启用**（显式说明即可），后者才是 bug。不区分的话，
	// 用户/排查者会照着"密钥不在可信列表中"去查 key ✗，而其实我们根本没发过公钥。

	test('★ 可信密钥为空 ⇒ 不拉远端，且只报一条"功能未启用"（不报像配错 key 的措辞）', async () => {
		let fetched = 0;
		const spy: FetchLike = async () => { fetched++; throw new Error('不该被调用'); };
		const r = await load(spy, URL, []);
		assert.strictEqual(fetched, 0, '没配密钥时不该发起远端拉取（白跑一次 + 报一串误导错误 ✗）');
		assert.strictEqual(r.source, 'bundled', '应仍用随包清单');
		assert.strictEqual(r.manifest?.versions.length, 1);
		assert.strictEqual(r.errors.length, 1, `应只有一条说明性错误：${r.errors.join(' | ')}`);
		assert.ok(r.errors[0].includes('未配置可信密钥'), r.errors[0]);
		assert.ok(!r.errors[0].includes('不在可信列表中'),
			'不该出现"密钥不在可信列表"这种像配错 key 的措辞 ✗（那是另一件事）');
	});

	test('没配远端地址 ⇒ 不产生"未配置可信密钥"噪音（没有远端就无所谓验签）', async () => {
		const r = await load(async () => { throw new Error('offline'); }, '', []);
		assert.deepStrictEqual(r.errors, []);
		assert.strictEqual(r.source, 'bundled');
	});

	test('the shipped dsh-plugins/dsh-compat.json is valid and agrees with the bridge peer range', () => {
		const m = parseCompatManifest(JSON.parse(readFileSync(join(REPO, 'dsh-plugins', 'dsh-compat.json'), 'utf8')));
		const pkg = JSON.parse(readFileSync(join(REPO, 'dsh-plugins', 'vssaros-bridge', 'package.json'), 'utf8'));
		assert.ok(m.versions.length > 0);
		for (const e of m.versions) {
			assert.strictEqual(satisfiesRange(e.version, pkg.peerDependencies['@deepseek-ai/dsh']), true, `${e.version} outside bridge peer range`);
			if (e.bridgePlugin) {
				assert.strictEqual(satisfiesRange(pkg.version, e.bridgePlugin), true, `bridge ${pkg.version} does not meet ${e.bridgePlugin} required by ${e.version}`);
			}
		}
	});

	test('bundled only when no remote URL', async () => {
		const r = await load(fetchText({}), '');
		assert.strictEqual(r.source, 'bundled');
		assert.deepStrictEqual(r.errors, []);
	});

	test('valid newer remote wins and is cached; offline later uses the cache', async () => {
		const signed = JSON.stringify(envelope(remote, k));
		const r = await load(fetchText({ [URL]: signed }));
		assert.strictEqual(r.source, 'remote');
		assert.strictEqual(r.manifest?.generatedAt, remote.generatedAt);
		assert.ok(existsSync(join(dir, 'cache.json')));
		const offline = await load(fetchText({}));
		assert.strictEqual(offline.source, 'cache');
		assert.match(offline.errors.join(), /offline/);
	});

	test('older remote loses to the bundled manifest', async () => {
		const r = await load(fetchText({ [URL]: JSON.stringify(envelope({ ...remote, generatedAt: '2026-01-01T00:00:00Z' }, k)) }));
		assert.strictEqual(r.source, 'bundled');
	});

	test('tampered payload, unknown key, unsigned manifest and HTTP errors are all rejected', async () => {
		const good = envelope(remote, k);
		const tampered = { ...good, payload: Buffer.from(JSON.stringify({ ...remote, versions: [{ version: '9.9.9' }] })).toString('base64') };
		assert.throws(() => verifyManifestEnvelope(tampered, trusted), /验签失败/);
		assert.throws(() => verifyManifestEnvelope(envelope(remote, keypair('rogue')), trusted), /不在可信列表/);
		assert.throws(() => verifyManifestEnvelope(remote, trusted), /格式不正确/);
		assert.throws(() => verifyManifestEnvelope(good, []), /不在可信列表/, 'no trusted keys (current production state) → remote ignored');

		for (const body of [JSON.stringify(tampered), JSON.stringify(remote), 500] as const) {
			const r = await load(fetchText({ [URL]: body }));
			assert.strictEqual(r.source, 'bundled', String(body).slice(0, 40));
			assert.strictEqual(r.errors.length, 1);
		}
	});

	test('signing script: keygen → sign → verify, and the app accepts its output', function () {
		this.timeout(30_000);
		const script = join(REPO, 'build', 'saros', 'dsh-compat-manifest.mjs');
		execFileSync(process.execPath, [script, 'keygen', join(dir, 'keys')]);
		writeFileSync(join(dir, 'm.json'), JSON.stringify(remote));
		execFileSync(process.execPath, [script, 'sign', join(dir, 'm.json'), '--key', join(dir, 'keys', 'dsh-compat.key'), '--key-id', 'ci-test', '--out', join(dir, 'signed.json')]);
		const out = execFileSync(process.execPath, [script, 'verify', join(dir, 'signed.json'), '--pub', join(dir, 'keys', 'dsh-compat.pub'), '--key-id', 'ci-test'], { encoding: 'utf8' });
		assert.match(out, /signature OK/);
		const m = verifyManifestEnvelope(JSON.parse(readFileSync(join(dir, 'signed.json'), 'utf8')), [{ keyId: 'ci-test', publicKey: readFileSync(join(dir, 'keys', 'dsh-compat.pub'), 'utf8') }]);
		assert.deepStrictEqual(m.versions.map(v => v.version), ['0.2.0-rc.2', '0.2.1']);
		writeFileSync(join(dir, 'bad.json'), JSON.stringify({ schema: 1, generatedAt: 'x', versions: [{ version: '../x' }] }));
		assert.throws(() => execFileSync(process.execPath, [script, 'sign', join(dir, 'bad.json'), '--key', join(dir, 'keys', 'dsh-compat.key'), '--key-id', 'ci-test'], { stdio: 'pipe' }), 'refuses to sign an invalid manifest');
	});
});
