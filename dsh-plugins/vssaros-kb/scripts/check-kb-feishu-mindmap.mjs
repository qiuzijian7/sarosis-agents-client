/*
 * 守卫：飞书同步的**思维导图（mindmap）**维护必须能自愈。
 *
 * 起因（2026-10-29 真机）：
 *   索引 `.feishu-sync.json` 里记的 `nodeToken` 指向的飞书节点**已被删除**（131012
 *   "node has been deleted"）⇒ 老代码「跳过本次更新」且**不清记录** ⇒
 *   该空间的导图从此永远不重建，而且每次同步都重复报同一条错。
 *
 * 另外两条：
 *   ② 错误 JSON 打在 **stderr** 上（老代码只解析 stdout ⇒ 判不出 131012）；
 *   ③ 索引里"已不在当前映射内"的遗留记录要清掉（否则每次都撞一次删除失败）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = readFileSync(HERE + '../scripts/feishu-sync.mjs', 'utf8');
const INDEX = readFileSync(HERE + '../lib/index.js', 'utf8');
const CLIENT = readFileSync(HERE + '../lib/client.js', 'utf8');

let pass = 0;
const failed = [];
function check(name, fn) {
	try { fn(); pass += 1; console.log('PASS  ' + name); }
	catch (e) { failed.push(name); console.log('FAIL  ' + name + '  — ' + (e && e.message ? e.message : e)); }
}

check('mindmap 删除失败时能识别「节点已不存在」（131012 / node has been deleted）', () => {
	if (!SCRIPT.includes('const gone = errCode === 131012')) { throw new Error('缺少 gone 判定'); }
	if (!/node has been deleted/i.test(SCRIPT)) { throw new Error('缺少文案匹配'); }
});

check('「节点已不存在」⇒ 清掉陈旧记录并继续重建（不再永久跳过）', () => {
	if (!SCRIPT.includes('delete idx.mindmaps[spaceId];')) { throw new Error('未清理陈旧记录'); }
	if (!SCRIPT.includes('清理记录并重建')) { throw new Error('缺少重建提示'); }
});

check('清理失败 JSON 从 stdout 与 stderr 两个通道解析', () => {
	if (!SCRIPT.includes('extractJson(del.stdout) || extractJson(del.stderr)')) { throw new Error('未做双通道解析'); }
});

check('清理「已不在当前映射内」的遗留导图记录', () => {
	if (!SCRIPT.includes('清理已不在当前映射内的导图记录')) { throw new Error('缺少遗留记录清理'); }
});

check('写节点失败时尽力删除刚建的空导图节点（不留孤儿）', () => {
	if (!/节点写入失败[\s\S]{0,900}?\+node-delete/.test(SCRIPT)) { throw new Error('未做孤儿清理'); }
});

check('服务端记录每次同步的结果（code / 错误 / 告警条数）', () => {
	if (!INDEX.includes('SYNC_STATE.lastWarnings')) { throw new Error('未记录 lastWarnings'); }
	if (!INDEX.includes('lastWarnings: SYNC_STATE.lastWarnings ?? 0')) { throw new Error('schedule 未暴露 lastWarnings'); }
});

check('面板「同步飞书」不再用会阻塞渲染进程的 window.alert', () => {
	const i = CLIENT.indexOf('feishuSync:');
	if (i < 0) { throw new Error('未找到 feishuSync 动作'); }
	const body = CLIENT.slice(i, i + 1200);
	if (/window\.alert/.test(body)) { throw new Error('仍在用 window.alert（会阻塞）'); }
	if (!body.includes('kb:feishu-sync-result')) { throw new Error('未把结果广播给 bundle'); }
});

console.log('\n' + (failed.length ? `✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项` : `✓ 全部 ${pass} 项通过`));
if (failed.length) { process.exit(1); }
