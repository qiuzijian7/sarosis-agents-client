/*
 * 守卫：两栏工作台的「IDE 拆分契约」（2026-10-27）。
 *
 * 背景：窗口里的工作台是「左列表 + 右详情」；IDE 侧要拆成「左栏进 sideview、右栏进 editorpane」。
 * 这套拆分靠 `split-workbenches.json` 的注册表 + 四条契约（R1~R4）保证，
 * 而不是每个工作台各自手写一遍、各自忘记一处。
 *
 * 为什么是"守卫先行"（而不是先抽基类）：
 *   · 抽基类之前，先得能说清"什么算合规"；否则抽出来的东西没人能验；
 *   · 四条规则全部是**可静态检查**的（文件存在 / 关键字不出现 / 关键字出现），零运行时风险。
 *
 * 跑法：
 *   node dsh-plugins/check-split-workbenches.mjs
 *   SPLIT_WB_ROOT=<fixture 目录> node dsh-plugins/check-split-workbenches.mjs   # 自测用
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HERE = import.meta.dirname;
/** 允许用 fixture 根目录做**自测**（证明守卫不是空转）。 */
const ROOT = process.env.SPLIT_WB_ROOT || join(HERE, '..');

let pass = 0;
const failed = [];
const t = (name, ok, extra = '') => {
	if (ok) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};

