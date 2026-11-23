/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「首启 wants = 0」的构建期守卫（2026-11-23）。
 *
 * 起因：`@deepseek-ai/dsh-experimental-session-search` 是首启必装的官方 bundle，却一直没进
 * `build/prepack-dsh-runtime.mjs` 的官方清单 ⇒ 种子里没有 ⇒ 首启 wants > 0 ⇒ 共享只读 profile
 * 立刻物化，shared 首启拿不到收益。这里把「清单里有没有」与「supervisor 伴生清单是否漂移」
 * 都钉在 CI 上，防止种子再次因为漏一个官方包而退回首启物化。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshSeedStartupCoverage
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const PREPACK = 'build/prepack-dsh-runtime.mjs';
const INCREMENTAL = 'build/saros/incremental-profile-seed.mjs';
const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

/** 读源码并去掉注释：查的是真实代码，不是注释里出现的名字。 */
function code(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split(/\r?\n/)
		.filter(l => !/^\s*\/\//.test(l))
		.join('\n');
}

/** 首启必装的官方包（与 supervisor 伴生清单同源；少一个都会让首启 wants > 0）。 */
const REQUIRED_OFFICIAL = [
	'dsh-web-app',
	'dsh-experimental-session-search',
	'dsh-experimental-voice-input-bundle',
	'dsh-experimental-forge-bundle',
	'dsh-experimental-forge',
	'dsh-experimental-forge-github',
	'dsh-experimental-forge-session',
	'dsh-experimental-client-ui-forge',
	'dsh-experimental-worktree',
	'dsh-skill-office',
	'dsh-tool-workspace-dependencies',
];

suite('dshHarness / 种子首启覆盖（wants = 0）', () => {

	test('首启必装的官方包都在构建清单里（全量与增量两路）', () => {
		const prepack = code(PREPACK);
		for (const name of REQUIRED_OFFICIAL) {
			assert.ok(prepack.includes(`'${name}'`), `prepack 的 OFFICIAL_BUNDLES 缺 ${name}（首启会 wants>0 ⇒ 物化）`);
		}
		const incremental = code(INCREMENTAL);
		for (const name of ['dsh-experimental-session-search', 'dsh-skill-office', 'dsh-tool-workspace-dependencies']) {
			assert.ok(incremental.includes(`'${name}'`), `增量种子的 officialPluginSources 缺 ${name}`);
		}
	});

	test('构建期有首启覆盖对账（assertSeedCoversStartupBundles）', () => {
		const prepack = code(PREPACK);
		assert.match(prepack, /function assertSeedCoversStartupBundles\(/, '缺对账函数');
		assert.match(prepack, /assertSeedCoversStartupBundles\(profileDir, runtimeDir\)/, '写 marker 前必须执行对账');
	});

	test('supervisor 伴生清单中的官方包都在构建清单里（防漂移）', () => {
		const sup = code(SUPERVISOR);
		const start = sup.indexOf('const plugins: [string, string | undefined, string][] = [');
		assert.ok(start > 0, '找不到伴生插件清单');
		const region = sup.slice(start, sup.indexOf('\n\t\t\t];', start));
		const names = new Set<string>();
		for (const m of region.matchAll(/['"](@deepseek-ai\/[a-z0-9-]+)['"]/g)) {
			names.add(m[1].replace('@deepseek-ai/', ''));
		}
		assert.ok(names.size > 0, '伴生清单里应能提取到官方包名');
		const prepack = code(PREPACK);
		for (const name of names) {
			assert.ok(prepack.includes(`'${name}'`), `伴生清单里的官方包 ${name} 不在 OFFICIAL_BUNDLES（首启会 wants>0）`);
		}
	});
});
