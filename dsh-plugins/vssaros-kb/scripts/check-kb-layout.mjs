/*
 * 布局契约守卫（★ 2026-11-02 目录改名）
 *
 *   `库` → `数据源`、`笔记` → `知识库列表`。这件事一旦回退，代价是**静默的**：
 *     · 索引按旧目录扫 ⇒ 0 篇命中（界面空白，不报错）
 *     · 飞书同步按旧前缀比对 ⇒ 认为从没同步过 ⇒ **重复建文档**
 *
 *   所以钉三条：
 *     ① 两个常量必须是新名；旧名只允许以 `*_LEGACY` 形式存在
 *     ② 运行期代码里不许再出现旧名的**路径字面量**（注释/迁移脚本除外）
 *     ③ 迁移脚本必须**幂等**：老库跑一次改名 + 重写飞书键；再跑一次说"已是新布局"
 *
 *   跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-layout.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LIB = path.join(HERE, '..', 'lib');
const SCRIPTS = HERE;

let fail = 0;
const check = (name, fn) => {
	try {
		const detail = fn();
		console.log('PASS  ' + name + (detail ? '  — ' + detail : ''));
	} catch (e) {
		fail += 1;
		console.log('FAIL  ' + name + '  — ' + String((e && e.message) || e).slice(0, 200));
	}
};

const read = (p) => fs.readFileSync(p, 'utf8');

// ── ① 常量 ────────────────────────────────────────────────────────────────
const kbSrc = read(path.join(LIB, 'core', 'kb.js'));

check('常量：LIBRARY_DIR = 数据源 / NOTES_DIR = 知识库列表', () => {
	if (!/export const LIBRARY_DIR = '数据源';/.test(kbSrc)) { throw new Error('LIBRARY_DIR 不是「数据源」'); }
	if (!/export const NOTES_DIR = '知识库列表';/.test(kbSrc)) { throw new Error('NOTES_DIR 不是「知识库列表」'); }
	return 'ok';
});

check('旧名只以 *_LEGACY 存在（迁移脚本用，运行期不引用）', () => {
	if (!/export const LIBRARY_DIR_LEGACY = '库';/.test(kbSrc)) { throw new Error('缺 LIBRARY_DIR_LEGACY'); }
	if (!/export const NOTES_DIR_LEGACY = '笔记';/.test(kbSrc)) { throw new Error('缺 NOTES_DIR_LEGACY'); }
	return 'ok';
});

// ── ② 运行期代码里的旧名字面量 ────────────────────────────────────────────
const files = [];
const walk = (d) => {
	for (const f of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, f.name);
		if (f.isDirectory()) { if (f.name !== 'web') { walk(p); } continue; }
		if (/\.js$/.test(f.name)) { files.push(p); }
	}
};
walk(LIB);

check('运行期 lib/*.js 里没有旧名路径字面量（注释除外）', () => {
	const hit = [];
	for (const p of files) {
		// kb.js = 常量与 LEGACY 定义处（2026-11-09 起 kb-expert 已移除，不再需要第二处豁免）。
		if (path.basename(p) === 'kb.js') { continue; }
		const lines = read(p).split('\n');
		lines.forEach((l, i) => {
			const t = l.trim();
			if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) { return; }
			// 旧名出现在引号里且后跟路径分隔符 / 或作为独立段
			if (/['"`](笔记|库)([/\\'`])/.test(l)) { hit.push(path.basename(p) + ':' + (i + 1)); }
		});
	}
	if (hit.length) { throw new Error('仍有旧名字面量：' + hit.slice(0, 5).join(', ')); }
	return files.length + ' 个文件已扫';
});

// ── ③ 迁移脚本幂等 ────────────────────────────────────────────────────────
const MIGRATE = path.join(SCRIPTS, 'kb-migrate-layout.mjs');
check('迁移脚本存在且可解析', () => {
	if (!fs.existsSync(MIGRATE)) { throw new Error('缺 kb-migrate-layout.mjs'); }
	const r = spawnSync(process.execPath, ['--check', MIGRATE], { encoding: 'utf8', windowsHide: true });
	if (r.status !== 0) { throw new Error('语法错：' + String(r.stderr).slice(0, 120)); }
	return 'ok';
});

check('迁移脚本：老库改名 + 飞书键重写 + 标记；再跑一次幂等', () => {
	const vault = path.join(os.tmpdir(), 'kb-layout-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
	fs.mkdirSync(path.join(vault, '笔记', '01_x'), { recursive: true });
	fs.mkdirSync(path.join(vault, '库', 'raw'), { recursive: true });
	fs.writeFileSync(path.join(vault, '笔记', '01_x', 'a.md'), '# A\n![](../库/raw/p.png)\n- [[库/raw/b.md]]\n', 'utf8');
	fs.writeFileSync(path.join(vault, '库', 'raw', 'b.md'), '# B\n', 'utf8');
	fs.mkdirSync(path.join(vault, '.kb'), { recursive: true });
		fs.writeFileSync(path.join(vault, '.kb/feishu-sync.json'), JSON.stringify({
		version: 2,
		spaces: { '笔记/01_x': { spaceId: 'S1' } },
		files: { '笔记/01_x/a.md': { token: 'T1' }, '库/raw/b.md': { token: 'T2' } },
	}, null, 2), 'utf8');
	fs.writeFileSync(path.join(vault, '.kb/kernel.json'), '{"docs":[]}', 'utf8');

	try {
		const run = () => spawnSync(process.execPath, [MIGRATE, '--vault', vault, '--apply'], { encoding: 'utf8', windowsHide: true });

		const r1 = run();
		if (r1.status !== 0) { throw new Error('迁移失败：' + String(r1.stderr || r1.stdout).slice(0, 160)); }
		if (fs.existsSync(path.join(vault, '笔记'))) { throw new Error('旧目录 笔记 还在'); }
		if (fs.existsSync(path.join(vault, '库'))) { throw new Error('旧目录 库 还在'); }
		if (!fs.existsSync(path.join(vault, '知识库列表', '01_x', 'a.md'))) { throw new Error('新目录缺文件'); }

		const fj = JSON.parse(read(path.join(vault, '.kb/feishu-sync.json')));
		const sk = Object.keys(fj.spaces);
		const fk = Object.keys(fj.files);
		if (sk.length !== 1 || !sk[0].startsWith('知识库列表/')) { throw new Error('spaces 键未重写：' + sk.join(',')); }
		if (fk.length !== 2 || !fk.every((k) => /^(知识库列表|数据源)\//.test(k))) { throw new Error('files 键未重写：' + fk.join(',')); }

		const md = read(path.join(vault, '知识库列表', '01_x', 'a.md'));
		if (!md.includes('](../数据源/raw/p.png)')) { throw new Error('md 相对链接未改写'); }
		if (!md.includes('[[数据源/raw/b.md]]')) { throw new Error('wiki 双链被改坏（应保留 [[ ]]）'); }

		if (!fs.existsSync(path.join(vault, '.kb/layout.json'))) { throw new Error('缺 .kb/layout.json'); }
		/*
		 * ★ 2026-11-02 改判据：迁移现在会在删掉旧索引后**立刻重建**（否则界面全 0 篇、看起来空白）。
		 *   所以"索引不存在"不再是正确终态 —— 真正的契约是**索引里不含旧路径**。
		 */
		const kernelPath = path.join(vault, '.kb/kernel.json');
		if (fs.existsSync(kernelPath)) {
			const ks = read(kernelPath);
			if (/[\\/]笔记[\\/]/.test(ks) || /[\\/]库[\\/]/.test(ks)) {
				throw new Error('索引里还有旧路径（应已重建）');
			}
		}

		const r2 = run();
		if (r2.status !== 0) { throw new Error('第二次运行失败（应幂等）'); }
		if (!/已是新布局/.test(r2.stdout || '')) { throw new Error('第二次没有识别为已迁移：' + String(r2.stdout).slice(0, 80)); }

		return '改名 / 键重写 / 链接 / 幂等 ✓';
	} finally {
		fs.rmSync(vault, { recursive: true, force: true });
	}
});

console.log('\n============================================================');
console.log(fail ? '✗ ' + fail + ' 项失败' : '✓ 全部布局契约通过');
process.exit(fail ? 1 : 0);
