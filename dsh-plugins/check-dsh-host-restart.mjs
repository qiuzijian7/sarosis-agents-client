/*
 * 守卫：**复用的 dsh Host 死掉后，本实例必须自己再起一个**。
 *
 * 起因（2026-10-29 真机）：知识库「本地载入文件夹」一直"载入失败" + 聊天页空白。
 *   日志三连：
 *     18:32:30  reusing the Host started by pid 77456 at http://127.0.0.1:1974
 *     18:33:02  bridge closed; watching the lease in case the owner restarts the Host
 *     18:33:22  the reused Host is gone          ← 20s 后放弃
 *   那个 Host 属于**上一个 IDE 实例**（已关掉）⇒ 永远等不到它重启 ⇒
 *   dsh 侧整体不可用（/x/kb/api/* 全 fetch failed ⇒ "载入失败"；聊天页 about:blank）。
 *
 * 跑法：node dsh-plugins/check-dsh-host-restart.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = path.dirname(HERE);
const SRC = path.join(ROOT, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'electron-main', 'dshHostSupervisor.ts');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0;
const failed = [];
function check(name, fn) {
	try { fn(); pass += 1; console.log('PASS  ' + name); }
	catch (e) { failed.push(name); console.log('FAIL  ' + name + '  — ' + (e && e.message ? e.message : e)); }
}

const goneIdx = src.indexOf("the reused Host is gone");
check('存在 the reused Host is gone 分支', () => {
	if (goneIdx < 0) { throw new Error('没找到该分支'); }
});

check('复用 Host 消失后**自己再起一个**（而不是停在 stopped）', () => {
	if (goneIdx < 0) { throw new Error('没找到该分支'); }
	const tail = src.slice(goneIdx, goneIdx + 2600);
	if (!/this\.start\(restartOptions\)/.test(tail)) {
		throw new Error('没有调用 start() 重启自己的 Host');
	}
	if (!/restartOptions = this\._requestedOptions \?\? \{\}/.test(tail)) {
		throw new Error('没有沿用上次的启动选项');
	}
});

check('重起失败也要留痕（不能静默）', () => {
	const tail = src.slice(goneIdx, goneIdx + 2600);
	if (!/failed to start our own Host/.test(tail)) { throw new Error('失败没有写日志'); }
});

console.log('\n' + (failed.length ? `✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项` : `✓ 全部 ${pass} 项通过`));
if (failed.length) { process.exit(1); }
