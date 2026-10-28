/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 第三方 dsh 插件的识别与升级判据（2026-10-28）。
 *
 * 背景：本仓对**随包插件**有完整闭环，但用户自己 `dsh plugin add` 装的第三方插件此前既看不到清单、
 * 也没有升级入口 —— 而那正是"从 npm / GitHub 装了个开源插件"的场景。
 *
 * 本守卫钉死的核心不是"能升级"，而是**不能升错**：
 *   profile 里的依赖有三种形态，`@latest` 只对 registry 形态安全。
 *   对 git 源写 `@latest` 会把源换成 npm 上的同名包、对本地目录写 `add` 会把链接换成注册表版本 ✗✗。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshPluginUpgrade
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

import { classifyPluginSpec, describeManualUpgrade, pickThirdPartyPlugins, upgradableSpecOf } from '../../common/dshPluginUpgrade.js';

const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

function fnBody(src: string, signature: string): string {
	const at = src.indexOf(signature);
	assert.ok(at > 0, `找不到 ${signature} ✗`);
	const rest = src.slice(at + signature.length);
	const next = rest.search(/\n\t(?:private|async|protected|public)\s/);
	return rest.slice(0, next > 0 ? next : 4000);
}

suite('第三方插件：识别与升级判据', () => {

	test('① 形态判定（决定能不能用 @latest）', () => {
		// registry：可安全 @latest
		for (const spec of ['^1.2.3', '1.2.3', '~1', '>=1 <2', '*', 'latest', 'next']) {
			assert.equal(classifyPluginSpec(spec), 'registry', `${spec} 应是 registry ✗`);
		}
		// git：写 @latest 会换成 npm 同名包 ⇒ 必须识别出来
		for (const spec of ['github:user/repo', 'git+https://github.com/a/b.git', 'git@github.com:a/b.git', 'https://github.com/a/b', 'user/repo']) {
			assert.equal(classifyPluginSpec(spec), 'git', `${spec} 应是 git ✗`);
		}
		// 本地：add 会把链接换成注册表版本 ⇒ 必须识别出来
		for (const spec of ['file:../x', 'link:../x', 'workspace:*', 'portal:../x']) {
			assert.equal(classifyPluginSpec(spec), 'local', `${spec} 应是 local ✗`);
		}
		assert.equal(classifyPluginSpec(''), 'unknown');
		assert.equal(classifyPluginSpec(undefined), 'unknown');
		assert.equal(classifyPluginSpec('???'), 'unknown');
	});

	test('② 只有 registry 形态给"一键升级"，且 spec 是 <name>@latest', () => {
		assert.equal(upgradableSpecOf({ name: '@scope/pkg', kind: 'registry' }), '@scope/pkg@latest');
		assert.equal(upgradableSpecOf({ name: 'pkg', kind: 'git' }), undefined, 'git 源不许给 @latest（会换源 ✗）');
		assert.equal(upgradableSpecOf({ name: 'pkg', kind: 'local' }), undefined, '本地目录不许给 @latest ✗');
		assert.equal(upgradableSpecOf({ name: 'pkg', kind: 'unknown' }), undefined);
	});

	test('③ 手动升级说明要能照着做（不许只说"请手动升级"）', () => {
		assert.match(describeManualUpgrade('git', 'p'), /重新执行一次同样的 add/);
		assert.match(describeManualUpgrade('git', 'p'), /@latest.*换成|换成.*npm/);
		assert.match(describeManualUpgrade('local', 'p'), /重启 Host/);
	});

	test('④ 只挑"用户自己装的"：排除随包名与 .vssaros 暂存目录', () => {
		const deps = {
			'@vssaros/dsh-agents': 'file:C:/Users/x/.vssaros-dev/dsh-home/profiles/vssaros/.vssaros/plugins/vssaros-dsh-agents-0.2.253-bcb371f9',
			'@vssaros/dsh-chat-surface': 'file:C:/Users/x/.vssaros-dev/dsh-home/profiles/vssaros/.vssaros/plugins/vssaros-dsh-chat-surface-0.2.268-92fea394',
			'@someone/cool-plugin': '^1.2.3',
			'@someone/gh-plugin': 'github:someone/cool-plugin',
			'@vssaros/dsh-kanban': '^0.8.15',   // 名字在随包清单里 ⇒ 排除（哪怕 spec 长得像 registry）
		};
		const out = pickThirdPartyPlugins(deps, ['@vssaros/dsh-kanban'], () => '1.0.0');
		const names = out.map(p => p.name);
		assert.deepEqual(names, ['@someone/cool-plugin', '@someone/gh-plugin'], `第三方清单应只有自己装的两个，实际 ${JSON.stringify(names)} ✗`);
		const byName = new Map(out.map(p => [p.name, p]));
		assert.equal(byName.get('@someone/cool-plugin')?.upgradable, true);
		assert.equal(byName.get('@someone/gh-plugin')?.upgradable, false, 'git 源必须标不可一键升级 ✗');
		assert.equal(byName.get('@someone/cool-plugin')?.installedVersion, '1.0.0');
	});

	test('⑤ 接线：supervisor 升级前必须先判形态（不许直接拼 @latest）', () => {
		const src = stripComments(read(SUPERVISOR));
		const list = fnBody(src, 'listThirdPartyPlugins(): IThirdPartyPlugin[] {');
		assert.ok(list.includes('pickThirdPartyPlugins('), '列清单必须走纯函数（判据只留一处 ✗）');

		const up = fnBody(src, 'async upgradeThirdPartyPlugin(name: string): Promise<{ ok: boolean; message: string }> {');
		const iSpec = up.indexOf('upgradableSpecOf(');
		const iInstall = up.indexOf('installPluginSpec(');
		assert.ok(iSpec > 0, '升级前必须 `upgradableSpecOf` 判形态（直接拼 @latest 会换源 ✗✗）');
		assert.ok(iInstall > iSpec, '必须先判形态再安装（顺序反了等于照装 ✗）');
		assert.ok(up.includes('describeManualUpgrade('), '不可升级时必须给出"该怎么做"的说明 ✗');
	});
});
