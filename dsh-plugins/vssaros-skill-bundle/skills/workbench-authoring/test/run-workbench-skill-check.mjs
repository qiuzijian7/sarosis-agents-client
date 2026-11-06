#!/usr/bin/env node
// run-workbench-skill-check.mjs —— 「工作台制作」技能自身的守卫（防文档腐烂）
//
// 技能最容易坏的方式不是写错，而是**写对了但后来代码变了**：
//   · 文档里引用的守卫脚本被改名/删除
//   · 示例路径 `dsh-plugins/vssaros-x/...` 已经不存在
//   · 约定的关键代码事实（CONV_MIN / display:none 收起 / ConversationMount）被改掉
// 所以这里把「文档里承诺的事实」逐条对代码做断言。
//
// 用法：node dsh-plugins/vssaros-skill-bundle/skills/workbench-authoring/test/run-workbench-skill-check.mjs

import fs from 'node:fs';
import path from 'node:path';

const SKILL_DIR = path.resolve(import.meta.dirname, '..');
// workbench-authoring → skills → .agents → resources → 仓库根（少一层就会指向 resources/）
const ROOT = path.resolve(SKILL_DIR, '../../../..');

let pass = 0;
let fail = 0;
const ok = (name) => { pass += 1; console.log('  ✓ ' + name); };
const bad = (name, detail = '') => { fail += 1; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); };
const check = (name, cond, detail) => { cond ? ok(name) : bad(name, detail); };

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

console.log('[workbench-authoring] 技能自检');

// ── 1. 结构 ────────────────────────────────────────────────────────────
const skillMd = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const fm = /^---\n([\s\S]*?)\n---\n/.exec(skillMd);
check('SKILL.md 有 frontmatter', !!fm);
const nameLine = fm && /^name:\s*(\S+)$/m.exec(fm[1]);
check('name 与目录名一致', !!nameLine && nameLine[1] === path.basename(SKILL_DIR), nameLine && nameLine[1]);
check('description 非空且够长', !!fm && /^description:\s*\S.{40,}/m.test(fm[1]));

// ── 2. 文档里引用的文件都真实存在 ──────────────────────────────────────
const docFiles = [];
const walk = (dir) => {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) { if (e.name !== 'test') { walk(p); } } else if (p.endsWith('.md')) { docFiles.push(p); }
	}
};
walk(SKILL_DIR);

const referenced = new Set();
for (const f of docFiles) {
	const text = fs.readFileSync(f, 'utf8');
	for (const m of text.matchAll(/`((?:references|scripts|test)\/[A-Za-z0-9._-]+)`/g)) { referenced.add(m[1]); }
	for (const m of text.matchAll(/`(dsh-plugins\/(?:check-[a-z-]+\.mjs|vssaros-[a-z-]+\/(?:lib\/)?[A-Za-z0-9._-]+))`/g)) { referenced.add(m[1]); }
}
for (const rel of referenced) {
	// 技能内相对路径（references/… scripts/…）以技能目录为基准；仓库路径以根为基准
	const found = fs.existsSync(path.join(SKILL_DIR, rel)) || fs.existsSync(path.join(ROOT, rel));
	check(`引用存在：${rel}`, found);
}

// ── 3. 关键代码事实（文档承诺 ↔ 代码现状）──────────────────────────────
const MARKET = 'dsh-plugins/vssaros-marketplace/lib/workbench.js';
const STUDIO = 'dsh-plugins/vssaros-studio/lib/client.js';
const UI_LAYER = 'dsh-plugins/vssaros-workbenches/lib/client.ui.js';
const FRAME = 'dsh-plugins/vssaros-workbenches/lib/client.js';

