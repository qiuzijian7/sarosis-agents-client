#!/usr/bin/env node
// run-workbench-skill-check.mjs —— 「工作台制作」技能自身的守卫（防文档腐烂）
//
// 技能最容易坏的方式不是写错，而是**写对了但后来代码变了**：
//   · 文档里引用的守卫脚本被改名/删除
//   · 示例路径 `dsh-plugins/vssaros-x/...` 已经不存在
//   · 约定的关键代码事实（CONV_MIN / display:none 收起 / ConversationMount）被改掉
// 所以这里把「文档里承诺的事实」逐条对代码做断言。
//
// 用法：node resources/.agents/skills/workbench-authoring/test/run-workbench-skill-check.mjs

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
check('两个工作台都有「» 收起」按钮',
	/'»\s*收起'/.test(marketCode) && /'»\s*收起'/.test(studioCode));
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
check('样式守卫的 UNIFIED 名单仍含 agents', /const UNIFIED\s*=\s*\[[^\]]*'vssaros-agents'/.test(style));

const pkg = JSON.parse(read('package.json'));
const chain = (pkg.scripts && pkg.scripts['check:dsh-plugins']) || '';
check('npm run check:dsh-plugins 含 assistant-collapse 守卫', chain.includes('check-assistant-collapse.mjs'));

// ── 4. 伸缩守卫的 TARGETS 覆盖了所有带右栏的工作台 ─────────────────────
const collapseGuard = read('dsh-plugins/check-assistant-collapse.mjs');
check('伸缩守卫已纳入商城', /vssaros-marketplace\/lib\/workbench\.js/.test(collapseGuard));
check('伸缩守卫已纳入萨罗斯平台', /vssaros-studio\/lib\/client\.js/.test(collapseGuard));

console.log(`\n[workbench-authoring] ${pass} passing / ${fail} failing`);
process.exit(fail ? 1 : 0);
