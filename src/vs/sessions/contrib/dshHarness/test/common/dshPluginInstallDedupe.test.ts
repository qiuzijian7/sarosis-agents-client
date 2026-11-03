/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「伴生插件清单必须按名字去重」守卫（2026-11-03）。
 *
 * 真机（别人机器，启动直接失败）：`plugins` 列表里 `DSH_LOOP_PLUGIN_NAME` 被伴生项**显式列了一次**，
 * `modulePluginDirs`（按 `vssaros.module` 自发现）**又列了一次** ⇒ 同一插件进列表两遍 ⇒
 * 两个并发 `_stagePlugin` 写**同一个**版本目录 ⇒ 一个 rm、一个 cp ⇒
 * `EEXIST: mkdir …\plugins\vssaros-dsh-loop-…\docs` / `ENOTEMPTY: rmdir …\lib` ⇒ Host 起不来。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshPluginInstallDedupe
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SUP = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 去整行 `//` 与以 ` *` 开头的块注释行（注释里会提到旧写法） */
function code(rel: string): string {
	return read(rel).split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
}

suite('伴生插件安装清单', () => {

	test('1) 必须按名字去重（伴生显式项与 modulePluginDirs 会重叠）', () => {
		const src = code(SUP);
		const at = src.indexOf('const wants: { name: string;');
		assert.ok(at > 0, '找不到 wants 声明');
		// 去重必须在 wants 循环**之前**完成
		const before = src.slice(Math.max(0, at - 2200), at);
		assert.match(before, /const seen = new Set<string>\(\);/, 'wants 之前必须有 seen 集合');
		assert.match(before, /const deduped = plugins\.filter\(\(\[name\]\) => \(seen\.has\(name\) \? false : \(seen\.add\(name\), true\)\)\);/,
			'必须按 name 去重（保留先出现的那条 = 伴生显式项优先）');
		assert.match(before, /plugins\.length = 0;\s*\n\s*plugins\.push\(\.\.\.deduped\);/, '去重结果必须写回 plugins（后面的循环读的是它）');
		assert.match(before, /伴生插件清单去重：/, '去重要留日志（方便发现清单重叠）');
	});

	test('2) 暂存必须走 dshPluginStaging（原子落位），不许内联"先 rm 再 cp"', () => {
		const src = code(SUP);
		const at = src.indexOf('private async _stagePlugin(');
		assert.ok(at > 0, '找不到 _stagePlugin');
		const body = src.slice(at, at + 1600);
		assert.match(body, /return stagePluginDir\(\{ sourceDir, destDir: dest \}\);/, '_stagePlugin 必须委托给 stagePluginDir');
		assert.ok(!/await fsp\.rm\(dest,/.test(body), '不许再在这里 rm 目标目录（那是并发互撞的根因）');
		assert.match(src, /import \{ stagePluginDir \} from '\.\/dshPluginStaging\.js';/, '必须引入 dshPluginStaging 模块');
	});
});
