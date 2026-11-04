/*---------------------------------------------------------------------------------------------
 *  dsh desktop 顶部「应用 / 编辑」菜单 —— 行为级守卫（2026-11-04）。
 *
 *  参考工程 dsh-desktop 的 `test/windows-titlebar.test.ts` / `test/context-menu.test.ts`：
 *  菜单结构、命令白名单、点击分发都必须是**行为级**断言，不能只 grep 源码字符串。
 *
 *  运行：`node --experimental-strip-types dsh-plugins/check-desktop-caption-menu.mjs`
 *  （模板是纯 TS 且只有 type-only import ⇒ Node 22 strip-types 可直接 import ✓）
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(ROOT, 'src/vs/sessions/contrib/dshHarness');
const MENU = path.join(HARNESS, 'common/dshDesktopMenu.ts');
const CHANNEL_COMMON = path.join(HARNESS, 'common/dshHarness.ts');
const VIEW_HOST = path.join(HARNESS, 'electron-main/dshViewHost.ts');
const CHANNEL_MAIN = path.join(HARNESS, 'electron-main/dshHarnessChannel.ts');
const SERVICE = path.join(HARNESS, 'electron-browser/dshHarnessService.ts');
const FULL_WINDOW = path.join(HARNESS, 'electron-browser/dshFullWindowContribution.ts');

const read = (p) => fs.readFileSync(p, 'utf8');
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const m = await import(pathToFileURL(MENU).href);

// ─── ① 菜单模板（行为级）───────────────────────────────────────────────────
check('两个 caption 菜单 + 标题本地化', () => {
	assert.deepStrictEqual([...m.desktopMenuNames], ['application', 'edit']);
	assert.strictEqual(m.desktopMenuLabel('application', 'zh'), '应用');
	assert.strictEqual(m.desktopMenuLabel('edit', 'zh'), '编辑');
	assert.strictEqual(m.desktopMenuLabel('application', 'en'), 'Application');
	assert.strictEqual(m.desktopMenuLabel('edit', 'en'), 'Edit');
});

check('「编辑」菜单照参考工程：撤销/重做 | 剪切/复制/粘贴/删除 | 全选', () => {
	const seen = [];
	const items = m.dshDesktopMenuTemplate('edit', 'zh', 1, {
		run: () => { throw new Error('edit 菜单不该用 run'); },
		act: (a) => seen.push(a),
	});
	const labels = items.map(i => i.label ?? '---');
	assert.deepStrictEqual(labels, ['撤销', '重做', '---', '剪切', '复制', '粘贴', '删除', '---', '全选']);
	assert.strictEqual(items[0].accelerator, 'Ctrl+Z');
	assert.strictEqual(items[items.length - 1].accelerator, 'Ctrl+A');
	// 真点一遍 ⇒ 每个都打到 act，且顺序与菜单一致
	for (const i of items) { if (typeof i.click === 'function') { i.click({}); } }
	assert.deepStrictEqual(seen, ['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll']);
});

check('「应用」菜单：重启 | 视图子菜单 | 检查更新/关于 | 退出', () => {
	const seen = [];
	const items = m.dshDesktopMenuTemplate('application', 'zh', 1.25, {
		run: (c) => seen.push('run:' + c),
		act: (a) => seen.push('act:' + a),
	});
	assert.strictEqual(items[0].label, '重启 Harness');
	const view = items.find(i => i.label === '视图');
	assert.ok(view && Array.isArray(view.submenu), '缺「视图」子菜单');
	const viewLabels = view.submenu.map(i => i.label ?? '---');
	assert.ok(viewLabels.includes('重新加载') && viewLabels.includes('开发者工具'), '视图缺重载/开发者工具');
	assert.ok(viewLabels.includes('放大') && viewLabels.includes('缩小'), '视图缺缩放');
	assert.ok(viewLabels.some(l => String(l).includes('125%')), '「实际大小」必须显示当前 zoom（125%）');
	assert.ok(viewLabels.includes('切换全屏'));
	assert.ok(items.some(i => i.label === '检查更新…'));
	assert.ok(items.some(i => i.label === '关于 VsSaros'));
	assert.strictEqual(items[items.length - 1].label, '退出');
	// 真点一遍：restart → run，zoomIn → act
	items[0].click({});
	const zoomIn = view.submenu.find(i => i.label === '放大');
	zoomIn.click({});
	assert.deepStrictEqual(seen, ['run:restart', 'act:zoomIn']);
});

check('英文模板与中文同构', () => {
	const en = m.dshDesktopMenuTemplate('edit', 'en', 1, { run: () => { }, act: () => { } });
	assert.deepStrictEqual(en.map(i => i.label ?? '---'), ['Undo', 'Redo', '---', 'Cut', 'Copy', 'Paste', 'Delete', '---', 'Select All']);
});

// ─── ② 封闭集 / 编辑按键（安全边界）───────────────────────────────────────
check('动作/命令是封闭集，拒绝自造', () => {
	assert.ok(m.isDshDesktopMenuAction('undo'));
	assert.ok(m.isDshDesktopMenuAction('zoomQuery'));
	assert.ok(!m.isDshDesktopMenuAction('__proto__'));
	assert.ok(!m.isDshDesktopMenuAction('evil'));
	assert.ok(!m.isDshDesktopMenuAction(undefined));
	assert.ok(m.isDshDesktopMenuCommand('quit'));
	assert.ok(!m.isDshDesktopMenuCommand('deleteAllFiles'));
});

check('编辑按键表覆盖 7 项且带 Ctrl', () => {
	for (const [action, key] of Object.entries(m.dshDesktopEditingKeys)) {
		assert.ok(m.isDshDesktopMenuAction(action), `按键表里出现了非白名单动作 ${action}`);
		assert.ok(key.keyCode.length > 0);
		assert.ok(Array.isArray(key.modifiers));
	}
	assert.strictEqual(Object.keys(m.dshDesktopEditingKeys).length, 7);
	assert.deepStrictEqual(m.dshDesktopEditingKeys.delete.modifiers, []);
	assert.strictEqual(m.formatZoomPercentage(1.5), '150%');
});

// ─── ③ 接线：按钮 / 原生菜单 / channel / 主进程 ────────────────────────────
check('标题栏两枚按钮 + no-drag + popup 原生菜单', () => {
	const s = read(FULL_WINDOW);
	assert.ok(s.includes('data-vssaros-desktop-menu'), '缺 caption 菜单按钮锚点');
	assert.ok(s.includes('desktopMenuNames'), '必须遍历两个菜单名渲染按钮');
	assert.ok(s.includes('-webkit-app-region:no-drag'), '按钮必须 no-drag（整条 bar 是 drag）');
	assert.ok(s.includes("from '../../../../base/parts/contextmenu/electron-browser/contextmenu.js'"), '必须用原生 popup()');
	assert.ok(s.includes('popup(items,'), '必须真的弹菜单（不能只 import）');
	assert.ok(s.includes("_openDesktopMenu"), '缺菜单打开方法');
	// ★ 真机：菜单打开路径必须同步。第一版在 popup 前 await 跨进程 zoomQuery ⇒ channel 挂起时
	//   click 到达、listener 齐全，但 aria-expanded 永不变化、菜单永不出现 ✗
	const openBody = s.slice(s.indexOf('private _openDesktopMenu'), s.indexOf('private async _runDesktopMenuCommand'));
	assert.ok(openBody.length > 100, '找不到 _openDesktopMenu 方法体');
	// 注释里会引用旧写法（含 await 字样）⇒ 去掉注释再判定代码
	const openCode = openBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
	assert.ok(!/\bawait\b/.test(openCode), '_openDesktopMenu 里不许有 await（跨进程 IPC 会挂住菜单）');
	assert.ok(/private _openDesktopMenu\([^)]*\): void \{/.test(openCode), '_openDesktopMenu 必须是同步方法');
	// ★ 真机二次：getZoomFactor() 在标题栏 realm 抛 TypeError(mainWindow undefined) ⇒ 菜单整个崩掉
	assert.ok(!/getZoomFactor\(\)/.test(openCode), '_openDesktopMenu 不许调 getZoomFactor()（该 realm 里 mainWindow 未定义会抛错）');
	assert.ok(/const zoomFactor = 1;/.test(openCode), '标题栏坐标/百分比必须按 1（不随页面缩放）');
	// ★ 2026-11-04 三次：aria-expanded 不能当行为开关（onHide 不回发会永久锁死按钮）
	assert.ok(!/aria-expanded'\)\s*===\s*'true'\)\s*\{\s*return;/.test(openCode), '不许用 aria-expanded 做硬守卫（onHide 丢失会永久打不开）');
	assert.ok(/15_000\)/.test(openCode), '必须有超时兜底复位 aria-expanded');
	assert.ok(/data-vssaros-menu-viewid/.test(openCode), '必须留 viewId 诊断锚点（验证菜单动作能定位到视图）');
	assert.ok(s.includes('dshDesktopMenuTemplate('), '必须调用纯函数模板');
	// 不许用 DOM 菜单：原生视图会盖住
	assert.ok(!/desktop-menu.*createElement\('div'.*role:\s*'menu'/s.test(s), '不许用 DOM 菜单');
});

check('按钮不抢 composer 焦点（编辑键要送回聚焦视图）', () => {
	const s = read(FULL_WINDOW);
	assert.ok(s.includes("addEventListener('pointerdown', e => e.preventDefault())"), 'pointerdown 必须 preventDefault');
	assert.ok(s.includes('aria-expanded'), '必须有 aria-expanded 状态');
	// ★ 真机：aux 窗口 about:blank 的 navigator.language 是 en-US ⇒ 按语言推断会显示英文 ✗
	assert.ok(/const locale: 'zh' \| 'en' = 'zh'/.test(s), 'dsh desktop 标题栏固定中文（不能按 navigator.language 推断）');
	assert.ok(/const reset = \(\) =>[\s\S]{0,160}aria-expanded', 'false'/.test(s), '菜单关闭要复位 aria-expanded（onHide 回调）');
	assert.ok(s.includes('popup(items,'), 'popup 必须带 onHide 复位回调');
});

check('宿主命令分发覆盖 5 个命令', () => {
	const s = read(FULL_WINDOW);
	assert.ok(s.includes('_runDesktopMenuCommand'), '缺宿主命令分发');
	for (const cmd of ['restart', 'toggleFullscreen', 'checkForUpdates', 'about', 'quit']) {
		assert.ok(s.includes(`case '${cmd}':`), `缺 ${cmd} 分支`);
	}
});

check('新增 channel 命令 + 主进程白名单校验 + sendInputEvent', () => {
	const common = read(CHANNEL_COMMON);
	assert.ok(common.includes("DesktopMenuAction = 'desktopMenuAction'"), 'channel 枚举缺 DesktopMenuAction');
	const ch = read(CHANNEL_MAIN);
	assert.ok(ch.includes('case DshHarnessChannelCommand.DesktopMenuAction:'), '主进程 channel 缺 case');
	assert.ok(ch.includes('runDesktopMenuAction(a.viewId, a.action)'), 'case 必须转发到 viewHost');
	assert.ok(ch.includes("typeof a?.viewId !== 'string'"), '必须校验 viewId 形状');
	const host = read(VIEW_HOST);
	assert.ok(host.includes('isDshDesktopMenuAction(rawAction)'), '主进程必须再做一次封闭集校验');
	assert.ok(host.includes('runDesktopMenuAction(viewId: string'), 'viewHost 缺执行方法');
	assert.ok(host.includes('wc.sendInputEvent('), '编辑键必须走 sendInputEvent（webContents.undo 会跳过 composer 历史栈）');
	assert.ok(host.includes('this.focus(viewId)'), '发键前必须聚焦视图（隐藏窗口送不进）');
	assert.ok(host.includes("process.platform === 'darwin'"), 'macOS 要把 control 换成 meta');
	const svc = read(SERVICE);
	assert.ok(svc.includes('runDesktopMenuAction(viewId: string, action: DshDesktopMenuAction)'), 'service 接口缺方法');
	assert.ok(svc.includes('DshHarnessChannelCommand.DesktopMenuAction'), 'service 实现必须调该 channel');
});

// ─── 执行 ──────────────────────────────────────────────────────────────────
let failed = 0;
for (const c of checks) {
	try { c.fn(); console.log(`  ✓ ${c.name}`); }
	catch (e) { failed++; console.log(`  ✗ ${c.name}\n      ${String(e.message).slice(0, 300)}`); }
}
console.log(failed ? `\n✗ ${failed}/${checks.length} 失败` : `\n✓ caption 菜单守卫通过（${checks.length} 项）`);
process.exit(failed ? 1 : 0);
