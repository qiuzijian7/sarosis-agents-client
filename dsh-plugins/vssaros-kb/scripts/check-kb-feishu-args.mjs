/*
 * 守卫：`feishu-sync.mjs` 的 `--src` 参数必须**逐目录**下发，不能被拆成单字。
 *
 * 起因（2026-10-28 真机）：
 *   `performFeishuSync` 传的是 `src: NOTES_DIR`（字符串 `'笔记'`），而
 *   `buildFeishuSyncArgs` 里 `for (const dir of src)` 会按**字符**迭代
 *   ⇒ 实际下发 `--src 笔 --src 记` ⇒ 脚本扫不到任何文档，却以退出码 0 结束
 *   ⇒ 用户只看到 `[map] 已配置 6 条映射，但本次没有文档命中` + `create=0 update=0 skip=0`。
 *
 * 这道守卫有两层：
 *   ① **行为层**：直接跑纯函数，字符串入参只能产出 1 个 `--src`；
 *   ② **调用点**：`index.js` 里不许再出现 `src: NOTES_DIR,` 这种"字符串当数组"。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-feishu-args.mjs
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFeishuSyncArgs } from '../lib/core/kb.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const INDEX = readFileSync(HERE + '../lib/index.js', 'utf8');

let pass = 0;
const failed = [];
function check(name, fn) {
	try { fn(); pass += 1; console.log('PASS  ' + name); }
	catch (e) { failed.push(name); console.log('FAIL  ' + name + '  — ' + (e && e.message ? e.message : e)); }
}

/** 取 `--src` 后面的值列表 */
const srcsOf = (args) => args.reduce((acc, a, i) => (a === '--src' ? acc.concat([args[i + 1]]) : acc), []);

check('字符串入参 ⇒ 只产出 1 个 --src（不是逐字符）', () => {
	const srcs = srcsOf(buildFeishuSyncArgs({ vault: 'V', src: '笔记' }));
	assert.deepStrictEqual(srcs, ['笔记'], '实际 = ' + JSON.stringify(srcs));
});

check('数组入参 ⇒ 原样逐个下发', () => {
	const srcs = srcsOf(buildFeishuSyncArgs({ vault: 'V', src: ['笔记', '库/x'] }));
	assert.deepStrictEqual(srcs, ['笔记', '库/x'], '实际 = ' + JSON.stringify(srcs));
});

check('空 / 缺省 ⇒ 不下发 --src', () => {
	assert.deepStrictEqual(srcsOf(buildFeishuSyncArgs({ vault: 'V', src: [] })), []);
	assert.deepStrictEqual(srcsOf(buildFeishuSyncArgs({ vault: 'V' })), []);
	assert.deepStrictEqual(srcsOf(buildFeishuSyncArgs({ vault: 'V', src: '   ' })), []);
});

check('调用点用数组传 NOTES_DIR（不许 `src: NOTES_DIR,`）', () => {
	assert.ok(/src:\s*\[NOTES_DIR\]/.test(INDEX), 'index.js 必须写 src: [NOTES_DIR]');
	assert.ok(!/src:\s*NOTES_DIR\s*,/.test(INDEX), 'index.js 仍有 src: NOTES_DIR（字符串当数组）');
});

check('默认 dry-run 且显式写 --dry-run', () => {
	assert.ok(buildFeishuSyncArgs({ vault: 'V' }).includes('--dry-run'));
	assert.ok(buildFeishuSyncArgs({ vault: 'V', apply: true }).includes('--apply'));
});

console.log('\n' + '='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（飞书同步 --src 参数口径）`);
