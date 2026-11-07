// shipped-files.mjs 的单测：安装副本「应当有」哪些文件。
// 跑法：node dsh-plugins/test/shipped-files.test.mjs
import assert from 'node:assert/strict';
import { expectedShipped, filesMatcher } from '../scripts/shipped-files.mjs';

const tracked = [
	'package.json', 'README.md', 'README-详细说明.md', 'CHANGELOG.md', 'LICENSE',
	'lib/index.js', 'lib/core/rooms.js', 'cordis.patch.yml',
	'mockups/split-pane/index.html', 'docs/CHANGELOG.en.md', 'scripts/vendor-lark-sdk.mjs',
	'vendor/markdown-it.cjs', 'tests/a.test.js',
];

// 白名单内的 + 固定文件；白名单外的原型 / 文档 / 开发脚本不要求
assert.deepEqual(expectedShipped({ files: ['lib/', 'cordis.patch.yml', 'vendor'] }, tracked),
	['package.json', 'README.md', 'LICENSE', 'lib/index.js', 'lib/core/rooms.js', 'cordis.patch.yml', 'vendor/markdown-it.cjs']);

// kb 白屏那一类：白名单漏了运行时目录 vendor/ ⇒ 里面的运行时代码仍然要求在（守卫会报红）
assert.ok(expectedShipped({ files: ['lib/'] }, tracked).includes('vendor/markdown-it.cjs'), '白名单外的运行时代码仍要求在');
assert.ok(!expectedShipped({ files: ['lib/'] }, tracked).includes('scripts/vendor-lark-sdk.mjs'), '开发脚本不算运行时');
assert.ok(!expectedShipped({ files: ['lib/'] }, tracked).includes('tests/a.test.js'), '测试不算运行时');
assert.deepEqual(expectedShipped({ files: ['lib/'] }, ['src/client/a.js', 'tsconfig.json', 'tsconfig.build.json', 'vite.config.json', 'data/seed.json']),
	['data/seed.json'], '构建源码 src/ 与构建配置不算运行时；其它 json 仍要求');

// 没有白名单 ⇒ 全部跟踪文件（旧口径）
assert.deepEqual(expectedShipped({}, tracked), tracked);

// 写法：目录带不带斜杠、通配、main
const m = filesMatcher({ files: ['./lib', '*.yml', 'assets/**/*.svg'], main: 'bin/agent.mjs' });
assert.deepEqual(['lib/x.js', 'liberty.js', 'a.yml', 'sub/a.yml', 'assets/i/a.svg', 'assets/a.png', 'bin/agent.mjs'].map(m),
	[true, false, true, false, true, false, true]);
assert.equal(filesMatcher({ files: 'lib' }), null, 'files 不是数组 ⇒ 当作没有白名单');

console.log('shipped-files: ok');
