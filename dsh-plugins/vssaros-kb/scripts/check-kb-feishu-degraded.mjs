/*
 * 2026-11-12：飞书同步「响应判定 / 结果汇总」正确性守卫。
 *
 * 触发：用户贴 apply 日志，18 篇全是 `degrade_code=4030004 ... No permission to operate
 *   on this document`，响应形如
 *     { ok:false, data:{ document:{revision_id:4,...}, result:"failed", warnings:[...] } }
 * 评估发现三个真实缺陷：
 *   ① 旧判据只看 `payload.ok === false`；同形态若被 `ok:true` 包装（降阶语义常见）
 *      ⇒ 当成成功 → 写 frontmatter 标记已同步 → 远端没变 → 下次 hash 相同被 skip
 *      ⇒ **静默丢数据**。且错误消息取 payload.error.message，降阶响应里没有该字段
 *      ⇒ 退化成 stdout 前 300 字符，日志里被截断成半句（用户贴的日志正是如此）。
 *   ② `--on-conflict skip` 的冲突跳过走 continue，既不算 done 也不算 failed 也不进报告。
 *   ③ 导图失败只 warn，不影响汇总与退出码 ⇒ 正文全成功时 Host 仍判 ok:true。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-feishu-degraded.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = readFileSync(HERE + '../scripts/feishu-sync.mjs', 'utf8');
const IDE_SCRIPT = readFileSync(HERE + '../../../resources/.agents/kb/feishu-sync.mjs', 'utf8');
const {
	larkFailure, larkDegradeCode, formatSyncReport, pickDocInfo,
} = await import(new URL('../scripts/feishu-sync.mjs', import.meta.url).href);

let pass = 0, fail = 0;
const check = (name, fn) => {
	try { fn(); pass++; console.log('PASS  ' + name); }
	catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + String(e?.message ?? e)); }
};

/** 用户日志里那条降阶响应（完整形态） */
const degraded = {
	ok: false, identity: 'bot',
	data: {
		document: { revision_id: 4, url: 'https://my.feishu.cn/docx/QUO4dMYqmoL9cmxAI6DceNBTnFf' },
		result: 'failed',
		warnings: ['degrade_code=4030004,msg=Document operation failed: No permission to operate on this document'],
	},
};

check('① 两份同步脚本字节一致', () => {
	assert.equal(Buffer.compare(Buffer.from(SCRIPT), Buffer.from(IDE_SCRIPT)), 0);
});

check('② ★ ok:false 降阶响应：判失败且原因可读（含 4030004 与完整 msg）', () => {
	const why = larkFailure(degraded, '');
	assert.ok(why, '不该放行');
	assert.ok(why.includes('ok:false'));
	assert.ok(why.includes('data.result=failed'));
	assert.ok(why.includes('4030004'));
	assert.ok(why.includes('No permission to operate on this document'), '原因被截断 ✗');
	assert.equal(larkDegradeCode(degraded), '4030004');
});

check('③ ★★ 同形态但 ok:true（静默丢数据场景）也必须判失败', () => {
	const wrapped = { ...degraded, ok: true };
	const why = larkFailure(wrapped, '');
	assert.ok(why, 'ok:true 包装的降阶响应被当成成功 ⇒ 会写 frontmatter 并永久 skip ✗');
	assert.ok(why.includes('4030004'));
	// 旧判据的对照：只看 ok:false 确实会放行（证明本守卫不是恒真）
	assert.equal(!wrapped || wrapped.ok === false, false);
});

check('④ 其它形态：正常成功 / 普通 error / 空响应', () => {
	assert.equal(larkFailure({ ok: true, data: { document: { document_id: 'abc' } } }, ''), '', '正常成功被误判');
	const normal = larkFailure({ ok: false, error: { code: 99991672, message: 'no scope' } }, '');
	assert.ok(normal.includes('no scope'));
	assert.ok(larkFailure(null, 'cli not found').includes('cli not found'));
	assert.ok(larkFailure(undefined, '').length > 0);
	assert.equal(larkDegradeCode({ ok: true, data: {} }), '');
});

