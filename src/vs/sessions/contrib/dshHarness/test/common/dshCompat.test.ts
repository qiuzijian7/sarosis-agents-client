/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { discoverUpdates, IDshCompatManifest, IDshUpdateInput, newerManifest, parseCompatManifest, resolveCurrentVersion, satisfiesRange, selectInstallTarget } from '../../common/dshCompat.js';

const MANIFEST: IDshCompatManifest = {
	schema: 1,
	generatedAt: '2026-10-09T00:00:00Z',
	versions: [
		{ version: '0.2.0-rc.2', bridgePlugin: '>=0.1.1' },
		{ version: '0.1.7-rc.2', bridgePlugin: '>=0.1.1' },
	],
	blocked: [{ version: '0.2.0-rc.1', reason: 'session migration bug' }],
};
const TAGS = { latest: '0.2.0-rc.2', next: '0.2.0-rc.2', alpha: '0.2.1-alpha.1' };
const base: IDshUpdateInput = { channel: 'stable', installed: ['0.1.7-rc.2'], current: '0.1.7-rc.2', distTags: TAGS, manifest: MANIFEST, bridgePeerRange: '>=0.1.7-0 <0.3.0-0', bridgeVersion: '0.1.1', nodeVersion: 'v24.11.1' };

suite('dshHarness / update discovery', () => {

	test('semver ranges (prereleases compare normally)', () => {
		assert.strictEqual(satisfiesRange('0.2.1-alpha.1', '>=0.1.7-0 <0.3.0-0'), true);
		assert.strictEqual(satisfiesRange('0.1.6-alpha.2', '>=0.1.7-0 <0.3.0-0'), false);
		assert.strictEqual(satisfiesRange('0.3.0', '>=0.1.7-0 <0.3.0-0'), false);
		assert.strictEqual(satisfiesRange('1.2.3', '<1.0.0 || >=1.2.0'), true);
		assert.strictEqual(satisfiesRange('0.1.1', '>=0.1.1'), true);
		assert.strictEqual(satisfiesRange('0.1.0', '>=0.1.1'), false);
		assert.strictEqual(satisfiesRange('0.1.0', '*'), true);
		assert.strictEqual(satisfiesRange('0.1.0', '^0.1.0'), undefined, 'caret is not supported → unknown, never blocks');
	});

	test('stable: recommends the highest verified version; alpha is listed only if installed', () => {
		const d = discoverUpdates(base);
		assert.strictEqual(d.recommended, '0.2.0-rc.2');
		assert.deepStrictEqual(d.candidates.map(c => c.version), ['0.2.0-rc.2', '0.1.7-rc.2']);
		assert.ok(d.candidates.find(c => c.version === '0.1.7-rc.2')?.current);
		assert.ok(d.candidates.every(c => c.verified));
	});

	// ── 自研模块插件的 peer 预检（③，2026-10-12）──────────────────────────────
	// 与 ② 同因：运行时升到模块插件 peer 范围之外时，dsh 的准入检查会让该插件失效，
	// 而用户只看到"某个模块凭空消失"✗。这条问题会由版本选择器展示并置灰那一项（它已展示 `problems`）。

	test('★ 模块插件 peer 不兼容 ⇒ 该候选被点名，且不再被推荐', () => {
		// ⚠ 用**真的不兼容**的范围（要求 0.3+，而候选是 0.2.0-rc.2）；写 `>=0.1.7-0 <0.3.0-0` 是兼容的，
		//   那样这条用例会"绿着空跑"（初版就是这么写错的 ✗）。
		const d = discoverUpdates({ ...base, modulePluginPeerRanges: [{ name: '@vssaros/dsh-kanban', range: '>=0.3.0-0' }] });
		const c = d.candidates.find(x => x.version === '0.2.0-rc.2');
		assert.ok(c, '候选应在');
		assert.strictEqual(c!.problems.length, 1, `应记一条问题：${JSON.stringify(c!.problems)}`);
		assert.ok(c!.problems[0].includes('@vssaros/dsh-kanban'), c!.problems[0]);
		assert.ok(c!.problems[0].includes('0.2.0-rc.2'), c!.problems[0]);
		assert.strictEqual(d.recommended, undefined, '不兼容的版本不该被推荐（升上去就少一个模块）✗');
	});

	test('兼容 / 空范围 / 解析不了的范围 / 不传该字段 ⇒ 一律不报问题（宁可漏报不误报）', () => {
		// 随包模块插件**当下真实**的范围就是这一条（`>=0.1.7-0 <0.3.0-0` 含 0.2.0-rc.2）⇒ 不该有任何问题
		const ok = discoverUpdates({ ...base, modulePluginPeerRanges: [{ name: 'a', range: '>=0.1.7-0 <0.3.0-0' }] });
		assert.deepStrictEqual(ok.candidates.find(x => x.version === '0.2.0-rc.2')!.problems, []);
		assert.strictEqual(ok.recommended, '0.2.0-rc.2', '兼容时应照常推荐');

		// 没声明 peer（空串）/ 解析不了的范围（caret 不支持 ⇒ satisfiesRange 返回 undefined）都不拦
		const loose = discoverUpdates({ ...base, modulePluginPeerRanges: [{ name: 'a', range: '' }, { name: 'b', range: '^0.1.0' }] });
		assert.deepStrictEqual(loose.candidates.find(x => x.version === '0.2.0-rc.2')!.problems, []);
		assert.strictEqual(loose.recommended, '0.2.0-rc.2');

		// 老调用方不传该字段 ⇒ 行为与从前完全一致
		assert.strictEqual(discoverUpdates(base).recommended, '0.2.0-rc.2');
	});

	test('接线守卫：版本发现真的把随包模块插件的范围传进来了（防"预检写了没人喂"）', () => {
		// `dshCompat` 是纯函数，喂不喂由主进程决定 ⇒ 只有这条能防"算了但没传"✗
		const channel = fs.readFileSync(path.join(process.cwd(), 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts'), 'utf8');
		assert.ok(/modulePluginPeerRanges:\s*listBundledPlugins\(/.test(channel),
			'dshHarnessChannel 没把随包模块插件的 peer 范围传给 discoverUpdates ⇒ 预检恒为空（等于没做）✗');
		const bundled = fs.readFileSync(path.join(process.cwd(), 'src/vs/sessions/contrib/dshHarness/electron-main/dshBundledPlugins.ts'), 'utf8');
		assert.ok(/peerDependencies\?\.\['@deepseek-ai\/dsh'\]/.test(bundled),
			'listBundledPlugins 没读 peerDependencies ⇒ 传上去的范围恒为空 ✗');
	});

	test('stable without a manifest recommends nothing and says why', () => {
		const d = discoverUpdates({ ...base, manifest: undefined });
		assert.strictEqual(d.recommended, undefined);
		assert.match(d.notes.join(), /兼容清单/);
	});

	test('preview: follows latest/next, lists other tags as unverified but does not recommend them', () => {
		const d = discoverUpdates({ ...base, channel: 'preview', current: '0.2.0-rc.2', installed: ['0.2.0-rc.2'] });
		assert.strictEqual(d.recommended, undefined, 'already on latest; alpha tag is not followed');
		const alpha = d.candidates.find(c => c.version === '0.2.1-alpha.1')!;
		assert.deepStrictEqual([alpha.verified, alpha.tags], [false, ['alpha']]);
		const d2 = discoverUpdates({ ...base, channel: 'preview', distTags: { ...TAGS, next: '0.2.1-alpha.1' } });
		assert.strictEqual(d2.recommended, '0.2.1-alpha.1', 'next moved → recommended even though unverified');
	});

	test('locked: only the pinned version, never a newer one', () => {
		const d = discoverUpdates({ ...base, channel: 'locked', pinned: '0.1.7-rc.2' });
		assert.strictEqual(d.recommended, undefined, 'already on the pinned version');
		assert.deepStrictEqual(d.candidates.map(c => c.version), ['0.1.7-rc.2']);
		const d2 = discoverUpdates({ ...base, channel: 'locked', pinned: '0.2.0-rc.2' });
		assert.strictEqual(d2.recommended, '0.2.0-rc.2', 'pinned differs from current → move to it');
		const d3 = discoverUpdates({ ...base, channel: 'locked' });
		assert.match(d3.notes.join(), /pinnedVersion/);
	});

	test('pre-checks: blocked versions, bridge peer range, bridge minimum, Node floor', () => {
		const withBlocked = discoverUpdates({ ...base, installed: ['0.1.7-rc.2', '0.2.0-rc.1'] });
		assert.strictEqual(withBlocked.candidates.find(c => c.version === '0.2.0-rc.1')?.blocked, 'session migration bug');

		const outOfRange = discoverUpdates({ ...base, channel: 'preview', distTags: { latest: '0.3.0' } });
		const v030 = outOfRange.candidates.find(c => c.version === '0.3.0')!;
		assert.match(v030.problems.join(), /伴生插件只支持/);
		assert.strictEqual(outOfRange.recommended, '0.2.0-rc.2', 'falls back to the next eligible tagged/verified version');

		const oldBridge = discoverUpdates({ ...base, bridgeVersion: '0.1.0' });
		assert.strictEqual(oldBridge.recommended, undefined);
		assert.match(oldBridge.candidates[0].problems.join(), /需要伴生插件 >=0.1.1/);

		const oldNode = discoverUpdates({ ...base, nodeVersion: 'v22.18.0' });
		assert.strictEqual(oldNode.recommended, undefined);
	});

	test('current version flagged as blocked produces a note', () => {
		const d = discoverUpdates({ ...base, current: '0.2.0-rc.1', installed: ['0.2.0-rc.1'] });
		assert.match(d.notes.join(), /已被兼容清单标记/);
		assert.strictEqual(d.recommended, '0.2.0-rc.2');
	});

	test('first install target per channel', () => {
		const inp = { channel: 'stable' as const, installed: [], distTags: TAGS, manifest: MANIFEST };
		assert.strictEqual(selectInstallTarget(inp), '0.2.0-rc.2');
		assert.strictEqual(selectInstallTarget({ ...inp, manifest: undefined }), '0.2.0-rc.2', 'no manifest → npm latest so the user can start');
		assert.strictEqual(selectInstallTarget({ ...inp, channel: 'locked', pinned: '0.1.7-rc.2' }), '0.1.7-rc.2');
		assert.strictEqual(selectInstallTarget({ ...inp, channel: 'locked' }), '0.2.0-rc.2', 'locked without pin → like stable');
		assert.strictEqual(selectInstallTarget({ ...inp, manifest: undefined, distTags: {} }), undefined);
	});

	test('current version: running Host wins over an empty managed pointer (bundled/global dsh)', () => {
		// 默认路径下 dsh 来自内置运行时或全局安装：托管目录为空 → 旧逻辑 current=undefined → 界面「当前 -」
		assert.strictEqual(resolveCurrentVersion({ runningVersion: '0.2.0-rc.2' }), '0.2.0-rc.2');
		// 未运行时才回退托管指针；两者都有时以运行中的 Host 为准（可能复用的是别的窗口的 Host）
		assert.strictEqual(resolveCurrentVersion({ managedVersion: '0.1.7-rc.2' }), '0.1.7-rc.2');
		assert.strictEqual(resolveCurrentVersion({ runningVersion: '0.2.0-rc.2', managedVersion: '0.1.7-rc.2' }), '0.2.0-rc.2');
		assert.strictEqual(resolveCurrentVersion({}), undefined);
		// 设了 runtimePath 时托管指针无意义（切换不生效）→ 不参与回退
		assert.strictEqual(resolveCurrentVersion({ runtimePath: 'C:/dsh', managedVersion: '0.1.7-rc.2' }), undefined);
		assert.strictEqual(resolveCurrentVersion({ runtimePath: '  ', managedVersion: '0.1.7-rc.2' }), '0.1.7-rc.2', 'blank runtimePath counts as unset');
	});

	test('running the bundled version is not offered as an upgrade', () => {
		// bundled 0.2.0-rc.2 在跑、托管目录为空：current 必须认得它，否则会把自己当升级目标弹提示
		const current = resolveCurrentVersion({ runningVersion: '0.2.0-rc.2' });
		const d = discoverUpdates({ ...base, current, installed: [] });
		assert.strictEqual(d.current, '0.2.0-rc.2');
		assert.ok(d.candidates.find(c => c.version === '0.2.0-rc.2')?.current);
		assert.strictEqual(d.recommended, undefined, 'already on the highest verified version');
		// 有更新版本时仍要正确提示（当前版本已知 → 能算出 recommended）
		const d2 = discoverUpdates({ ...base, current, installed: [], manifest: { ...MANIFEST, versions: [{ version: '0.2.1-rc.1', bridgePlugin: '>=0.1.1' }, ...MANIFEST.versions] } });
		assert.strictEqual(d2.recommended, '0.2.1-rc.1');
	});

	// 调用点源码守卫（非空跑）：主进程必须经 resolveCurrentVersion 取「当前版本」。
	// 为什么需要：默认路径下 dsh 来自内置/全局，不写托管目录，直读托管指针会得到 undefined（界面「当前 -」）。
	test('source guard: dshHarnessChannel derives 当前版本 via resolveCurrentVersion', function () {
		const rel = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';
		const abs = path.join(process.cwd(), rel);
		if (!fs.existsSync(abs)) {
			this.skip(); // 从仓库根之外运行时才跳过，避免静默通过
		}
		const src = fs.readFileSync(abs, 'utf8');
		assert.match(src, /const current = resolveCurrentVersion\(\{/, '当前版本必须经 resolveCurrentVersion 推导');
		assert.match(src, /runningVersion: this\._supervisor\.status\.dshVersion/, '必须把运行中的 Host 版本作为首选');
		assert.doesNotMatch(src, /const current = start\.runtimePath\?\.trim\(\)/, '不得退回「只看托管指针」的旧写法');
	});

	test('manifest parsing drops malformed entries; newer manifest wins', () => {
		const m = parseCompatManifest({ schema: 1, generatedAt: '2026-10-10T00:00:00Z', versions: [{ version: '0.2.0' }, { version: '../x' }, null], blocked: [{ version: 'bad' }] });
		assert.deepStrictEqual(m.versions.map(v => v.version), ['0.2.0']);
		assert.deepStrictEqual(m.blocked, []);
		assert.throws(() => parseCompatManifest({ schema: 2 }));
		assert.strictEqual(newerManifest(MANIFEST, m), m);
		assert.strictEqual(newerManifest(m, MANIFEST), m);
		assert.strictEqual(newerManifest(undefined, MANIFEST), MANIFEST);
	});
});
