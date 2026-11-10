#!/usr/bin/env node
// 商城工作台插件（`@vssaros/dsh-marketplace`）的**页面脚本守卫**。
//
// ★ 为什么需要这道守卫（同类事故已犯两次，2026-10-22）：
//   在 PowerShell 上用 here-string 落盘长文件时，**内容里的 `||` 会被吞成 `;`**
//   （`|` 被 shell 当成管道符解析）⇒ 前端脚本里出现 `a || b` 变成 `a; b`：
//     · `a; b` 在多数位置**语法合法** ⇒ `node --check` 过得去 ⇒ 不会在提交前被发现；
//     · 运行时语义却变了（`pkg.permissions; {}` ⇒ 权限判定永远落到空对象 ⇒
//       按钮该藏不藏 / 该显不显）⇒ 表现为"界面上少个按钮"这种查不到根因的现象。
//   ⇒ 这道守卫**专门**抓这种"分号夹在表达式中间"的形态 ✓。
//
// ★ 守卫做三件事：
//   1. 扫 `lib/client.js` / `lib/index.js`：不允许出现"分号 + 同行还有内容"的表达式形态
//      （去掉字符串字面量后判定）✓；
//   2. `node --check` 真解析（语法坏了当场红）✓；
//   3. 页内脚本不许出现 `//` 行注释（拼出来是一长行 ⇒ 注释会吃掉后续拼接 ⇒ 整页交互静默失效）✓。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// 本脚本在 `dsh-plugins/` 下 ⇒ 插件目录是它的同级子目录（不是仓库根的子目录）✓
const root = here;
const pluginDir = path.join(root, 'vssaros-marketplace');
const clientFile = path.join(pluginDir, 'lib', 'client.js');
const indexFile = path.join(pluginDir, 'lib', 'index.js');

