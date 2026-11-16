/*
 * 守卫：`feishu-sync.mjs` 的 `--src` 参数必须**逐目录**下发，不能被拆成单字。
 *
 * 起因（2026-10-28 真机）：
 *   `performFeishuSync` 传的是 `src: NOTES_DIR`（字符串 `'知识库列表'`），而
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
	const srcs = srcsOf(buildFeishuSyncArgs({ vault: 'V', src: '知识库列表' }));
	assert.deepStrictEqual(srcs, ['知识库列表'], '实际 = ' + JSON.stringify(srcs));
});

check('数组入参 ⇒ 原样逐个下发', () => {
	const srcs = srcsOf(buildFeishuSyncArgs({ vault: 'V', src: ['知识库列表', '数据源/x'] }));
	assert.deepStrictEqual(srcs, ['知识库列表', '数据源/x'], '实际 = ' + JSON.stringify(srcs));
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

/*
 * ★ 2026-11-12：设置页「本地覆盖」旧值写 'local'，而 Host 判据是
 *   `conflict === 'skip' ? 'skip' : 'overwrite'`、CLI 只认 '--on-conflict overwrite'。
 *   值名分叉 ⇒ 设置改成 overwrite 后下拉找不到匹配项，回显成「跳过」，用户以为没生效。
 */
const CLIENT = readFileSync(HERE + '../lib/client.js', 'utf8');
check('★ 冲突口径统一：设置页选项值 = Host/CLI 的 skip | overwrite', () => {
	const at = CLIENT.indexOf('远端手改时');
	const seg = at < 0 ? '' : CLIENT.slice(at, at + 700);
	assert.ok(seg.includes('远端手改时'), '找不到冲突设置控件');
	assert.ok(/value:\s*'overwrite'/.test(seg), '「本地覆盖」选项值必须是 overwrite');
	assert.ok(!/value:\s*'local'/.test(seg), '仍残留 local 值（Host/CLI 不认）');
	// 旧存量 'local' 归一到 overwrite：只有显式 skip 才是 skip
	assert.ok(/===\s*'skip'\s*\?\s*'skip'\s*:\s*'overwrite'/.test(seg), '下拉回显没归一旧值');
	assert.ok(/onConflict:\s*feishuCfg\.conflict === 'skip' \? 'skip' : 'overwrite'/.test(INDEX),
		'Host 判据与选项值不一致');
});
check('★ 参数组装只下发 skip / overwrite 两种值', () => {
	const args = buildFeishuSyncArgs({ vault: 'V', onConflict: 'overwrite' });
	assert.equal(args[args.indexOf('--on-conflict') + 1], 'overwrite');
	const a2 = buildFeishuSyncArgs({ vault: 'V', onConflict: 'skip' });
	assert.equal(a2[a2.indexOf('--on-conflict') + 1], 'skip');
});
check('反向突变自证：选项值写回 local 会被上一条抓到', () => {
	const broken = CLIENT.replace(/value: 'overwrite'/, "value: 'local'");
	const at = broken.indexOf('远端手改时');
	assert.ok(/value:\s*'local'/.test(broken.slice(at, at + 700)));
});

console.log('\n' + '='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（飞书同步 --src 参数口径）`);
