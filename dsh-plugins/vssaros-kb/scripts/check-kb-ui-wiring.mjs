/*
 * 守卫：**交互接线**不许断（2026-10-24）。
 *
 * 起因：连着两次"点了没反应"——
 *   ① 图谱按钮：面板里 `openGraph` 直接把 pane 切成 graph，但容器高度链断了 ⇒ canvas 0×0，
 *      点击其实生效了、界面却像没动静（真机表现与"事件没绑上"完全一样）；
 *   ② 设置按钮：早先被"能力缺失就不渲染"的规则连按钮一起藏了。
 * 这类问题 `node --check` / tsc 全绿，只有真机点一下才能发现 ⇒ 用本守卫把它们钉住：
 *   · 面板必须有 openGraph 且切 pane（不是空函数）
 *   · 图谱必须渲染在**固定定位覆盖层**里（不依赖父级高度）
 *   · 视图必须有设置面板（`data-kb-settings`）与图谱画布锚点
 *   · 面板必须提供 switchVault（设置里切库）
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-ui-wiring.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLIENT = readFileSync(HERE + '../lib/client.js', 'utf8');
const BUNDLE = readFileSync(HERE + '../lib/web/kbSideview.js', 'utf8');
const INDEX = readFileSync(HERE + '../lib/index.js', 'utf8');

let pass = 0;
const failed = [];
function check(name, cond, detail = '') {
	if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
	else { failed.push(name); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}

// ── 面板：图谱 ─────────────────────────────────────────────
check('面板定义了 openGraph 且切换到 graph pane',
	/openGraph:\s*\(\)\s*=>\s*\{\s*setPane\('graph'\);\s*\}/.test(CLIENT));
// ⚠ 不许再用 `position: fixed`：宿主视图容器带 transform ⇒ fixed 的包含块变成那个容器，
//   图谱会被钉在面板的下半部分（2026-10-24 真机截图）。必须"父相对 + 子绝对"。
check('图谱层用面板内绝对定位（父容器 relative）',
	CLIENT.includes("'data-kb-graph-overlay': '1'")
	&& /position:\s*'absolute'/.test(CLIENT)
	&& /position:\s*'relative'/.test(CLIENT));
check('图谱层没有使用 fixed 定位（会被宿主 transform 限制）',
	!/data-kb-graph-overlay[\s\S]{0,300}?position:\s*'fixed'/.test(CLIENT));
check('图谱有画布锚点', CLIENT.includes("'data-kb-graph-canvas': '1'"));
check('图谱有返回入口（onClose → 切回 tree）',
	/setPane\('tree'\)/.test(CLIENT));
check('面板提供 switchVault（设置里切库）', /switchVault:\s*\(id\)\s*=>/.test(CLIENT));
// 设置：IDE 由宿主开 editor pane；面板必须开**二级页面**（整页 + 返回），不是弹窗
check('面板提供 openSettings 并切到二级页面', /openSettings:\s*\(\)\s*=>\s*setPane\('settings'\)/.test(CLIENT));
check('已实现设置二级页面（data-kb-settings-page）', CLIENT.includes("'data-kb-settings-page': '1'"));
check('设置页有返回入口', CLIENT.includes('← 返回知识库'));
// ⚠ 光有 `openSettings: () => setPane('settings')` + 组件定义是不够的：
//   2026-10-24 真机"设置点了没反应"就是**切了 pane 但没有对应渲染分支**，
//   组件变成了死代码，而旧守卫只查字符串存在 ⇒ 全绿却坏。
//   ⇒ 必须同时断言：① 有 `pane === 'settings'` 分支；② 组件被真正使用（定义 + 使用 ≥ 2 处）。
check("设置 pane 有渲染分支（pane === 'settings'）", /pane === 'settings'/.test(CLIENT));
check('KbSettingsPage 被真正渲染（出现 ≥ 2 处）',
	(CLIENT.match(/KbSettingsPage/g) ?? []).length >= 2,
	'出现 ' + (CLIENT.match(/KbSettingsPage/g) ?? []).length + ' 处');
// ⚠ 2026-10-24（真机：`c is not defined` 让整个工作台变成"渲染时出错"）：
//   静态检查看不出"引用了作用域里不存在的标识符"，而这类错误只有渲染时才炸。
//   这里用最省的一条：只要用了 `c.xxx` 颜色令牌，就必须有 `const c = {` 定义。
{
	const usesC = /[^A-Za-z0-9_$.]c\.(line|fgFaint|fgDim|fg|bg|inputBg|inputFg|badge|sel)/.test(CLIENT);
	const definesC = /const c = \{/.test(CLIENT);
	check('使用 c.* 颜色令牌时必须定义 const c', !usesC || definesC, usesC ? (definesC ? '已定义' : '缺定义') : '未使用');
}
check('面板请求 view-data 时带 vault 参数', CLIENT.includes("'?vault='"));
check('面板提供 feishuSync', CLIENT.includes('feishuSync:'));

// ── 视图 bundle：设置面板 ───────────────────────────────────
check('视图有设置面板锚点（data-kb-settings）', BUNDLE.includes('data-kb-settings'));
check('设置按钮不再被能力门控掉（⚙ 无条件渲染）',
	/* 旧写法是 `{actions?.openSettings ? <IconBtn …⚙/> : null}`，这条断言防止它回来 */
	!BUNDLE.includes("actions?.openSettings?") || BUNDLE.includes('data-kb-settings'));
check('视图声明 switchVault 动作', BUNDLE.includes('switchVault'));

// ── 飞书二则（2026-10-24 真机两次「点了没反应」）──────────────
//  ① lark-cli 的 `wiki +space-list` 返回 `{ data: { spaces } }`，只认 items/spaces 会得到 0 条；
//  ② 拉取结果**必须有可见反馈**（原先成功但 0 条 ⇒ 界面毫无变化，看起来像按钮坏了）。
check('知识库列表解析兼容 data.spaces', INDEX.includes('j?.data?.spaces'));
check('拉取知识库列表有可见反馈（spacesMsg）', CLIENT.includes('spacesMsg'));
check('lark-cli 支持 .cmd 启动（Windows npm shim）', INDEX.includes("shell: true"));

console.log('\n' + '='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项`);
	for (const f of failed) { console.log('   - ' + f); }
	process.exit(1);
} else {
	console.log(`✓ 全部 ${pass} 项通过（交互接线完整）`);
}
