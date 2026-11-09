#!/usr/bin/env node
// 逐个跑本插件的 *.test.mjs，全跑完再汇总。
//   node dsh-plugins/vssaros-computer/test/run-computer-check.mjs
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort();
const failed = [];
for (const file of files) {
	const run = spawnSync(process.execPath, [join(here, file)], {
		stdio: 'inherit', windowsHide: true,
		env: { ...process.env, NODE_OPTIONS: '' },
	});
	if (run.status !== 0) failed.push(file);
}
console.log(`\n[vssaros-computer] ${files.length - failed.length}/${files.length} 个测试文件通过`);
if (failed.length) {
	console.error(`失败：${failed.join(' / ')}`);
	process.exit(1);
}
