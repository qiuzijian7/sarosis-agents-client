/*
 * 守卫：**元数据必须收在 `.kb/` 一个目录里**（★ 2026-11-02）。
 *
 * 起因：索引 / 飞书映射 / 各类缓存 / 日志原先全散在库根，用户反馈「json 文件太多」。
 * 契约：
 *   ① 真源只有 `lib/core/kbMeta.js`（目录名 + 文件名 + 新旧路径映射）
 *   ② 业务代码里**不许再出现**库根旧文件名（`.kbkernel.json` 之类）
 *   ③ `core/kb.js` 的 `KERNEL_FILE` 等常量必须指向 `.kb/`
 *   ④ 真实库：`.kb/kernel.json` 存在、库根没有旧散件
 *   ⑤ `.gitignore` 有 `.kb/`
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-meta.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const KB = path.join(REPO, 'dsh-plugins/vssaros-kb');

let fail = 0;
const check = (name, fn) => {
	try {
		const d = fn();
		console.log('PASS  ' + name + (d ? '  — ' + d : ''));
	} catch (e) {
		fail += 1;
		console.log('FAIL  ' + name + '  — ' + String((e && e.message) || e).slice(0, 200));
	}
};

const read = (p) => fs.readFileSync(p, 'utf8');

/* ① 真源存在且目录名正确 */
const metaSrc = read(path.join(KB, 'lib/core/kbMeta.js'));
check('真源 kbMeta.js：META_DIR = .kb，且列全 12 类元数据', () => {
	if (!/export const META_DIR = '\.kb';/.test(metaSrc)) { throw new Error("META_DIR 不是 '.kb'"); }
	const keys = ['kernel', 'ftindex', 'feishu', 'spaceMap', 'layout', 'buildCache', 'ingestCache', 'insightsCache', 'topicCache', 'schema', 'opLog', 'htmlCache'];
	const miss = keys.filter((k) => !new RegExp('\\b' + k + ':').test(metaSrc));
	if (miss.length) { throw new Error('缺键：' + miss.join(',')); }
	if (!/export function resolveMetaPath/.test(metaSrc)) { throw new Error('缺 resolveMetaPath（双读兼容）'); }
	if (!/export function ensureMetaDir/.test(metaSrc)) { throw new Error('缺 ensureMetaDir（写前建目录）'); }
	return keys.length + ' 类';
});

/* ② 业务代码不许再写库根旧名 */
const LEGACY = ['.kbkernel.json', '.ftindex.json', '.feishu-space-map.json', '.kb-layout.json', '.kb-build-cache.json', '.kb-ingest-cache.json', '.kb-insights-cache.json', '.kb-topic-overview-cache.json', '.kb-html-cache'];
const ALLOW = ['kbMeta.js', 'kb-migrate-meta.mjs', 'kb-migrate-layout.mjs', 'kb-reorg-topics.mjs', 'check-kb-meta.mjs'];

const offenders = [];
const walk = (d) => {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) {
			if (/node_modules|\.git|^web$/.test(e.name)) { continue; }
			walk(p);
			continue;
		}
		if (!/\.(js|mjs)$/.test(e.name)) { continue; }
		if (ALLOW.includes(e.name)) { continue; }
		const s = read(p);
		for (const L of LEGACY) {
			// 只认"作为路径用"的形态：引号里、或 join(...) 里
			if (s.includes("'" + L + "'") || s.includes('"' + L + '"')) {
				offenders.push(p.replace(REPO + path.sep, '').replace(/\\/g, '/') + ' → ' + L);
			}
		}
	}
};
walk(path.join(KB, 'lib'));
walk(path.join(KB, 'scripts'));
check('业务代码不再引用库根旧文件名（只有真源/迁移脚本可以）', () => {
	if (offenders.length) { throw new Error(offenders.slice(0, 3).join(' | ') + (offenders.length > 3 ? ' …共 ' + offenders.length : '')); }
	return '干净';
});

/* ③ 常量指向 .kb/ */
const kbSrc = read(path.join(KB, 'lib/core/kb.js'));
check('core/kb.js 的 KERNEL_FILE 指向 .kb/', () => {
	const m = /export const KERNEL_FILE = '([^']+)'/.exec(kbSrc);
	if (!m) { throw new Error('找不到 KERNEL_FILE'); }
	if (!m[1].startsWith('.kb/')) { throw new Error('KERNEL_FILE = ' + m[1]); }
	return m[1];
});

/* ④ 真实库体检（E: 主库；没有就跳过） */
const VAULT = 'E:/VsSarosVault';
check('真实库：.kb/kernel.json 在，库根无旧散件', () => {
	if (!fs.existsSync(VAULT)) { return '（跳过：没有 E: 库）'; }
	const kernel = path.join(VAULT, '.kb/kernel.json');
	if (!fs.existsSync(kernel)) { throw new Error('.kb/kernel.json 不存在'); }
	const junk = fs.readdirSync(VAULT).filter((n) => LEGACY.includes(n) || /^\.feishu-sync\.json$|^\.op-log\.jsonl$|^kb-schema\.json$/.test(n));
	if (junk.length) { throw new Error('库根还有旧文件：' + junk.join(',')); }
	return Math.round(fs.statSync(kernel).size / 1024) + 'KB';
});

/* ④.5 导航三件必须落在 .kb/nav/（2026-11-02 第二轮） */
check('导航三件（index/overview/insights/log）写到 .kb/nav/', () => {
	const org = read(path.join(KB, 'lib/organize.js'));
	if (!/join\(vaultRoot, '\.kb', 'nav'\)/.test(org)) { throw new Error('organize.js 没写 .kb/nav'); }
	if (/join\(notesDir, name\)/.test(org)) { throw new Error('organize.js 还在往 notesDir 根写导航'); }
	// IDE 侧同口径
	const idePath = path.join(REPO, 'src/vs/sessions/contrib/agentStudio/browser/kbImportController.ts');
	if (fs.existsSync(idePath)) {
		const ide = read(idePath);
		if (!/static _navDir\(notesDir: URI\): URI/.test(ide)) { throw new Error('IDE 缺 _navDir'); }
		if (/URI\.joinPath\((notesDir|targetDir), '(index|overview|insights|log)\.md'\)/.test(ide)) {
			throw new Error('IDE 还在往 notesDir 根写导航');
		}
	}
	// 真实库体检
	if (fs.existsSync(VAULT)) {
		const notes = path.join(VAULT, '知识库列表');
		if (fs.existsSync(notes)) {
			const strays = fs.readdirSync(notes).filter((n) => ['index.md', 'overview.md', 'insights.md', 'log.md'].includes(n));
			if (strays.length) { throw new Error('知识库列表/ 根下还有导航文件：' + strays.join(',')); }
		}
	}
	return 'ok';
});

/* ⑤ .gitignore 收敛 */
check('.gitignore 含 .kb/（一条覆盖全部元数据）', () => {
	const gi = path.join(VAULT, '.gitignore');
	if (!fs.existsSync(gi)) { return '（跳过：没有 .gitignore）'; }
	const s = read(gi);
	if (!s.split(/\r?\n/).some((l) => l.trim() === '.kb/')) { throw new Error('缺 .kb/ 条目'); }
	return 'ok';
});

console.log('\n============================================================');
console.log(fail ? '✗ ' + fail + ' 项失败' : '✓ 全部元数据目录契约通过');
process.exit(fail ? 1 : 0);
