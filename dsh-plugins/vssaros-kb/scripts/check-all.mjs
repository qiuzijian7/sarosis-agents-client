/*
 * 一把跑完本插件的**全部**静态守卫。
 *
 * ★ 为什么要有它（2026-10-19 第 6 次反引号事故）：那次我只手动跑了 `check-plugin-scope` 和
 *   `check-page-script`，**漏了 `check-page-templates`** —— 而恰恰是它才管"页内脚本注释里不许有反引号"
 *   ⇒ 模板串被提前闭合、`node --check` 报错，全靠人肉发现 ✗。
 *   守卫齐不齐不该靠记性 ⇒ 统一入口，一条命令。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-all.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const STEPS = [
	{ file: 'check-page-templates.mjs', desc: '模板串：HTML 注释/内容不许有反引号 + 真求值' },
	{ file: 'check-page-script.mjs', desc: '页内脚本：no-undef' },
	{ file: 'check-page-surfaces.mjs', desc: '一页三形态：脚本可解析 + 三态接线不变（2026-10-21）' },
	{ file: 'check-page-render-surfaces.mjs', desc: '一页三形态：真渲染三种表面（2026-10-21）' },
	{ file: 'check-plugin-scope.mjs', desc: '服务端模块：no-undef（抓跨作用域误用，如 vaultDisplayName）' },
	{ file: 'check-codicon-subset.mjs', desc: 'codicon 子集与页面引用对账' },
	{ file: 'smoke-graph-page.mjs', args: ['--no-serve'], desc: '图谱页端到端（真实 renderGraphPage + 数据）' },
	// ★ 2026-10-24：写接口的**拒绝路径**（库区只读 / 库外 / `../` 穿越 / 超限 / mtime 冲突）。
	//   这一层是唯一能证明"改用户文件的接口不会写错地方"的东西 —— 功能测试只证明能写，证明不了不该写的地方写不进去。
	{ file: 'check-kb-write-guards.mjs', desc: '写入护栏：保存/上传/备份恢复的拒绝路径（27 项）' },
	// ★ 2026-10-24：图谱力学参数不许分叉（独立页 import 共享模块；面板常量逐项对账）
	{ file: 'check-kb-graph-physics.mjs', desc: '图谱力学：共享模块与两处使用点一致（15 项）' },
	// ★ 2026-10-24：交互接线（"点了没反应"类问题）—— 图谱面板入口、覆盖层、设置面板锚点
	{ file: 'check-kb-ui-wiring.mjs', desc: '交互接线：图谱入口/设置面板/切库动作（17 项）' },
	// ★ 2026-10-24：面板单块里**不许有未定义标识符**
	//   （真机 `c is not defined` 让整个工作台变成"渲染时出错"；node --check 抓不到）
	{ file: 'check-kb-client-no-undef.mjs', desc: '面板 client.js：no-undef 静态检查' },
	// ★ 2026-10-25：**Markdown 渲染回归** —— 用真实渲染器 + react-dom/server 断言 27 类语法
	//   （frontmatter / Callout / 双链 / 表格 / 嵌套列表 / mermaid / 数学 / 删除线 …）
	// ★ 2026-10-25：**服务端渲染**（markdown-it + Obsidian 方言，vendor 随包）
	{ file: 'check-kb-md-node.mjs', desc: '服务端 Markdown 渲染（28 项）' },
	// ★ 2026-10-25：**真实库全文扫描** —— 每篇渲染后检查有无残留原始标记（缺库则跳过）
	// ★ 2026-10-26：mermaid → pele（服务端渲染）——**路径探测**按三种安装布局各验一遍
	{ file: 'check-kb-pele.mjs', desc: 'mermaid → pele：路径探测 / 渲染 / 降级（10 项）' },
	{ file: 'check-kb-md-vault.mjs', desc: '真实库渲染覆盖扫描（无残留标记）' },
	// ★ 2026-10-25：`/api/doc` 端到端（渲染结果 + 磁盘缓存命中/失效）
	{ file: 'check-kb-doc-route.mjs', desc: '/api/doc 端到端：渲染 + 缓存 + 失效（8 项）' },
	// ★ 2026-10-24：飞书能力搬到 dsh 侧 —— CLI 检测 / 库列表 / 同步日志 / 同步门禁
	{ file: 'check-kb-feishu-routes.mjs', desc: '飞书路由：CLI / 库列表 / 日志 / 门禁（9 项）' },
	// ★ 2026-10-25：重建索引（临时库；含"向量索引如实标注不支持"的边界断言）
	{ file: 'check-kb-reindex.mjs', desc: '重建索引：内核缓存 + 状态 + 能力边界（6 项）' },
	// ★ 2026-10-25：视图数据缓存（命中 / 目录变化后失效 / refresh 绕过）
	{ file: 'check-kb-view-cache.mjs', desc: 'view-data 缓存（7 项）' },
	// ★ 2026-10-25：**源码完整性** —— 防"replace 的 $' 把文件整段复制一份"这类事故
	//   （`node --check` 查不出：两份代码都合法，只是后者覆盖前者）
	{ file: 'check-kb-file-integrity.mjs', desc: '源码完整性：符号唯一 / 无整段重复（21 项，含自测）' },
	// ★ 2026-10-25：导图（.canvas）解析契约（临时库；坏 JSON / 错扩展名都要如实报错）
	{ file: 'check-kb-canvas.mjs', desc: '导图路由：清单 / 解析 / 错误 / 扩展名（8 项）' },
	// ★ 2026-10-25：查重（只检测）—— 近似/完全重复能查到，无关笔记不误报
	{ file: 'check-kb-dedupe.mjs', desc: '查重：近似 / 完全重复 / 不误报（7 项）' },
	// ★ 2026-10-25：审核（状态在 frontmatter；保留其它键 + 改前备份 + 拒绝越界路径）
	{ file: 'check-kb-review.mjs', desc: '审核：状态判定 / frontmatter 保留 / 备份（13 项）' },
	// ★ 2026-10-25：**全路由冒烟** —— 能力堆到 20+ 条路由后，最容易出现"某条没人调、悄悄 500"
	{ file: 'check-kb-routes-smoke.mjs', desc: '全路由冒烟（19 条路由 + 越界负例）' },
	// ★ 2026-10-26：编辑态键盘行为（列表续写 / 空白条目跳出 / Tab 缩进）
	//   被测函数刻意做成纯函数单独文件（mdList.ts）⇒ 守卫只需 bundle 那 40 行
	{ file: 'check-kb-editor-keys.mjs', desc: '编辑态键盘：列表续写 / 缩进（8 项）' },
	// 2026-10-25：前端手写渲染器已删除（服务端渲染为唯一实现）⇒ 它的 27 项回归一并退场，
	// 语义覆盖由 `check-kb-md-node`（28 项）+ `check-kb-md-vault`（全库扫描）承接。
];

const failed = [];
for (const step of STEPS) {
	console.log(`\n── ${step.file} —— ${step.desc}`);
	// windowsHide 必带（本仓约定，见 dsh-plugins/check-spawn-hide.mjs）：这个脚本可能跑在
	// dsh Host（node.exe，无控制台）里 ⇒ 不带就会为每个子检查新分配一个控制台窗口（闪窗）。
	const r = spawnSync(process.execPath, [HERE + step.file, ...(step.args ?? [])], { encoding: 'utf8', windowsHide: true });
	const out = (r.stdout ?? '').trim();
	// 只回显最后几行（前面是逐条 PASS，太多）
	const lines = out.split('\n');
	console.log(lines.slice(-4).join('\n'));
	if (r.status !== 0) { failed.push(step.file); }
}

console.log('\n' + '='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 个守卫未通过：${failed.join(', ')}`);
	process.exit(1);
}
console.log(`✓ 全部 ${STEPS.length} 个守卫通过`);
