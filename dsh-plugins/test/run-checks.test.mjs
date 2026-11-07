// run-checks.mjs 的纯函数测试：node dsh-plugins/test/run-checks.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { failureLines, isExclusive, splitChain, toArgv } from '../scripts/run-checks.mjs';

assert.equal(isExclusive('node dsh-plugins/vssaros-superagent/dev/scripts/build.mjs --check'), true, 'build --check 会删除重建 lib，必须独占');
assert.equal(isExclusive('node dsh-plugins\\vssaros-superagent\\dev\\scripts\\build.mjs --check'), true);
assert.equal(isExclusive('node dsh-plugins/check-plugin-files.mjs'), false);

assert.deepEqual(splitChain('node a.mjs && node b.mjs --x &&node c.mjs'), ['node a.mjs', 'node b.mjs --x', 'node c.mjs']);
assert.deepEqual(splitChain(''), []);
assert.throws(() => splitChain('node a.mjs || node b.mjs'), /只支持纯 &&/);
assert.throws(() => splitChain('node a.mjs; node b.mjs'), /只支持纯 &&/);
assert.throws(() => splitChain('node a.mjs | tee x'), /只支持纯 &&/);
assert.deepEqual(toArgv('node "x y.mjs" --only a'), ['x y.mjs', '--only', 'a']);
assert.throws(() => toArgv('npm run x'), /只支持 node/);
assert.deepEqual(failureLines('ok\n  ✗ boom one\nfine\nFAIL two\n\u001b[31mError: three\u001b[0m\nAssertionError x'), ['✗ boom one', 'FAIL two', 'Error: three']);
assert.deepEqual(failureLines('a\nb\nc'), ['b', 'c'], '无失败标记 ⇒ 取最后两行当摘要');

// 真清单：package.json 的 check:dsh-plugins 必须能被完整解析，且每条都是 node 命令
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts['check:dsh-plugins'];
const commands = splitChain(script);
assert.ok(commands.length > 10, `清单太短：${commands.length}`);
for (const command of commands) { assert.ok(toArgv(command).length >= 1, command); }
assert.ok(commands.some(c => c.includes('check-bots-rooms.mjs')), '群聊 UI 守卫在清单里');

console.log(`run-checks: ok（解析 ${commands.length} 条）`);