check('⑤ 降级短码可从数组 / 字符串形态的 warnings 中提取', () => {
	assert.equal(larkDegradeCode({ data: { warnings: ['a', 'degrade_code=131006,msg=bot lacks permission'] } }), '131006');
	assert.equal(larkDegradeCode({ data: { warnings: 'degrade_code=4030004,msg=boom' } }), '4030004');
	assert.equal(larkDegradeCode({ data: {} }), '');
	assert.equal(larkDegradeCode(null), '');
});

check('⑥ ★ 正文写入主路径确实调用新判据，且旧「只看 ok」写法已清除', () => {
	assert.ok(/const why = larkFailure\(payload, r\.stderr \|\| r\.stdout\);/.test(SCRIPT));
	assert.ok(/if \(why\) \{[\s\S]*?larkDegradeCode\(payload\)/.test(SCRIPT), '失败时没带 degrade_code');
	// 主写入路径里不该再有裸的 `payload.ok === false` 判定；其它辅助路径允许保留
	const mainSeg = SCRIPT.slice(SCRIPT.indexOf('const cmdArgs = token'), SCRIPT.indexOf('const info = pickDocInfo(payload);'));
	assert.ok(!/payload\.ok === false/.test(mainSeg), '主路径仍只看 ok:false ✗');
});

check('⑦ ★ 冲突跳过如实计数并进汇总 / 报告', () => {
	assert.ok(/let conflictSkipped = 0/.test(SCRIPT));
	assert.ok(/conflictSkipped\+\+;/.test(SCRIPT));
	assert.ok(/另有 \$\{conflictSkipped\} 篇因远端手改跳过/.test(SCRIPT));
	assert.ok(/reportItems\.push\(`跳过 \$\{p\.rel\}/.test(SCRIPT));
	const rpt = formatSyncReport({ dryRun: false, done: 18, skip: 56, total: 20, failed: 18, conflictSkipped: 2, mindmapFailed: 5, items: [] });
	assert.ok(rpt.includes('另有 2 篇因远端手工修改'), '报告没体现冲突跳过');
	assert.ok(rpt.includes('失败 18 篇'), '报告没体现失败数');
	assert.ok(rpt.includes('5 个知识库导图未更新'), '报告没体现导图失败');
});

check('⑧ ★ 导图失败纳入汇总与非零退出码', () => {
	assert.ok(/mindmapFailed = updateMindmaps\(/.test(SCRIPT));
	assert.ok(/if \(failed \|\| mindmapFailed\) \{[\s\S]*?process\.exitCode = 1/.test(SCRIPT));
	assert.ok(/另有 \$\{mindmapFailed\} 个导图未更新/.test(SCRIPT));
	assert.ok(!/思维导图更新失败（不影响同步结果）/.test(SCRIPT), '不该再说「不影响同步结果」');
});

check('⑨ 不再有重复的 continue（真机代码里发现的无害冗余）', () => {
	assert.ok(!/continue;\s*\n\s*continue;/.test(SCRIPT));
});

check('⑨b 写同步日志前先建 .kb 目录（新 vault 不会 ENOENT 崩溃）', () => {
	assert.ok(/fs\.mkdirSync\(path\.dirname\(logPath\), \{ recursive: true \}\)/.test(SCRIPT));
	assert.ok(/fs\.appendFileSync\(logPath,/.test(SCRIPT));
});

check('⑩ 反向突变自证：把主路径改回只看 ok:false 会被 ⑥ 抓到', () => {
	const broken = SCRIPT.replace('const why = larkFailure(payload, r.stderr || r.stdout);',
		'const why = (!payload || payload.ok === false) ? "x" : "";');
	const seg = broken.slice(broken.indexOf('const cmdArgs = token'), broken.indexOf('const info = pickDocInfo(payload);'));
	assert.ok(/payload\.ok === false/.test(seg) && !/payload\.ok === false/.test(
		SCRIPT.slice(SCRIPT.indexOf('const cmdArgs = token'), SCRIPT.indexOf('const info = pickDocInfo(payload);'))));
});

check('⑪ 降阶响应仍能被 pickDocInfo 正确读出 url（错误信息不再只靠 stdout 截断）', () => {
	assert.equal(pickDocInfo(degraded).url, 'https://my.feishu.cn/docx/QUO4dMYqmoL9cmxAI6DceNBTnFf');
	assert.equal(pickDocInfo({ ok: true, data: { document: { document_id: 'abc123456' } } }).token, 'abc123456');
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { process.exit(1); }