/** 去掉注释再断言 —— 注释里写的「» 收起」不能算实现（第一次写守卫就栽在这） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const market = read(MARKET);
const studio = read(STUDIO);
const uiLayer = read(UI_LAYER);
const frame = read(FRAME);
const marketCode = stripComments(market);
const studioCode = stripComments(studio);

check('样例商城：收起是 display:none',
	/display:\s*collapsed\s*\?\s*'none'\s*:\s*'flex'/.test(marketCode));
check('萨罗斯平台：与样例同一表达式',
	/display:\s*collapsed\s*\?\s*'none'\s*:\s*'flex'/.test(studioCode));
// 断言到具体值，避免「CONV_MIN_X 也含 CONV_MIN」这类假绿
check('两个工作台都有 CONV_MIN = 320',
	/CONV_MIN\s*=\s*320/.test(marketCode) && /CONV_MIN\s*=\s*320/.test(studioCode));
// ★ 2026-11-02（用户：「AI 助手侧边栏左上角不要有收起按钮」）：此前这里**要求**两个工作台各自有「» 收起」，
//   现在反过来 —— 对话栏顶部的「＋ 新会话」由宿主统一提供，收起 / 展开统一走右侧浮动工具栏，工作台不许自画。
check('两个工作台都**没有**自画的「» 收起」（左上角不放收起按钮）',
	!/'»\s*收起'/.test(marketCode) && !/'»\s*收起'/.test(studioCode));
check('两个工作台都**没有**自画的「＋ 新会话」（宿主对话栏统一提供）',
	!/＋\s*新会话/.test(marketCode) && !/＋\s*新会话/.test(studioCode));
// ★ 2026-10-26 定稿：展开入口 + 外开 合成 **S2 一体条**，只在外壳渲染一次。
//   工作台侧只写属性 + 监听事件（不再自造按钮 / 拖拽实现）。
const SHELL = 'dsh-plugins/vssaros-workbenches/lib/client.js';
const shellSrc = read(SHELL);
const shellCode = stripComments(shellSrc);

check('外壳渲染 S2 一体条（.vssWbActions）', /className: 'vssWbActions'/.test(shellCode));
check('一体条含「« AI 助手」与「↗ 外开」两段',
	/data-vssaros-wb-assist/.test(shellCode) && /data-vssaros-wb-open-external/.test(shellCode));
check('展开按钮可拖拽（attachActionsDrag，外壳唯一实现）',
	/function attachActionsDrag\(el, frameEl\)/.test(shellCode)
	&& !/function attachExpandDrag/.test(marketCode) && !/function attachExpandDrag/.test(studioCode));
check('拖拽落点持久化（ACTIONS_POS_KEY）', /ACTIONS_POS_KEY/.test(shellCode));
check('不落 header 安全区（ACTIONS_SAFE_TOP）', /ACTIONS_SAFE_TOP = 30/.test(shellCode));
check('右键复位', /contextmenu[\s\S]{0,200}applyActionsPos\(el, null\)/.test(shellCode));
check('两个工作台都上报助手收起态',
	/'data-vssaros-assist-collapsed'/.test(marketCode) && /'data-vssaros-assist-collapsed'/.test(studioCode));
check('两个工作台都监听 vssaros:assist-expand',
	/vssaros:assist-expand/.test(marketCode) && /vssaros:assist-expand/.test(studioCode));
check('宿主帧里有 ConversationMount', /function ConversationMount/.test(frame));
check('宿主帧提供 data-vssaros-wb-dock 停靠点', /data-vssaros-wb-dock/.test(frame));
check('props.conversation 由 Frame 注入 customFrame 工作台', /customFrame[\s\S]{0,80}props\.conversation/.test(frame));

for (const prim of ['wb-toolbar', 'wb-split', 'wb-pane', 'wb-list', 'wb-btn', 'wb-empty', 'wb-table']) {
	check(`共享层仍定义 .${prim}`, new RegExp('\\.' + prim + '\\s*\\{').test(uiLayer));
}
for (const tok of ['--wb-f-xs', '--wb-r-md', '--wb-s1']) {
	check(`共享层仍定义 ${tok}`, new RegExp(tok.replace(/-/g, '\\-') + '\\s*:').test(uiLayer));
}

const style = read('dsh-plugins/check-workbench-style.mjs');
check('样式守卫仍有 surface / toolbar / @container 规则',
	/data-vssaros-surface/.test(style) && /data-dsh-workbench-toolbar/.test(style) && /@container/.test(style));
// 2026-11-06：Bots 工作台 11-03 已下线（vssaros-agents 不再有工作台 chunk）⇒ 名单里不再要求 agents，只要求名单还在、且没有已下线的条目
check('样式守卫的 UNIFIED 名单仍在且不含已下线的 agents 工作台',
	/const UNIFIED\s*=\s*\[[^\]]*'vssaros-kb'/.test(style) && !/const UNIFIED\s*=\s*\[[^\]]*'vssaros-agents'/.test(style));

const pkg = JSON.parse(read('package.json'));
const chain = (pkg.scripts && pkg.scripts['check:dsh-plugins']) || '';
check('npm run check:dsh-plugins 含 assistant-collapse 守卫', chain.includes('check-assistant-collapse.mjs'));

// ── 4. 伸缩守卫的 TARGETS 覆盖了所有带右栏的工作台 ─────────────────────
const collapseGuard = read('dsh-plugins/check-assistant-collapse.mjs');
check('伸缩守卫已纳入商城', /vssaros-marketplace\/lib\/workbench\.js/.test(collapseGuard));
check('伸缩守卫已纳入萨罗斯平台', /vssaros-studio\/lib\/client\.js/.test(collapseGuard));

// ── 5. 脚手架端到端（2026-11-02）：external 模式 = 「0 处宿主改动就能装上」的证据 ──────
// 链路：生成 → 包内自检 → `npm pack` → 宿主 Host 侧预检（prepareLocalWorkbench，与 install_local_workbench 同一段）。
// 为什么必须端到端：单看“生成了哪些文件”看不出包能不能被宿主接受
// （缺 dsh.bundle.patch / 入口不在包里 / 包名不合法，都是装到一半才报，用户只看到“没反应”）。
{
	const { spawnSync } = await import('node:child_process');
	const os = await import('node:os');
	const { pathToFileURL } = await import('node:url');
	const SCAFFOLD = path.join(SKILL_DIR, 'scripts', 'scaffold_workbench.mjs');
	const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, shell: cmd === 'npm' });
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-scaffold-'));
	try {
		// 5a. external：不碰宿主、不写 vssaros 块、描述符走 package
		const ext = sh(process.execPath, [SCAFFOLD, 'demoext', '--mode', 'external', '--package', '@me/demo-ext', '--title', '演示'], tmp);
		check('external：脚手架成功退出', ext.status === 0, (ext.stderr || ext.stdout || '').slice(0, 200));
		const extDir = path.join(tmp, 'demoext');
		const extPkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8')); } catch { return null; } })();
		check('external：包名是 --package 给的', extPkg && extPkg.name === '@me/demo-ext', extPkg && extPkg.name);
		check('external：不带 vssaros 清单块（那是内置包协议）', extPkg && extPkg.vssaros === undefined);
		check('external：dsh.bundle.patch + 注入宿主包都在',
			extPkg && !!extPkg.dsh?.bundle?.patch && (extPkg.dsh?.client?.inject || []).includes('@vssaros/dsh-workbenches'));
		const extChunk = (() => { try { return fs.readFileSync(path.join(extDir, 'lib', 'client.demoext.js'), 'utf8'); } catch { return ''; } })();
		check('external：描述符走 package、不写 repository', extChunk.includes("package: '@me/demo-ext'") && !/^\s*repository\s*:/m.test(extChunk));
		check('external：不写 route / order / id（内置专属字段）', !/^\s*(route|order|id)\s*:/m.test(extChunk.slice(extChunk.indexOf('const DESCRIPTOR'))));
		const extSelf = sh(process.execPath, [path.join(extDir, 'test', 'run-demoext-check.mjs')], extDir);
		check('external：生成的包内自检全绿', extSelf.status === 0, (extSelf.stdout || '').split('\n').filter(l => /FAIL/.test(l)).join(' | ').slice(0, 240));
		let syntaxOk = true;
		for (const rel of ['lib/index.js', 'lib/client.js', 'lib/client.demoext.js']) {
			const r = sh(process.execPath, ['--check', path.join(extDir, rel)], extDir);
			if (r.status !== 0) { syntaxOk = false; bad('external：语法错误 ' + rel, (r.stderr || '').slice(0, 160)); }
		}
		if (syntaxOk) { ok('external：生成的 js 语法全部合法'); }

		// 5b. pack → 宿主预检（与 install_local_workbench 同一个函数）
		const pack = sh('npm', ['pack', '--silent'], extDir);
		const tgzName = (pack.stdout || '').trim().split(/\r?\n/).pop();
		check('external：npm pack 出 .tgz', pack.status === 0 && /\.tgz$/.test(tgzName || ''), (pack.stderr || pack.stdout || '').slice(0, 200));
		if (pack.status === 0 && tgzName) {
			try {
				const { prepareLocalWorkbench } = await import(pathToFileURL(path.join(ROOT, 'dsh-plugins/vssaros-workbenches/lib/localInstall.js')).href);
				const prepared = await prepareLocalWorkbench(path.join(extDir, tgzName));
				check('external：宿主预检通过且识别出包名 / 版本', prepared.name === '@me/demo-ext' && prepared.version === '0.1.0', `${prepared.name}@${prepared.version}`);
				check('external：宿主识别出带客户端入口（hasClient）', prepared.hasClient === true);
				await prepared.cleanup();
			} catch (error) {
				bad('external：宿主预检失败（装上去会被拒）', String(error && error.message || error).slice(0, 240));
			}

			// 5b2. 全链：脚手架产物 → 干跑审计 → 安装工具（假控制桥）→ 安装证据 → 生效态提示。
			// 为什么要这一段：之前各环节都是分段验的（干跑用手造的包、安装用手造的包）。
			// “脚手架产出的包，能不能过我们自己的干跑审计、走完安装与生效态”从未被验证过——
			// 两边各自演进，很容易出现“脚手架生成的东西被干跑判不合格”这种自相矛盾。
			try {
				const hostLib = (name) => import(pathToFileURL(path.join(ROOT, 'dsh-plugins/vssaros-workbenches/lib', name)).href);
				const { checkLocalWorkbenchTool, localWorkbenchInstallTool } = await hostLib('index.js');
				const { readInstallRecords, pendingRestartRecords } = await hostLib('localInstall.js');
				const archive = path.join(extDir, tgzName);

				const dry = await checkLocalWorkbenchTool().execute({ path: archive });
				check('全链：脚手架产物通过干跑审计（ok:true）', dry.ok === true, JSON.stringify(dry.errors));
				check('全链：干跑推导出身份 local:<包名>', dry.identity === 'local:@me/demo-ext', dry.identity);
				check('全链：脚手架产物没有宿主单例警告', !(dry.warnings || []).some(w => /宿主单例/.test(w)), (dry.warnings || []).join('|'));

				const dataRoot = fs.mkdtempSync(path.join(tmp, 'data-'));
				const calls = [];
				const bridge = { callIDE: async (method, args) => { calls.push({ method, args }); return { ok: true, version: '0.1.0', restartRequired: true }; } };
				const startedAt = Date.now() - 60_000;   // 假定 Host 一分钟前启动，这次安装发生在它之后
				const installed = await localWorkbenchInstallTool({}, dataRoot, () => bridge).execute({ path: archive });
				check('全链：安装工具走完，回执 restart-required', installed.application === 'restart-required', JSON.stringify(installed).slice(0, 160));
				check('全链：发给 IDE 的参数齐全（name/version/dir/source）',
					calls.length === 1 && calls[0].args.params.name === '@me/demo-ext' && calls[0].args.params.version === '0.1.0'
					&& typeof calls[0].args.params.dir === 'string' && calls[0].args.params.source === 'local');
				check('全链：全新安装不带 replacing（不能把新装说成覆盖）', calls[0] && calls[0].args.params.replacing === undefined);

				const records = await readInstallRecords(dataRoot);
				check('全链：留下一条安装证据，包名是真实包名', records.length === 1 && records[0].name === '@me/demo-ext', JSON.stringify(records));
				const pending = pendingRestartRecords(records, startedAt);
				check('全链：生效态提示认出它（已安装、重启后出现）', pending.length === 1 && pending[0].name === '@me/demo-ext', JSON.stringify(pending));
				check('全链：Host 重启之后提示自动消失', pendingRestartRecords(records, Date.now() + 60_000).length === 0);
			} catch (error) {
				bad('全链：脚手架产物 → 干跑 → 安装 → 生效态 没走通', String(error && error.stack || error).split('\n').slice(0, 3).join(' | ').slice(0, 300));
			}
		}

		// 5c. 与内置包同名 / 占用内置作用域 ⇒ 必须拒绝（会静默抢路由 / 被当内置）
		const clash = sh(process.execPath, [SCAFFOLD, 'x', '--mode', 'external', '--package', '@vssaros/x'], tmp);
		check('external：拒绝 @vssaros/ 作用域', clash.status !== 0 && /@vssaros/.test(clash.stderr || ''));
		const badName = sh(process.execPath, [SCAFFOLD, 'x', '--mode', 'external', '--package', 'Bad Name'], tmp);
		check('external：拒绝非法 npm 包名', badName.status !== 0);
		const badMode = sh(process.execPath, [SCAFFOLD, 'x', '--mode', 'bogus'], tmp);
		check('--mode 非法值被拒绝', badMode.status !== 0);

		// 5d. builtin 回归：默认形态不变（有 vssaros 块 + repository）
		const bi = sh(process.execPath, [SCAFFOLD, 'demobi', '--dir', path.join(tmp, 'vssaros-demobi'), '--title', '内置演示'], tmp);
		check('builtin：脚手架成功退出（默认模式）', bi.status === 0, (bi.stderr || '').slice(0, 160));
		const biPkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(tmp, 'vssaros-demobi', 'package.json'), 'utf8')); } catch { return null; } })();
		check('builtin：包名 @vssaros/dsh-<module>，带 vssaros.workbench.repository',
			biPkg && biPkg.name === '@vssaros/dsh-demobi' && biPkg.vssaros?.workbench?.repository === 'vssaros:demobi');
		const biSelf = sh(process.execPath, [path.join(tmp, 'vssaros-demobi', 'test', 'run-demobi-check.mjs')], path.join(tmp, 'vssaros-demobi'));
		check('builtin：生成的包内自检全绿', biSelf.status === 0, (biSelf.stdout || '').split('\n').filter(l => /FAIL/.test(l)).join(' | ').slice(0, 240));
	} finally {
		try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结果 */ }
	}
}

console.log(`\n[workbench-authoring] ${pass} passing / ${fail} failing`);
process.exit(fail ? 1 : 0);
