# 验证：守卫、探针、变异测试

## 仓库里真实存在的守卫（按顺序跑）

| 脚本 | 查什么 |
|---|---|
| `dsh-plugins/check-plugin-files.mjs` | `package.json` 的 `files` ↔ 目录实际文件，逐项一致 |
| `dsh-plugins/check-workbench-catalog.mjs` | 工作台清单 ↔ 注册一致性 |
| `dsh-plugins/check-workbench-style.mjs` | 视觉/结构 6 条（S6/S7/S8/TOOLBAR/S9/S11），**只查 `UNIFIED` 名单里的包** |
| `dsh-plugins/check-chat-surface-chunks.mjs` | 入口/子块 chunk 形状 + mtime（入口不能比子块旧） |
| `dsh-plugins/check-assistant-collapse.mjs` | AI 助手栏伸缩一致性（契约见 `assistant-collapse.md`） |
| `dsh-plugins/check-agent-tools.mjs` | agent 的 `tools` / `skills` 名单是否都真实存在 |
| `src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs` | IDE 侧一致性（模块容器、活动栏 order、描述符 ↔ 清单逐字） |

`UNIFIED` 当前名单（在 `check-workbench-style.mjs` 里）：

```
vssaros-workflow, vssaros-kanban, vssaros-memory, vssaros-codebase,
vssaros-kb, vssaros-agents, vssaros-scheduler, vssaros-xhs-note
```

新包**先体检、后入列**：`node "<Base directory>\scripts\audit_workbench.mjs" dsh-plugins/vssaros-<module>`。

## 选「活」文件（最容易得出假绿结论）

把子块整段并进入口之后，旧子块是**死文件**。按「`wb-*` 最多」挑文件会检查到死代码，给出"已达标"的假结论（kb 就这样漏了 4 项）。

正确顺序：

1. 入口文件里有 `register(` ⇒ 用入口；
2. 否则看入口 `require.async('./client.X.js')` 装载的是哪个 ⇒ 用它；
3. 都没有才退回「`wb-*` 最多」的那个。

## 变异测试（每条守卫都要做一次）

守卫写完先证明它会红，否则等于没写：

| 改坏什么 | 应当触发的守卫 |
|---|---|
| 删掉根节点 `data-vssaros-surface` | `check-workbench-style`（S8） |
| 塞一行 `background: #ff0000` | `check-workbench-style`（S7） |
| 把图标改成 emoji 直出 `🧩` | 人工/视觉 |
| 入口文件加 `chunk:` | `check-chat-surface-chunks` |
| 收起改成 `display:'flex'` + 30px 宽 | `check-assistant-collapse` |
| `files` 里删掉一个真实存在的文件 | `check-plugin-files` |

做完**务必还原**，再确认全绿。守卫脚本自身的判断也要用绝对期望值（不要用相对比较，容易自洽）。

## 探针写法

探针依赖本仓 sandbox lib，脚本放 `poc/dsh-p0/scripts/p3-xx-<module>.mjs`。断言只认 `data-*` 锚点：

```js
const reg = await page.evaluate(() => [...document.querySelectorAll('[data-vssaros-workbench]')]
	.map(el => el.getAttribute('data-vssaros-workbench')));
assert(reg.includes('vssaros-tasks'), '注册表里没有 tasks');

const rows = await page.evaluate(() => document.querySelectorAll('[data-tasks-row]').length);
assert(rows === expected, `行数 ${rows} != ${expected}`);

const noIframe = await page.evaluate(() => !document.querySelector('[data-vssaros-workbench="vssaros-tasks"] iframe'));
assert(noIframe, '注册式工作台里出现了 iframe');
```

明暗跟随要取**常驻根元素**（不要取页签内的元素，切页签后被卸载 ⇒ 取到 null）。

## 真机沙箱

```powershell
VsSaros.exe %TEMP%\wb-tasks
```

断言四件事：注册表里有它 / 渲染无 iframe（注册式）/ 切暗色时颜色真的变 / boot 无失败（console 无 `invalid package-local chunk`）。

## 常见「假绿」

| 现象 | 真因 |
|---|---|
| 守卫全绿但页面空白 | 查的是死文件；或 `cordis.patch.yml` 没被 `dsh.bundle.patch` 引用 |
| 模块加载了但注册被拒 | 描述符漏 `repository`（错误只在页面 console） |
| 样式"没生效" | 用了不存在的令牌名（`--dsw-alias-border-default` 之类）⇒ 静默回落 |
| 探针数到 0 条 | 用了类名当锚点，UI 统一后被换掉 |
| 宽度断点不生效 | 用 `@media` 而非 `@container` |
