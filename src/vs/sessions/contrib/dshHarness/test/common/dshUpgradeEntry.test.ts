/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * desktop 窗口「更新」入口的守卫（2026-10-23）。
 *
 * 三件不能退让的事：
 *  ① 三条命令**不许**把 IDE 主窗口拉到前台 —— 用户要的就是"只显示 desktop"
 *     （登记进 `DSH_PAGE_COMMANDS_WITHOUT_IDE_UI`，否则点一下「检查更新」就露出 IDE ✗）；
 *  ② 「一键升级」里**先比版本再下载** —— 更新源现在比本地旧（2.2.26080 < 2.2.26125），
 *     少了这道闸门，"一键升级"就是"一键降级" ✗；
 *  ③ 页面侧**没有桥就不渲染** —— 老宿主上不许出现一个点了没反应的入口 ✗。
 */
import assert from 'assert';
import fs from 'node:fs';

const PROTOCOL = 'src/vs/sessions/contrib/dshHarness/common/dshPageBridgeProtocol.ts';
const SERVICE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';
const PRELOAD = 'src/vs/sessions/contrib/dshHarness/electron-browser/preload-dshView.ts';
const CHUNK = 'dsh-plugins/vssaros-chat-surface/lib/client.upgrade.js';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

suite('dshHarness / desktop 窗口的「更新」入口', () => {

	test('① 三条命令必须登记进"不需要 IDE 出界面"的白名单', () => {
		const src = strip(fs.readFileSync(PROTOCOL, 'utf8'));
		const at = src.indexOf('DSH_PAGE_COMMANDS_WITHOUT_IDE_UI');
		assert.ok(at > 0, '找不到 DSH_PAGE_COMMANDS_WITHOUT_IDE_UI ✗');
		const body = src.slice(at, src.indexOf(']);', at));
		for (const method of ['upgradeRefresh', 'upgradeBundled', 'upgradeApp']) {
			assert.ok(body.includes(`'${method}'`),
				`${method} 必须登记进白名单（否则点一下就把 IDE 主窗口拉出来 ✗）`);
		}
	});

	test('② 一键升级：降级闸门必须**早于** checkForUpdates', () => {
		const src = strip(fs.readFileSync(SERVICE, 'utf8'));
		const at = src.indexOf('public async upgradeApp(');
		assert.ok(at > 0, '找不到 upgradeApp ✗');
		const body = src.slice(at, at + 3000);
		const gate = body.indexOf("checked.action !== 'upgrade'");
		const download = body.indexOf('checkForUpdates(true)');
		assert.ok(gate > 0, 'upgradeApp 里必须有"不是 upgrade 就不下载"的闸门 ✗');
		assert.ok(download > 0, '找不到 checkForUpdates(true)（守卫不能空跑）✗');
		assert.ok(gate < download, '闸门必须早于 checkForUpdates（晚于它 = 一键降级 ✗）');
		// 闸门还必须真的 return（不是只打日志）
		const gateBlock = body.slice(gate, download);
		assert.ok(/return;/.test(gateBlock), '闸门里必须 return（否则照样往下下载 ✗）');
	});

	test('③ 页面侧：没有桥就不渲染；状态靠推送；两个动作都接上了', () => {
		const src = fs.readFileSync(CHUNK, 'utf8');
		assert.ok(/if \(!b\) \{ return null; \}/.test(src),
			'页面必须"没有桥 ⇒ 不渲染"（老宿主上不许出现点了没反应的入口 ✗）');
		assert.ok(/upgradeBundled/.test(src), '页面要能升级随包插件（否则入口是死的）');
		assert.ok(/upgradeApp/.test(src), '页面要能一键升级应用（否则入口是死的）');
		assert.ok(/upgradeAsset/.test(src), '页面要能升级商城资产（技能/MCP/智能体/工作流/工作台）✗');
		assert.ok(/vssaros-dsh-upgrade/.test(src), '页面要听宿主推来的状态事件 ✗');
	});

	// ★ 2026-10-23（用户："增加 skill、mcp、agent、工作流、工作台的升级检查"）
	test('④ 五类资产都要查；技能/工作流不许画升级按钮（它们由 dsh 侧自持）', () => {
		const proto = strip(fs.readFileSync(PROTOCOL, 'utf8'));
		for (const kind of ['skill', 'mcp', 'agent', 'workflow', 'workbench']) {
			assert.ok(proto.includes(`'${kind}'`), `资产类别必须含 ${kind} ✗`);
		}
		const svc = strip(fs.readFileSync(SERVICE, 'utf8'));
		assert.ok(/getInstalled\(\)/.test(svc), '要用本地台账 getInstalled() 才知道"装了什么" ✗');
		assert.ok(/checkUpgrades\(/.test(svc), '要调 checkUpgrades() 才知道"有没有新版" ✗');
		// 下线闸：skill/workflow 在 IDE 侧调 upgrade 会被拒 ⇒ 宿主自己也别兜底（否则点了只看到报错）
		const at = svc.indexOf('public async upgradeAsset(');
		assert.ok(at > 0, '找不到 upgradeAsset ✗');
		const body = svc.slice(at, at + 600);
		assert.ok(/kind === 'skill' \|\| kind === 'workflow'/.test(body),
			'upgradeAsset 必须短路 skill/workflow（IDE 侧调用会被商城下线闸拒 ✗）');
		// 页面：via==='dsh' 的那两类不画按钮
		const page = fs.readFileSync(CHUNK, 'utf8');
		assert.ok(/r\.via === "dsh"/.test(page), '页面必须按 via 区分（dsh 侧那两类不画按钮）✗');
	});

	test('⑤ 桥版本两处必须同值（协议常量 vs preload 字面量）', () => {
		const proto = fs.readFileSync(PROTOCOL, 'utf8');
		const preload = fs.readFileSync(PRELOAD, 'utf8');
		const m1 = /export const DSH_PAGE_BRIDGE_VERSION = (\d+);/.exec(proto);
		const m2 = /bridgeVersion: (\d+),/.exec(preload);
		assert.ok(m1 && m2, '找不到版本常量（协议 / preload 各一处）✗');
		assert.strictEqual(m2![1], m1![1],
			`桥版本不一致：协议 ${m1![1]} vs preload ${m2![1]} —— 真机表现是"新命令被静默丢弃"（点了没反应）✗`);
	});

	test('⑥ preload 必须把四条命令都暴露出去（少一条 = 页面点了没反应）', () => {
		const preload = fs.readFileSync(PRELOAD, 'utf8');
		for (const [method, re] of [
			['upgradeRefresh', /upgradeRefresh: \(\) => invoke\(\{ method: 'upgradeRefresh' \}\)/],
			['upgradeBundled', /upgradeBundled: \(name: string\) => invoke\(\{ method: 'upgradeBundled', name \}\)/],
			['upgradeApp', /upgradeApp: \(\) => invoke\(\{ method: 'upgradeApp' \}\)/],
			['upgradeAsset', /upgradeAsset: \(kind: string, slug: string\) => invoke\(\{ method: 'upgradeAsset', kind, slug \}\)/],
		] as const) {
			assert.ok(re.test(preload), `preload 没有暴露 ${method} ✗`);
		}
	});

	test('⑦ upgradeAsset 的 kind 必须走五类白名单（不许手写字符串比较）', () => {
		const proto = strip(fs.readFileSync(PROTOCOL, 'utf8'));
		const at = proto.indexOf("case 'upgradeAsset':");
		assert.ok(at > 0, '找不到 upgradeAsset 的校验分支 ✗');
		const body = proto.slice(at, at + 700);
		assert.ok(/DSH_UPGRADE_ASSET_KINDS/.test(body),
			'必须用 DSH_UPGRADE_ASSET_KINDS 白名单校验 kind（手写字符串会与常量漂移 ✗）');
		assert.ok(/return undefined;/.test(body), '形状不合必须 return undefined（静默放行 = 任意 kind 都能进 ✗）');
	});

	// ★ 2026-10-23（用户报「更新按钮为透明背景，导致和后面的文字有重叠」）
	test('⑨ 侧栏那行必须不透明，且锚在官方状态行**上方**（否则和「N 个工作区 · N 条会话」糊在一起）', () => {
		const page = fs.readFileSync(CHUNK, 'utf8');
		// ① 不透明：overlay 覆盖在官方侧栏上 ⇒ 透明就会透出背后的文字
		// ⚠ 源码里是模板串：选择器写成 `[${MARK}-row]`（MARK = data-vssaros-upgrade）⇒ 按源码形态断言
		const rowCss = /\[\$\{MARK\}-row\]\{([\s\S]{0,700})/.exec(page);
		assert.ok(rowCss, '找不到侧栏那一行的 CSS ✗');
		assert.ok(/background:var\(--dsw-alias-bg-layer-1/.test(rowCss![1]),
			'行必须有**不透明**底色（`--dsw-alias-bg-layer-1` 一类）—— 透明会把背后的状态文字透上来 ✗');
		assert.ok(!/background:transparent/.test(rowCss![1]),
			'行底色不许是 `transparent`（用户报障就是这个：透明 + 重叠 ✗）');
		// ② 定位：必须把官方那行状态文字算进去，锚到它上面
		assert.ok(/function footerStatusTop\(chipRect\)/.test(page),
			'必须识别官方底部的状态行（「N 个工作区 · N 条会话」）✗');
		assert.ok(/statusTop !== null \? statusTop :/.test(page),
			'锚点必须优先用状态行顶部、取不到才退回 chip 顶部 ✗');
		// ③ 判据不能太宽：必须限"短文本 + 就在 chip 上方"
		assert.ok(/个工作区\|条会话\|个会话/.test(page), '状态行判据要认这几类文案 ✗');
		assert.ok(/chipRect\.top - r\.bottom > 64/.test(page),
			'必须限制"紧贴 chip 上方"（否则会话列表项也会被当成状态行，行会飞到列表里 ✗）');
	});

	// ★ 2026-10-23（用户："如果没有可升级的内容，则不用显示 更新UI"）
	test('⑩ 没有可升级内容就整块不显示（不是显示一行"已最新"占地方）', () => {
		const page = fs.readFileSync(CHUNK, 'utf8');
		assert.ok(/const pendingCount = totalPending\(state\);/.test(page),
			'判空必须按"随包插件 + 资产"的总数（只看插件会漏掉资产 ✗）');
		assert.ok(/const appNew = !!\(state && state\.app && state\.app\.action === "upgrade"\);/.test(page),
			'应用有新版也要算"可升级内容"（否则有应用更新时入口反而不显示 ✗）');
		const at = page.indexOf('if (!open && pendingCount === 0 && !appNew && !busyNow) {');
		assert.ok(at > 0, '缺少"没有可升级内容 ⇒ 不渲染"的判据 ✗');
		assert.ok(/if \(!open && pendingCount === 0 && !appNew && !busyNow\) \{\s*return null;/.test(page),
			'判据里必须 return null（否则仍会渲染出一行"已最新" ✗）');
		// 面板开着时不许隐藏（刚升完最后一个就凭空消失 ✗）
		assert.ok(/!open && pendingCount === 0/.test(page), '判据必须包含"面板没开着"（`!open &&`）✗');
		// 顺序：判空必须早于真正渲染
		const firstRender = page.indexOf('return react.createElement(react.Fragment, null,');
		assert.ok(firstRender > 0 && at < firstRender, '判空必须早于渲染 ✗');
	});

	test('⑧ 页面：五类标签与顺序齐全，徽标数把资产算进去', () => {
		const page = fs.readFileSync(CHUNK, 'utf8');
		for (const label of ['技能', 'MCP', '智能体', '工作流', '工作台']) {
			assert.ok(page.includes(label), `页面缺少「${label}」这一类 ✗`);
		}
		const order = /const KIND_ORDER = \[([^\]]+)\]/.exec(page);
		assert.ok(order, '找不到 KIND_ORDER ✗');
		assert.deepStrictEqual(
			order![1].split(',').map(s => s.trim().replace(/["']/g, '')),
			['skill', 'mcp', 'agent', 'workflow', 'workbench'],
			'KIND_ORDER 必须与协议的 DSH_UPGRADE_ASSET_KINDS 同序（否则汇总行与宿主顺序不一致）✗');
		assert.ok(/const totalPending = s => pendingRows\(s\)\.length \+ assetRows\(s\)\.length;/.test(page),
			'徽标数必须是"随包插件 + 资产"合计（只算插件会让用户以为资产不用升 ✗）');
	});
});