const read = (rel) => {
	const p = join(ROOT, rel);
	return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

// ── ① 读注册表 ────────────────────────────────────────────────
const REG = JSON.parse(read('dsh-plugins/split-workbenches.json') || '{}');
const entries = Object.entries(REG.workbenches || {});
t('注册表可解析且非空', entries.length > 0, 'got=' + entries.length);
t('注册表声明了 detail 策略枚举', Array.isArray(REG.detailStrategies) && REG.detailStrategies.length >= 3);

for (const [id, e] of entries) {
	const tag = id;

	// ── ② 工作台真的存在（清单里有 vssaros.workbench）──────────────
	{
		const pkg = read(`dsh-plugins/${e.plugin}/package.json`);
		t(`${tag}: 插件清单存在`, pkg.length > 0, e.plugin);
		if (pkg) {
			const j = JSON.parse(pkg);
			t(`${tag}: 清单声明了 workbench`, !!(j.vssaros && j.vssaros.workbench), 'vssaros.workbench 缺失');
			if (j.vssaros?.workbench) {
				t(`${tag}: 标题与注册表一致`, j.vssaros.workbench.title === e.title, `清单=${j.vssaros.workbench.title} 表=${e.title}`);
			}
			t(`${tag}: 声明 customFrame（自带外框才可能内嵌）`, j.vssaros?.workbench?.customFrame === true);
		}
	}

	// ── R1: 注册了就必须有 IDE 侧 side pane ──────────────────────
	const pane = read(e.sidePaneFile);
	t(`${tag}/R1: side pane 文件存在`, pane.length > 0, e.sidePaneFile);
	if (pane) {
		t(`${tag}/R1: 声明了 pane 类 ${e.sidePane}`, pane.includes(`class ${e.sidePane}`), e.sidePane);
	}

	// ── R1b: detail input 能解析到（不要求同一文件）─────────────
	{
		const dir = dirname(e.sidePaneFile).replace(/\\/g, '/');
		const asInput = `${dir}/${e.detailInput.replace(/Input$/, 'Input')}.ts`;
		// detailInput 定义在 common/ 或 browser/ 下：两处都找一遍
		const candidates = [
			`src/vs/sessions/contrib/agentStudio/browser/${e.detailInput}.ts`,
			`src/vs/sessions/contrib/agentStudio/common/${e.detailInput}.ts`,
			`src/vs/sessions/contrib/agentStudio/browser/views/${e.detailInput}.ts`,
		];
		const hit = candidates.filter((p) => read(p).length > 0);
		t(`${tag}/R1: detail input 文件可定位（${e.detailInput}）`, hit.length > 0, candidates.join(' | '));
	}

	// ── R2: side pane 不得注入 loadDoc ──────────────────────────
	if (pane) {
		t(`${tag}/R2: side pane 不提供 loadDoc（否则双栏重复）`, !/loadDoc/.test(pane));
	}

	// ── R3: 点击走 openNode → detail input ─────────────────────
	if (pane) {
		t(`${tag}/R3: side pane 有 ${e.openAction} 动作`, new RegExp(e.openAction + '\\s*:').test(pane), e.openAction);
		const opensDetail = pane.includes(`override: ${e.detailInput}.ID`) || pane.includes(`new ${e.detailInput}(`);
		t(`${tag}/R3: 点击后走 ${e.detailInput}`, opensDetail, '既没有 override 也没有 new');
	}

	// ── R4: bundle 实现「无 loadDoc ⇒ 单列」缺省分支 ──────────────
	const bundleSrc = read(e.bundleSource);
	t(`${tag}/R4: bundle 源码存在`, bundleSrc.length > 0, e.bundleSource);
	if (bundleSrc) {
		t(`${tag}/R4: 有 docMode 判据（!!actions?.loadDoc）`, bundleSrc.includes('!!actions?.loadDoc'));
		t(`${tag}/R4: 无 loadDoc 时隐藏右栏（docMode ? … : null）`, /docMode \? \(/.test(bundleSrc));
		t(`${tag}/R4: 点节点先试内嵌、再退宿主（openNode 兜底）`, /actions\?\.openNode\?\.\(/.test(bundleSrc));
	}

	// ── R5: HTML 外壳必须复用 sidePaneHost ───────────────────
	//    自带外壳的工作台会各自拼 CSP / nonce / 脚本顺序；抄错一处的表现是白屏或
	//    后半段动作失灵（`</script>` 未转义），而且只在手点时才发现。
	{
		const hostRel = e.sidePaneHost || REG.sidePaneHost;
		const host = hostRel ? read(hostRel) : '';
		t(`${tag}/R5: 外壳模块存在`, host.length > 0, String(hostRel));
		if (host) {
			t(`${tag}/R5: 外壳用 nonce 作唯一脚本来源`, host.includes("script-src 'nonce-"));
			t(`${tag}/R5: 外壳允许 inline style`, host.includes("style-src 'unsafe-inline'"));
			t(`${tag}/R5: 外壳转义 < （防 </script> 截断）`, host.includes("replace(/</g"));
		}
		if (pane) {
			t(`${tag}/R5: side pane 复用 buildSidePaneHtml`, pane.includes('buildSidePaneHtml('));
			t(`${tag}/R5: side pane 不再自带 HTML 外壳`, !pane.includes('<!DOCTYPE html>'));
		}
	}

	// ── ⑤ detail 策略合法 ──────────────────────────────────────
	t(`${tag}: detail 策略在枚举内`, (REG.detailStrategies || []).includes(e.detail), e.detail);
}

// ── ⑥ 清单对齐：把所有 customFrame 工作台盘一遍 ────────────────
//    守卫只对「已登记」的条目判 R1~R5；但**哪些工作台该登记**不能靠记性 ⇒
//    这里扫全部插件清单，把「已拆分 / 候选」列出来。候选不失败（避免把待办变红灯），
//    但每次跑都能看到还差几个，以及差的是什么。
const inventory = (() => {
	const dir = join(ROOT, 'dsh-plugins');
	const rows = [];
	let names = [];
	try { names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return rows; }
	const registered = new Set(Object.keys(REG.workbenches || {}));
	for (const name of names) {
		const raw = read(`dsh-plugins/${name}/package.json`);
		if (!raw) { continue; }
		let wb = null;
		try { wb = JSON.parse(raw).vssaros?.workbench ?? null; } catch { continue; }
		if (!wb) { continue; }
		rows.push({
			plugin: name,
			title: wb.title || name,
			customFrame: wb.customFrame === true,
			registered: registered.has(name),
		});
	}
	return rows.sort((a, b) => (a.registered === b.registered ? a.plugin.localeCompare(b.plugin) : (a.registered ? -1 : 1)));
})();

const split = inventory.filter((r) => r.registered);
const candidates = inventory.filter((r) => !r.registered && r.customFrame);
t('注册表中的工作台都在清单里', split.length === Object.keys(REG.workbenches || {}).length, `表=${Object.keys(REG.workbenches || {}).length} 命中=${split.length}`);

if (process.argv.includes('--list')) {
	console.log('\n  ── 两栏工作台盘点 ──');
	console.log('  ' + '插件'.padEnd(24) + '标题'.padEnd(16) + 'customFrame  状态');
	for (const r of inventory) {
		console.log('  ' + r.plugin.padEnd(24) + r.title.padEnd(16) + String(r.customFrame).padEnd(13) + (r.registered ? '已拆分成 sideview + editorpane' : (r.customFrame ? '候选（未登记）' : '不适用（非自带外框）')));
	}
} else {
	console.log(`\n  已拆分 ${split.length} 个 · 候选 ${candidates.length} 个（--list 看全表）`);
}

console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（两栏工作台 IDE 拆分契约）`);
	console.log('  修法：R1 补 side pane 注册 / R2 删掉 loadDoc / R3 改成 openNode→detailInput / R4 补 docMode 缺省分支');
	console.log('  注册表：dsh-plugins/split-workbenches.json');
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（${entries.length} 个工作台 × R1~R5 契约）`);