let problems = 0;
const fail = (msg) => { problems++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✔ ${msg}`);

if (!fs.existsSync(clientFile) || !fs.existsSync(indexFile)) {
	console.error('[check-marketplace-client] 找不到插件文件（vssaros-marketplace/lib/{client,index}.js）');
	process.exit(1);
}

// ── 1. 扫"被吞掉的 ||"形态 ────────────────────────────────────────
/**
 * 判据（**只抓有鉴别力的形态**，避免假阳性）：
 *   误替换 `a || b` → `a; b` 时，若 b 是**对象字面量**，结果是 `a; {}` ——
 *   这在 JS 里**语法合法**（`;` 是语句分隔、`{}` 是空块）⇒ `node --check` 抓不到 ✗
 *   ⇒ 这道守卫专门抓「分号 + 空块」这一形态 ✓（实测两处误替换都是它）。
 *
 * ⚠ **只保留这一条**：更宽的判据（"实参内有分号"）会被**正则字面量**误伤
 *   （`.replace(/"/g, 'x')` 里的分号）⇒ 假阳性会让守卫失去可信度 ✗。
 *   其它形态（`esc(a; 'x')` 这类**实参内**分号）语法非法 ⇒ 由 `node --check` 兜底 ✓。
 */
function scanSwallowedOperators(file) {
	const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
	const hits = [];
	lines.forEach((line, i) => {
		// 去掉字符串/模板串，避免把字符串里的内容当代码
		const code = line
			.replace(/'[^']*'/g, "''")
			.replace(/"[^"]*"/g, '""')
			.replace(/`[^`]*`/g, '``');
		// 「分号 + 空块」⇒ `|| {}` 被吞成 `; {}`
		if (/;\s*\{\s*\}/.test(code)) {
			hits.push({ line: i + 1, text: line.trim() });
		}
	});
	return hits;
}

for (const file of [clientFile, indexFile]) {
	const hits = scanSwallowedOperators(file);
	const rel = path.relative(root, file);
	if (hits.length === 0) {
		ok(`${rel}：没有被吞掉的运算符（分号形态扫描）`);
	} else {
		for (const h of hits) {
			fail(`${rel}:${h.line} 疑似 || 被吞成 ;（PowerShell here-string 会吃掉 |）⇒ ${h.text}`);
		}
	}
}

// ── 2. 真解析（语法坏了当场红）──────────────────────────────────
for (const file of [clientFile, indexFile]) {
	const rel = path.relative(root, file);
	try {
		execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', windowsHide: true });
		ok(`${rel}：node --check 通过`);
	} catch (e) {
		fail(`${rel}：语法错误（node --check 失败）⇒ ${String(e.stderr ?? e.message).split('\n').slice(0, 3).join(' ')}`);
	}
}

// ── 3. 清单与路由的自洽（页面必须能被 IDE 侧清单解析出来）────────
{
	const rel = path.relative(root, path.join(root, 'vssaros-marketplace', 'package.json'));
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'vssaros-marketplace', 'package.json'), 'utf8'));
	const route = pkg?.vssaros?.view?.route;
	if (route === '/x/marketplace/') {
		ok(`${rel}：清单路由 = ${route}（与页面/Host 路由一致）`);
	} else {
		fail(`${rel}：清单路由应为 /x/marketplace/，实际 ${String(route)}`);
	}
	const caps = pkg?.vssaros?.ideCapabilities;
	if (Array.isArray(caps) && caps.includes('marketplace')) {
		ok(`${rel}：清单声明了 marketplace 能力（否则 IDE 侧会拒授权）`);
	} else {
		fail(`${rel}：清单必须声明 ideCapabilities:["marketplace"]（缺了 IDE 侧直接拒授权）`);
	}
}

// ── 4. 「已安装」状态必须真的被页面消费（★ 2026-10-29）──────────
//
// 为什么守：Host 侧早就在 list/detail 里算了 `installedVersion`（2026-10-29 起还带
//   **磁盘落地物核对**），但页面一直没读它 ⇒ 装完的商品卡片仍然显示「安装」。
//   这种"算好了没人用"的静默失效，语法检查与数据单测都抓不到（数据是对的，只是没人取）✗
//   ⇒ 至少两处消费（卡片 + 详情抽屉），且 Host 必须走 `installedState.js` 的判据。
{
	const client = fs.readFileSync(clientFile, 'utf8');
	const index = fs.readFileSync(indexFile, 'utf8');
	// 两个表面**各自**必须读（只数"取值"形态，注释里提字段名不算）
	// ⚠ 必须带 `\b`：否则 `d.installedVersionMUT` 这种改名/打错也会被当成"读到了"（假绿）
	const inCard = /pkg\.installedVersion\b/.test(client);
	const inDetail = /d\.installedVersion\b/.test(client);
	if (inCard) { ok('lib/client.js：卡片读 pkg.installedVersion（装完的卡片显示"已安装"）'); }
	else { fail('lib/client.js：卡片没读 pkg.installedVersion ⇒ 装完仍显示「安装」'); }
	if (inDetail) { ok('lib/client.js：详情抽屉读 d.installedVersion（与卡片同一状态）'); }
	else { fail('lib/client.js：详情抽屉没读 d.installedVersion ⇒ 卡片说"已安装"、抽屉还说「安装」'); }
	if (index.includes('resolveInstalledVersions') && index.includes('./installedState.js')) {
		ok('lib/index.js：已安装状态取自 installedState.js（磁盘核对，不是裸台账）');
	} else {
		fail('lib/index.js：必须用 installedState.js 的 resolveInstalledVersions（裸台账会谎报已安装）');
	}
}

// ── 5. `/api/action` 的**参数形状契约**（★ 2026-10-31）────────────
//
// 为什么守：这条接口的入参是 `{ op, params:{...} }`——**params 是嵌套的**。
//   只要有一端写成平铺（`{ op, kind }`），`params` 就会是 `{}` ⇒
//   **筛选条件被静默丢弃**（表现为"点了页签却还是全部商品"，且没有任何报错）。
//   这次就是我在验证脚本里写平了，白查了一轮 ✗ ⇒ 把形状钉死。
{
	const client = fs.readFileSync(clientFile, 'utf8');
	const index = fs.readFileSync(indexFile, 'utf8');
	const mkt = fs.readFileSync(path.join(root, 'vssaros-marketplace', 'lib', 'marketClient.js'), 'utf8');

	// ① 前端：必须发 { op, params }
	if (/JSON\.stringify\(\{\s*op:\s*op,\s*params:\s*params/.test(client)) {
		ok('lib/client.js：动作请求发 { op, params }（params 嵌套，不是平铺）');
	} else {
		fail('lib/client.js：动作请求必须是 { op, params }（平铺会让筛选条件被静默丢弃）');
	}
	// ② 宿主：必须读 parsed.params
	if (/const params = parsed\.params \?\? \{\}/.test(index)) {
		ok('lib/index.js：宿主读 parsed.params（与前端形状对齐）');
	} else {
		fail('lib/index.js：宿主必须读 parsed.params ?? {}（读错形状 ⇒ 筛选全丢）');
	}
	// ③ list 必须把 kind 传下去（页签筛选靠它）
	if (/\.\.\.\(params\.kind \? \{ kind: String\(params\.kind\) \} : \{\}\)/.test(index)) {
		ok('lib/index.js：list 把 kind 传给服务端（页签筛选生效）');
	} else {
		fail('lib/index.js：list 必须把 params.kind 传下去 ⇒ 否则点页签仍返回全部');
	}
	// ④ marketClient 必须把 kind 拼进查询串
	if (/if \(opts\.kind\) \{ qs\.set\('kind', opts\.kind\)/.test(mkt)) {
		ok('lib/marketClient.js：kind 拼进查询串');
	} else {
		fail('lib/marketClient.js：kind 必须拼进查询串（否则服务端收不到筛选）');
	}
}

// ── 6. 分类页签必须有 MCP，且后端真的支持这一类（★ 2026-11-10）────
//
// 为什么守：服务端 kinds 早含 mcp、MCP 商品也已在库里，但页签把它藏了
//   ⇒ 只能去「全部」里翻，而「全部」被大量 plugin 挤满 ⇒ 等于找不到。
//   只加页签还不够：Host 的 KINDS 与安装分派表也认 mcp，点进去才装得上。
{
	const client = fs.readFileSync(clientFile, 'utf8');
	const index = fs.readFileSync(indexFile, 'utf8');
	const dispatch = fs.readFileSync(path.join(pluginDir, 'lib', 'dispatch.js'), 'utf8');
	const m = client.match(/var KIND_TABS\s*=\s*\[([\s\S]*?)\];/);
	const ids = m ? Array.from(m[1].matchAll(/id:\s*'([^']*)'/g), x => x[1]) : [];
	const iSkill = ids.indexOf('skill');
	const iMcp = ids.indexOf('mcp');
	const iWorkbench = ids.indexOf('workbench');
	if (m && iSkill >= 0 && iMcp > iSkill && iWorkbench > iMcp) {
		ok('lib/client.js：分类页签含 MCP 且位于 Skill 与工作台之间');
	} else {
		fail('lib/client.js：KIND_TABS 必须在 skill 与 workbench 之间含 mcp（id 与服务端 kind 同值）');
	}
	if (/const KINDS\s*=\s*\[[^\]]*'mcp'/.test(index)) {
		ok('lib/index.js：Host 的 KINDS 含 mcp（页签筛选有后端支持）');
	} else {
		fail('lib/index.js：KINDS 缺 mcp ⇒ MCP 页签点开也拿不到商品');
	}
	if (/LOCAL_WRITE_KINDS[\s\S]{0,240}?'mcp'/.test(dispatch)) {
		ok('lib/dispatch.js：LOCAL_WRITE_KINDS 含 mcp（MCP 商品走本地落盘安装）');
	} else {
		fail('lib/dispatch.js：LOCAL_WRITE_KINDS 缺 mcp ⇒ 页签有商品也装不上');
	}
}

// ── 7. 「安装」按钮不能被发布权限门控（★ 2026-11-10 真机报障）──────
//
// 为什么守：卡片与详情抽屉曾把「安装」挂在服务端 permissions 的发布权限上。
//   普通用户浏览别人的包一律无权 ⇒ 两个表面都不渲染按钮 ⇒ 表现为
//   「所有类别的 item 都无法安装」，且不报错、语法与数据全对 ✗
//   安装面向所有登录用户；能否安装由 Host/服务端裁决，失败在消息条如实显示。
{
	const raw = fs.readFileSync(clientFile, 'utf8');
	// 注释里提到字段名不算（判据要看**代码形态**，别被说明文字绕过）
	const stripComments = (src) => src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split(/\r?\n/)
		.map((line) => line.replace(/\/\/.*$/, ''))
		.join('\n');
	const code = stripComments(raw);
	const cardSrc = stripComments(raw.slice(raw.indexOf('function Card(props)'), raw.indexOf('function Drawer(props)')));
	const detailSrc = stripComments(raw.slice(raw.indexOf('function DetailDrawer(props)'), raw.indexOf('function PublishDrawer(props)')));
	// ① 两个表面都必须有「安装」按钮，且真的接上 onInstall
	for (const [label, body] of [['卡片', cardSrc], ['详情抽屉', detailSrc]]) {
		if (/},\s*'安装'\)/.test(body) && /props\.onInstall/.test(body)) {
			ok(`lib/client.js：${label}有「安装」按钮且接上 onInstall`);
		} else {
			fail(`lib/client.js：${label}缺「安装」按钮（或未接 onInstall）⇒ 商品装不了`);
		}
	}
	// ② 装不装得上只看「是否已安装」，源码里不得再用发布权限做门控
	if (!/\bcanPublish\b/.test(code)) {
		ok('lib/client.js：安装不再由发布权限门控（普通用户也能看到安装按钮）');
	} else {
		fail('lib/client.js：安装按钮不得依赖 canPublish（普通用户一律无权 ⇒ 按钮全消失）');
	}
	// ③ 卡片完全不该读 permissions（编辑/下架判权只在详情抽屉）
	if (!/permissions/.test(cardSrc)) {
		ok('lib/client.js：卡片不读 permissions（安装是公开动作）');
	} else {
		fail('lib/client.js：卡片不该读 permissions ⇒ 很可能又拿权限挡住了安装');
	}
}

// ── 8. 自托管页必须跟随 dsh「外观」（★ 2026-11-10 真机报障）────────
//
// 为什么守：商城是**独立 document** 的自托管 SSR 页，拿不到宿主的 --dsw-alias-*
//   （CSS 变量不跨 iframe 继承）。旧版 page.css 把 html/body 写死成深色 +
//   color-scheme:dark，且变量全引用**不存在**的 --dsw-fg / --vscode-* 系列
//   ⇒ 恒走一套深色兜底 ⇒ 切浅色外观时整页纹丝不动，且没有任何报错 ✗
//   ⇒ 判据：根底色走变量 + 有 light 档且真的换了值 + 只用真实 alias 令牌。
{
	const cssFile = path.join(pluginDir, 'lib', 'page.css');
	const css = fs.readFileSync(cssFile, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	/** 取某个起点之后的那对花括号内容（@media 里嵌 :root ⇒ 正则非贪婪会截断）。 */
	const blockAfter = (src, startRe) => {
		const m = startRe.exec(src);
		if (!m) { return ''; }
		const open = src.indexOf('{', m.index);
		if (open < 0) { return ''; }
		let depth = 0;
		for (let i = open; i < src.length; i++) {
			if (src[i] === '{') { depth++; }
			else if (src[i] === '}') { depth--; if (depth === 0) { return src.slice(open + 1, i); } }
		}
		return '';
	};
	// ① 页面底色/前景不能写死（否则外观切换根本影响不到它）
	const rootRule = (css.match(/html\s*,\s*body\s*\{([\s\S]*?)\}/) || [, ''])[1];
	if (/background:\s*var\(--/.test(rootRule) && /color:\s*var\(--/.test(rootRule)
		&& !/#[0-9a-fA-F]{3,8}\b/.test(rootRule)) {
		ok('lib/page.css：html/body 的底色与前景走主题变量（不写死深色）');
	} else {
		fail('lib/page.css：html/body 写死了底色/前景 ⇒ 切浅色外观整页不变');
	}
	// ② 必须有 light 档，且浅色档里真的重定义了底色与 color-scheme
	const lightBlock = blockAfter(css, /@media\s*\(prefers-color-scheme:\s*light\)/);
	if (/--vs-mp-bg\s*:/.test(lightBlock) && /color-scheme:\s*light/.test(lightBlock)) {
		ok('lib/page.css：有 prefers-color-scheme:light 档且重定义了底色/表单配色');
	} else {
		fail('lib/page.css：缺浅色档（或浅色档没换底色）⇒ 外观切到浅色时仍是深色');
	}
	if (/color-scheme:\s*dark/.test(css) && /color-scheme:\s*light/.test(css)) {
		ok('lib/page.css：深浅两档 color-scheme 都在（滚动条/表单跟随）');
	} else {
		fail('lib/page.css：color-scheme 必须深浅各一档，写死 dark 会让表单控件永远深色');
	}
	// ③ 只用真实存在的 dsh 令牌；不存在的令牌名 = 静默回落到兜底值
	if (/var\(--dsw-alias-/.test(css)) {
		ok('lib/page.css：变量优先取 --dsw-alias-* 真令牌（宿主注入时自动跟随）');
	} else {
		fail('lib/page.css：变量必须写成 var(--dsw-alias-*, <兜底>)');
	}
	if (!/var\(--dsw-(?!alias-|specific-|static-)/.test(css) && !/var\(--vscode-/.test(css)) {
		ok('lib/page.css：不再引用 --dsw-fg / --vscode-* 这类页内恒不存在的令牌');
	} else {
		fail('lib/page.css：引用了不存在的令牌系列 ⇒ 恒走兜底值，明暗不跟随');
	}
	// ④ 组件里不许再写死表面色（兜底值只能出现在 var() 内）
	if (!/background(?:-color)?:\s*#/.test(css) && !/(?:^|[;{])\s*color:\s*#/.test(css)) {
		ok('lib/page.css：组件表面色/前景色没有裸色值');
	} else {
		fail('lib/page.css：组件里写死了颜色 ⇒ 该处不会跟随外观');
	}
}

// ── 9. 安装前预览 / 安全模式（★ 2026-11-10 P0：安全与信任）──────
//
// 为什么守：官方 dsh-desktop 的 .dshpreset 用「预览 → 确认」两步 + 密钥/路径告警
//   把不可信包挡在落盘之前；商城此前点「安装」直接下载解包，没有任何拦截面。
//   这类防线最容易被「赶时间直接调 run('install')」绕掉 ⇒ 钉住接线 + 纯函数行为。
{
	const client = fs.readFileSync(clientFile, 'utf8');
	const idx = fs.readFileSync(indexFile, 'utf8');
	const disp = fs.readFileSync(path.join(pluginDir, 'lib', 'dispatch.js'), 'utf8');
	const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
	const previewFile = path.join(pluginDir, 'lib', 'preview.js');

	if (/LOCAL_READ_OPS = new Set\([^\n]*'previewInstall'[^\n]*'safeModePlan'/.test(disp)) {
		ok('lib/dispatch.js：previewInstall / safeModePlan 都是只读 op（不触发写审批）');
	} else {
		fail('lib/dispatch.js：两个新 op 必须在 LOCAL_READ_OPS 里（否则会落到 IDE 兜底）');
	}
	if (/op === 'previewInstall'/.test(idx) && /op === 'safeModePlan'/.test(idx)) {
		ok('lib/index.js：Host 实现了预览与安全模式计划');
	} else {
		fail('lib/index.js：缺预览/安全模式分支 ⇒ 页面点了没回执');
	}
	const at = idx.indexOf("if (op === 'previewInstall')");
	const end = idx.indexOf("if (op === 'safeModePlan')");
	const previewBlock = at >= 0 && end > at ? idx.slice(at, end) : '';
	if (previewBlock && !/upsertInstalled|installBundle|writeFile|mkdir\(|registerMcpServer/.test(previewBlock)) {
		ok('lib/index.js：预览分支不落盘 / 不写台账 / 不注册（真的只读）');
	} else {
		fail('lib/index.js：预览分支里出现了写副作用 ⇒ 两步确认形同虚设');
	}
	if (/var onInstall = function \(pkg\) \{ void openPreview\(pkg, false\); \}/.test(client)) {
		ok('lib/client.js：点安装先进预览抽屉，不直接落盘');
	} else {
		fail('lib/client.js：onInstall 必须走 openPreview（直接 run install 会绕过告警）');
	}
	if (/disabled: !!p\.blocked/.test(client) && /已阻止安装/.test(client)) {
		ok('lib/client.js：高危内容禁用「确认安装」并给出原因');
	} else {
		fail('lib/client.js：preview.blocked 必须挡住确认按钮');
	}
	if (/function restoreSafeMode/.test(client) && /localStorage\.getItem\(SAFE_MODE_KEY\)/.test(client)
		&& /onRestore/.test(client)) {
		ok('lib/client.js：安全模式有「按记录恢复」路径（非破坏）');
	} else {
		fail('lib/client.js：安全模式必须能按 localStorage 记录恢复');
	}
	if (/res\.shaNote/.test(client) && /已发布/.test(client)) {
		ok('lib/client.js：发布回执展示锁定的 commit（pin commit 可见）');
	} else {
		fail('lib/client.js：Host 返回的 shaNote 没回显给作者 ⇒ 锁没锁住看不见');
	}
	if (fs.existsSync(previewFile) && (pkg.files || []).includes('lib/preview.js')) {
		ok('package.json：lib/preview.js 已进 files（漏了装到用户机就缺件）');
	} else {
		fail('package.json：新 lib 文件必须补进 files 数组');
	}

	// 行为级：纯函数必须真抓得住危险内容，且不误伤正常包 / 二进制
	if (fs.existsSync(previewFile)) {
		const pv = await import(pathToFileURL(previewFile).href);
		const buf = (s, p = 'a.md') => ({ path: p, data: Buffer.from(s, 'utf8') });
		const hit = pv.scanPackageFiles([buf('token sk-abcdefghijklmnopqrstuvwxyz012345')]);
		if (hit.blocked && hit.warnings.some(w => w.level === 'danger')) {
			ok('preview.js：真密钥形态 ⇒ blocked（负对照）');
		} else { fail('preview.js：密钥形态没被判为 danger'); }
		const clean = pv.scanPackageFiles([buf('---\nname: demo\n---\n\n正文\n')]);
		if (!clean.blocked && clean.warnings.length === 0) {
			ok('preview.js：正常 SKILL.md 零告警（正对照）');
		} else { fail('preview.js：正常包被误报'); }
		const binary = pv.scanPackageFiles([buf('sk-abcdefghijklmnopqrstuvwxyz012345', 'cover.png')]);
		if (!binary.blocked && binary.scanned === 0) {
			ok('preview.js：二进制封面不扫描（避免误报与无谓开销）');
		} else { fail('preview.js：不该扫二进制文件'); }
		const npm = pv.distributionWarnings({ type: 'npm', name: '@x/y' }, 'skill');
		if (npm.some(w => w.level === 'danger' && /不支持安装/.test(w.text))) {
			ok('preview.js：npm 源 + 资源类 ⇒ 如实判为装不了');
		} else { fail('preview.js：npm 源资源类必须判 danger'); }
		const unlocked = pv.distributionWarnings({ type: 'github-source', name: 'a/b' }, 'skill');
		const pinned = pv.distributionWarnings({ type: 'github-source', name: 'a/b', commit: 'abc123' }, 'skill');
		if (unlocked.length === 1 && unlocked[0].level === 'warn' && pinned.length === 0) {
			ok('preview.js：未锁 commit 只警告，锁定后零告警');
		} else { fail('preview.js：commit 锁定判据不对'); }
		const rel = pv.distributionWarnings({ type: 'github-release', url: 'https://x/y.tgz' }, 'skill');
		if (rel.some(w => w.level === 'danger' && /sha256/.test(w.text))) {
			ok('preview.js：github-release 缺 sha256 ⇒ 阻止安装');
		} else { fail('preview.js：缺 sha256 必须挡下'); }
		const sum = pv.summarizeDistribution({ type: 'github-source', name: 'a/b', commit: 'deadbeef' });
		if (sum.fields.some(f => f.k === '锁定 commit' && f.v === 'deadbeef')) {
			ok('preview.js：pin commit 会展现在预览里');
		} else { fail('preview.js：commit 没进预览字段'); }
		const fin = pv.finishPreview({ ok: true, warnings: [{ level: 'warn', text: 'x' }] },
			{ warnings: [{ level: 'danger', text: 'y' }], scanned: 1 });
		if (fin.blocked && fin.scanned === 1 && fin.warnings.length === 2) {
			ok('preview.js：来源告警与包内扫描合并后仍正确 blocked');
		} else { fail('preview.js：finishPreview 合并语义不对'); }
	}
}

// ── 10. 技能正文净化 / 侧车溯源（★ 2026-11-10 P1）────────────────
//
// 为什么守：官方 dsh / Agent Skills 的 SKILL.md 是纯内容。往 frontmatter 注入
//   storeId / version / displayName 会让装回来的技能带脏字段、无法拷到别的生态，
//   且每次升级都改写作者原文。元数据必须走同级 `.market.json` 侧车。
//   最容易复发的是「图省事又调一次 injectSkillFrontmatter」⇒ 钉住调用点数量。
{
	const ins = fs.readFileSync(path.join(pluginDir, 'lib', 'installers.js'), 'utf8');
	const pub = fs.readFileSync(path.join(pluginDir, 'lib', 'publisher.js'), 'utf8');
	const state = fs.readFileSync(path.join(pluginDir, 'lib', 'installedState.js'), 'utf8');
	const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
	const sidecarFile = path.join(pluginDir, 'lib', 'sidecar.js');

	// `injectSkillFrontmatter(` 只应剩函数**定义**那一处；出现 2+ 次即有人又去改正文
	const callSites = (ins.match(/injectSkillFrontmatter\(/g) || []).length;
	if (callSites === 1) {
		ok('lib/installers.js：安装链不再改写 SKILL.md frontmatter（纯函数仅保留兼容导出）');
	} else {
		fail(`lib/installers.js：injectSkillFrontmatter 出现 ${callSites} 次 ⇒ 技能正文又被注入了宿主字段`);
	}
	// 必须钉到「推进 runtimeFiles」这一步：只写 sidecarOf 却推进了别的路径，
	//   页面上照样显示装成功，但溯源文件其实没落盘（反向突变验证过会漏）。
	if (/sidecarOf\(\{ storeId, version, displayName \}\)/.test(ins)
		&& /f\.path !== SIDECAR_FILE/.test(ins)
		&& /runtimeFiles\.push\(\{ path: SIDECAR_FILE/.test(ins)) {
		ok('lib/installers.js：安装落盘写侧车，且包内旧侧车不会覆盖新溯源');
	} else {
		fail('lib/installers.js：侧车没写进资源目录（升级溯源会断）');
	}
	if (/readSidecar\(/.test(ins) && /side\?\.version/.test(ins)) {
		ok('lib/installers.js：已装版本优先读侧车');
	} else {
		fail('lib/installers.js：侧车没参与版本判定');
	}
	if (/EXCLUDE_FILES\s*=\s*new Set\([^\n]*\.market\.json/.test(pub)) {
		ok('lib/publisher.js：发布时排除侧车（不把本机安装状态打进新包）');
	} else {
		fail('lib/publisher.js：侧车必须排除，否则别人会装到上一个来源的 storeId/版本');
	}
	// ★ 顺带还上一轮欠账：knowledge 的「已安装」不再只信台账
	if (/if \(kind === 'knowledge'\)[\s\S]{0,140}targetRootOf/.test(state)
		&& /\|\| kind === 'knowledge'/.test(state)) {
		ok('lib/installedState.js：knowledge 也做磁盘落地物核对（不再只信台账）');
	} else {
		fail('lib/installedState.js：knowledge 仍只信台账 ⇒ 删了目录还谎报已装');
	}
	if (fs.existsSync(sidecarFile) && (pkg.files || []).includes('lib/sidecar.js')) {
		ok('package.json：lib/sidecar.js 已进 files（漏了装到用户机会缺件）');
	} else {
		fail('package.json：新 lib 文件必须补进 files 数组');
	}

	if (fs.existsSync(sidecarFile)) {
		const side = await import(pathToFileURL(sidecarFile).href);
		const parsed = side.parseSidecar(side.sidecarOf({ storeId: 'a', version: '1.2.3', displayName: '甲' }));
		if (parsed && parsed.storeId === 'a' && parsed.version === '1.2.3' && parsed.displayName === '甲') {
			ok('sidecar.js：侧车读写往返一致');
		} else { fail('sidecar.js：侧车字段往返丢了'); }
		if (side.parseSidecar('{"foo":1}') === null && side.parseSidecar('坏 JSON') === null) {
			ok('sidecar.js：非本家格式 / 坏文件 ⇒ null（存量技能安全兜底）');
		} else { fail('sidecar.js：坏侧车必须安全返回 null'); }

		// 行为级：真落一份「老技能」到临时目录，验证无侧车时回退 frontmatter；写侧车后优先
		const { default: os } = await import('node:os');
		const fsp = await import('node:fs/promises');
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vssaros-mp-p1-'));
		try {
			await fsp.mkdir(path.join(tmp, 'skills', 'legacy'), { recursive: true });
			await fsp.writeFile(path.join(tmp, 'skills', 'legacy', 'SKILL.md'),
				'---\nname: legacy\nversion: 9.9.9\n---\n\n正文\n');
			const { installedVersionOf } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'installers.js')).href);
			const before = await installedVersionOf({ dataRoot: tmp, kind: 'skill', storeId: 'legacy' });
			if (before === '9.9.9') {
				ok('installedVersionOf：存量技能无侧车 ⇒ 回退正文 frontmatter（不误判没装）');
			} else { fail(`installedVersionOf：存量兼容断了（读到 ${before}）`); }
			await fsp.writeFile(path.join(tmp, 'skills', 'legacy', '.market.json'),
				side.sidecarOf({ storeId: 'legacy', version: '10.0.0' }));
			const after = await installedVersionOf({ dataRoot: tmp, kind: 'skill', storeId: 'legacy' });
			if (after === '10.0.0') {
				ok('installedVersionOf：有侧车 ⇒ 优先取侧车版本（升级判断仍准）');
			} else { fail(`installedVersionOf：侧车优先级不对（读到 ${after}）`); }
		} finally {
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	}
}

// ── 11. 统一组合包 components.json（★ 2026-11-10 P1-B）────────────
//
// 为什么守：组合包是「一个包分发到 4 个数据根」，最容易出的错是接线只做一半 ——
//   能发不能装、能装不能卸、卸了留孤儿组件。⇒ 除了源码接线，必须真跑一遍
//   「发布判据 → 落盘 → 台账 owner → 级联卸载」的端到端闭环。
{
	const ins = fs.readFileSync(path.join(pluginDir, 'lib', 'installers.js'), 'utf8');
	const pub = fs.readFileSync(path.join(pluginDir, 'lib', 'publisher.js'), 'utf8');
	const idx = fs.readFileSync(indexFile, 'utf8');
	const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
	const compFile = path.join(pluginDir, 'lib', 'components.js');

	if (/const combo = readComponents\(files\)/.test(ins) && /installComponentsPack\(/.test(ins)
		&& /同时有 bot\.json 与 components\.json/.test(ins)) {
		ok('lib/installers.js：识别可选 components.json、两份清单互斥、走组合安装');
	} else { fail('lib/installers.js：组合包接线不全（或没挡住 bot.json 与 components.json 并存）'); }
	if (/validateComponents\(\{ files, pack, kind, storeId: localId \}\)/.test(pub)) {
		ok('lib/publisher.js：发布预检复用安装端同一份闭包判据（不会发出装不上的包）');
	} else { fail('lib/publisher.js：组合包发布没做预检'); }
	if (/const owned = \(await readInstalled\(dataRoot\)\)/.test(ins) && /cascadeRemoveOwned\(dataRoot, storeId, owned\)/.test(ins)) {
		ok('lib/installers.js：卸载按台账 owner 级联清理（不依赖清单是否落盘）');
	} else { fail('lib/installers.js：缺级联卸载 ⇒ 卸组合包会留孤儿组件'); }
	if (/installed\.combo \? \{ combo: installed\.combo, comboComponents/.test(idx)) {
		ok('lib/index.js：组合包回执透出组件清单（前端能如实提示生效边界）');
	} else { fail('lib/index.js：组合包回执没透出 ⇒ 用户不知道装了几个组件'); }
	if (fs.existsSync(compFile) && (pkg.files || []).includes('lib/components.js')) {
		ok('package.json：lib/components.js 已进 files（漏了装到用户机会缺件）');
	} else { fail('package.json：新 lib 文件必须补进 files 数组'); }

	if (fs.existsSync(compFile)) {
		const C = await import(pathToFileURL(compFile).href);
		const mk = (components) => ({ path: 'components.json', data: Buffer.from(JSON.stringify({ format: 'vssaros-components', components })) });
		const GOOD = [
			{ kind: 'skill', id: 'combo-demo', path: '' },
			{ kind: 'skill', id: 'combo-demo-extra', path: 'skills/extra' },
			{ kind: 'mcp', id: 'combo-demo-search', path: 'mcp/search' },
		];
		const throws = (fn) => { try { fn(); return false; } catch { return true; } };
		if (C.readComponents([]) === null) {
			ok('components.js：无 components.json ⇒ null（存量 7023 条商品零影响）');
		} else { fail('components.js：没有清单时必须返回 null 走原链路'); }
		if (throws(() => C.readComponents([mk([{ kind: 'bogus', id: 'x' }])]))
			&& throws(() => C.readComponents([mk([...GOOD, { kind: 'skill', id: 'combo-demo', path: 'z' }])]))
			&& throws(() => C.readComponents([mk([{ kind: 'skill', id: 'x', path: '../escape' }])]))) {
			ok('components.js：非法 kind / 重复 id / 越界 path 一律拒绝');
		} else { fail('components.js：结构校验有漏网之鱼'); }

		const files = [
			{ path: 'manifest.json', data: Buffer.from('{}') },
			mk(GOOD),
			{ path: 'SKILL.md', data: Buffer.from('---\nname: combo-demo\n---\n\n正文\n') },
			{ path: 'skills/extra/SKILL.md', data: Buffer.from('---\nname: combo-demo-extra\n---\n\n附加\n') },
			{ path: 'mcp/search/config.json', data: Buffer.from('{"transport":"stdio","command":"node"}') },
		];
		const checked = C.validateComponents({ files, pack: C.readComponents(files), kind: 'skill', storeId: 'combo-demo' });
		// buckets 的 key 是 `readComponents` 解析出的对象，不能用 GOOD 数组里的字面量对象去取
		if (checked.buckets.size === 3
			&& checked.buckets.get(checked.components[1])[0]?.path === 'SKILL.md') {
			ok('components.js：闭包分派正确且剥掉了组件 path 前缀');
		} else { fail('components.js：文件分派/前缀剥离不对'); }
		// 去掉主组件的 SKILL.md ⇒ 根组件没有实体文件，闭包不成立
		const noEntry = files.filter(f => f.path !== 'SKILL.md');
		if (throws(() => C.validateComponents({ files, pack: C.readComponents(files), kind: 'skill', storeId: 'other' }))
			&& throws(() => C.validateComponents({ files, pack: { components: GOOD.map(c => c.id === 'combo-demo-extra' ? { ...c, id: 'rogue' } : c) }, kind: 'skill', storeId: 'combo-demo' }))
			&& throws(() => C.validateComponents({ files: noEntry, pack: C.readComponents(files), kind: 'skill', storeId: 'combo-demo' }))) {
			ok('components.js：缺主组件 / 缺命名空间 / 闭包不成立都被拒');
		} else { fail('components.js：主组件或命名空间校验不严'); }

		// 端到端：真打一个 tar.gz → 装 → 核对 3 个数据根/台账/mcp.json → 卸 → 全清
		const LIB = path.join(pluginDir, 'lib');
		const { packTarGz } = await import(pathToFileURL(path.join(LIB, 'tar.js')).href);
		const { installBundle, uninstallBundle } = await import(pathToFileURL(path.join(LIB, 'installers.js')).href);
		const { readInstalled } = await import(pathToFileURL(path.join(LIB, 'installedLedger.js')).href);
		const { readMcpJson } = await import(pathToFileURL(path.join(LIB, 'mcpInstall.js')).href);
		const { default: os } = await import('node:os');
		const fsp = await import('node:fs/promises');
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vssaros-mp-p1b-'));
		try {
			const gz = packTarGz([
				{ path: 'manifest.json', data: Buffer.from(JSON.stringify({ kind: 'skill', id: 'combo-demo', version: '1.0.0', files: [] })) },
				mk(GOOD),
				{ path: 'SKILL.md', data: Buffer.from('---\nname: combo-demo\ndescription: 主技能\n---\n\n正文\n') },
				{ path: 'skills/extra/SKILL.md', data: Buffer.from('---\nname: combo-demo-extra\n---\n\n附加技能\n') },
				{ path: 'mcp/search/config.json', data: Buffer.from(JSON.stringify({ transport: 'stdio', command: 'node', args: ['server.js'] })) },
			]);
			const res = await installBundle({ dataRoot: tmp, kind: 'skill', storeId: 'combo-demo', version: '1.0.0', gzBuffer: gz });
			const dirs = [
				path.join(tmp, 'skills', 'combo-demo'),
				path.join(tmp, 'skills', 'combo-demo-extra'),
				path.join(tmp, 'mcp', 'combo-demo-search'),
			];
			if (res.combo?.count === 3 && dirs.every(d => fs.existsSync(d))) {
				ok('组合包端到端：3 个组件分别落进 skills / mcp 数据根');
			} else { fail(`组合包端到端：落盘不全（${JSON.stringify(res.combo)}）`); }
			const mainMd = fs.readFileSync(path.join(dirs[0], 'SKILL.md'), 'utf8');
			if (!/^storeId:/m.test(mainMd) && fs.existsSync(path.join(dirs[0], '.market.json'))) {
				ok('组合包端到端：主技能正文保持纯内容 + 侧车溯源');
			} else { fail('组合包端到端：主技能正文被污染或没写侧车'); }
			const ledger = await readInstalled(tmp);
			const owned = ledger.filter(e => e.owner === 'combo-demo');
			const mcpJson = await readMcpJson(tmp).catch(() => null);
			if (owned.length === 3 && !!mcpJson?.servers?.['combo-demo-search']) {
				ok('组合包端到端：3 条台账带 owner，MCP 已注册进 mcp.json');
			} else { fail(`组合包端到端：台账/MCP 注册不对（owner=${owned.length}）`); }
			await uninstallBundle({ dataRoot: tmp, kind: 'skill', storeId: 'combo-demo' });
			const after = await readInstalled(tmp);
			const mcpAfter = await readMcpJson(tmp).catch(() => null);
			if (dirs.every(d => !fs.existsSync(d)) && after.filter(e => e.owner === 'combo-demo').length === 0
				&& !mcpAfter?.servers?.['combo-demo-search']) {
				ok('组合包端到端：卸载级联清干净（目录 / 台账 / mcp.json 无残留）');
			} else { fail('组合包端到端：卸载留下了孤儿组件'); }
		} finally {
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	}
}

// ── 12. 离线便携包（★ 2026-11-10 P2）──────────────────────────────
//
// 为什么守：dsh-desktop 的 .dshpreset 有「预览 → 确认 / 不覆盖同 id / 原子落盘 /
//   失败不留半个目录」四道闸。少任何一道都会变成「导入把本机资源覆盖了」或
//   「装了 1/2 个还报成功」。⇒ 除了源码接线，必须真跑导出 → 导入 → 冲突 →
//   改名 → 坏包 → 半包回滚的闭环。
{
	const disp = fs.readFileSync(path.join(pluginDir, 'lib', 'dispatch.js'), 'utf8');
	const idx = fs.readFileSync(indexFile, 'utf8');
	const ui = fs.readFileSync(clientFile, 'utf8');
	const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
	const portableFile = path.join(pluginDir, 'lib', 'portable.js');

	if (/PORTABLE_READ_OPS/.test(disp) && /PORTABLE_WRITE_OPS/.test(disp)
		&& /PORTABLE_WRITE_OPS\.has\(name\)\) \{ return 'local-write'; \}/.test(disp)) {
		ok('lib/dispatch.js：便携包导出/预览只读、导入按写操作分派（不绕过确认链）');
	} else { fail('lib/dispatch.js：便携包分派集合/去向不全'); }
	if (/if \(op === 'exportPortable' \|\| op === 'previewPortable'\)/.test(idx)
		&& /if \(op === 'importPortable'\)/.test(idx)) {
		ok('lib/index.js：Host 实现了导出 / 预览 / 导入三个分支');
	} else { fail('lib/index.js：便携包 op 没接上 ⇒ 页面点了没回执'); }
	if (/function PortableDrawer\(props\)/.test(ui) && /onPick: pickPortableFile/.test(ui)
		&& /confirmPortableImport/.test(ui) && /'便携包'/.test(ui)) {
		ok('lib/client.js：便携包抽屉与两步确认（选文件 → 预览 → 确认导入）');
	} else { fail('lib/client.js：便携包 UI 或两步确认链不完整'); }
	if (fs.existsSync(portableFile) && (pkg.files || []).includes('lib/portable.js')) {
		ok('package.json：lib/portable.js 已进 files（漏了装到用户机会缺件）');
	} else { fail('package.json：新 lib 文件必须补进 files 数组'); }

	if (fs.existsSync(portableFile)) {
		const LIB = path.join(pluginDir, 'lib');
		const P = await import(pathToFileURL(portableFile).href);
		const { packTarGz } = await import(pathToFileURL(path.join(LIB, 'tar.js')).href);
		const { readInstalled } = await import(pathToFileURL(path.join(LIB, 'installedLedger.js')).href);
		const { readMcpJson } = await import(pathToFileURL(path.join(LIB, 'mcpInstall.js')).href);
		const { default: os } = await import('node:os');
		const fsp = await import('node:fs/promises');
		const roots = [];
		const mkRoot = async () => { const r = await fsp.mkdtemp(path.join(os.tmpdir(), 'vssaros-mp-p2-')); roots.push(r); return r; };
		const throws = async (fn) => { try { await fn(); return ''; } catch (e) { return String(e?.message ?? e); } };
		try {
			const src = await mkRoot();
			await fsp.mkdir(path.join(src, 'skills', 'demo-a'), { recursive: true });
			await fsp.writeFile(path.join(src, 'skills', 'demo-a', 'SKILL.md'), '---\nname: demo-a\n---\n\n正文\n');
			await fsp.mkdir(path.join(src, 'mcp', 'demo-b'), { recursive: true });
			await fsp.writeFile(path.join(src, 'mcp', 'demo-b', 'config.json'),
				JSON.stringify({ transport: 'stdio', command: 'node', args: ['s.js'] }));
			const exp = await P.exportPortable({
				dataRoot: src,
				entries: [{ kind: 'skill', storeId: 'demo-a', version: '1.2.3' }, { kind: 'mcp', storeId: 'demo-b', version: '2.0.0' }],
			});
			const gz = Buffer.from(exp.base64, 'base64');
			if (exp.manifest.items.length === 2 && gz.length === exp.bytes && gz.length <= P.MAX_PACK_BYTES) {
				ok('portable.js：导出 2 个资源，base64 往返一致且在上限内');
			} else { fail('portable.js：导出清单 / base64 / 体积校验不对'); }

			const dst = await mkRoot();
			const pv = await P.previewPortable({ dataRoot: dst, gzBuffer: gz });
			if (pv.items.length === 2 && pv.conflicts.length === 0) {
				ok('portable.js：预览列出 2 个资源且无冲突（只读不写盘）');
			} else { fail('portable.js：预览结果不对'); }
			const imported = await P.importPortable({ dataRoot: dst, gzBuffer: gz });
			const ledger = await readInstalled(dst);
			const mcpJson = await readMcpJson(dst).catch(() => null);
			if (imported.imported.length === 2
				&& fs.existsSync(path.join(dst, 'skills', 'demo-a', 'SKILL.md'))
				&& fs.existsSync(path.join(dst, 'skills', 'demo-a', '.market.json'))
				&& fs.existsSync(path.join(dst, 'mcp', 'demo-b', 'config.json'))
				&& ledger.length === 2 && !!mcpJson?.servers?.['demo-b']) {
				ok('portable.js：导入落到两个数据根 + 侧车 + 台账 + mcp.json 注册');
			} else { fail('portable.js：导入落盘/注册不全'); }
			const dup = await throws(() => P.importPortable({ dataRoot: dst, gzBuffer: gz }));
			if (/不覆盖/.test(dup)) {
				ok('portable.js：重复导入同 id 一律拒绝（不覆盖本机资源）');
			} else { fail(`portable.js：重复导入没被挡住（${dup}）`); }

			const dst2 = await mkRoot();
			const renamed = await P.importPortable({ dataRoot: dst2, gzBuffer: gz, renames: { 'skill:demo-a': 'renamed-a' } });
			if (renamed.ok && fs.existsSync(path.join(dst2, 'skills', 'renamed-a', 'SKILL.md'))
				&& !fs.existsSync(path.join(dst2, 'skills', 'demo-a'))) {
				ok('portable.js：冲突改名映射生效（renames 迁移表）');
			} else { fail('portable.js：renames 没生效'); }

			const bad = packTarGz([{ path: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 'not-vssaros', version: 1, items: [] })) }]);
			const badMsg = await throws(() => P.readPortable(bad));
			const bigMsg = await throws(() => P.readPortable(Buffer.alloc(P.MAX_PACK_BYTES + 1)));
			if (/不是 VsSaros/.test(badMsg) && /超过体积上限/.test(bigMsg)) {
				ok('portable.js：非本家 format / 超体积包一律拒绝');
			} else { fail('portable.js：坏包校验有漏网之鱼'); }

			// 半包：第二个资源缺实体 ⇒ 第一个已 rename 的必须被回滚（不留半个目录）
			const half = packTarGz([
				{ path: 'manifest.json', data: Buffer.from(JSON.stringify({
					format: P.PORTABLE_FORMAT, version: P.PORTABLE_VERSION,
					items: [{ kind: 'skill', id: 'ok-one', version: '1' }, { kind: 'mcp', id: 'bad-two', version: '1' }],
				})) },
				{ path: 'items/skill/ok-one/SKILL.md', data: Buffer.from('---\nname: ok-one\n---\n\nx\n') },
			]);
			const dst3 = await mkRoot();
			const halfMsg = await throws(() => P.importPortable({ dataRoot: dst3, gzBuffer: half }));
			if (halfMsg && !fs.existsSync(path.join(dst3, 'skills', 'ok-one'))
				&& !fs.existsSync(path.join(dst3, 'mcp', 'bad-two'))) {
				ok('portable.js：导入中途失败原子回滚（不留半个目录）');
			} else { fail(`portable.js：半包留下了残局（${halfMsg}）`); }
		} finally {
			for (const r of roots) { await fsp.rm(r, { recursive: true, force: true }).catch(() => undefined); }
		}
	}
}

// ── 13. P3 语义对齐：技能 watcher / knowledge 注册表 ────────────────
//
// 为什么守：技能目录改动原本只能等下一次 list() 的指纹比对；knowledge 注册表
//   是 read-modify-write 整文件覆写、路径靠「向上 5 层猜」、失败被 catch{} 吞掉。
//   三条都是「不报错的静默不一致」⇒ 钉住接线 + 真跑并发/原子/失败回执。
{
	const skillsIdx = fs.readFileSync(path.join(root, 'vssaros-skills', 'lib', 'index.js'), 'utf8');
	const inst = fs.readFileSync(path.join(pluginDir, 'lib', 'installers.js'), 'utf8');
	const idx = fs.readFileSync(indexFile, 'utf8');
	const ui = fs.readFileSync(clientFile, 'utf8');
	const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
	const registryFile = path.join(pluginDir, 'lib', 'knowledgeRegistry.js');

	if (/existsSync, watch \} from 'node:fs'/.test(skillsIdx)
		&& /function ensureSkillWatcher\(\)/.test(skillsIdx)
		&& /watch\(root, \{ persistent: false \}/.test(skillsIdx)) {
		ok('vssaros-skills：惰性 fs.watch 已接入（persistent:false，不阻止进程退出）');
	} else { fail('vssaros-skills：技能目录 watcher 没接上'); }
	if (/ensureSkillWatcher\(\);\s*\n\s*const scan = await scanSkills\(/.test(skillsIdx)) {
		ok('vssaros-skills：watcher 在首次 list 惰性启动（apply 期不同步求值 dataRoot）');
	} else { fail('vssaros-skills：watcher 启动点不对，或破坏了每次 list 重扫'); }
	if (/const scan = await scanSkills\(skillsRootOf\(config\), options\?\.signal\)/.test(skillsIdx)) {
		ok('vssaros-skills：每次 list 无条件重扫仍在（watcher 只是额外主动失效）');
	} else { fail('vssaros-skills：每次 list 重扫被改掉了'); }
	if (/ctx\.effect\(\(\) => \(\) => \{/.test(skillsIdx) && /state\.skillWatcher\.close\(\)/.test(skillsIdx)) {
		ok('vssaros-skills：watcher 归 Cordis effect disposer（停用/热重载不残留句柄）');
	} else { fail('vssaros-skills：watcher 没有 disposer ⇒ 旧实例会继续回调失效句柄'); }
	if (/state\.providerControl\?\.invalidate\(\)/.test(skillsIdx) && /不改 lastFingerprint|不会进指纹分支/.test(skillsIdx)) {
		ok('vssaros-skills：复用写路径 invalidate 且不改指纹（无自激循环）');
	} else { fail('vssaros-skills：watcher 的自激循环防护缺失'); }

	if (fs.existsSync(registryFile) && (pkg.files || []).includes('lib/knowledgeRegistry.js')) {
		ok('package.json：lib/knowledgeRegistry.js 已进 files');
	} else { fail('package.json：新 lib 文件必须补进 files 数组'); }
	if (/export const MARKET_VAULTS_FILE = '\.market-vaults\.json';/.test(inst)
		&& /return addVault\(\{ dataRoot, kbRoot, entry \}\)/.test(inst)
		&& /return removeVault\(\{ dataRoot, kbRoot, id \}\)/.test(inst)) {
		ok('lib/installers.js：登记/反登记走注册表服务，且保留跨插件同值常量');
	} else { fail('lib/installers.js：注册表接线不全（或删了守卫钉住的常量）'); }
	if (!/best effort：登记失败不该让安装失败/.test(inst)
		&& /vaultWarning/.test(inst) && /installed\.vaultWarning/.test(idx) && /res\.vaultWarning/.test(ui)) {
		ok('登记失败不再静默：安装结果 → Host 回执 → 前端提示全链路');
	} else { fail('knowledge 登记失败仍被吞掉，或回执链断在某一段'); }

	if (fs.existsSync(registryFile)) {
		const KR = await import(pathToFileURL(registryFile).href);
		const LIB = path.join(pluginDir, 'lib');
		const { packTarGz } = await import(pathToFileURL(path.join(LIB, 'tar.js')).href);
		const { installBundle } = await import(pathToFileURL(path.join(LIB, 'installers.js')).href);
		const { default: os } = await import('node:os');
		const fsp = await import('node:fs/promises');
		const roots = [];
		const mkRoot = async () => { const r = await fsp.mkdtemp(path.join(os.tmpdir(), 'vssaros-mp-p3-')); roots.push(r); return r; };
		try {
			const a = await mkRoot();
			const custom = path.join(a, 'custom-kb');
			await fsp.mkdir(custom, { recursive: true });
			if (await KR.resolveKbRoot(a, custom) === custom) {
				ok('knowledgeRegistry：显式 kbRoot 优先（修「用户配了自定义根就永远读不到」）');
			} else { fail('knowledgeRegistry：显式 kbRoot 没生效'); }
			const direct = path.join(a, 'knowledge-base');
			await fsp.mkdir(direct, { recursive: true });
			if (await KR.resolveKbRoot(a) === direct) {
				ok('knowledgeRegistry：默认布局与 KB 的 kbRootOf 同口径（dataRoot/knowledge-base）');
			} else { fail('knowledgeRegistry：默认布局解析不对'); }
			const legacy = await mkRoot();
			const prof = path.join(legacy, 'dsh-home', 'profiles', 'vssaros');
			await fsp.mkdir(prof, { recursive: true });
			await fsp.mkdir(path.join(legacy, 'knowledge-base'), { recursive: true });
			if (await KR.resolveKbRoot(prof) === path.join(legacy, 'knowledge-base')) {
				ok('knowledgeRegistry：旧布局向上猜仍兼容（跨插件守卫的默认布局不回归）');
			} else { fail('knowledgeRegistry：旧布局兼容断了'); }

			const b = await mkRoot();
			await fsp.mkdir(path.join(b, 'knowledge-base'), { recursive: true });
			await Promise.all([
				KR.addVault({ dataRoot: b, entry: { id: 'v-a', name: 'A', path: '/a' } }),
				KR.addVault({ dataRoot: b, entry: { id: 'v-b', name: 'B', path: '/b' } }),
			]);
			const listed = await KR.listVaults({ dataRoot: b });
			if (listed.ok && listed.items.length === 2) {
				ok('knowledgeRegistry：并发登记两条都在（串行队列不丢更新）');
			} else { fail(`knowledgeRegistry：并发写丢了条目（${listed.items?.length}）`); }
			await KR.removeVault({ dataRoot: b, id: 'v-a' });
			const after = await KR.listVaults({ dataRoot: b });
			if (after.items.length === 1 && after.items[0].id === 'v-b') {
				ok('knowledgeRegistry：反登记按 id 精确删，不动别人的条目');
			} else { fail('knowledgeRegistry：removeVault 删错了'); }
			const tmpLeft = (await fsp.readdir(path.join(b, 'knowledge-base'))).filter(n => n.includes('.tmp-'));
			if (tmpLeft.length === 0) {
				ok('knowledgeRegistry：原子写后无 .tmp-* 残留');
			} else { fail('knowledgeRegistry：原子写留下了临时文件'); }

			// 失败不再静默：KB 根不存在时安装仍成功，但必须给出可诊断的 vaultWarning
			const noKb = await mkRoot();
			const gz = packTarGz([
				{ path: 'manifest.json', data: Buffer.from(JSON.stringify({ kind: 'knowledge', id: 'kb-x', version: '1', name: 'X' })) },
				{ path: '笔记/a.md', data: Buffer.from('# a\n\n正文\n') },
			]);
			const installedRes = await installBundle({ dataRoot: noKb, kind: 'knowledge', storeId: 'kb-x', version: '1.0.0', gzBuffer: gz });
			if (installedRes.vaultWarning && /没登记进 KB 清单/.test(installedRes.vaultWarning)) {
				ok('端到端：KB 根缺失时安装成功但如实回执 vaultWarning（不再静默假绿）');
			} else { fail('端到端：登记失败又被吞了'); }
		} finally {
			for (const r of roots) { await fsp.rm(r, { recursive: true, force: true }).catch(() => undefined); }
		}
	}
}

// ── 14. 「已安装」折叠组（★ 2026-11-10，复刻「工具」工作台 .sk-fold）────
//
// 为什么守：MCP 等分类页签里已装/可装商品原本混在同一张网格里。用户要求像
//   「工具」工作台那样把已装项单独折叠。最容易退化的是「只画了折叠头却忘了
//   把已装项从网格里剔掉」⇒ 同一个商品出现两次。⇒ 两头都钉住。
{
	const ui = fs.readFileSync(clientFile, 'utf8');
	const host = fs.readFileSync(indexFile, 'utf8');
	const css = fs.readFileSync(path.join(pluginDir, 'lib', 'page.css'), 'utf8');
	const toolsPage = fs.readFileSync(path.join(root, 'vssaros-skills', 'lib', 'index.js'), 'utf8');

	if (/function foldHtml\(key, count, innerHtml, emptyHtml\)/.test(toolsPage)
		&& /class="sk-fold"/.test(toolsPage) && /sk-fold-n/.test(toolsPage)
		&& /vssaros\.tools\.fold\./.test(toolsPage)) {
		ok('蓝本仍在：工具工作台的 details 折叠组 / 计数徽章 / localStorage 记忆');
	} else { fail('工具工作台蓝本变了，「同款」不再有依据，请重新核对'); }

	if (/function InstalledFold\(props\)/.test(ui)
		&& /className: 'vs-mp-fold'/.test(ui)
		&& /className: 'vs-mp-fold-n'/.test(ui)
		&& /onToggle: function \(e\)/.test(ui)) {
		ok('lib/client.js：已安装折叠组用原生 details + 计数徽章 + toggle 回调');
	} else { fail('lib/client.js：折叠组渲染缺失（不是原生 details 形态）'); }
	if (/FOLD_KEY_PREFIX = 'vs-mp-fold\.'/.test(ui)
		&& /function loadFold\(key\)/.test(ui) && /function saveFold\(key, open\)/.test(ui)
		&& /key: 'fold-' \+ foldKey/.test(ui)) {
		ok('lib/client.js：开合状态按分类 key 存 localStorage（切页签各自独立）');
	} else { fail('lib/client.js：折叠状态没按分类隔离或不持久'); }
	if (/tab === 'market'[\s\S]{0,320}action\('installed', \{\}\)/.test(ui)) {
		ok('lib/client.js：商城页签额外取 installed（磁盘核对过的真实已装清单）');
	} else { fail('lib/client.js：折叠组没有独立数据源 ⇒ 会显示幽灵/漏项'); }
	if (/installedItems\.filter\(function \(it\) \{ return !kind \|\| it\.kind === kind; \}\)/.test(ui)) {
		ok('lib/client.js：折叠组按当前分类过滤（MCP 页签只显示已装 MCP）');
	} else { fail('lib/client.js：折叠组没按 kind 过滤'); }
	if (/items\.filter\(function \(it\) \{ return !it\.installedVersion; \}\)/.test(ui)
		&& /'vs-mp-grid'[\s\S]{0,200}shownItems\.map/.test(ui)) {
		ok('lib/client.js：可安装网格剔除已装项（同一商品不会在两处重复出现）');
	} else { fail('lib/client.js：网格没剔已装项 ⇒ 折叠组会变成重复列表'); }
	if (/function InstalledRow\(props\)/.test(ui) && /className: 'sk-row'/.test(ui)
		&& /tab === 'market' \? h\(InstalledFold/.test(ui)) {
		ok('lib/client.js：折叠组用复刻「工具」工作台的 InstalledRow（不再是商品 Card）');
	} else { fail('lib/client.js：折叠组没换成行样式（仍然是商品卡片网格）'); }

	const tabsMatch = ui.match(/var KIND_TABS\s*=\s*\[([\s\S]*?)\];/);
	const tabIds = tabsMatch ? Array.from(tabsMatch[1].matchAll(/id:\s*'([^']*)'/g), x => x[1]) : [];
	if (tabIds.includes('plugin') && tabIds.indexOf('skill') < tabIds.indexOf('mcp')
		&& tabIds.indexOf('mcp') < tabIds.indexOf('workbench')) {
		ok('lib/client.js：六类都有分类入口（含插件），且 Skill < MCP < 工作台顺序不变');
	} else { fail('lib/client.js：插件分类缺失或 MCP 位置被挪动'); }
	if (/const KINDS\s*=\s*\[[^\]]*'plugin'/.test(host)) {
		ok('lib/index.js：Host 的 KINDS 含 plugin（插件页签筛选有后端支持）');
	} else { fail('lib/index.js：KINDS 缺 plugin ⇒ 插件页签点开拿不到商品'); }

	if (/\.vs-mp-fold > summary::before/.test(css)
		&& /\.vs-mp-fold\[open\] > summary::before \{ transform: rotate\(90deg\);? \}/.test(css)
		&& /\.vs-mp-fold \.vs-mp-fold-n/.test(css)) {
		ok('lib/page.css：折叠箭头 / 展开旋转 / 计数徽章三件套齐全');
	} else { fail('lib/page.css：折叠头样式不全（不像工具工作台）'); }
	const foldCss = css.slice(css.indexOf('.vs-mp-fold'), css.indexOf('/* ── 离线便携包'));
	if (foldCss && !/--vscode-/.test(foldCss) && !/#[0-9a-fA-F]{3,8}\b/.test(foldCss)
		&& /var\(--vs-mp-/.test(foldCss)) {
		ok('lib/page.css：折叠样式只用商城主题变量（深浅外观自动跟随）');
	} else { fail('lib/page.css：折叠样式写死了颜色或用了页内不存在的令牌'); }
}

// ── 15. MCP 配置弹层 + 已安装 item 状态自动同步（★ 2026-11-10）────────
//
// 为什么守：用户要求「MCP 有配置页按钮 → 单独弹出一页展示所有配置 → 改完后
//   已安装页签下对应 item 自动更新状态」。最易退化的是只画了弹层却没把
//   mcp.json 的 servers 接成行状态的真源，或只在保存时手动刷一次、外部改动不生效。
{
	const disp = fs.readFileSync(path.join(pluginDir, 'lib', 'dispatch.js'), 'utf8');
	const host = fs.readFileSync(indexFile, 'utf8');
	const ui = fs.readFileSync(clientFile, 'utf8');
	const css = fs.readFileSync(path.join(pluginDir, 'lib', 'page.css'), 'utf8');

	if (/LOCAL_READ_OPS = new Set\([^\n]*'mcpConfig'/.test(disp)) {
		ok('lib/dispatch.js：mcpConfig 是只读 op（读配置不该触发写审批）');
	} else { fail('lib/dispatch.js：mcpConfig 没进 LOCAL_READ_OPS ⇒ 会落到 IDE 兜底'); }

	const at = host.indexOf("if (op === 'mcpConfig')");
	const end = host.indexOf("if (op === 'list')", at);
	const block = at >= 0 && end > at ? host.slice(at, end) : '';
	if (block && /digestOnly/.test(block) && /readMcpJson/.test(block) && !/writeMcpJson|writeFile\(/.test(block)) {
		ok('lib/index.js：mcpConfig 只读、支持 digestOnly 轻量轮询、返回每台服务器状态');
	} else { fail('lib/index.js：mcpConfig 分支缺失、有写副作用，或没有 digestOnly'); }

	if (/function McpConfigModal\(props\)/.test(ui) && /'MCP 配置'/.test(ui)
		&& /data-vs-mp-mcp-text/.test(ui) && /sk-act-cfg/.test(ui)) {
		ok('lib/client.js：页头「MCP 配置」+ 行内「配置」+ 独立弹层展示整份 mcp.json');
	} else { fail('lib/client.js：配置按钮或独立弹层缺失'); }
	if (/run\('saveMcpConfig', \{ text: text \}, ''\)/.test(ui) && /JSON\.parse\(text\)/.test(ui)) {
		ok('lib/client.js：弹层先本地校验 JSON，再走 saveMcpConfig（Host 备份+落盘）');
	} else { fail('lib/client.js：保存链没接上或跳过 JSON 校验'); }
	if (/action\('mcpConfig', \{\}\)/.test(ui) && /setMcpState\(mc\)/.test(ui)
		&& /mcpServers: mcpServerMap/.test(ui)) {
		ok('lib/client.js：mcp.json 的 servers 是折叠组 MCP 行开关/描述的实时真源');
	} else { fail('lib/client.js：折叠组没接 mcp 实时状态 ⇒ 配置改了 item 不会变'); }
	if (/mcpConfig', \{ digestOnly: true \}/.test(ui) && /setInterval\(function \(\)/.test(ui)
		&& /mcpDigestRef\.current/.test(ui) && /void fetchPage\(1, false\)/.test(ui)) {
		ok('lib/client.js：2s digest 轮询检测外部改动 ⇒ item 状态自动更新（非仅保存时手动刷）');
	} else { fail('lib/client.js：缺自动同步的轮询链'); }
	if (/setMcpEnabled', \{ kind: 'mcp', slug: id, enabled/.test(ui) && /data-vs-mp-mcp-sw/.test(ui)) {
		ok('lib/client.js：行内开关写 disabled；弹层 draft 与轮询状态互不覆盖');
	} else { fail('lib/client.js：MCP 行开关没接 setMcpEnabled'); }
	if (/s\.draft/.test(ui) && /onDraft: function \(v\) \{ patchMcpModal/.test(ui)) {
		ok('lib/client.js：弹层自持 draft，轮询只更新 mcpState（不覆盖用户正在编辑的内容）');
	} else { fail('lib/client.js：弹层没隔离 draft ⇒ 轮询会冲掉未保存的编辑'); }

	if (/\.sk-row \{/.test(css) && /\.sk-sw\[aria-checked/.test(css) && /\.vs-mp-mcp-modal/.test(css)) {
		ok('lib/page.css：复刻行样式 + 开关 + 独立配置弹层三套样式齐备');
	} else { fail('lib/page.css：行样式/开关/弹层样式有缺'); }
	const rowCss = css.slice(css.indexOf('.sk-list {'), css.indexOf('/* ── 离线便携包'));
	if (rowCss && !/--vscode-/.test(rowCss) && !/#[0-9a-fA-F]{3,8}\b/.test(rowCss)
		&& /var\(--vs-mp-/.test(rowCss)) {
		ok('lib/page.css：新增样式只用商城主题变量（深浅外观自动跟随）');
	} else { fail('lib/page.css：复刻样式写死了颜色或用了页内不存在的令牌'); }

	// 行为级：真调 mcpInstall 的状态写入，证明「配置改了 → item 状态能变」这条数据链
	const mcpFile = path.join(pluginDir, 'lib', 'mcpInstall.js');
	if (fs.existsSync(mcpFile)) {
		const mcp = await import(pathToFileURL(mcpFile).href);
		const { default: os } = await import('node:os');
		const fsp = await import('node:fs/promises');
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vssaros-mp-mcp-'));
		try {
			await fsp.writeFile(path.join(tmp, 'mcp.json'),
				JSON.stringify({ servers: { demo: { type: 'stdio', command: 'node', disabled: false } } }, null, 2));
			let j = await mcp.readMcpJson(tmp);
			if (j.servers.demo.disabled === false) {
				ok('mcpInstall：初始状态可读（item 显示启用）');
			} else { fail('mcpInstall：读不到初始 disabled'); }
			await mcp.setMcpEnabled(tmp, 'demo', false);
			j = await mcp.readMcpJson(tmp);
			if (j.servers.demo.disabled === true) {
				ok('mcpInstall：开关写 disabled ⇒ item 会变停用态');
			} else { fail('mcpInstall：setMcpEnabled 没写进 mcp.json'); }
			await mcp.writeMcpJson(tmp, {
				servers: { demo: { type: 'http', url: 'https://example.test', disabled: true } }, inputs: [],
			});
			j = await mcp.readMcpJson(tmp);
			if (j.servers.demo.disabled === true && j.servers.demo.url === 'https://example.test'
				&& Array.isArray(j.inputs)) {
				ok('mcpInstall：整份配置被改写后状态可重新读出（弹层保存 → item 刷新有数据）');
			} else { fail('mcpInstall：整份改写后读不出新状态或丢了其它顶层键'); }
		} finally {
			await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

// ── 16. 发布表单的图标 / 缩略图设置（★ 2026-11-10）──────────────────
//
// 为什么守：`market_publish` 工具参数、`ensurePackage` 透传、服务端 schema
//   三层都支持 icon / cover，但工作台表单和 Host 的 meta 都没接 ⇒ 作者无法自定义、
//   页面填了也写不进商品。最容易复发的是「只加表单、忘了 Host 三条 meta」。
{
	const ui = fs.readFileSync(clientFile, 'utf8');
	const host = fs.readFileSync(indexFile, 'utf8');
	const pub = fs.readFileSync(path.join(pluginDir, 'lib', 'publisher.js'), 'utf8');
	const agent = fs.readFileSync(path.join(pluginDir, 'lib', 'marketAgent.js'), 'utf8');

	if (/小图标 URL/.test(ui) && /缩略图 URL/.test(ui)
		&& /value: st\.icon \|\| ''/.test(ui) && /value: st\.cover \|\| ''/.test(ui)) {
		ok('lib/client.js：发布表单有 icon / cover 两个可编辑字段（两种来源模式通用）');
	} else { fail('lib/client.js：发布表单缺图标 / 缩略图设置入口'); }
	if (/icon: '', cover: '',/.test(ui) && (ui.match(/icon: '', cover: '',/g) || []).length === 2) {
		ok('lib/client.js：打开发布表单两次初始化都带 icon / cover（不残留上次的值）');
	} else { fail('lib/client.js：openPublish 没把图标字段初始化干净'); }
	if (/params\.icon = icon/.test(ui) && /params\.cover = cover/.test(ui)
		&& /\^\(https\?:\\\/\\\/\|data:image\\\/\)\/i/.test(ui)) {
		ok('lib/client.js：提交前按 isImageIcon 口径校验，再把非空值透传给 publish');
	} else { fail('lib/client.js：图标字段没提交或校验缺失'); }
	if (/r\.logo \|\| ''/.test(ui) && /图标已回填 owner 头像/.test(ui)) {
		ok('lib/client.js：✨ 自动填写会用 inspectGithub 的 logo 回填图标（不覆盖手填）');
	} else { fail('lib/client.js：自动填写没回填图标'); }

	if (/const mediaMeta = \{/.test(host) && (host.match(/\.\.\.mediaMeta/g) || []).length === 3
		&& !/meta: \{\}/.test(host)) {
		ok('lib/index.js：npm / external / bundle 三条发布路径的 meta 都带 mediaMeta');
	} else { fail('lib/index.js：Host 有发布路径没透传 icon / cover ⇒ 页面填了也无效'); }
	if (/icon: meta\.icon\.trim\(\)/.test(pub) && /cover: meta\.cover\.trim\(\)/.test(pub)) {
		ok('lib/publisher.js：ensurePackage 仍把 icon / cover 透传给服务端建包');
	} else { fail('lib/publisher.js：建包请求丢了图片字段'); }
	if (/`icon`（小图标）/.test(agent) && /`cover`（16:9 大图）/.test(agent)) {
		ok('lib/marketAgent.js：人设告诉 bot 可以自定义图片、发布前要讲给用户');
	} else { fail('lib/marketAgent.js：人设没提 icon / cover'); }

	// 行为级：真调发布链，确认图片字段最终进了 POST /packages 的 body；
	//   并确认空 meta 时**不带**这两个键（避免覆盖服务端已有的图）
	const PUB = await import(pathToFileURL(path.join(pluginDir, 'lib', 'publisher.js')).href);
	const calls = [];
	const fake = {
		request: async (method, url, body) => { calls.push({ method, url, body }); return { ok: true }; },
		upload: async () => undefined,
	};
	const base = {
		market: fake, kind: 'skill', localId: 'media-demo', version: '1.0.0',
		distribution: { type: 'npm', name: '@x/media-demo' },
	};
	try {
		await PUB.publishDistribution({ ...base, meta: {
			icon: 'https://example.test/icon.png', cover: 'https://example.test/cover.png',
		} });
		const withMedia = calls.find(c => c.method === 'POST' && c.url === '/packages');
		if (withMedia && withMedia.body.icon === 'https://example.test/icon.png'
			&& withMedia.body.cover === 'https://example.test/cover.png') {
			ok('行为级：icon / cover 真的写进 POST /packages 的建包请求');
		} else { fail(`行为级：建包请求没带上图片字段（${JSON.stringify(withMedia?.body)}）`); }
		calls.length = 0;
		await PUB.publishDistribution({ ...base, meta: {} });
		const empty = calls.find(c => c.method === 'POST' && c.url === '/packages');
		if (empty && !('icon' in empty.body) && !('cover' in empty.body)) {
			ok('行为级：留空时不带 icon / cover（不覆盖服务端已有图）');
		} else { fail('行为级：空值也写进了建包请求，会清掉已有图片'); }
	} catch (e) {
		fail(`行为级：publishDistribution 抛错（${String(e?.message ?? e)}）`);
	}
}

// ── 17. 本地新建资源的「已安装 → 详情 → 发布」闭环（★ 2026-11-10）────
//
// 为什么守：以前「已安装」页唯一数据源是台账，本地新建资源根本不出现；
//   `detail` 只查服务端 ⇒ 就算有 item，点详情也 404、抽屉打不开。
//   两条链任一断掉，用户都拿不到发布入口。另有两个静默断点：
//   sourceDir / acknowledgePrivacy 在 UI→Host→库层之间被吞。
{
	const ui = fs.readFileSync(clientFile, 'utf8');
	const host = fs.readFileSync(indexFile, 'utf8');
	const shape = fs.readFileSync(path.join(pluginDir, 'lib', 'shape.js'), 'utf8');
	const pubSrc = fs.readFileSync(path.join(pluginDir, 'lib', 'publisher.js'), 'utf8');

	if (/async function localDetailOf\(/.test(host) && /const local = await localDetailOf\(state\.dataRoot, slug, kindHint\)/.test(host)
		&& /if \(!local\) \{ throw e; \}/.test(host)) {
		ok('lib/index.js：detail 在服务端查不到时回退到本机详情（本地资源不再 404）');
	} else { fail('lib/index.js：detail 缺本地回退 ⇒ 本地新建资源点详情打不开'); }
	// ★ 2026-11-10：installed 补了 `params.kind` 分类过滤 ⇒ total 不再是写死的
	//   `alive.length + locals.length`，改成过滤后的 `items.length`。判据跟着实现更新，
	//   但**仍钉住**「磁盘扫描差集 + locals 并入 + 两路都进 allItems」这三条，不放宽 ✓。
	if (/const scanned = await listPublishables\(state\.dataRoot\)/.test(host)
		&& /isLocal: true, localId: it\.localId/.test(host)
		&& /const allItems = \[[\s\S]{0,240}\.\.\.locals\.map/.test(host)
		&& /total: items\.length/.test(host)) {
		ok('lib/index.js：installed 用磁盘扫描与台账做差集，本地新建条目并入已安装页（并按分类过滤）');
	} else { fail('lib/index.js：installed 仍是纯台账 ⇒ 本地新建资源不出现在已安装页'); }
	if (/isLocal: entry\.isLocal === true/.test(shape) && /localId: entry\.localId/.test(shape)) {
		ok('lib/shape.js：toInstalledItem 透传 isLocal / localId / sourceDir');
	} else { fail('lib/shape.js：前端拿不到本地标记，无法判断该不该给发布按钮'); }

	if (/d\.isLocal\) \{[\s\S]{0,320}props\.onPublish/.test(ui)
		&& /发布到商城/.test(ui)) {
		ok('lib/client.js：详情抽屉只对本地资源显示「发布到商城」按钮');
	} else { fail('lib/client.js：本地详情没有发布按钮'); }
	if (/async function openPublish\(preset\)/.test(ui) && /var hit = \(pre\.kind && pre\.localId\)/.test(ui)
		&& /pick: hit \?/.test(ui) && /version: hit \?/.test(ui)) {
		ok('lib/client.js：openPublish 支持 preset，预填 pick 与版本（不出现空选却已提交）');
	} else { fail('lib/client.js：从详情直达发布没预填资源/版本'); }
	if (/onPublishLocal: props\.onPublishLocal/.test(ui) && /onPublishLocal: function \(it\)/.test(ui)) {
		ok('lib/client.js：折叠组行的发布按钮已接到 openPublish（不是死按钮）');
	} else { fail('lib/client.js：折叠组本地发布回调没接上'); }
	if (/async function submitPublish\(force\)/.test(ui) && /force === true/.test(ui)
		&& /onForcePublish/.test(ui) && /确认公开并发布/.test(ui)) {
		ok('lib/client.js：隐私体检被拦后有「确认公开并发布」出口，放行标志真传给 Host');
	} else { fail('lib/client.js：隐私拦截仍无出口（用户被卡死）'); }
	if (/showUninstall: tab === 'installed' && !pkg\.isLocal/.test(ui) && /if \(!it\.isLocal\) \{/.test(ui)) {
		ok('lib/client.js：本地条目不显示必然失败的「卸载」按钮');
	} else { fail('lib/client.js：本地条目仍会给出卸载按钮 ⇒ 点了报错'); }

	if (/acknowledgePrivacy: params\.acknowledgePrivacy === true/.test(host)
		&& /acknowledgePrivacy, meta/.test(pubSrc)
		&& /sourceDir, acknowledgePrivacy/.test(pubSrc)) {
		ok('Host / 库层：sourceDir 与 acknowledgePrivacy 一路透到 preparePublishBundle');
	} else { fail('发布参数仍在 UI→Host→库层之间被吞（知识库自选库与隐私确认不可用）'); }

	// 行为级 ①：toInstalledItem 真的把本地标记带给前端
	const SHAPE = await import(pathToFileURL(path.join(pluginDir, 'lib', 'shape.js')).href);
	const localItem = SHAPE.toInstalledItem({ kind: 'skill', storeId: 'my-local', version: '0.1.0',
		isLocal: true, localId: 'my-local', sourceDir: '/tmp/my-local' }, '');
	if (localItem.isLocal === true && localItem.localId === 'my-local' && localItem.sourceDir === '/tmp/my-local') {
		ok('行为级：本地条目的 isLocal / localId / sourceDir 到达前端');
	} else { fail('行为级：toInstalledItem 丢了本地标记'); }

	// 行为级 ②：sourceDir + acknowledgePrivacy 真的影响打包（目录不在 dataRoot/skills 下也能发）
	const PUB = await import(pathToFileURL(path.join(pluginDir, 'lib', 'publisher.js')).href);
	const { default: os } = await import('node:os');
	const fsp = await import('node:fs/promises');
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vssaros-mp-local-'));
	try {
		const custom = path.join(tmp, 'custom-skill');
		await fsp.mkdir(custom, { recursive: true });
		await fsp.writeFile(path.join(custom, 'SKILL.md'), '---\nname: custom-skill\ndescription: 本机新建\n---\n\n正文\n');
		const calls = [];
		const fake = {
			request: async (method, url, body) => { calls.push({ method, url, body }); return { ok: true }; },
			upload: async () => undefined,
		};
		let err = '';
		try {
			await PUB.publishVersion({
				market: fake, dataRoot: path.join(tmp, 'data-root'), kind: 'skill',
				localId: 'custom-skill', version: '1.0.0', sourceDir: custom,
				acknowledgePrivacy: true, meta: { name: '自定义技能', description: '介绍' },
			});
		} catch (e) { err = String(e?.message ?? e); }
		const create = calls.find(c => c.method === 'POST' && c.url === '/packages');
		if (!err && create && create.body.name === '自定义技能') {
			ok('行为级：自选目录 + 隐私确认 + name/description 真能走完发布（参数没被吞）');
		} else { fail(`行为级：本地资源发布失败（${err || '建包请求没带上名称'}）`); }
	} finally {
		await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
	}
}

console.log(problems === 0
	? '\n[check-marketplace-client] ✓ 商城页面脚本守卫通过'
	: `\n[check-marketplace-client] ✗ ${problems} 项问题`);
process.exit(problems === 0 ? 0 : 1);
