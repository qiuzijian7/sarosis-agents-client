/*
 * 守卫：`scripts/dsh-plugin-deploy.mjs` 必须**真的**把改动落到宿主读的那份，
 * 并且**证明**落地了（否则就是"报成功但不同步"）。
 *
 * 起因（2026-10-29，连续 8 次假成功的四个根因）：
 *   ① 目标只写 node_modules/@vssaros/<pkg> ⇒ 宿主真正读的
 *      `.vssaros/plugins/<pkg>-<版本>-<哈希>/`（已安装副本）压根没被更新；
 *   ② `--changed` 遇到"repo 版本 ≠ 已装版本"就跳过复制 ⇒ 天天在改的插件正好命中；
 *   ③ SKIP_DIRS 含 'scripts' ⇒ 插件的 scripts/（服务端 spawn 的那份）永远同步不过去；
 *   ④ 复制后不校验 ⇒ 漏文件/失败/写错目录也报成功。
 *
 * 跑法：node dsh-plugins/check-deploy-sync.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.dirname(HERE);
const SRC = path.join(ROOT, 'scripts', 'dsh-plugin-deploy.mjs');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0;
const failed = [];
function check(name, fn) {
	try { fn(); pass += 1; console.log('PASS  ' + name); }
	catch (e) { failed.push(name); console.log('FAIL  ' + name + '  — ' + (e && e.message ? e.message : e)); }
}

check('① 目标包含**已安装副本**（.vssaros/plugins/<pkg>-<版本>-<哈希>）', () => {
	assert.ok(src.includes('installedCopiesOf'), '缺少 installedCopiesOf');
	assert.ok(src.includes(".vssaros', 'plugins'"), "没有指向 .vssaros/plugins");
	assert.ok(/vssaros-/.test(src), '没有按插件名匹配版本化目录');
});

check('② --changed 不再因"版本不一致"跳过复制', () => {
	assert.ok(!/leave-to-official/.test(src) || src.includes('versionDrift'),
		'仍在用 leave-to-official 跳过复制');
	assert.ok(src.includes('versionDrift'), '没有 versionDrift 概念');
});

check('③ 插件的 scripts/ 不再被排除（服务端 spawn 的那份要能同步）', () => {
	const m = src.match(/const SKIP_DIRS = new Set\(\[([^\]]*)\]\)/);
	assert.ok(m, '没找到 SKIP_DIRS');
	assert.ok(!/'scripts'/.test(m[1]), "SKIP_DIRS 里还有 'scripts'");
});

check('④ 复制后逐文件 sha256 校验', () => {
	assert.ok(src.includes('sha256File'), '缺少 sha256File');
	assert.ok(/for \(const rel of changed\)/.test(src) && /a !== b/.test(src), '没有逐文件比对');
});

check('⑤ 校验不过 ⇒ 非零退出（假成功必须让机器看见）', () => {
	assert.ok(src.includes('process.exitCode = 1'), '失败时没有设置非零退出码');
	assert.ok(src.includes('failures.push'), '没有 failures 收集');
});

check('⑥ 复制失败变成可读错误（不抛栈）', () => {
	assert.ok(/catch \(e\) \{/.test(src), '复制没有 try/catch');
	assert.ok(src.includes('复制失败'), '没有可读的复制失败提示');
});

check('⑦ 脚本本身能跑（--verify 不崩、退出码 0）', () => {
	const out = execFileSync(process.execPath, [SRC, '--verify', 'vssaros-kb'], { encoding: 'utf8' });
	assert.ok(out.includes('vssaros-kb'), '输出里没有插件名');
});

console.log('\n' + (failed.length ? `✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项` : `✓ 全部 ${pass} 项通过`));
if (failed.length) { process.exit(1); }
