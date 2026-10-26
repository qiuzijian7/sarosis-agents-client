/*
 * 守卫：**审核（review）**（2026-10-25）。
 *
 * 状态写在笔记自己的 frontmatter（`review` / `reviewedAt`），所以这条守卫必须证明：
 *   ① 能正确区分「已审 / 未审」（没有 review 键 = 未审）
 *   ② 标记后 **其它 frontmatter 键不丢**（`title` 等要原样保留）
 *   ③ 没有 frontmatter 的笔记能补出 frontmatter 且**正文不被吞**
 *   ④ 改前有备份、非法 status 被拒、笔记区外的路径被拒
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-review.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KB = new URL('../lib/index.js', import.meta.url).href;
const FND = new URL('../../vssaros-foundation/lib/index.js', import.meta.url).href;
const mod = await import(KB);
const fnd = await import(FND);
const foundation = fnd.createFoundationService();

let handler;
const noop = () => () => {};
const ctx = new Proxy({}, {
	get(_t, key) {
		if (key === 'inject') {
			return (deps, cb) => {
				if (Array.isArray(deps) && deps.includes('webServer')) {
					cb({
						effect: fn => { fn(); return noop(); },
						connection: { requestRejection: () => undefined },
						webServer: { register: spec => { handler = spec.handler; return noop(); } },
					});
				} else if (Array.isArray(deps) && deps.includes('vssarosFoundation')) {
					cb({ vssarosFoundation: foundation });
				}
				return noop();
			};
		}
		if (key === 'effect') { return fn => { try { const d = fn(); return typeof d === 'function' ? d : noop(); } catch { return noop(); } }; }
		if (key === 'get') { return n => (n === 'vssarosFoundation' ? foundation : null); }
		if (key === 'tools') { return { register: noop }; }
		if (key === 'on') { return noop; }
		return undefined;
	},
});

const vault = mkdtempSync(join(tmpdir(), 'kb-review-'));
mkdirSync(join(vault, '库'), { recursive: true });
mkdirSync(join(vault, '笔记'), { recursive: true });

const aPath = join(vault, '笔记', 'a.md');
const bPath = join(vault, '笔记', 'b.md');
const cPath = join(vault, '笔记', 'c.md');
writeFileSync(aPath, '---\ntitle: A 篇\ntags: [x]\n---\n\n# A\n\n正文甲。\n', 'utf8');
writeFileSync(bPath, '---\ntitle: B 篇\nreview: approved\n---\n\n# B\n\n正文乙。\n', 'utf8');
writeFileSync(cPath, '# C\n\n没有 frontmatter 的正文丙。\n', 'utf8');

mod.apply(ctx, {
	dataRoot: mkdtempSync(join(tmpdir(), 'kb-review-root-')),
	hostHalf: true,
	kbVaults: JSON.stringify([{ id: 'demo', name: '临时库', path: vault }]),
});

const call = async (path, method = 'GET', body = '') => {
	const out = [];
	const req = { method, url: path };
	if (method === 'POST') {
		req[Symbol.asyncIterator] = async function* () { if (body) { yield Buffer.from(body); } };
	}
	await handler(req, { writeHead() {}, end(b) { out.push(String(b ?? '')); } });
	return JSON.parse(out.join('') || '{}');
};

await call('/x/kb/api/view-data');

let pass = 0;
const failed = [];
const t = (name, ok, extra = '') => {
	if (ok) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};

const before = await call('/x/kb/api/review');
t('清单：3 篇 / 已审 1 / 未审 2', before.total === 3 && before.approvedCount === 1 && before.unreviewedCount === 2,
	JSON.stringify({ t: before.total, a: before.approvedCount, u: before.unreviewedCount }));
t('未审清单里不含已审那篇', !(before.unreviewed || []).some(r => r.rel.endsWith('b.md')));

// 标记 a.md 为已审
const markA = await call('/x/kb/api/review/mark', 'POST', JSON.stringify({ uri: aPath.replace(/\\/g, '/'), status: 'approved' }));
t('标记接口返回 ok', markA.ok === true, JSON.stringify(markA).slice(0, 120));
const aText = readFileSync(aPath, 'utf8');
t('写入 review: approved', /^review:\s*approved$/m.test(aText), aText.split('\n').slice(0, 6).join(' | '));
t('保留原有 frontmatter 键（title / tags）', aText.includes('title: A 篇') && aText.includes('tags: [x]'));
t('写入 reviewedAt', /^reviewedAt:\s*\d{4}-\d{2}-\d{2}$/m.test(aText));
t('正文没有被吞', aText.includes('正文甲。'));
t('改前有备份', existsSync(join(vault, '笔记', '.kb-backup')));

// 无 frontmatter 的 c.md
const markC = await call('/x/kb/api/review/mark', 'POST', JSON.stringify({ uri: cPath.replace(/\\/g, '/'), status: 'rejected' }));
const cText = readFileSync(cPath, 'utf8');
t('无 frontmatter 时补出 frontmatter', cText.startsWith('---\n') && /^review:\s*rejected$/m.test(cText), cText.slice(0, 80));
t('补 frontmatter 后正文仍在', cText.includes('没有 frontmatter 的正文丙。'));

const after = await call('/x/kb/api/review');
t('再查：已审 2 / 未审 1（那篇 rejected 也算未通过）', after.approvedCount === 2 && after.rejectedCount === 1,
	JSON.stringify({ a: after.approvedCount, r: after.rejectedCount, u: after.unreviewedCount }));

const badStatus = await call('/x/kb/api/review/mark', 'POST', JSON.stringify({ uri: aPath.replace(/\\/g, '/'), status: 'whatever' }));
t('非法 status 被拒', badStatus.ok === false);

const outside = await call('/x/kb/api/review/mark', 'POST', JSON.stringify({ uri: 'C:/Windows/notepad.exe', status: 'approved' }));
t('笔记区外路径被拒', outside.ok === false);

console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（审核）`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（审核：状态判定 / frontmatter 保留 / 备份 / 拒绝路径）`);
