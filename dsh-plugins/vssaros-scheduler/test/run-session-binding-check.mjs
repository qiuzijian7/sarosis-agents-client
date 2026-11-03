// 会话归属「根治」的独立单测：造一个临时数据根，覆盖跨环境 / 会话被删 / 解绑 / 旧数据兼容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindFoundation } from '../lib/foundationRef.js';
import { bindingOf, currentRoot, normalizeRoot, sessionExists, sessionsDirOf, stampSession } from '../lib/sessionBinding.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
	if (cond) { pass += 1; console.log(`  ok   ${name}`); }
	else { fail += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-sb-'));
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-sb-other-'));
try {
	// foundation 是唯一真源：这里绑一个假的，让 dataRootOf(config) 返回我们造的临时根。
	bindFoundation({ dataRootOf: (cfg) => cfg?.dataRoot ?? root });
	const config = { dataRoot: root };
	fs.mkdirSync(path.join(sessionsDirOf(root), 'ws-a', 'session-abc'), { recursive: true });

	console.log('── 路径与存在性 ──');
	eq('currentRoot 归一化到当前数据根', currentRoot(config), normalizeRoot(root));
	eq('存在性：abc', sessionExists(root, 'abc'), true);
	eq('存在性：带 session- 前缀', sessionExists(root, 'session-abc'), true);
	eq('存在性：不存在的会话', sessionExists(root, 'zzz'), false);
	eq('存在性：数据根不存在时降级为 false', sessionExists(path.join(root, 'nope'), 'abc'), false);

	console.log('── 归属判定 ──');
	eq('未绑定', bindingOf({ sessionId: '' }, config).state, 'unbound');
	eq('本环境 + 会话在 ⇒ ok', bindingOf({ sessionId: 'abc', sessionRoot: normalizeRoot(root) }, config).state, 'ok');
	eq('本环境 + 会话被删 ⇒ missing', bindingOf({ sessionId: 'zzz', sessionRoot: normalizeRoot(root) }, config).state, 'missing');
	eq('跨环境 ⇒ foreign', bindingOf({ sessionId: 'abc', sessionRoot: normalizeRoot(other) }, config).state, 'foreign');
	eq('旧任务（无 sessionRoot）仍靠存在性拦住', bindingOf({ sessionId: 'zzz' }, config).state, 'missing');
	eq('旧任务（无 sessionRoot）+ 会话在 ⇒ ok', bindingOf({ sessionId: 'abc' }, config).state, 'ok');
	check('foreign 的提示是可行动的', /用当前会话/.test(bindingOf({ sessionId: 'abc', sessionRoot: normalizeRoot(other) }, config).message));

	console.log('── 写入盖章 ──');
	eq('盖章写当前 root', stampSession({ sessionId: 'abc', title: 'x' }, config).sessionRoot, currentRoot(config));
	eq('解绑清空归属', stampSession({ sessionId: '' }, config).sessionRoot, '');
	eq('本次没带 sessionId ⇒ 不动归属', stampSession({ title: 'x' }, config).sessionRoot, undefined);
} finally {
	for (const d of [root, other]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } }
}
console.log(`\n[session-binding] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
