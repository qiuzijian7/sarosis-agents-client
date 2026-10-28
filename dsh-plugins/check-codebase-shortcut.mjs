#!/usr/bin/env node
// codebase 快捷键守卫（2026-10-27 新增）
//
// 背景：用户报「codebase 的快捷键功能丢失：Alt+Shift+S」。真机取证结论：
//   · IDE（VS Code 底座）窗口里 sarosis.findGraphSymbol = Shift+Alt+S 一直有效；
//   · 丢失发生在独立 dsh 客户端（桌面窗口 = 纯网页，没有 VS Code 的快捷键/命令面板）。
// 于是：在 vssaros-codebase/lib/client.js 里补了 Alt+Shift+S ⇒ 打开「代码库」工作台 + 聚焦检索框。
//
// 本守卫钉住四件容易静默失效的事：
//   1) dsh 侧监听还在（判定条件 Alt+Shift+S + preventDefault）；
//   2) IDE 让路判据还在（window.vssarosDsh）—— 少了它 ⇒ IDE 内嵌页里会与 IDE 的 keybinding 重复触发；
//   3) 两处分叉：工作台 id / 检索框锚点必须与 lib/client.codebase.js 对得上
//      （分叉 ⇒ 快捷键打开不存在的页或聚焦不到输入框 ⇒ 静默无反应）；
//   4) IDE 侧那条命令仍在（别把好的一侧改坏）。
//
// 跑法：node dsh-plugins/check-codebase-shortcut.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'dsh-plugins', 'vssaros-codebase');
const CLIENT = join(PLUGIN, 'lib', 'client.js');
const PANEL = join(PLUGIN, 'lib', 'client.codebase.js');
const IDE_CMD = join(ROOT, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'codebaseGraphFindSymbol.contribution.ts');

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail }); };

const clientSrc = readFileSync(CLIENT, 'utf8');
const panelSrc = readFileSync(PANEL, 'utf8');
const ideSrc = readFileSync(IDE_CMD, 'utf8');

const hasAltShift = /event\.altKey/.test(clientSrc) && /event\.shiftKey/.test(clientSrc);
const hasKeyS = /keyName\s*!==?\s*'s'/.test(clientSrc) || /toLowerCase\(\)\s*!==?\s*'s'/.test(clientSrc); const hasKeyCode = /'KeyS'/.test(clientSrc);
check('dsh side listener exists', hasAltShift, 'client.js must test both altKey and shiftKey');
check('dsh side matches the S key', hasKeyS, 'client.js must match key s'); check('dsh side also accepts the physical KeyS code', hasKeyCode, 'non-US layouts need the code fallback');
check('dsh side blocks default behavior', /preventDefault\(\)/.test(clientSrc), 'client.js must call preventDefault()');
check('IDE yield guard exists (window.vssarosDsh)', /window\.vssarosDsh/.test(clientSrc), 'IDE hosted views must yield to the IDE keybinding');

const anchorMatch = /SEARCH_INPUT_SELECTOR\s*=\s*'([^']+)'/.exec(clientSrc);
const anchor = anchorMatch ? anchorMatch[1] : '';
check('search input selector declared', Boolean(anchor), anchor ? 'selector = ' + anchor : 'SEARCH_INPUT_SELECTOR not found');
const bare = anchor.replace(/^\[/, '').replace(/\]$/, '');
const anchorMatchesPanel = Boolean(anchor) ? panelSrc.includes(bare) : false;
check('search input selector matches the panel', anchorMatchesPanel, 'panel must use the same anchor');

const idMatch = /WORKBENCH_ID\s*=\s*'([^']+)'/.exec(clientSrc);
const wbId = idMatch ? idMatch[1] : '';
const slash = wbId.indexOf('/');
const moduleName = slash >= 0 ? wbId.slice(slash + 1) : wbId;
check('workbench id declared', Boolean(wbId), wbId ? 'id = ' + wbId : 'WORKBENCH_ID not found');
check('workbench id points at the codebase panel', Boolean(moduleName) && panelSrc.includes(moduleName), 'panel repository must mention the same module (' + moduleName + ')');

const ideHasCmd = /id:\s*'sarosis\.findGraphSymbol'/.test(ideSrc);
const ideHasKey = /KeyMod\.Shift\s*\|\s*KeyMod\.Alt\s*\|\s*KeyCode\.KeyS/.test(ideSrc);
check('IDE side command still bound', ideHasCmd && ideHasKey, 'IDE side command must stay registered with Alt+Shift+S');

const failed = results.filter(r => !r.ok);
for (const r of results) {
	console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.detail ? ' -- ' + r.detail : ''));
}
console.log('codebase shortcut guard: ' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
