#!/usr/bin/env node
// 逐个跑本插件的 *.test.mjs，全跑完再汇总（不因第一个红就中断）。
//   node dsh-plugins/vssaros-local-agents/test/run-local-agents-check.mjs
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort();
const failed = [];
for (const file of files) {
	const run = spawnSync(process.execPath, [join(here, file)], {
		stdio: 'inherit',
		windowsHide: true,
		env: { ...process.env, NODE_OPTIONS: '' },
	});
	if (run.status !== 0) failed.push(file);
}
console.log(`\n[vssaros-local-agents] ${files.length - failed.length}/${files.length} 个测试文件通过`);
if (failed.length) {
	console.error(`失败：${failed.join(' / ')}`);
	process.exit(1);
}
